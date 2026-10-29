import type { ScreenCredentials, ScreenEvent, ScreenKind, ScreenRequest } from '../../shared/screen';

export async function screen<T = null>(request: ScreenRequest): Promise<T> {
  if (!window.codingHub) throw new Error('This feature requires the desktop app.');
  const result = await window.codingHub.screen(request); if (!result.ok) throw new Error(result.error.message);
  return result.value as T;
}
export const savedCredentials = (id: string) => screen<ScreenCredentials | null>({ action: 'screen-credentials', id });

const channels = new Map<string, ScreenChannel>();
/** The host whose events are routed here (one per page; tests swap it). */
let listening: unknown = null;
function route(event: ScreenEvent) {
  const channel = channels.get(event.streamId); if (!channel) return;
  if (event.type === 'data') channel.receive(event.data); else channel.ended(event.error);
}

/**
 * A linked computer's screen-sharing connection, carried by the host, in the shape noVNC drives a WebSocket through
 * (its "raw channel": send, close, readyState, binaryType, protocol and the on* handlers).
 */
export class ScreenChannel {
  binaryType = 'arraybuffer'; protocol = '';
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  onopen: ((event: Event) => void) | null = null; onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null; onerror: ((event: Event) => void) | null = null;
  /** Why the connection ended, when the window did not close it. */
  error: string | null = null;
  /** Which screen server answered, once open: Trace's (Windows) or the system's (macOS Screen Sharing). */
  kind: ScreenKind | null = null;
  private readonly streamId = crypto.randomUUID();
  /** The server speaks first, as soon as the host connects, which can be before the host's answer to open arrives. */
  private early: Uint8Array[] = [];

  constructor(computerId: string) {
    if (window.codingHub && listening !== window.codingHub) { window.codingHub.onScreenEvent(route); listening = window.codingHub; }
    channels.set(this.streamId, this);
    screen<{ kind: ScreenKind }>({ action: 'screen-open', id: computerId, streamId: this.streamId }).then((opened) => {
      if (this.readyState === 'closing') { void screen({ action: 'screen-close', streamId: this.streamId }).catch(() => {}); return; }
      if (this.readyState !== 'connecting') return;
      this.kind = opened?.kind ?? null; this.readyState = 'open'; this.onopen?.(new Event('open'));
      for (const data of this.early) this.deliver(data); this.early = [];
    }, (error: Error) => this.ended(error.message));
  }

  send(data: ArrayBuffer | Uint8Array) {
    if (this.readyState !== 'open') return;
    // noVNC reuses its send buffer once this returns, so the bytes are copied now. Requests reach the host in order.
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
    void screen({ action: 'screen-send', streamId: this.streamId, data: bytes }).catch(() => {});
  }

  close() {
    if (this.readyState === 'closing' || this.readyState === 'closed') return;
    const opened = this.readyState === 'open'; this.readyState = 'closing';
    if (opened) void screen({ action: 'screen-close', streamId: this.streamId }).catch(() => this.ended());
  }

  receive(data: Uint8Array) {
    if (this.readyState === 'connecting') this.early.push(data); else if (this.readyState === 'open') this.deliver(data);
  }

  ended(error?: string) {
    if (this.readyState === 'closed') return;
    channels.delete(this.streamId); this.early = []; this.error = error ?? null; this.readyState = 'closed';
    if (error) this.onerror?.(new Event('error'));
    this.onclose?.(new CloseEvent('close', { code: error ? 1006 : 1000, reason: error ?? '', wasClean: !error }));
  }

  private deliver(data: Uint8Array) {
    const buffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.onmessage?.(new MessageEvent('message', { data: buffer }));
  }
}
