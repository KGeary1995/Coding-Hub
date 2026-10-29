import net from 'node:net';
import tls from 'node:tls';
import { z } from 'zod';
import { HubError } from '../cli/engine-adapter';
import { load, save } from '../workbench/local-store';
import { SCREEN_SERVICE_PATH, type ScreenCredentials, type ScreenEvent, type ScreenKind } from '../../../shared/screen';

const FILE = 'screen-sharing.json';
const MAX_STREAMS = 4;
const CONNECT_TIMEOUT = 10000;
/** Passwords are stored only as the OS encrypts them (DPAPI on Windows, the Keychain on a Mac): `password` is that ciphertext. */
const savedSchema = z.record(z.uuid(), z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(16384) }).strict());
/** Electron's safeStorage, behind an interface so tests need no Electron. */
export interface SecretCipher { available(): boolean; encrypt(text: string): string; decrypt(value: string): string }
/**
 * Where a linked computer's screen is: its Trace screen service (Windows), reached at its remote's address with the
 * link key, and its system's screen-sharing server (macOS Screen Sharing) on its Tailscale name. Either may be absent.
 */
export interface ScreenTarget { name: string; trace: { url: string; token: string } | null; system: { host: string; port: number } | null }
/** `ready` once its listeners are attached; until then a close ends it here. */
interface Stream { socket: net.Socket; owner: number; name: string; closing: boolean; ready: boolean }
/** The other computer's screen service answered but refused: say why, rather than try its system's. */
class Refused extends Error {}

/** A linked computer's Tailscale name, the only place a system screen connection may go (never a name the window supplies). */
export function screenHost(url: string | null): string | null {
  if (!url || !URL.canParse(url)) return null;
  const host = new URL(url).hostname.toLowerCase();
  return host.endsWith('.ts.net') ? host : null;
}

function connectError(name: string, code: string | undefined): string {
  if (code === 'ECONNREFUSED') return `Screen sharing is off on ${name}. On a Mac, turn on System Settings → General → Sharing → Screen Sharing. On Windows, in Trace there, turn on Settings → Other computers → Share this screen.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${name}'s Tailscale name could not be found. Check that Tailscale is connected on this computer.`;
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${name} is not reachable. Check that it is on and connected to Tailscale.`;
  return `Could not reach ${name}'s screen${code ? ` (${code})` : ''}.`;
}

function connected(socket: net.Socket, event: 'connect' | 'secureConnect') {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), CONNECT_TIMEOUT);
    socket.once(event, () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('close', () => { clearTimeout(timer); reject(Object.assign(new Error('closed'), { code: 'CLOSED' })); });
  });
}

/**
 * Opens the Trace screen service on that computer: an HTTP request upgraded to the VNC stream, with the link key. It
 * resolves with the socket and any VNC bytes that came with the answer. Refused (401, 403, 503) means the service is
 * there and said no; anything else (Trace there is older, or the computer is a Mac) means there is no such service.
 */
export async function openTraceScreen(name: string, url: string, token: string): Promise<{ socket: net.Socket; head: Buffer }> {
  const address = new URL(url); const secure = address.protocol === 'https:';
  const socket = secure ? tls.connect({ host: address.hostname, port: Number(address.port) || 443, servername: address.hostname }) : net.connect({ host: address.hostname, port: Number(address.port) || 80 });
  socket.on('error', () => { /* Reported below. */ });
  try {
    await connected(socket, secure ? 'secureConnect' : 'connect');
    socket.write(`GET ${SCREEN_SERVICE_PATH} HTTP/1.1\r\nHost: ${address.host}\r\nAuthorization: Bearer ${token}\r\nConnection: Upgrade\r\nUpgrade: trace-screen\r\n\r\n`);
    const answer = await new Promise<Buffer>((resolve, reject) => {
      let received = Buffer.alloc(0); let done = false;
      const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); socket.off('data', data); socket.off('close', end); if (error) reject(error); else resolve(received); };
      const timer = setTimeout(() => finish(new Error('timeout')), CONNECT_TIMEOUT);
      const data = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]); const split = received.indexOf('\r\n\r\n'); if (split < 0) return;
        // A refusal carries its reason as JSON: wait for all of it (Content-Length) before reading it.
        const head = received.toString('latin1', 0, split); const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
        const length = Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? 0);
        if (status === 101 || received.length >= split + 4 + length) finish();
      };
      const end = () => finish();
      socket.on('data', data); socket.once('close', end);
    });
    const split = answer.indexOf('\r\n\r\n'); const status = split < 0 ? 0 : Number(/^HTTP\/1\.1 (\d{3})/.exec(answer.toString('latin1', 0, split))?.[1]);
    if (status === 101) return { socket, head: answer.subarray(split + 4) };
    if (status === 401 || status === 403 || status === 503) {
      let message = `${name} refused to share its screen.`;
      try { message = (JSON.parse(answer.subarray(split + 4).toString('utf8')) as { error?: string }).error || message; } catch { /* Not JSON. */ }
      throw new Refused(message);
    }
    throw new Error(`No screen service (${status || 'no answer'}).`);
  } catch (error) { socket.destroy(); throw error; }
}

/**
 * Carries a linked computer's screen-sharing connection (VNC) for the window, which runs the viewer (noVNC): the
 * window cannot open network connections itself, and may reach only linked computers' screens.
 */
export class ScreenSharing {
  private streams = new Map<string, Stream>();
  constructor(private root: string, private target: (id: string) => ScreenTarget | null, private emit: (owner: number, event: ScreenEvent) => void, private cipher: SecretCipher) {}

  async open(owner: number, id: string, streamId: string): Promise<{ kind: ScreenKind }> {
    const target = this.target(id);
    if (!target || (!target.trace && !target.system)) throw new HubError('SCREEN_UNKNOWN', 'That computer is not linked, or has no Tailscale address. Open Settings → Other computers.');
    if (this.streams.has(streamId)) throw new HubError('SCREEN_STREAM', 'That screen connection is already open.');
    if (this.streams.size >= MAX_STREAMS) throw new HubError('SCREEN_LIMIT', 'Close another screen before opening this one.');
    const stream: Stream = { socket: new net.Socket(), owner, name: target.name, closing: false, ready: false }; this.streams.set(streamId, stream);
    let kind: ScreenKind = 'trace'; let head: Buffer = Buffer.alloc(0);
    try {
      // Trace's own screen service first (Windows). Where there is none (a Mac), its own Screen Sharing.
      let opened: { socket: net.Socket; head: Buffer } | null = null;
      if (target.trace) try { opened = await openTraceScreen(target.name, target.trace.url, target.trace.token); } catch (error) { if (error instanceof Refused || !target.system) throw error; }
      if (opened) { stream.socket = opened.socket; head = opened.head; }
      else { kind = 'system'; stream.socket = net.connect({ host: target.system!.host, port: target.system!.port }); await connected(stream.socket, 'connect'); }
      if (this.streams.get(streamId) !== stream) throw new HubError('SCREEN_CLOSED', 'That screen connection has closed.');
    } catch (error) {
      if (this.streams.get(streamId) === stream) this.streams.delete(streamId); stream.socket.destroy();
      if (error instanceof HubError) throw error;
      throw new HubError('SCREEN_CONNECT', error instanceof Refused ? error.message : connectError(target.name, (error as NodeJS.ErrnoException).code));
    }
    const socket = stream.socket; socket.setNoDelay(true);
    if (head.length) this.emit(owner, { type: 'data', streamId, data: new Uint8Array(head) });
    socket.on('data', (data: Buffer) => this.emit(owner, { type: 'data', streamId, data: new Uint8Array(data) }));
    socket.on('error', () => { /* Reported by close. */ });
    socket.on('close', (hadError) => {
      if (this.streams.get(streamId) !== stream) return; this.streams.delete(streamId);
      this.emit(owner, stream.closing ? { type: 'closed', streamId } : { type: 'closed', streamId, error: hadError ? `The connection to ${target.name}'s screen was lost.` : `${target.name} ended screen sharing.` });
    });
    stream.ready = true;
    return { kind };
  }

  send(owner: number, streamId: string, data: Uint8Array) {
    const stream = this.owned(owner, streamId); if (stream.ready && !stream.socket.destroyed) stream.socket.write(data);
    return null;
  }

  close(owner: number, streamId: string) {
    const stream = this.streams.get(streamId); if (!stream || stream.owner !== owner) return null;
    stream.closing = true; stream.socket.destroy();
    if (!stream.ready) { this.streams.delete(streamId); this.emit(owner, { type: 'closed', streamId }); }
    return null;
  }

  /** On quit, or when the window that opened them reloads. */
  closeAll(owner?: number) { for (const [streamId, stream] of [...this.streams]) if (owner === undefined || stream.owner === owner) { stream.closing = true; stream.socket.destroy(); this.streams.delete(streamId); } }

  credentials(id: string): ScreenCredentials | null {
    const saved = this.saved()[id]; if (!saved || !this.cipher.available()) return null;
    try { return { username: saved.username, password: this.cipher.decrypt(saved.password) }; } catch { return null; }
  }

  saveCredentials(id: string, credentials: ScreenCredentials) {
    if (!this.target(id)) throw new HubError('SCREEN_UNKNOWN', 'That computer is not linked.');
    if (!this.cipher.available()) throw new HubError('SCREEN_KEYCHAIN', 'This computer cannot encrypt saved passwords, so Trace will ask each time.');
    save(this.root, FILE, { ...this.saved(), [id]: { username: credentials.username, password: this.cipher.encrypt(credentials.password) } });
    return null;
  }

  forgetCredentials(id: string) {
    const { [id]: _gone, ...rest } = this.saved(); save(this.root, FILE, rest);
    return null;
  }

  private saved() { return load(this.root, FILE, savedSchema, {}); }
  private owned(owner: number, streamId: string): Stream {
    const stream = this.streams.get(streamId);
    if (!stream || stream.owner !== owner) throw new HubError('SCREEN_CLOSED', 'That screen connection has closed.');
    return stream;
  }
}
