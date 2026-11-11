import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScreenService, SHARE_FILE } from './screen-service-server';
import { openTraceScreen } from './screen-sharing';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); });
const until = async (check: () => boolean, what: string) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!check()) throw new Error('Timed out waiting for ' + what); };
const COMPUTER = 'c'.repeat(43); const PHONE = 'p'.repeat(43);
const device = (name: string, token: string, kind: 'phone' | 'computer') => ({ id: crypto.randomUUID(), name, tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString(), lastSeen: null, kind });

async function service(enabled = true, options: { open?: () => Promise<never | { source: unknown }>; openTimeout?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-service-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'remote-devices.json'), JSON.stringify([device('MacBook-Air-2.local', COMPUTER, 'computer'), device('Phone', PHONE, 'phone')]));
  fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled }));
  const viewers: (string | null)[] = []; let opened = 0; let stopped = 0;
  const screen = new ScreenService(root, () => 'Obsidian-Halo', {
    open: options.open as never ?? (async () => { opened++; return { source: { width: 320, height: 200, frame: async () => [] }, input: { pointer: () => {}, key: () => {}, clipboard: () => {}, close: () => {} }, stop: () => { stopped++; } }; }),
    viewing: (name) => viewers.push(name),
  }, options.openTimeout);
  const port = await screen.listen(0); cleanup.push(() => screen.close());
  return { root, screen, url: `http://127.0.0.1:${port}/`, viewers, counts: () => ({ opened, stopped }) };
}

describe('the Windows screen service', () => {
  it('lets a linked computer in with its link key, and speaks VNC from there', async () => {
    const { url, viewers } = await service();
    const { socket, head } = await openTraceScreen('Obsidian-Halo', url, COMPUTER); cleanup.push(() => { socket.destroy(); });
    let received = Buffer.from(head); socket.on('data', (data: Buffer) => { received = Buffer.concat([received, data]); });
    await until(() => received.length >= 12, 'the VNC greeting'); expect(received.toString('latin1', 0, 12)).toBe('RFB 003.008\n');
    await until(() => viewers.length > 0, 'the viewer'); expect(viewers.at(-1)).toBe('MacBook-Air-2.local');
  });

  it('shows the display the viewer asks for, and says how many there are', async () => {
    const asked: number[] = [];
    const open = async (display: number) => { asked.push(display); return { source: { width: 320, height: 200, frame: async () => [] }, input: { pointer: () => {}, key: () => {}, clipboard: () => {}, close: () => {} }, stop: () => {}, displays: 3, display: display > 3 ? 0 : display }; };
    const { url } = await service(true, { open: open as never });
    const one = await openTraceScreen('Obsidian-Halo', url, COMPUTER, undefined, 2); one.socket.destroy();
    expect(asked).toEqual([2]); expect(one).toMatchObject({ displays: 3, display: 2 });
    // A number that is gone (a display was unplugged) shows them all; no choice asks for all.
    const gone = await openTraceScreen('Obsidian-Halo', url, COMPUTER, undefined, 5); gone.socket.destroy(); expect(gone).toMatchObject({ displays: 3, display: 0 });
    const all = await openTraceScreen('Obsidian-Halo', url, COMPUTER); all.socket.destroy(); expect(asked).toEqual([2, 5, 0]); expect(all).toMatchObject({ displays: 3, display: 0 });
    // An older service (or one that cannot say) gives neither, and the viewer offers no choice.
    const older = await service(); const plain = await openTraceScreen('Obsidian-Halo', older.url, COMPUTER, undefined, 2); plain.socket.destroy();
    expect(plain.displays).toBeUndefined(); expect(plain.display).toBeUndefined();
  });

  it('refuses unknown keys, phones, and a switched-off share, saying why', async () => {
    const { url, root } = await service();
    await expect(openTraceScreen('Obsidian-Halo', url, 'x'.repeat(43))).rejects.toThrow(/no longer accepts this computer/);
    await expect(openTraceScreen('Obsidian-Halo', url, PHONE)).rejects.toThrow(/through Trace’s phone access/);
    fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: false }));
    await expect(openTraceScreen('Obsidian-Halo', url, COMPUTER)).rejects.toThrow(/Screen sharing is off on Obsidian-Halo/);
  });

  it('removing the computer in Trace locks it out at once', async () => {
    const { url, root } = await service();
    fs.writeFileSync(path.join(root, 'remote-devices.json'), JSON.stringify([device('Phone', PHONE, 'phone')]));
    await expect(openTraceScreen('Obsidian-Halo', url, COMPUTER)).rejects.toThrow(/no longer accepts/);
  });

  it('has one viewer at a time, and stops capturing when it leaves', async () => {
    const { url, viewers, counts } = await service();
    const first = await openTraceScreen('Obsidian-Halo', url, COMPUTER);
    const second = await openTraceScreen('Obsidian-Halo', url, COMPUTER); cleanup.push(() => { second.socket.destroy(); });
    await until(() => first.socket.destroyed || first.socket.readableEnded, 'the first viewer to be replaced');
    await until(() => counts().opened === 2 && counts().stopped === 1, 'the first capture to stop');
    second.socket.destroy(); await until(() => counts().stopped === 2, 'the capture to stop'); expect(viewers.at(-1)).toBeNull();
  });

  it('tells the viewer when its capture does not start in time, and stops it should it start later', async () => {
    let start: (capture: unknown) => void = () => {}; let stopped = 0; let closed = 0;
    const open = () => new Promise<never>((resolve) => { start = resolve as never; });
    const { url, screen } = await service(true, { open: open as never, openTimeout: 50 });
    await expect(openTraceScreen('Obsidian-Halo', url, COMPUTER)).rejects.toThrow(/Obsidian-Halo could not capture its screen: it did not start in time/);
    expect(screen.watching).toBeNull();
    start({ source: { width: 1, height: 1, frame: async () => [] }, input: { pointer: () => {}, key: () => {}, clipboard: () => {}, close: () => { closed++; } }, stop: () => { stopped++; } });
    await until(() => stopped === 1 && closed === 1, 'the late capture to stop');
  });

  it('a service that takes the request but never answers is reported as such, not as missing', async () => {
    const http = await import('node:http');
    const server = http.createServer(); const sockets: import('node:stream').Duplex[] = [];
    server.on('upgrade', (_request, socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`;
    await expect(openTraceScreen('Obsidian-Halo', url, COMPUTER, 50)).rejects.toThrow(/Obsidian-Halo did not start sharing its screen in time/);
  });
});
