import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { RunReference, RunningSession, SessionEvent } from '../../../shared/ipc';
import type { CLIEngine } from '../../../shared/types';
import { PAIRING_PREFIX, REMOTE_PORT, type RemoteChannel, type RemoteDevice, type RemoteStatus, type TailscaleState } from '../../../shared/remote';
import { isPersonInput } from '../../../shared/terminal-input';
import { HubError } from '../cli/engine-adapter';
import { load, save } from '../workbench/local-store';
import { PHONE_FILES } from './phone-page';

/** What the remote needs from the rest of the app: the saved channels, the running CLIs, and a way to type into one. */
export interface RemoteHost {
  sessions(): { id: string; title: string; engine: CLIEngine }[];
  running(): RunningSession[];
  write(reference: RunReference, data: string): void;
}
interface Stream { device: string; response: http.ServerResponse; sessionId: string | null }

const deviceSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(60), tokenHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime(), lastSeen: z.iso.datetime().nullable() }).strict();
type Device = z.infer<typeof deviceSchema>;
const settingsSchema = z.object({ enabled: z.boolean() }).strict();
const pairSchema = z.object({ code: z.string().min(1).max(40), name: z.string().max(200) }).strict();
const inputSchema = z.object({ sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100), data: z.string().min(1).max(4096) }).strict();
/** Unambiguous characters, so a code read off the screen can be typed on a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_MINUTES = 5; const PAIRING_ATTEMPTS = 10; const REPLAY_BYTES = 256 * 1024; const STREAM_BUFFER = 2 * 1024 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The phone remote. It listens only on this computer (127.0.0.1); a phone reaches it through `tailscale serve`, which
 * adds HTTPS and admits only devices on the person's tailnet. On top of that every request needs a device key, given
 * once to a phone that presents a short-lived pairing code shown on this computer. Only key hashes are stored, and a
 * key can be revoked at any time. A phone can read channel output and type into running CLIs; it cannot start, stop
 * or reconfigure anything.
 */
export class RemoteServer {
  private server: http.Server | null = null; private error: string | null = null;
  private streams = new Set<Stream>();
  private replay = new Map<string, { runId: string; text: string }>();
  private attention = new Map<string, { runId: string; message: string }>();
  private pairing: { code: string; expires: number; attempts: number } | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private channelsTimer: ReturnType<typeof setTimeout> | null = null; private sentChannels = '';
  tailscale: TailscaleState = { installed: false, running: false, host: null, serving: false, funnel: false, error: null };
  constructor(private root: string, private host: RemoteHost, readonly port = REMOTE_PORT) {}

  private devices(): Device[] { return load(this.root, 'remote-devices.json', z.array(deviceSchema).max(20), []); }
  private settings() { return load(this.root, 'remote.json', settingsSchema, { enabled: false }); }
  get enabled() { return this.settings().enabled; }

  async setEnabled(enabled: boolean) { save(this.root, 'remote.json', { enabled }); if (enabled) await this.start(); else await this.stop(); }
  async start() {
    if (this.server || !this.enabled) return;
    const server = http.createServer((request, response) => { void this.handle(request, response).catch(() => { if (!response.headersSent) this.send(response, 500, { error: 'The remote request failed.' }); else response.destroy(); }); });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      this.server = server; this.error = null;
      this.heartbeat = setInterval(() => { for (const stream of this.streams) this.write(stream, ': ping\n\n'); }, 25000);
    } catch (error) {
      this.error = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${this.port} on this computer is in use by another program.` : 'The phone remote could not start.';
    }
  }
  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; if (this.channelsTimer) clearTimeout(this.channelsTimer); this.channelsTimer = null;
    for (const stream of this.streams) stream.response.end(); this.streams.clear();
    const server = this.server; this.server = null; this.pairing = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  get address() { return this.server ? (this.server.address() as AddressInfo).port : null; }

  /** Starts pairing: a code good for five minutes and ten tries, shown on this computer as a QR link. */
  pair() {
    if (!this.server) throw new HubError('REMOTE_OFF', 'Turn on phone access first.');
    if (this.devices().length >= 20) throw new HubError('REMOTE_LIMIT', 'Up to 20 phones can be paired. Remove one first.');
    const bytes = randomBytes(10); const code = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
    this.pairing = { code, expires: Date.now() + PAIRING_MINUTES * 60000, attempts: 0 };
    return this.status();
  }
  cancelPairing() { this.pairing = null; return this.status(); }
  revoke(id: string) {
    const devices = this.devices(); if (!devices.some((device) => device.id === id)) throw new HubError('REMOTE_DEVICE', 'That phone is no longer paired.');
    save(this.root, 'remote-devices.json', devices.filter((device) => device.id !== id));
    for (const stream of this.streams) if (stream.device === id) { stream.response.end(); this.streams.delete(stream); }
    return this.status();
  }
  status(): RemoteStatus {
    const base = this.tailscale.serving && this.tailscale.host ? `https://${this.tailscale.host}/` : null;
    const pairing = this.pairing && this.pairing.expires > Date.now() ? { code: this.pairing.code, url: (base ?? `http://127.0.0.1:${this.port}/`) + PAIRING_PREFIX + this.pairing.code, expiresAt: new Date(this.pairing.expires).toISOString() } : null;
    return { enabled: this.enabled, listening: Boolean(this.server), port: this.port, url: base, error: this.error, tailscale: this.tailscale, pairing,
      devices: this.devices().map(({ id, name, createdAt, lastSeen }): RemoteDevice => ({ id, name, createdAt, lastSeen })) };
  }

  /** Every session event passes through here: output is kept for replay and sent to phones watching that channel. */
  onSessionEvent(event: SessionEvent) {
    if (event.type === 'started') { this.replay.set(event.sessionId, { runId: event.runId, text: '' }); this.attention.delete(event.sessionId); this.broadcastChannels(); return; }
    if (event.type === 'data') {
      const held = this.replay.get(event.sessionId); if (held?.runId === event.runId) { held.text = (held.text + event.data).slice(-REPLAY_BYTES); }
      const payload = `event: output\ndata: ${JSON.stringify({ sessionId: event.sessionId, runId: event.runId, data: event.data })}\n\n`;
      for (const stream of this.streams) if (stream.sessionId === event.sessionId) this.write(stream, payload);
      return;
    }
    if (event.type === 'attention') { this.attention.set(event.sessionId, { runId: event.runId, message: event.message }); this.broadcastChannels(); return; }
    if (event.type === 'answered' || event.type === 'exit') { this.attention.delete(event.sessionId); this.broadcastChannels(); }
  }
  /**
   * The saved workspace changed (channels added, removed, renamed or reordered). Saves come often, so phones are told
   * shortly after, and only when the channel list they see is different.
   */
  channelsChanged() {
    if (this.channelsTimer || !this.streams.size) return;
    this.channelsTimer = setTimeout(() => { this.channelsTimer = null; if (JSON.stringify(this.channels()) !== this.sentChannels) this.broadcastChannels(); }, 250);
  }
  /** The person typed on the desktop: a waiting prompt is answered there. */
  personInput(sessionId: string, data: string) { if (isPersonInput(data) && this.attention.delete(sessionId)) this.broadcastChannels(); }

  channels(): RemoteChannel[] {
    const running = new Map(this.host.running().map((run) => [run.sessionId, run]));
    return this.host.sessions().map((session, index) => {
      const run = running.get(session.id); const waiting = this.attention.get(session.id);
      return { sessionId: session.id, channel: index + 1, title: session.title, engine: session.engine, runId: run?.runId ?? null, running: Boolean(run), attention: run && waiting?.runId === run.runId ? waiting.message : null };
    });
  }
  private broadcastChannels() { if (!this.streams.size) return; this.sentChannels = JSON.stringify(this.channels()); const payload = `event: channels\ndata: ${this.sentChannels}\n\n`; for (const stream of this.streams) this.write(stream, payload); }
  private write(stream: Stream, text: string) {
    // A phone that stops reading (asleep, out of signal) is dropped; it reconnects and gets the replay.
    if (stream.response.writableLength > STREAM_BUFFER) { stream.response.destroy(); this.streams.delete(stream); return; }
    stream.response.write(text);
  }

  private send(response: http.ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(JSON.stringify(body));
  }
  private async body(request: http.IncomingMessage) {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 16384) throw new HubError('REMOTE_BODY', 'Request too large.'); chunks.push(chunk as Buffer); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  }
  private device(request: http.IncomingMessage): Device | null {
    const header = request.headers.authorization; if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = hash(token); const devices = this.devices(); const device = devices.find((item) => same(item.tokenHash, tokenHash)) ?? null;
    if (device && (!device.lastSeen || Date.now() - Date.parse(device.lastSeen) > 300000)) { device.lastSeen = new Date().toISOString(); save(this.root, 'remote-devices.json', devices); }
    return device;
  }
  /**
   * Requests must name this computer (loopback or its tailnet name). That stops a web page in a desktop browser from
   * reaching the remote through a DNS name it points at 127.0.0.1.
   */
  private allowedHost(value: string | undefined) {
    const host = (value ?? '').toLowerCase().replace(/:\d+$/, '');
    if (host === '127.0.0.1' || host === 'localhost') return true;
    return Boolean(this.tailscale.host) && host === this.tailscale.host!.toLowerCase();
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!this.allowedHost(request.headers.host)) return this.send(response, 421, { error: 'Unknown host.' });
    // Tailscale Funnel would put the remote on the public internet; refuse rather than rely on the device key alone.
    if (request.headers['tailscale-funnel-request'] !== undefined) return this.send(response, 403, { error: 'The phone remote is not available through Tailscale Funnel.' });
    const origin = request.headers.origin; if (origin && !this.allowedHost(URL.canParse(origin) ? new URL(origin).host : '')) return this.send(response, 403, { error: 'Cross-site request refused.' });
    const url = new URL(request.url ?? '/', 'http://remote');
    if (request.method === 'GET' && url.pathname in PHONE_FILES) {
      const file = PHONE_FILES[url.pathname];
      response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      return void response.end(file.body);
    }
    if (request.method === 'POST' && url.pathname === '/api/pair') {
      const parsed = pairSchema.safeParse(await this.body(request)); const pairing = this.pairing;
      if (!parsed.success || !pairing || pairing.expires < Date.now()) return this.send(response, 401, { error: 'This pairing code has expired. Start pairing again on the computer.' });
      if (++pairing.attempts > PAIRING_ATTEMPTS) { this.pairing = null; return this.send(response, 401, { error: 'Too many tries. Start pairing again on the computer.' }); }
      if (!same(hash(parsed.data.code.toUpperCase()), hash(pairing.code))) return this.send(response, 401, { error: 'That pairing code is not right.' });
      this.pairing = null;
      const token = randomBytes(32).toString('base64url'); const name = parsed.data.name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60) || 'Phone';
      const device: Device = { id: randomUUID(), name, tokenHash: hash(token), createdAt: new Date().toISOString(), lastSeen: null };
      save(this.root, 'remote-devices.json', [...this.devices(), device]);
      return this.send(response, 200, { token, device: { id: device.id, name: device.name } });
    }
    if (!url.pathname.startsWith('/api/')) return this.send(response, 404, { error: 'Not found.' });
    const device = this.device(request); if (!device) return this.send(response, 401, { error: 'This phone is not paired. Pair it again from Settings on the computer.' });
    if (request.method === 'GET' && url.pathname === '/api/channels') return this.send(response, 200, this.channels());
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      const sessionId = url.searchParams.get('sessionId');
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      const stream: Stream = { device: device.id, response, sessionId }; this.streams.add(stream);
      request.on('close', () => this.streams.delete(stream));
      this.write(stream, `event: channels\ndata: ${JSON.stringify(this.channels())}\n\n`);
      const held = sessionId ? this.replay.get(sessionId) : undefined;
      if (held) this.write(stream, `event: replay\ndata: ${JSON.stringify({ sessionId, runId: held.runId, data: held.text })}\n\n`);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/input') {
      const parsed = inputSchema.safeParse(await this.body(request)); if (!parsed.success) return this.send(response, 400, { error: 'Invalid input.' });
      // The phone may have been removed while its request body was arriving.
      if (!this.devices().some((item) => item.id === device.id)) return this.send(response, 401, { error: 'This phone is not paired. Pair it again from Settings on the computer.' });
      try { this.host.write({ sessionId: parsed.data.sessionId, runId: parsed.data.runId }, parsed.data.data); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'Input could not be delivered.' }); }
      if (isPersonInput(parsed.data.data) && this.attention.delete(parsed.data.sessionId)) this.broadcastChannels();
      return this.send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/unpair') { this.revoke(device.id); return this.send(response, 200, { ok: true }); }
    return this.send(response, 404, { error: 'Not found.' });
  }
}
