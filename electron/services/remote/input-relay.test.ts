import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { COMMAND, InputRelay, trackHeld } from './input-relay';
import { spawnSync } from 'node:child_process';
import { pointerCommands, relayHelper, WindowsInput, type InputHelper } from './screen-input';
import { LOCAL_FILE } from './screen-service-server';

const TOKEN = 'k'.repeat(43);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); });
const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); expect(done()).toBe(true); };

/** A stand-in for the PowerShell helper: what it was written, and whether its input was closed. */
function fakeHelper() {
  const stdin = new PassThrough(); const state = { lines: [] as string[], ended: false };
  stdin.on('data', (data: Buffer) => state.lines.push(...data.toString().split('\n').filter(Boolean))); stdin.on('end', () => { state.ended = true; });
  const helper = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as InputHelper & EventEmitter;
  return { helper, state };
}
async function relay() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'input-relay-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, LOCAL_FILE), JSON.stringify({ token: TOKEN }));
  const helpers: ReturnType<typeof fakeHelper>[] = [];
  const server = new InputRelay(root, () => { const made = fakeHelper(); helpers.push(made); return made.helper; }); server.version = '1.28.1';
  const port = await server.listen(0); cleanup.push(() => server.close());
  return { port, helpers };
}
/** An upgrade request as the screen service makes it; resolves with the status, and the socket once it is let in. */
function connect(port: number, headers: Record<string, string>) {
  return new Promise<{ status: number; socket?: net.Socket }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/input', headers: { Connection: 'Upgrade', ...headers } });
    request.on('upgrade', (response, socket) => { socket.on('error', () => {}); resolve({ status: response.statusCode ?? 0, socket }); });
    request.on('response', (response) => { response.resume(); resolve({ status: response.statusCode ?? 0 }); }); request.on('error', reject); request.end();
  });
}

describe('the administrator side of the screen service', () => {
  it('tells its version, and lets in only Trace’s own key, asked for from this computer', async () => {
    const { port, helpers } = await relay();
    const health = await new Promise<string>((resolve) => http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(body)); }));
    expect(JSON.parse(health)).toEqual({ ok: true, version: '1.28.1' });
    expect((await connect(port, { Upgrade: 'trace-input' })).status).toBe(401);
    expect((await connect(port, { Upgrade: 'trace-input', Authorization: `Bearer ${'x'.repeat(43)}` })).status).toBe(401);
    expect((await connect(port, { Upgrade: 'trace-screen', Authorization: `Bearer ${TOKEN}` })).status).toBe(400);
    // Passed on by Tailscale (nothing sets that up; refused all the same), even with the key.
    for (const header of ['Tailscale-Funnel-Request', 'Tailscale-User-Login', 'X-Forwarded-For']) expect((await connect(port, { Upgrade: 'trace-input', Authorization: `Bearer ${TOKEN}`, [header]: '1' })).status).toBe(403);
    // Nobody refused started a helper.
    expect(helpers).toHaveLength(0);
  });

  it('presses what the service sends, and nothing that is not one of its commands', async () => {
    const { port, helpers } = await relay();
    const { status, socket } = await connect(port, { Upgrade: 'trace-input', Authorization: `Bearer ${TOKEN}` }); expect(status).toBe(101);
    socket!.write('m 100 200 49153 0\nk 65 1 0\nk 65 0 0\nc 228 1\nc 228 0\n');
    socket!.write('Start-Process calc\nk 65 1 0; rm x\nm 1 2 3\nk 9999 1 0\n\nm 0 0 2048 -1');
    socket!.write('20\n');
    await until(() => helpers[0]?.state.lines.length === 6);
    expect(helpers[0].state.lines).toEqual(['m 100 200 49153 0', 'k 65 1 0', 'k 65 0 0', 'c 228 1', 'c 228 0', 'm 0 0 2048 -120']);
    // A clean close after everything was released: the helper's input is closed, and nothing more is pressed.
    socket!.end(); await until(() => helpers[0].state.ended); expect(helpers[0].state.lines).toHaveLength(6);
  });

  it('releases what was left pressed when the service goes without doing so', async () => {
    const { port, helpers } = await relay();
    const { socket } = await connect(port, { Upgrade: 'trace-input', Authorization: `Bearer ${TOKEN}` });
    // Shift and a held, a character held, the left button down at a point; the right button pressed and released.
    const [, press] = pointerCommands(10, 20, 1, 0, 1920, 1080); const [, right] = pointerCommands(10, 20, 4, 0, 1920, 1080); const [, rightUp] = pointerCommands(10, 20, 0, 4, 1920, 1080);
    socket!.write(['k 16 1 0', 'k 65 1 0', 'k 65 0 0', 'c 228 1', press, right, rightUp].join('\n') + '\n');
    await until(() => helpers[0]?.state.lines.length === 7);
    socket!.destroy(); await until(() => helpers[0].state.ended);
    const [, x, y] = press.split(' ');
    expect(helpers[0].state.lines.slice(7).sort()).toEqual(['k 16 0 0', 'c 228 0', `m ${x} ${y} ${0x8000 | 0x4000 | 0x0004} 0`].sort());
  });

  it('follows what each line leaves pressed', () => {
    const held = new Map<string, string>();
    for (const line of ['k 17 1 1', 'k 17 1 0', 'c 97 1', 'm 5 6 49184 0']) trackHeld(held, line);
    expect([...held.values()]).toEqual(['k 17 0 1', 'k 17 0 0', 'c 97 0', 'm 5 6 49216 0']);
    for (const line of ['k 17 0 1', 'c 97 0', 'm 7 8 49216 0', 'm 1 1 49153 0', 'm 0 0 2048 120']) trackHeld(held, line);
    expect([...held.values()]).toEqual(['k 17 0 0']);
  });
});

describe('the service’s input through the administrator side', () => {
  it('sends a viewer’s input there, in order, from the first line on', async () => {
    const { port, helpers } = await relay(); const local: ReturnType<typeof fakeHelper>[] = [];
    const input = new WindowsInput(1920, 1080, () => {}, () => relayHelper(port, TOKEN, () => { const made = fakeHelper(); local.push(made); return made.helper; }));
    // Written before the connection is made: they wait, and arrive first.
    input.key(0x61, true); input.key(0x61, false); input.pointer(0, 0, 1);
    await until(() => helpers[0]?.state.lines.length === 4);
    expect(helpers[0].state.lines).toEqual(['c 97 1', 'c 97 0', 'm 0 0 49153 0', 'm 0 0 49154 0']);
    // Leaving releases the button there and closes the helper; nothing was pressed from the service itself.
    input.close(); await until(() => helpers[0].state.ended);
    expect(helpers[0].state.lines.slice(4)).toEqual(['m 0 0 49153 0', 'm 0 0 49156 0']); expect(local).toHaveLength(0);
  });

  it('presses from the service itself when the administrator side is not there, or refuses', async () => {
    const closed = await new Promise<number>((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });
    const { port, helpers } = await relay();
    for (const [where, token] of [[closed, TOKEN], [port, 'x'.repeat(43)]] as const) {
      const local: ReturnType<typeof fakeHelper>[] = [];
      const input = new WindowsInput(1920, 1080, () => {}, () => relayHelper(where, token, () => { const made = fakeHelper(); local.push(made); return made.helper; }));
      input.key(0x62, true); input.key(0x62, false);
      await until(() => local[0]?.state.lines.length === 2);
      expect(local[0].state.lines).toEqual(['c 98 1', 'c 98 0']);
      input.close(); await until(() => local[0].state.ended);
    }
    expect(helpers).toHaveLength(0);
  });

  it('connects again for the next input once the administrator side has gone', async () => {
    const { port, helpers } = await relay(); let made = 0;
    const input = new WindowsInput(1920, 1080, () => {}, () => { made++; return relayHelper(port, TOKEN, () => fakeHelper().helper); });
    input.key(0x61, true); input.key(0x61, false); await until(() => helpers[0]?.state.lines.length === 2);
    // Its helper there exits (PowerShell was ended): the connection closes, and the next key starts a new one.
    helpers[0].helper.emit('exit'); await new Promise((resolve) => setTimeout(resolve, 100));
    input.key(0x62, true); await until(() => helpers[1]?.state.lines.length === 1);
    expect(made).toBe(2); expect(helpers[1].state.lines).toEqual(['c 98 1']); input.close();
  });
});

// The protected helper (native/trace-input.c) takes exactly the lines the relay takes; run where it was built (Windows CI).
const helperExe = path.join(__dirname, '..', '..', '..', 'dist-electron', 'native', 'trace-input.exe');
describe('the protected helper\'s grammar', () => {
  it.runIf(process.platform === 'win32' && fs.existsSync(helperExe))('accepts exactly the relay\'s commands', () => {
    const lines = ['m 1 2 3 4', 'm -1 -2 3 -4', 'k 13 1 0', 'c 65 1', 'c 1114111 0', 'm 1  2 3 4', 'm 1 2 3 4 ', ' m 1 2 3 4', 'k 1234 1 0', 'k 13 2 0', 'c 12345678 1', 'm 1234567 1 1 1', 'm 1 2 -3 4', 'k -1 1 0', 'c 65', 'x 1 2', 'm --1 2 3 4', 'c 0065 1', 'm 123456 -123456 12345 -123456'];
    const run = spawnSync(helperExe, ['--check'], { input: lines.join('\n') + '\n', encoding: 'utf8' });
    expect(run.status).toBe(0); expect(run.stdout.trim().split(/\r?\n/)).toEqual(lines.map((line) => COMMAND.test(line) ? 'ok' : 'bad'));
  });
});
