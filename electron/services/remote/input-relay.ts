import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { localScreenToken } from './screen-service-server';
import type { InputHelper } from './screen-input';

/** The most viewers' inputs relayed at once (one viewer, and Trace's own check); each is a PowerShell process. */
const MAX_CLIENTS = 4;
/** Longer than any command the screen service writes; a line that grows past it ends the connection. */
const MAX_LINE = 64;
/** The helper's commands as screen-input.ts writes them, and nothing else: this side runs as administrator. */
export const COMMAND = /^(?:m -?\d{1,6} -?\d{1,6} \d{1,5} -?\d{1,6}|k \d{1,3} [01] [01]|c \d{1,7} [01])$/;
/** SendInput's button flags: pressed → released (left, right, middle). */
const BUTTON_UP: [number, number][] = [[0x0002, 0x0004], [0x0008, 0x0010], [0x0020, 0x0040]];
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * What one input line leaves pressed, as the lines that release it: a key or character held down, a mouse button down.
 * A release removes its entry. Pure, for tests.
 */
export function trackHeld(held: Map<string, string>, line: string) {
  const part = line.split(' ');
  if (part[0] === 'k') { const key = `k ${part[1]} ${part[3]}`; if (part[2] === '1') held.set(key, `k ${part[1]} 0 ${part[3]}`); else held.delete(key); }
  else if (part[0] === 'c') { const key = `c ${part[1]}`; if (part[2] === '1') held.set(key, `c ${part[1]} 0`); else held.delete(key); }
  else if (part[0] === 'm') {
    const flags = Number(part[3]);
    for (const [down, up] of BUTTON_UP) { if (flags & down) held.set(`m ${down}`, `m ${part[1]} ${part[2]} ${(flags & ~down) | up} 0`); else if (flags & up) held.delete(`m ${down}`); }
  }
}

/**
 * The administrator side of the Windows screen service (Settings: also control apps running as administrator): it
 * presses the keys and moves the mouse the screen service sends it, and does nothing else. Windows lets only a program
 * running as administrator control apps that do, but refuses an administrator Electron its screen capture (Windows
 * Graphics Capture answers "access denied", and Chromium has no other capture from Windows 11 24H2), so the ordinary
 * service captures and serves the viewer, and only its input comes here.
 * It listens on this computer only and takes Trace's own key (screen-service-local.json), as the service's check does.
 */
export class InputRelay {
  private server: http.Server | null = null; private clients = new Set<Duplex>();
  /** The Trace version this runs, told in /health so Trace can replace one an update left behind. */
  version: string | null = null;
  constructor(private root: string, private spawnHelper: () => InputHelper) {}

  async listen(port: number) {
    const server = http.createServer((request, response) => {
      const ok = request.method === 'GET' && request.url === '/health';
      response.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(ok ? { ok: true, ...(this.version ? { version: this.version } : {}) } : { error: 'Not found.' }));
    });
    server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    this.server = server; return (server.address() as AddressInfo).port;
  }
  async close() { for (const socket of this.clients) socket.destroy(); const server = this.server; this.server = null; if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }

  private refuse(socket: Duplex, status: number) { socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }

  private upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => {});
    const header = request.headers.authorization; const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''; const local = localScreenToken(this.root);
    // Never from outside this computer: nothing passes this port on, and a request Tailscale passed on is refused anyway.
    if (request.headers['tailscale-funnel-request'] !== undefined || request.headers['tailscale-user-login'] !== undefined || request.headers['x-forwarded-for'] !== undefined) return this.refuse(socket, 403);
    if (request.headers.upgrade?.toLowerCase() !== 'trace-input') return this.refuse(socket, 400);
    if (!local || !/^[A-Za-z0-9_-]{43}$/.test(token) || !same(token, local)) return this.refuse(socket, 401);
    if (this.clients.size >= MAX_CLIENTS) return this.refuse(socket, 503);
    const helper = this.spawnHelper(); const held = new Map<string, string>(); let open = true; let pending = '';
    const write = (line: string) => { if (open) helper.stdin.write(line + '\n'); };
    // Whatever the service left pressed when it went (it releases its own on a clean close) is released here.
    const done = () => { if (!open) return; for (const release of held.values()) write(release); held.clear(); open = false; helper.stdin.end(); this.clients.delete(socket); socket.destroy(); };
    helper.on('error', () => { open = false; this.clients.delete(socket); socket.destroy(); }); helper.on('exit', () => { open = false; this.clients.delete(socket); socket.destroy(); });
    helper.stdout.resume(); helper.stderr.resume(); helper.stdin.on('error', () => {});
    this.clients.add(socket); socket.on('close', done); socket.on('end', done);
    const take = (data: Buffer) => {
      pending += data.toString('latin1'); const lines = pending.split('\n'); pending = lines.pop() ?? '';
      if (pending.length > MAX_LINE) { done(); return; }
      for (const line of lines) { if (!COMMAND.test(line)) continue; trackHeld(held, line); write(line); }
    };
    socket.on('data', take);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: trace-input\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) take(head);
  }
}
