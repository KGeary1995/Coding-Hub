import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { compactLength, RfbSession, type FrameRect, type ScreenInput } from './rfb-server';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const item of cleanup.splice(0)) item(); });
const until = async (check: () => boolean, what: string) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!check()) throw new Error('Timed out waiting for ' + what); };

/** A session on one end of a loopback connection; the test is the viewer on the other end. */
async function session(frames: FrameRect[][]) {
  const events: string[] = []; const received: Buffer[] = []; let ended = false; const asked: boolean[] = []; let clipboard = 'before';
  const input: ScreenInput = { pointer: (x, y, buttons) => events.push(`pointer ${x} ${y} ${buttons}`), key: (keysym, down) => events.push(`key ${keysym.toString(16)} ${down}`), clipboard: (text) => events.push(`clipboard ${text}`) };
  const server = net.createServer((socket) => { new RfbSession(socket, { width: 640, height: 480, frame: async (full) => { asked.push(full); return frames.shift() ?? []; } }, input, 'Obsidian-Halo', () => { ended = true; }, async () => clipboard); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const viewer = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1'); viewer.on('data', (data) => received.push(data));
  cleanup.push(() => { viewer.destroy(); server.close(); });
  const bytes = () => Buffer.concat(received);
  return { viewer, events, bytes, asked, ended: () => ended, setClipboard: (text: string) => { clipboard = text; } };
}
const encodings = (...list: number[]) => { const message = Buffer.alloc(4 + 4 * list.length); message[0] = 2; message.writeUInt16BE(list.length, 2); list.forEach((value, index) => message.writeInt32BE(value, 4 + 4 * index)); return message; };
const request = (incremental: boolean) => Buffer.from([3, incremental ? 1 : 0, 0, 0, 0, 0, 2, 128, 1, 224]);

describe('the Windows screen as a VNC server', () => {
  it('encodes Tight lengths in one to three bytes', () => {
    expect([...compactLength(100)]).toEqual([100]);
    expect([...compactLength(1000)]).toEqual([0xe8, 0x07]);
    expect([...compactLength(100000)]).toEqual([0xa0, 0x8d, 0x06]);
  });

  it('greets, needs no VNC password (the link key was checked), and sends changed parts as JPEG', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const vnc = await session([[{ x: 0, y: 0, width: 64, height: 32, jpeg }]]);
    await until(() => vnc.bytes().length >= 12, 'the version'); expect(vnc.bytes().toString('latin1', 0, 12)).toBe('RFB 003.008\n');
    vnc.viewer.write('RFB 003.008\n'); await until(() => vnc.bytes().length >= 14, 'security types'); expect([...vnc.bytes().subarray(12, 14)]).toEqual([1, 1]);
    vnc.viewer.write(Buffer.from([1])); vnc.viewer.write(Buffer.from([1]));
    await until(() => vnc.bytes().length >= 18 + 24 + 13, 'the server init');
    const init = vnc.bytes().subarray(18);
    expect(init.readUInt16BE(0)).toBe(640); expect(init.readUInt16BE(2)).toBe(480); expect(init.subarray(24, 24 + 13).toString()).toBe('Obsidian-Halo');
    vnc.viewer.write(Buffer.concat([encodings(7, -32), request(false)]));
    await until(() => vnc.bytes().length >= 18 + 37 + 4 + 12 + 2 + jpeg.length, 'the update');
    const update = vnc.bytes().subarray(18 + 37);
    expect(update.readUInt16BE(2)).toBe(1); expect(update.readUInt16BE(8)).toBe(64); expect(update.readUInt16BE(10)).toBe(32); expect(update.readInt32BE(12)).toBe(7);
    expect(update[16]).toBe(0x90); expect(update[17]).toBe(jpeg.length); expect([...update.subarray(18, 18 + jpeg.length)]).toEqual([...jpeg]);
    expect(vnc.asked[0]).toBe(true);
    // Input reaches this computer; then the viewer's text lands on its clipboard.
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]); const pointer = Buffer.from([5, 1, 0, 10, 0, 20]); const text = Buffer.from('hi');
    const cut = Buffer.alloc(8); cut[0] = 6; cut.writeUInt32BE(text.length, 4);
    vnc.viewer.write(Buffer.concat([key, pointer, cut, text]));
    await until(() => vnc.events.length >= 3, 'input'); expect(vnc.events).toEqual(['key 61 true', 'pointer 10 20 1', 'clipboard hi']);
  });

  it('pushes changes without being asked once the viewer takes continuous updates', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); const rect = (x: number) => [{ x, y: 0, width: 64, height: 64, jpeg }];
    const vnc = await session([rect(0), rect(64), rect(128)]);
    vnc.viewer.write('RFB 003.008\n'); vnc.viewer.write(Buffer.from([1, 1])); await until(() => vnc.bytes().length >= 18 + 37, 'the server init');
    vnc.viewer.write(Buffer.concat([encodings(7, -313), request(false)]));
    // EndOfContinuousUpdates offers them, then the requested update.
    await until(() => vnc.bytes().length >= 18 + 37 + 1 + 22, 'the offer and the first update'); expect(vnc.bytes()[18 + 37]).toBe(150);
    vnc.viewer.write(Buffer.from([150, 1, 0, 0, 0, 0, 2, 128, 1, 224]));
    // Two more updates arrive with no further request.
    await until(() => vnc.bytes().length >= 18 + 37 + 1 + 3 * 22, 'pushed updates');
    const second = vnc.bytes().subarray(18 + 37 + 1 + 22); expect(second[0]).toBe(0); expect(second.readUInt16BE(4)).toBe(64);
  });

  it('sends what is copied here after the viewer connects, not what was there before', async () => {
    const vnc = await session([]);
    vnc.viewer.write('RFB 003.008\n'); vnc.viewer.write(Buffer.from([1, 1]));
    await until(() => vnc.bytes().length >= 18 + 37, 'the server init'); await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(vnc.bytes().length).toBe(18 + 37);
    vnc.setClipboard('copied here'); await until(() => vnc.bytes().length > 18 + 37, 'the clipboard');
    const message = vnc.bytes().subarray(18 + 37); expect(message[0]).toBe(3); expect(message.subarray(8).toString('latin1')).toBe('copied here');
  });

  it('ends the connection on a message it does not know', async () => {
    const vnc = await session([]);
    vnc.viewer.write('RFB 003.008\n'); vnc.viewer.write(Buffer.from([1, 1])); await until(() => vnc.bytes().length >= 18 + 37, 'the server init');
    vnc.viewer.write(Buffer.from([99])); await until(() => vnc.ended(), 'the end');
  });
});
