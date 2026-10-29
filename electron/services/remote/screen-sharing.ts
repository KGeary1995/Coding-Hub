import net from 'node:net';
import { z } from 'zod';
import { HubError } from '../cli/engine-adapter';
import { load, save } from '../workbench/local-store';
import { SCREEN_PORT, type ScreenCredentials, type ScreenEvent } from '../../../shared/screen';

const FILE = 'screen-sharing.json';
const MAX_STREAMS = 4;
const CONNECT_TIMEOUT = 10000;
/** Passwords are stored only as the OS encrypts them (DPAPI on Windows, the Keychain on a Mac): `password` is that ciphertext. */
const savedSchema = z.record(z.uuid(), z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(16384) }).strict());
/** Electron's safeStorage, behind an interface so tests need no Electron. */
export interface SecretCipher { available(): boolean; encrypt(text: string): string; decrypt(value: string): string }
export interface ScreenTarget { host: string; name: string }
interface Stream { socket: net.Socket; owner: number; name: string; closing: boolean }

/** A linked computer's Tailscale name, the only place a screen connection may go (never a name the window supplies). */
export function screenHost(url: string | null): string | null {
  if (!url || !URL.canParse(url)) return null;
  const host = new URL(url).hostname.toLowerCase();
  return host.endsWith('.ts.net') ? host : null;
}

function connectError(name: string, code: string | undefined): string {
  if (code === 'ECONNREFUSED') return `Screen sharing is off on ${name}. On a Mac, turn on System Settings → General → Sharing → Screen Sharing. (Windows has no screen-sharing server Trace can use.)`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${name}'s Tailscale name could not be found. Check that Tailscale is connected on this computer.`;
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${name} is not reachable. Check that it is on and connected to Tailscale.`;
  return `Could not reach ${name}'s screen${code ? ` (${code})` : ''}.`;
}

/**
 * Carries a linked computer's screen-sharing connection (VNC) for the window, which runs the viewer (noVNC): the
 * window cannot open network connections itself, and may reach only linked computers' screens.
 */
export class ScreenSharing {
  private streams = new Map<string, Stream>();
  constructor(private root: string, private target: (id: string) => ScreenTarget | null, private emit: (owner: number, event: ScreenEvent) => void, private cipher: SecretCipher, private port = SCREEN_PORT) {}

  async open(owner: number, id: string, streamId: string): Promise<null> {
    const target = this.target(id);
    if (!target) throw new HubError('SCREEN_UNKNOWN', 'That computer is not linked, or has no Tailscale address. Open Settings → Other computers.');
    if (this.streams.has(streamId)) throw new HubError('SCREEN_STREAM', 'That screen connection is already open.');
    if (this.streams.size >= MAX_STREAMS) throw new HubError('SCREEN_LIMIT', 'Close another screen before opening this one.');
    const socket = net.connect({ host: target.host, port: this.port }); socket.setNoDelay(true);
    const stream: Stream = { socket, owner, name: target.name, closing: false }; this.streams.set(streamId, stream);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), CONNECT_TIMEOUT);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
    } catch (error) {
      this.streams.delete(streamId); socket.destroy();
      throw new HubError('SCREEN_CONNECT', connectError(target.name, (error as NodeJS.ErrnoException).code));
    }
    socket.on('data', (data) => this.emit(owner, { type: 'data', streamId, data: new Uint8Array(data) }));
    socket.on('error', () => { /* Reported by close. */ });
    socket.on('close', (hadError) => {
      if (this.streams.get(streamId) !== stream) return; this.streams.delete(streamId);
      this.emit(owner, stream.closing ? { type: 'closed', streamId } : { type: 'closed', streamId, error: hadError ? `The connection to ${target.name}'s screen was lost.` : `${target.name} ended screen sharing.` });
    });
    return null;
  }

  send(owner: number, streamId: string, data: Uint8Array) {
    const stream = this.owned(owner, streamId); if (!stream.socket.destroyed) stream.socket.write(data);
    return null;
  }

  close(owner: number, streamId: string) {
    const stream = this.streams.get(streamId); if (!stream || stream.owner !== owner) return null;
    stream.closing = true; stream.socket.destroy();
    return null;
  }

  /** On quit, or when the window that opened them reloads. */
  closeAll(owner?: number) { for (const stream of [...this.streams.values()]) if (owner === undefined || stream.owner === owner) { stream.closing = true; stream.socket.destroy(); } }

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
