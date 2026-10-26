import { z } from 'zod';
import type { ChannelControl, LinkedComputer, LinkedComputerEvent, RemoteChannel } from '../../../shared/remote';
import { HubError } from '../cli/engine-adapter';
import { load, save } from '../workbench/local-store';
import type { RemoteRelay } from './remote-server';
import { ScreenMirror } from './screen-mirror';

/** A computer found through the Drive sync folder: its sync identity, and its remote's address when it has one. */
export interface AdvertisedComputer { id: string; name: string; url: string | null }
/** Where output from linked computers goes besides the desktop window: this computer's phones. */
export interface RelaySink { output(sessionId: string, runId: string, data: string): void; resize(sessionId: string, runId: string, cols: number, rows: number): void; changed(): void }

const FILE = 'linked-computers.json';
const linkSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(100), url: z.string().max(500), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), linkedAt: z.iso.datetime() }).strict();
type Link = z.infer<typeof linkSchema>;
const channelSchema = z.object({ sessionId: z.string().max(100), channel: z.number().int(), title: z.string().max(200), engine: z.enum(['claude', 'codex', 'shell']), runId: z.string().max(100).nullable(), running: z.boolean(), attention: z.string().max(2000).nullable(), cols: z.number().int().nullable(), rows: z.number().int().nullable(), topic: z.string().max(200).optional() });
const RETRY_MAX = 30000;

/**
 * Only the other computer's remote on the tailnet (HTTPS on a *.ts.net name), or this computer's own loopback for
 * tests. An address read from Drive therefore cannot send a pairing code or key anywhere else.
 */
export function linkableAddress(value: string | null): string | null {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value); const host = url.hostname.toLowerCase();
  const ok = url.protocol === 'https:' && host.endsWith('.ts.net') || url.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost');
  return ok && !url.username && !url.password ? `${url.protocol}//${url.host}/` : null;
}

interface Connection {
  link: Link; controller: AbortController | null; stopped: boolean; connected: boolean; error: string | null;
  channels: RemoteChannel[]; mirrors: Map<string, ScreenMirror>; wake?: () => void;
}

/**
 * Trace on this computer following Trace on the person's other computers: one event stream per linked computer
 * (every channel's output), a copy of each channel's screen, and typing, starting and stopping passed back. The key a
 * computer gives when it is linked stays in this computer's data folder; Drive only carries the addresses.
 */
export class LinkedComputers implements RemoteRelay {
  private connections = new Map<string, Connection>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private root: string,
    private self: () => { id: string; name: string },
    private advertised: () => AdvertisedComputer[],
    private emit: (event: LinkedComputerEvent) => void,
    private sink: RelaySink,
    private fetcher: typeof fetch = fetch,
  ) {}

  private links(): Link[] { return load(this.root, FILE, z.array(linkSchema).max(20), []); }
  start() { for (const link of this.links()) this.connect(link); }
  stop() { for (const connection of this.connections.values()) this.disconnect(connection); this.connections.clear(); }

  status(): LinkedComputer[] {
    const self = this.self().id; const links = new Map(this.links().map((link) => [link.id, link]));
    const found = new Map(this.advertised().filter((item) => item.id !== self).map((item) => [item.id, item]));
    return [...new Set([...found.keys(), ...links.keys()])].map((id): LinkedComputer => {
      const link = links.get(id); const advertised = found.get(id); const connection = this.connections.get(id);
      return { id, name: advertised?.name ?? link!.name, url: linkableAddress(advertised?.url ?? null) ?? link?.url ?? null, linked: Boolean(link), connected: Boolean(connection?.connected), error: connection?.error ?? null, channels: connection?.connected ? this.tagged(connection) : [] };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Links to a computer found in Drive with the code it shows under Settings → Other computers. */
  async link(id: string, code: string): Promise<LinkedComputer[]> {
    const computer = this.status().find((item) => item.id === id);
    if (!computer) throw new HubError('LINK_UNKNOWN', 'That computer is not in the sync folder. Turn on sync between computers on both, then Sync now.');
    const url = linkableAddress(computer.url);
    if (!url) throw new HubError('LINK_ADDRESS', `${computer.name} has no Tailscale HTTPS address yet. On it, turn on Phone access and set up Tailscale HTTPS.`);
    const self = this.self(); let response: Response;
    try { response = await this.fetcher(new URL('api/pair', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.replace(/\s+/g, ''), name: self.name.slice(0, 60), machineId: self.id }), signal: AbortSignal.timeout(15000) }); }
    catch { throw new HubError('LINK_UNREACHABLE', `${computer.name} could not be reached at ${url}. Check that it is on, Trace is open, and Tailscale is connected on both.`); }
    const body = await response.json().catch(() => ({})) as { token?: string; error?: string; device?: { kind?: string }; computer?: { id?: string } };
    if (!response.ok || !body.token) throw new HubError('LINK_REFUSED', body.error ?? `${computer.name} refused the code.`);
    // A phone's code gives a phone's key, which cannot start or stop channels: say so rather than link half-way.
    if (body.device?.kind !== 'computer') {
      // The other computer already made a phone key for it; hand that back so no unused key is left there.
      try { await this.fetcher(new URL('api/unpair', url), { method: 'POST', headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }); } catch { /* It can be removed there. */ }
      throw new HubError('LINK_PHONE_CODE', 'That is a phone pairing code. On the other computer, use Settings → Other computers → Show link code.');
    }
    if (body.computer?.id && body.computer.id !== id) throw new HubError('LINK_MISMATCH', 'That address answered as a different computer. Sync now on both computers and try again.');
    const link: Link = { id, name: computer.name, url, token: body.token, linkedAt: new Date().toISOString() };
    save(this.root, FILE, [...this.links().filter((item) => item.id !== id), link]);
    const existing = this.connections.get(id); if (existing) { this.disconnect(existing); this.connections.delete(id); }
    this.connect(link); this.notify();
    return this.status();
  }

  async unlink(id: string): Promise<LinkedComputer[]> {
    const link = this.links().find((item) => item.id === id); if (!link) return this.status();
    const connection = this.connections.get(id); if (connection) { this.disconnect(connection); this.connections.delete(id); }
    save(this.root, FILE, this.links().filter((item) => item.id !== id));
    // Best effort: the other computer forgets this one's key too. If it is off, remove it there later.
    try { await this.request(link, 'api/unpair', { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) }); } catch { /* Unreachable. */ }
    this.notify(); this.sink.changed();
    return this.status();
  }

  async input(id: string, sessionId: string, runId: string, data: string) { await this.request(this.linked(id), 'api/input', { method: 'POST', body: JSON.stringify({ sessionId, runId, data }) }); }
  async control(id: string, sessionId: string, control: ChannelControl) { await this.request(this.linked(id), 'api/control', { method: 'POST', body: JSON.stringify({ sessionId, control }), signal: AbortSignal.timeout(60000) }); }
  /** A phone key from a linked computer for one of this computer's phones, so the phone can reach it directly. */
  async phoneKey(id: string, name: string, relayKey: string) {
    const link = this.linked(id);
    const body = await (await this.request(link, 'api/phone-key', { method: 'POST', body: JSON.stringify({ name, relayKey }), signal: AbortSignal.timeout(15000) })).json() as { token?: string; url?: string | null };
    const url = linkableAddress(body.url ?? link.url);
    if (!body.token || !url) throw new HubError('LINK_PHONE_KEY', `${link.name} did not give a key.`);
    return { id, name: link.name, url, token: body.token };
  }
  /** A phone of this computer shows a linked computer's channel at its size, or (null) leaves it. */
  async size(sessionId: string, runId: string, size: { cols: number; rows: number } | null) {
    const connection = [...this.connections.values()].find((item) => item.channels.some((channel) => channel.sessionId === sessionId));
    if (!connection) throw new HubError('LINK_CHANNEL', 'That channel’s computer is not connected.');
    await this.request(connection.link, 'api/size', size ? { method: 'POST', body: JSON.stringify({ sessionId, runId, ...size }) } : { method: 'DELETE', body: JSON.stringify({ sessionId }) });
  }
  /** The desktop opened a linked computer's tab: send it every channel's screen as it is now. */
  watch(id: string) {
    const connection = this.connections.get(id); if (!connection) return;
    for (const [sessionId, mirror] of connection.mirrors) mirror.snapshot((screen) => this.emit({ type: 'replay', id, sessionId, runId: mirror.runId, ...screen }));
  }

  // RemoteRelay: this computer's phones see linked computers' channels.
  channels(): RemoteChannel[] { return [...this.connections.values()].filter((connection) => connection.connected).flatMap((connection) => this.tagged(connection)); }
  snapshot(sessionId: string, callback: (screen: { runId: string; cols: number; rows: number; data: string }) => void) {
    for (const connection of this.connections.values()) {
      const mirror = connection.mirrors.get(sessionId); if (mirror) { mirror.snapshot((screen) => callback({ runId: mirror.runId, ...screen })); return true; }
    }
    return false;
  }
  async write(sessionId: string, runId: string, data: string) {
    const connection = [...this.connections.values()].find((item) => item.channels.some((channel) => channel.sessionId === sessionId));
    if (!connection) throw new HubError('LINK_CHANNEL', 'That channel’s computer is not connected.');
    await this.input(connection.link.id, sessionId, runId, data);
  }

  private tagged(connection: Connection) { return connection.channels.map((channel) => ({ ...channel, computer: { id: connection.link.id, name: connection.link.name } })); }
  private linked(id: string) { const link = this.links().find((item) => item.id === id); if (!link) throw new HubError('LINK_UNKNOWN', 'That computer is not linked.'); return link; }
  private async request(link: Link, path: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await this.fetcher(new URL(path, link.url), { ...init, headers: { ...init.headers, Authorization: `Bearer ${link.token}`, 'Content-Type': 'application/json' } }); }
    catch (error) { if ((error as Error).name === 'AbortError') throw error; throw new HubError('LINK_UNREACHABLE', `${link.name} could not be reached.`); }
    if (response.status === 401) throw new HubError('LINK_REVOKED', `${link.name} no longer accepts this computer. Link it again in Settings → Other computers.`);
    if (!response.ok) throw new HubError('LINK_FAILED', (await response.json().catch(() => ({})) as { error?: string }).error ?? `${link.name} did not accept the request.`);
    return response;
  }
  /** Coalesces status updates for the desktop window. */
  private notify() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.emit({ type: 'computers', computers: this.status() }); }, 100);
  }

  private connect(link: Link) {
    const connection: Connection = { link, controller: null, stopped: false, connected: false, error: null, channels: [], mirrors: new Map() };
    this.connections.set(link.id, connection);
    void (async () => {
      let delay = 2000;
      while (!connection.stopped) {
        connection.controller = new AbortController();
        try {
          const response = await this.request(link, 'api/stream?all=1', { signal: connection.controller.signal });
          connection.connected = true; connection.error = null; delay = 2000; this.notify();
          const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end; while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const type = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
              if (type && data) try { this.event(connection, type, JSON.parse(data)); } catch { /* One bad event is skipped. */ }
            }
          }
          if (!connection.stopped) connection.error = `${link.name} closed the connection.`;
        } catch (error) {
          if (connection.stopped) return;
          connection.error = error instanceof HubError ? error.message : `${link.name} could not be reached.`;
          // A removed key will not start working again by itself.
          if (error instanceof HubError && error.code === 'LINK_REVOKED') { this.drop(connection); this.notify(); this.sink.changed(); return; }
        }
        this.drop(connection); this.notify(); this.sink.changed();
        await new Promise<void>((resolve) => { const timer = setTimeout(resolve, delay); connection.wake = () => { clearTimeout(timer); resolve(); }; });
        delay = Math.min(delay * 2, RETRY_MAX);
      }
    })();
  }
  /** Clears what this computer showed of a computer that went away; its channels come back with the connection. */
  private drop(connection: Connection) {
    connection.connected = false; connection.channels = [];
    for (const mirror of connection.mirrors.values()) mirror.dispose(); connection.mirrors.clear();
  }
  private disconnect(connection: Connection) { connection.stopped = true; connection.controller?.abort(); connection.wake?.(); this.drop(connection); }

  private event(connection: Connection, type: string, data: unknown) {
    const id = connection.link.id;
    if (type === 'channels') {
      connection.channels = z.array(channelSchema).max(64).parse(data).map((channel) => ({ ...channel }));
      const current = new Map(connection.channels.map((channel) => [channel.sessionId, channel.runId]));
      for (const [sessionId, mirror] of connection.mirrors) if (current.get(sessionId) !== mirror.runId) { mirror.dispose(); connection.mirrors.delete(sessionId); }
      this.notify(); this.sink.changed(); return;
    }
    const event = data as { sessionId: string; runId: string; data?: string; cols?: number; rows?: number };
    if (typeof event.sessionId !== 'string' || typeof event.runId !== 'string') return;
    if (type === 'replay' && typeof event.data === 'string' && event.cols && event.rows) {
      connection.mirrors.get(event.sessionId)?.dispose();
      const mirror = new ScreenMirror(event.runId, event.cols, event.rows); mirror.write(event.data); connection.mirrors.set(event.sessionId, mirror);
      this.emit({ type: 'replay', id, sessionId: event.sessionId, runId: event.runId, data: event.data, cols: event.cols, rows: event.rows });
    } else if (type === 'output' && typeof event.data === 'string') {
      let mirror = connection.mirrors.get(event.sessionId);
      // A run that started after this computer connected has no replay; its screen starts with its first output.
      if (mirror?.runId !== event.runId) {
        mirror?.dispose(); const channel = connection.channels.find((item) => item.sessionId === event.sessionId);
        mirror = new ScreenMirror(event.runId, channel?.cols ?? 80, channel?.rows ?? 24); connection.mirrors.set(event.sessionId, mirror);
      }
      mirror.write(event.data);
      this.emit({ type: 'output', id, sessionId: event.sessionId, runId: event.runId, data: event.data });
      this.sink.output(event.sessionId, event.runId, event.data);
    } else if (type === 'resize' && event.cols && event.rows) {
      const mirror = connection.mirrors.get(event.sessionId); if (mirror?.runId === event.runId) mirror.resize(event.cols, event.rows);
      const channel = connection.channels.find((item) => item.sessionId === event.sessionId); if (channel) { channel.cols = event.cols; channel.rows = event.rows; }
      this.emit({ type: 'resize', id, sessionId: event.sessionId, runId: event.runId, cols: event.cols, rows: event.rows });
      this.sink.resize(event.sessionId, event.runId, event.cols, event.rows);
    }
  }
}
