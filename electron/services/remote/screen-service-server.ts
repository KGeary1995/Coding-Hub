import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { load } from '../workbench/local-store';
import { RfbSession, type ScreenInput, type ScreenSource } from './rfb-server';

/** The screen service's switch, written by Trace's settings and read by the service, which quits when it turns off. */
export const SHARE_FILE = 'screen-share.json';
const shareSchema = z.object({ enabled: z.boolean() }).strict();
/** Only what the service needs from Trace's paired devices; the remote owns that file and its full shape. */
const devicesSchema = z.array(z.object({ name: z.string(), tokenHash: z.string(), kind: z.enum(['phone', 'computer']).optional() }).passthrough()).max(20);
export function shareEnabled(root: string) { try { return load(root, SHARE_FILE, shareSchema, { enabled: false }).enabled; } catch { return false; } }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface ScreenCaptureSession { source: ScreenSource; input: ScreenInput & { close(): void }; stop(): void }
/** What the service needs from Electron: the capture and the input for one viewer, the clipboard, and a way to show who watches. */
export interface ScreenServiceHost {
  open(): Promise<ScreenCaptureSession>;
  readClipboard?(): Promise<string>;
  /** Someone started (a name, with a way to disconnect them) or stopped (null) watching. */
  viewing(name: string | null, disconnect: () => void): void;
}

/**
 * The Windows screen service's server: it listens on this computer only, and `tailscale serve` passes it
 * https://<name>.ts.net/api/screen (without the path). A linked computer upgrades that request to a VNC stream, signed
 * in with the key it was linked with (the remote's own paired computers, read fresh each time, so removing one there
 * locks it out here too). Phones' keys are refused. One viewer at a time: a new one replaces the last.
 */
export class ScreenService {
  private server: http.Server | null = null;
  private viewer: { name: string; socket: Duplex; session: RfbSession | null; capture: ScreenCaptureSession | null } | null = null;
  constructor(private root: string, private name: () => string, private host: ScreenServiceHost) {}

  async listen(port: number) {
    const server = http.createServer((request, response) => {
      const ok = request.method === 'GET' && (request.url === '/health' || request.url?.endsWith('/health'));
      response.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(ok ? { ok: true } : { error: 'Not found.' }));
    });
    server.on('upgrade', (request, socket, head) => void this.upgrade(request, socket, head).catch(() => socket.destroy()));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    this.server = server; return (server.address() as AddressInfo).port;
  }
  async close() { this.disconnect(); const server = this.server; this.server = null; if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
  get watching() { return this.viewer?.name ?? null; }

  disconnect() {
    const viewer = this.viewer; if (!viewer) return; this.viewer = null;
    viewer.session?.close(); viewer.socket.destroy(); viewer.capture?.input.close(); viewer.capture?.stop();
    this.host.viewing(null, () => {});
  }

  private refuse(socket: Duplex, status: number, error: string) {
    const body = JSON.stringify({ error });
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private async upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => {});
    // Tailscale Funnel would put this on the public internet; refuse rather than rely on the key alone.
    if (request.headers['tailscale-funnel-request'] !== undefined) return this.refuse(socket, 403, 'Screen sharing is not available through Tailscale Funnel.');
    if (request.headers.upgrade?.toLowerCase() !== 'trace-screen') return this.refuse(socket, 400, 'Not a screen connection.');
    const header = request.headers.authorization; const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    let devices: z.infer<typeof devicesSchema> = []; try { devices = load(this.root, 'remote-devices.json', devicesSchema, []); } catch { /* Unreadable: nobody is let in. */ }
    const device = /^[A-Za-z0-9_-]{43}$/.test(token) ? devices.find((item) => same(item.tokenHash, hash(token))) : undefined;
    if (!device) return this.refuse(socket, 401, `${this.name()} no longer accepts this computer. Link it again in Settings → Other computers.`);
    if (device.kind !== 'computer') return this.refuse(socket, 403, 'Only linked computers can see this screen; phones cannot.');
    if (!shareEnabled(this.root)) return this.refuse(socket, 403, `Screen sharing is off on ${this.name()}. There, in Trace, turn on Settings → Other computers → Share this screen.`);
    this.disconnect();
    const viewer: NonNullable<ScreenService['viewer']> = { name: device.name, socket, session: null, capture: null }; this.viewer = viewer;
    const left = () => { if (this.viewer === viewer) this.disconnect(); }; socket.on('close', left); socket.on('end', left);
    try { viewer.capture = await this.host.open(); }
    catch (error) {
      if (this.viewer === viewer) this.viewer = null;
      return this.refuse(socket, 503, `${this.name()} could not capture its screen: ${(error as Error).message}`);
    }
    if (this.viewer !== viewer || socket.destroyed) { viewer.capture.input.close(); viewer.capture.stop(); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: trace-screen\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) socket.unshift(head);
    viewer.session = new RfbSession(socket, viewer.capture.source, viewer.capture.input, this.name(), () => { if (this.viewer === viewer) this.disconnect(); }, this.host.readClipboard);
    this.host.viewing(device.name, () => { if (this.viewer === viewer) this.disconnect(); });
  }
}
