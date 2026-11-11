import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import zlib from 'node:zlib';
import { compactLength, RfbSession, type FrameRect, type ScreenInput } from './rfb-server';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const item of cleanup.splice(0)) item(); });
const until = async (check: () => boolean, what: string) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!check()) throw new Error('Timed out waiting for ' + what); };

/** A session on one end of a loopback connection; the test is the viewer on the other end. */
async function session(frames: FrameRect[][], frame?: (full: boolean) => Promise<FrameRect[]>) {
  const events: string[] = []; const received: Buffer[] = []; let ended = 0; const asked: boolean[] = []; let clipboard = 'before';
  const input: ScreenInput = { pointer: (x, y, buttons) => events.push(`pointer ${x} ${y} ${buttons}`), key: (keysym, down) => events.push(`key ${keysym.toString(16)} ${down}`), clipboard: (text) => events.push(`clipboard ${text}`) };
  const server = net.createServer((socket) => { new RfbSession(socket, { width: 640, height: 480, frame: frame ?? (async (full) => { asked.push(full); return frames.shift() ?? []; }) }, input, 'Obsidian-Halo', () => { ended++; }, async () => clipboard); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const viewer = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1'); viewer.on('data', (data) => received.push(data));
  cleanup.push(() => { viewer.destroy(); server.close(); });
  const bytes = () => Buffer.concat(received);
  return { viewer, events, bytes, asked, ended: () => ended > 0, endings: () => ended, setClipboard: (text: string) => { clipboard = text; } };
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

  it('ends the session when the capture fails, rather than leaving the last picture up', async () => {
    let calls = 0; const vnc = await session([], async () => { if (++calls === 1) return [{ x: 0, y: 0, width: 64, height: 64, jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }]; throw new Error('The capture ended.'); });
    let closed = false; vnc.viewer.on('close', () => { closed = true; });
    vnc.viewer.write('RFB 003.008\n'); vnc.viewer.write(Buffer.from([1, 1])); await until(() => vnc.bytes().length >= 18 + 37, 'the server init');
    vnc.viewer.write(Buffer.concat([encodings(7, -313), request(false)])); await until(() => vnc.bytes().length >= 18 + 37 + 1 + 22, 'the first update');
    vnc.viewer.write(Buffer.from([150, 1, 0, 0, 0, 0, 2, 128, 1, 224]));
    await until(() => vnc.ended() && closed, 'the end'); await new Promise((resolve) => setTimeout(resolve, 50)); expect(vnc.endings()).toBe(1);
  });

  describe('the clipboard', () => {
    const quoted = '“quoted” — text 🙂';
    /** Plays noVNC: lists the extended clipboard, and reads the server's clipboard messages (the only ones sent here). */
    async function extended() {
      const vnc = await session([]);
      vnc.viewer.write('RFB 003.008\n'); vnc.viewer.write(Buffer.from([1, 1])); await until(() => vnc.bytes().length >= 18 + 37, 'the server init');
      vnc.viewer.write(encodings(7, 0xc0a1e5ce | 0));
      const messages = () => { const out: { flags: number; payload: Buffer }[] = []; let at = 18 + 37; const all = vnc.bytes(); while (at + 8 <= all.length) { const length = -all.readInt32BE(at + 4); if (all[at] !== 3 || length < 4 || at + 8 + length > all.length) break; out.push({ flags: all.readUInt32BE(at + 8), payload: all.subarray(at + 12, at + 8 + length) }); at += 8 + length; } return out; };
      const send = (flags: number, payload = Buffer.alloc(0)) => { const header = Buffer.alloc(12); header[0] = 6; header.writeInt32BE(-(4 + payload.length), 4); header.writeUInt32BE(flags >>> 0, 8); vnc.viewer.write(Buffer.concat([header, payload])); };
      await until(() => messages().length === 1, 'the server caps');
      // noVNC's own Caps reply: its actions, with text.
      send((1 << 24) | (1 << 25) | (1 << 26) | (1 << 27) | (1 << 28) | 1, Buffer.alloc(4));
      return { vnc, messages, send };
    }
    it('offers the extended clipboard with text and every action it answers', async () => {
      const { messages } = await extended();
      expect(messages()[0].flags >>> 0).toBe(((1 << 24) | (1 << 25) | (1 << 26) | (1 << 27) | (1 << 28) | 1) >>> 0); expect(messages()[0].payload.readUInt32BE(0)).toBe(1024 * 1024);
    });
    it('takes text copied on the viewer intact, as noVNC sends it', async () => {
      const { vnc, messages, send } = await extended();
      send((1 << 27) | 1); await until(() => messages().length === 2, 'the request'); expect(messages()[1].flags).toBe((1 << 25) | 1);
      // noVNC flushes its zlib stream without finishing it.
      const utf8 = Buffer.from(quoted.replace(/\n/g, '\r\n') + '\0', 'utf8'); const size = Buffer.alloc(4); size.writeUInt32BE(utf8.length);
      send((1 << 28) | 1, zlib.deflateSync(Buffer.concat([size, utf8]), { finishFlush: zlib.constants.Z_FULL_FLUSH }));
      await until(() => vnc.events.length === 1, 'the clipboard'); expect(vnc.events).toEqual([`clipboard ${quoted}`]);
    });
    it('sends text copied here intact, when the viewer asks for it', async () => {
      const { vnc, messages, send } = await extended(); await new Promise((resolve) => setTimeout(resolve, 1100));
      vnc.setClipboard(quoted); await until(() => messages().length === 2, 'the notify'); expect(messages()[1].flags).toBe((1 << 27) | 1);
      send((1 << 25) | 1); await until(() => messages().length === 3, 'the text'); expect(messages()[2].flags).toBe((1 << 28) | 1);
      const data = zlib.inflateSync(messages()[2].payload); const length = data.readUInt32BE(0);
      expect(data.subarray(4, 4 + length).toString('utf8')).toBe(quoted + '\0');
    });
    it('ends the session when the text inflates past the limit', async () => {
      const { vnc, send } = await extended();
      const huge = Buffer.alloc(2 * 1024 * 1024, 0x61); const size = Buffer.alloc(4); size.writeUInt32BE(huge.length);
      send((1 << 28) | 1, zlib.deflateSync(Buffer.concat([size, huge]))); await until(() => vnc.ended(), 'the end'); expect(vnc.events).toEqual([]);
    });
    it('falls back to Latin-1 for a viewer without the extended clipboard', async () => {
      const vnc = await session([]);
      vnc.viewer.write('RFB 003.008\n'); vnc.viewer.write(Buffer.from([1, 1])); await until(() => vnc.bytes().length >= 18 + 37, 'the server init');
      vnc.viewer.write(encodings(7)); await new Promise((resolve) => setTimeout(resolve, 1100)); expect(vnc.bytes().length).toBe(18 + 37);
      vnc.setClipboard(quoted); await until(() => vnc.bytes().length > 18 + 37, 'the clipboard');
      const message = vnc.bytes().subarray(18 + 37); expect(message.readInt32BE(4)).toBeGreaterThan(0); expect(message.subarray(8).toString('latin1')).toBe('?quoted? ? text ??');
    });
  });

  it('ends the connection on a message it does not know', async () => {
    const vnc = await session([]);
    vnc.viewer.write('RFB 003.008\n'); vnc.viewer.write(Buffer.from([1, 1])); await until(() => vnc.bytes().length >= 18 + 37, 'the server init');
    vnc.viewer.write(Buffer.from([99])); await until(() => vnc.ended(), 'the end');
  });
});
