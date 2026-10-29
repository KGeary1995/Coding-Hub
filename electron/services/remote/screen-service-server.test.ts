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

async function service(enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-service-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'remote-devices.json'), JSON.stringify([device('MacBook-Air-2.local', COMPUTER, 'computer'), device('Phone', PHONE, 'phone')]));
  fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled }));
  const viewers: (string | null)[] = []; let opened = 0; let stopped = 0;
  const screen = new ScreenService(root, () => 'Obsidian-Halo', {
    open: async () => { opened++; return { source: { width: 320, height: 200, frame: async () => [] }, input: { pointer: () => {}, key: () => {}, clipboard: () => {}, close: () => {} }, stop: () => { stopped++; } }; },
    viewing: (name) => viewers.push(name),
  });
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

  it('refuses unknown keys, phones, and a switched-off share, saying why', async () => {
    const { url, root } = await service();
    await expect(openTraceScreen('Obsidian-Halo', url, 'x'.repeat(43))).rejects.toThrow(/no longer accepts this computer/);
    await expect(openTraceScreen('Obsidian-Halo', url, PHONE)).rejects.toThrow(/phones cannot/);
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
});
