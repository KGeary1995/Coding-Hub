import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ScreenEvent } from '../../../shared/screen';
import { ScreenSharing, screenHost, type SecretCipher } from './screen-sharing';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); });
const until = async (check: () => boolean, what: string) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!check()) throw new Error('Timed out waiting for ' + what); };
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const MAC = '6c119c8a-b055-4476-b16f-b3e50e873bb8'; const STREAM = '0b5f1f9e-8a3c-4d6e-9f0a-1b2c3d4e5f60';
const cipher = (available = true): SecretCipher => ({ available: () => available, encrypt: (text) => Buffer.from('sealed:' + text).toString('base64'), decrypt: (value) => Buffer.from(value, 'base64').toString().replace(/^sealed:/, '') });

/** A screen-sharing server that speaks first, as a VNC server does, and echoes what it receives. */
async function vncServer() {
  const received: Buffer[] = []; const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => { sockets.push(socket); socket.write('RFB 003.889\n'); socket.on('data', (data) => received.push(data)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return { port: (server.address() as net.AddressInfo).port, received, sockets };
}
function sharing(port: number, options: { cipher?: SecretCipher; linked?: boolean } = {}) {
  const events: { owner: number; event: ScreenEvent }[] = []; const root = temporary();
  const screens = new ScreenSharing(root, (id) => options.linked !== false && id === MAC ? { host: '127.0.0.1', name: 'MacBook-Air-2.local' } : null, (owner, event) => events.push({ owner, event }), options.cipher ?? cipher(), port);
  cleanup.push(() => screens.closeAll());
  return { screens, events, root };
}

describe('screen sharing with a linked computer', () => {
  it('connects only to linked computers on their Tailscale name', () => {
    expect(screenHost('https://macbook-air-2.tail433c9f.ts.net/')).toBe('macbook-air-2.tail433c9f.ts.net');
    expect(screenHost('https://example.com/')).toBeNull(); expect(screenHost('http://127.0.0.1:47821/')).toBeNull(); expect(screenHost(null)).toBeNull();
  });

  it('carries bytes both ways, and only for the window that opened it', async () => {
    const server = await vncServer(); const { screens, events } = sharing(server.port);
    await screens.open(7, MAC, STREAM);
    await until(() => events.some(({ event }) => event.type === 'data'), 'the server greeting');
    const greeting = events.find(({ event }) => event.type === 'data')!;
    expect(greeting.owner).toBe(7); expect(Buffer.from((greeting.event as { data: Uint8Array }).data).toString()).toBe('RFB 003.889\n');
    screens.send(7, STREAM, new TextEncoder().encode('RFB 003.008\n'));
    await until(() => server.received.length > 0, 'the client version'); expect(Buffer.concat(server.received).toString()).toBe('RFB 003.008\n');
    expect(() => screens.send(8, STREAM, new Uint8Array([1]))).toThrow(/closed/);
    screens.close(8, STREAM); expect(events.some(({ event }) => event.type === 'closed')).toBe(false);
    screens.close(7, STREAM);
    await until(() => events.some(({ event }) => event.type === 'closed'), 'the close');
    expect(events.find(({ event }) => event.type === 'closed')!.event).toEqual({ type: 'closed', streamId: STREAM });
  });

  it('says when the other computer ends it', async () => {
    const server = await vncServer(); const { screens, events } = sharing(server.port);
    await screens.open(1, MAC, STREAM); await until(() => server.sockets.length > 0, 'the connection');
    server.sockets[0].end();
    await until(() => events.some(({ event }) => event.type === 'closed'), 'the close');
    expect(events.find(({ event }) => event.type === 'closed')!.event).toMatchObject({ error: 'MacBook-Air-2.local ended screen sharing.' });
  });

  it('explains how to turn on Screen Sharing when nothing listens there', async () => {
    const server = net.createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port; await new Promise<void>((resolve) => server.close(() => resolve()));
    const { screens } = sharing(port);
    await expect(screens.open(1, MAC, STREAM)).rejects.toMatchObject({ code: 'SCREEN_CONNECT', message: expect.stringContaining('System Settings → General → Sharing → Screen Sharing') });
    // The failed stream is gone, so the same name can be tried again.
    await expect(screens.open(1, MAC, STREAM)).rejects.toMatchObject({ code: 'SCREEN_CONNECT' });
  });

  it('refuses computers that are not linked, and a second stream of the same name', async () => {
    const server = await vncServer();
    await expect(sharing(server.port, { linked: false }).screens.open(1, MAC, STREAM)).rejects.toMatchObject({ code: 'SCREEN_UNKNOWN' });
    const { screens } = sharing(server.port); await screens.open(1, MAC, STREAM);
    await expect(screens.open(1, MAC, STREAM)).rejects.toMatchObject({ code: 'SCREEN_STREAM' });
  });

  it('keeps the password only encrypted, and forgets it', () => {
    const { screens, root } = sharing(1);
    expect(screens.credentials(MAC)).toBeNull();
    screens.saveCredentials(MAC, { username: 'kgeary', password: 'hunter2' });
    expect(fs.readFileSync(path.join(root, 'screen-sharing.json'), 'utf8')).not.toContain('hunter2');
    expect(screens.credentials(MAC)).toEqual({ username: 'kgeary', password: 'hunter2' });
    screens.forgetCredentials(MAC); expect(screens.credentials(MAC)).toBeNull();
  });

  it('does not save a password when the system cannot encrypt it', () => {
    const { screens, root } = sharing(1, { cipher: cipher(false) });
    expect(() => screens.saveCredentials(MAC, { username: 'kgeary', password: 'hunter2' })).toThrow(/ask each time/);
    expect(fs.existsSync(path.join(root, 'screen-sharing.json'))).toBe(false);
  });
});
