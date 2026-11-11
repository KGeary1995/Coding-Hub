import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import type { RunReference, RunningSession, SessionEvent } from '../../../shared/ipc';
import type { ChannelEngine } from '../../../shared/types';
import type { AccountLabel } from '../../../shared/accounts';
import { PAIRING_PREFIX, REMOTE_PORT, type ChannelControl, type ChannelTranscript, type ChatReplay, type RemoteChannel, type RemoteDevice, type RemoteDeviceKind, type RemoteMe, type RemoteStatus, type ServeProblem, type TailscaleState } from '../../../shared/remote';
import type { ChatEnvelope, ChatRequest } from '../../../shared/chat';
import { chatRequestSchema } from '../../../shared/schemas';
import { ChatReplayBuffer } from './chat-replay';
import { exitNotice, isPersonInput } from '../../../shared/terminal-input';
import { sessionTopic } from '../../../shared/channel-name';
import { HubError } from '../cli/engine-adapter';
import { load, save } from '../workbench/local-store';
import { phoneFile } from './phone-files';
import { ScreenMirror } from './screen-mirror';
import { acceptKey, frame, FrameReader } from './websocket';
import { pushEndpoint, pushSender, vapidKeys, type PushSender, type VapidKeys } from './web-push';
import type { DayUsage, HubPreferences, MemoryNote } from '../../../shared/hub';
import type { PlanLimits } from '../../../shared/plan-limits';
import type { NativeConversation, Task } from '../../../shared/workbench';
import { FROM_PHONE, remoteHistory, remoteMemory, remoteTasks, remoteUsage } from './phone-data';

/** What the remote needs from the rest of the app: the saved channels, the running CLIs, and a way to type into one. */
/** A channel's live coaching as phones and linked computers see it: only while it has something to say. */
const coached = (tip: import('../../../shared/coaching').LiveTip | null) => tip && (tip.tips.length || tip.review) ? { coaching: { id: tip.id, tips: tip.tips, review: tip.review } } : {};
export interface RemoteHost {
  /** `seatedAt`: a Round Table's partner, which has no channel of its own; the lead it sits with carries the table. */
  sessions(): { id: string; title: string; engine: ChannelEngine; chat?: true; account?: AccountLabel; seatedAt?: string }[];
  running(): (RunningSession & { cols?: number; rows?: number; title?: string })[];
  write(reference: RunReference, data: string): void;
  /** Starts, stops or restarts a channel for a linked computer, through the desktop window that runs it. */
  control?(sessionId: string, control: ChannelControl): Promise<void>;
  /** Adds a channel to this computer's workspace (a linked computer's + Channel); `chat` makes it a chat channel. */
  /** `like`: a channel on this computer whose folder the new one works in (a Round Table's partner). */
  add?(engine: ChannelEngine, chat?: boolean, like?: string): Promise<void>;
  /** A chat request (ChatRequest, validated again there) for a run on this computer, as if its window sent it. */
  chat?(request: ChatRequest): void;
  /** An image a linked computer pasted into a channel here: onto this clipboard, then the CLI's image key. */
  pasteImage?(reference: RunReference, image: Buffer): Promise<void>;
  /** Live coaching on a channel's last prompt, and its AI review on request (see LiveCoach). */
  coaching?(sessionId: string): import('../../../shared/coaching').LiveTip | null;
  askCoach?(id: string): Promise<unknown>;
  /** Restart and install the latest version, for a linked computer; says what will happen. */
  update?(): Promise<string>;
  /** Resizes a running CLI for a phone showing it (the desktop window resizes through its own route). */
  resize?(reference: RunReference, cols: number, rows: number): void;
  /** Seconds since the person last used this computer's keyboard or mouse; without it the computer counts as away. */
  idleSeconds?(): number;
  /** Whether this computer's screen is locked (null when the system cannot say), for a linked computer showing it. */
  screenLocked?(): boolean | null | Promise<boolean | null>;
  /** A channel's conversation from its CLI's transcript, across restarts. */
  transcript?(sessionId: string): ChannelTranscript;
  /** This computer's own screen-sharing server (macOS Screen Sharing on loopback), for a phone's Screen; null when there is none. */
  screenTarget?(): { host: string; port: number } | null;
  /**
   * This computer's Trace screen service (Windows, when Share this screen is on), for a phone's Screen: whether it is
   * on, and a VNC stream from it for the phone named `viewer` (shown by the clock there while it watches).
   */
  screenService?(): boolean;
  openScreenService?(viewer: string): Promise<{ socket: Duplex; head: Buffer }>;
  /** Today's usage, the plan limits last read, and the daily budgets (null when Settings cannot be read). */
  usage?(): { today: DayUsage; limits: PlanLimits[]; budget: Pick<HubPreferences, 'dailyTokens' | 'dailyCost' | 'limitWarning'> | null };
  /** The task board, and moving a card on it (as dragging it on the desktop does). */
  tasks?(): Task[];
  taskStatus?(id: string, status: Task['status']): Promise<void>;
  /** Session history's CLI conversations, newest first, each with the name the person gave it there. */
  history?(): Promise<(NativeConversation & { label?: string })[]>;
  /** Resumes one in a new channel here, through the window, as Session history's Resume does. */
  resume?(key: string): Promise<void>;
  /** The memory project of each of this computer's channels (by its folder), each once, and that folder. */
  memoryProjects?(): { project: string; directory: string }[];
  memoryNotes?(project: string): MemoryNote[];
  /** A handoff the person wrote on a phone, as the desktop's Memory saves one. */
  writeMemory?(project: string, title: string, content: string): void;
}
/** One-time tickets a phone opens its screen with: a browser's WebSocket cannot send the Authorization header. */
const SCREEN_TICKET_MS = 30000; const MAX_SCREENS = 2;
/** A phone gets its own size for a channel only once the computer has gone unused this long, unless it insists. */
export const DESKTOP_IDLE_SECONDS = 120;
/** Channels running on linked computers, which this computer passes on to its phones. */
export interface RemoteRelay {
  /** Each with `computer` set. */
  channels(): RemoteChannel[];
  /** Calls back with the channel's screen and returns true, or returns false when no linked computer runs it. */
  snapshot(sessionId: string, callback: (screen: { runId: string; cols: number; rows: number; data: string }) => void): boolean;
  write(sessionId: string, runId: string, data: string): Promise<void>;
  /** Asks a linked computer for a phone key for one of this computer's phones, so that phone can reach it directly. */
  phoneKey(computerId: string, name: string, relayKey: string): Promise<{ id: string; name: string; url: string; token: string }>;
  /** Asks every linked computer to forget the keys it gave one of this computer's phones (`relayKey`), now removed. */
  revokePhone?(relayKey: string): Promise<void>;
  /** Draws a linked computer's channel at a phone's size, or (null) gives it back. */
  size(sessionId: string, runId: string, size: { cols: number; rows: number } | null): Promise<void>;
  /** A linked computer's channel's conversation, for a phone of this computer. */
  relayTranscript?(sessionId: string): Promise<ChannelTranscript>;
  /** A chat request from a phone of this computer for a chat on a linked computer. */
  relayChat?(request: ChatRequest): Promise<void>;
  /** A linked computer's chat's recent events, as this computer received them; null when none of them runs it. */
  relayChatReplay?(sessionId: string): ChatReplay | null;
}
/**
 * `held` collects what is sent while a phone waits for its channel's screen, so nothing arrives ahead of it. A linked
 * computer's stream (`all`) carries every channel's output; phones follow one channel at a time.
 */
interface Stream { device: string; kind: RemoteDeviceKind; response: http.ServerResponse; sessionId: string | null; all?: boolean; held?: string[] }

const subscriptionSchema = z.object({ endpoint: z.string().max(2048).refine(pushEndpoint, 'Not a push service.'), p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).strict();
const deviceSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(60), tokenHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime(), lastSeen: z.iso.datetime().nullable(), push: subscriptionSchema.optional(),
  /** Absent on phones paired before computers could link. */
  kind: z.enum(['phone', 'computer']).optional(), machineId: z.uuid().optional(),
  /** A phone key a linked computer asked for on behalf of its phone (`<computer id>:<its key>`): asking again replaces it. */
  relayKey: z.string().max(36 + 1 + 100).optional(),
  /** A phone the person let start, stop, restart and add channels; absent (off) on every phone until then. */
  canRun: z.boolean().optional() }).strict();
const devicesSchema = z.array(deviceSchema).max(20);
const vapidSchema = z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/), privateKey: z.string().min(40).max(400) }).strict();
/** What a browser's `PushSubscription.toJSON()` gives (`expirationTime` is usually null and is not needed to send). */
const subscribeSchema = z.object({ endpoint: z.string().max(2048), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).strict() }).strict();
/** At most one alert per channel and kind in this window, so a CLI that keeps asking does not flood the phone. */
const ALERT_INTERVAL = 20000;
type Device = z.infer<typeof deviceSchema>;
const settingsSchema = z.object({ enabled: z.boolean(), autoLink: z.boolean().optional() }).strict();
const pairSchema = z.object({ code: z.string().min(1).max(40), name: z.string().max(200), machineId: z.uuid().optional() }).strict();
const autoLinkSchema = z.object({ name: z.string().max(200), machineId: z.uuid() }).strict();
const phoneKeySchema = z.object({ name: z.string().max(200), relayKey: z.string().min(1).max(100) }).strict();
const phoneKeyRevokeSchema = z.object({ relayKey: z.string().min(1).max(100) }).strict();
const computerKeySchema = z.object({ id: z.uuid() }).strict();
/** JSON for one server-sent event line. U+2028/U+2029 are escaped: JSON allows them raw, but phone and computer apps
 * from before 1.11.4 read events with a pattern that ends lines there, which broke the stream. */
export const eventJSON = (value: unknown) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const sizeSchema = z.object({ sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100), cols: z.number().int().min(20).max(300), rows: z.number().int().min(6).max(200), force: z.boolean().optional() }).strict();
const releaseSchema = z.object({ sessionId: z.string().min(1).max(100) }).strict();
const addSchema = z.object({ engine: z.enum(['claude', 'codex', 'shell']), chat: z.boolean().optional(), like: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional() }).strict().refine((value) => !(value.chat && value.engine === 'shell'), 'A terminal channel cannot be a chat.');
/** A chat message may carry 10 images of up to 14 MB of base64 each (chatRequestSchema). */
const CHAT_BODY = 10 * 14 * 1024 * 1024 + 256 * 1024;
/** A Windows computer's screen (Trace's screen service) asks no password of its own, so a phone needs the same setting as starting agents. */
const SCREEN_REFUSED = 'This phone can’t see or control this computer’s screen. On the computer, turn on Settings → Phone access → Can start and stop agents for it.';
const RUN_REFUSED = 'This phone can’t start or stop agents. On the computer, turn on Settings → Phone access → Can start and stop agents for it.';
const taskStatusSchema = z.object({ id: z.uuid(), status: z.enum(['todo', 'working', 'review', 'done']) }).strict();
const resumeSchema = z.object({ key: z.string().min(1).max(200) }).strict();
/** The same limits as the desktop's Memory (memory-write); a project must be one of this computer's channels'. */
const handoffSchema = z.object({ project: z.string().min(1).max(80), title: z.string().trim().min(1).max(200), content: z.string().min(1).max(60000) }).strict();
const controlSchema = z.object({ sessionId: z.string().min(1).max(100), control: z.enum(['start', 'stop', 'restart', 'close']) }).strict();
/** A pasted image (PNG or JPEG, base64), at most 15 MB. */
const IMAGE_LIMIT = 15 * 1024 * 1024;
const pasteSchema = z.object({ sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100), image: z.string().min(8).max(Math.ceil(IMAGE_LIMIT / 3) * 4).regex(/^[A-Za-z0-9+/]+=*$/) }).strict();
const inputSchema = z.object({ sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100), data: z.string().min(1).max(4096) }).strict();
/** Unambiguous characters, so a code read off the screen can be typed on a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Screens kept for replay: one per channel, and no more than this many in all (oldest started first out). */
const REPLAY_CHANNELS = 32;
const PAIRING_MINUTES = 5; const PAIRING_ATTEMPTS = 10; const STREAM_BUFFER = 2 * 1024 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The phone remote. It listens only on this computer (127.0.0.1); a phone reaches it through `tailscale serve`, which
 * adds HTTPS and admits only devices on the person's tailnet. On top of that every request needs a device key, given
 * once to a phone that presents a short-lived pairing code shown on this computer. Only key hashes are stored, and a
 * key can be revoked at any time. A phone can read channel output, type into running CLIs and use chat channels; it
 * starts, stops, restarts or adds channels only once the person allows that for it (`canRun`, off by default). Another
 * of the person's computers, linked with a code made for computers, can always do those; phones see linked computers'
 * channels through this one (RemoteRelay).
 */
export class RemoteServer {
  private server: http.Server | null = null; private error: string | null = null;
  private streams = new Set<Stream>();
  private screenTickets = new Map<string, { device: string; expires: number }>(); private screens = new Set<Duplex>();
  /**
   * The phone each screen connection belongs to, open or still connecting, and whether it comes from Trace's screen
   * service: removing the phone closes all of its own, and taking its setting away closes those from the service.
   */
  private screenOwners = new Map<Duplex, { device: string; service: boolean }>();
  private replay = new Map<string, ScreenMirror>();
  /** Chat channels' recent events, kept whether or not phone access is on, so a phone opening a chat sees its thread. */
  private chats = new ChatReplayBuffer();
  private attention = new Map<string, { runId: string; message: string }>();
  /** Why a channel's last run stopped with an error, until it starts again; linked computers alert on it. */
  private failures = new Map<string, string>();
  private pairing: { code: string; expires: number; attempts: number; kind: RemoteDeviceKind } | null = null;
  private relay: RemoteRelay | null = null;
  /** This computer's sync identity, given to a computer that links to it so it can recognise this one in Drive. */
  identity: { id: string; name: string } | null = null;
  /**
   * The person's other computers' remote addresses (https://name.tailnet.ts.net). The phone app one of them served may
   * call this computer directly when that one is off, so these origins are allowed alongside this computer's own.
   */
  allowedOrigins: () => string[] = () => [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private channelsTimer: ReturnType<typeof setTimeout> | null = null; private sentChannels = '';
  tailscale: TailscaleState = { installed: false, running: false, host: null, serving: false, funnel: false, error: null };
  /** The last failed `tailscale serve`, and the Tailscale page that fixes it; both clear once HTTPS works. */
  serveProblem: ServeProblem | null = null; serveLink: string | null = null;
  private alerted = new Map<string, number>();
  /**
   * Channels a phone is showing at its own size, like tmux: the CLI redraws for the phone, and the desktop's size is
   * kept to put back when the phone leaves the channel or disconnects, or the person types at the desktop.
   */
  private phoneSizes = new Map<string, { device: string; runId: string; desktop: { cols: number; rows: number }; cols: number; rows: number; forced: boolean }>();
  /** Phone sizes asked for while the person was using this computer, applied once it goes idle. */
  private wants = new Map<string, { device: string; runId: string; cols: number; rows: number }>();
  /**
   * Which of this computer's phones last asked for its size on a linked computer's channel. The linked computer sees all
   * of them as this one computer, so only that phone leaving gives the channel back; another phone leaving keeps it.
   */
  private relaySizes = new Map<string, string>();
  /** When each linked computer last said its person was using this computer's channels (`/api/active`). */
  private usedFrom = new Map<string, number>();
  private desktopTimer: ReturnType<typeof setInterval> | null = null;
  private sender: PushSender;
  constructor(private root: string, private host: RemoteHost, readonly port = REMOTE_PORT, private phoneRoot = '', sender?: PushSender) { this.sender = sender ?? pushSender(() => this.vapid()); }

  /** This computer's VAPID key pair, made the first time a phone asks to turn on alerts. */
  private vapid(): VapidKeys {
    const existing = load(this.root, 'remote-push.json', vapidSchema.nullable(), null); if (existing) return existing;
    const keys = vapidKeys(); save(this.root, 'remote-push.json', keys); return keys;
  }
  private setPush(id: string, push: z.infer<typeof subscriptionSchema> | undefined) {
    const devices = this.devices(); const device = devices.find((item) => item.id === id); if (!device) return false;
    if (push) device.push = push; else delete device.push; this.saveDevices(devices); return true;
  }
  /** Sends an alert to every phone that turned alerts on; a subscription the push service reports gone is forgotten. */
  private async alert(sessionId: string, kind: 'waiting' | 'failed' | 'test', title: string, body: string, only?: string) {
    const key = `${sessionId}:${kind}`; const now = Date.now();
    if (kind !== 'test') { if (now - (this.alerted.get(key) ?? 0) < ALERT_INTERVAL) return; this.alerted.set(key, now); }
    const targets = this.devices().filter((device) => device.push && (!only || device.id === only));
    await Promise.all(targets.map(async (device) => {
      // A newer alert replaces one still queued for the phone only for the same channel and kind (RFC 8030 topics, at
      // most 32 URL-safe characters), so a phone that was offline still hears about every channel.
      const topic = kind[0] + createHash('sha256').update(sessionId).digest('base64url').slice(0, 24);
      const result = await this.sender(device.push!, { title, body, sessionId: this.tileOf(sessionId), tag: key }, { topic });
      if (result === 'gone') this.setPush(device.id, undefined);
    }));
  }
  private channelLabel(sessionId: string) {
    const seated = this.tileOf(sessionId) !== sessionId; const channel = this.channels().find((item) => item.sessionId === this.tileOf(sessionId));
    const engine = seated ? this.host.sessions().find((session) => session.id === sessionId)?.engine : undefined;
    return channel ? `CH${channel.channel} · ${channel.title}${engine ? ` (${engine === 'codex' ? 'Codex' : 'Claude'})` : ''}` : 'A channel';
  }
  /** The channel a session is shown as: a Round Table's partner goes by the lead it sits with. */
  private tileOf(sessionId: string) { return this.host.sessions().find((session) => session.id === sessionId)?.seatedAt ?? sessionId; }
  /** A test alert to one phone, from Settings on the computer. */
  async testAlert(id: string) {
    const device = this.devices().find((item) => item.id === id); if (!device) throw new HubError('REMOTE_DEVICE', 'That phone is no longer paired.');
    if (!device.push) throw new HubError('REMOTE_ALERTS_OFF', `Alerts are not on for ${device.name}. Turn them on in Trace on the phone.`);
    await this.alert('test', 'test', 'Trace alerts are on', `${device.name} will be told when a channel needs you.`, id);
    return this.status();
  }

  private devices(): Device[] { return load(this.root, 'remote-devices.json', devicesSchema, []); }
  /** Writes the paired devices only if the whole list reads back: a bad entry leaves the previous file as it was. */
  private saveDevices(devices: Device[]) { save(this.root, 'remote-devices.json', devicesSchema.parse(devices)); }
  private settings() { return load(this.root, 'remote.json', settingsSchema, { enabled: false }); }
  get enabled() { return this.settings().enabled; }
  /** On unless turned off: the person's own computers link without a code (see `owner`). */
  get autoLink() { return this.settings().autoLink ?? true; }
  setAutoLink(autoLink: boolean) { save(this.root, 'remote.json', { ...this.settings(), autoLink }); return this.status(); }

  async setEnabled(enabled: boolean) { save(this.root, 'remote.json', { ...this.settings(), enabled }); if (enabled) await this.start(); else await this.stop(); }
  async start() {
    if (this.server || !this.enabled) return;
    const server = http.createServer((request, response) => { void this.handle(request, response).catch(() => { if (!response.headersSent) this.send(response, 500, { error: 'The remote request failed.' }); else response.destroy(); }); });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      this.server = server; this.error = null;
      server.on('upgrade', (request, socket, head) => void this.upgrade(request, socket, head).catch(() => socket.destroy()));
      for (const run of this.host.running()) if (!this.replay.has(run.sessionId)) this.mirror(run.sessionId, run.runId);
      this.heartbeat = setInterval(() => { for (const stream of this.streams) this.write(stream, ': ping\n\n'); }, 25000);
    } catch (error) {
      this.error = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${this.port} on this computer is in use by another program.` : 'The phone remote could not start.';
    }
  }
  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; if (this.desktopTimer) clearInterval(this.desktopTimer); this.desktopTimer = null; if (this.channelsTimer) clearTimeout(this.channelsTimer); this.channelsTimer = null;
    for (const stream of this.streams) stream.response.end(); this.streams.clear();
    for (const socket of this.screens) socket.destroy(); this.screens.clear(); this.screenOwners.clear(); this.screenTickets.clear();
    for (const id of [...this.replay.keys()]) this.forget(id);
    const server = this.server; this.server = null; this.pairing = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  /**
   * A phone's Screen: its WebSocket, opened with a ticket from /api/phone-screen-ticket, carries a VNC stream: from this
   * computer's own screen-sharing server (a Mac, which still asks for its user name and password; they go from the phone to
   * it, not to Trace), or from Trace's screen service (Windows, which the ticket alone lets in).
   */
  private async upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const refuse = (status: number, text: string) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/screen' && url.pathname !== '/api/phone-screen') return refuse(404, 'Not Found');
    if (!this.allowedHost(request.headers.host) || request.headers['tailscale-funnel-request'] !== undefined) return refuse(403, 'Forbidden');
    const origin = request.headers.origin; if (origin && !this.allowedHost(URL.canParse(origin) ? new URL(origin).host : '')) return refuse(403, 'Forbidden');
    const ticket = this.screenTickets.get(url.searchParams.get('ticket') ?? ''); this.screenTickets.delete(url.searchParams.get('ticket') ?? '');
    if (!ticket || ticket.expires < Date.now() || !this.devices().some((device) => device.id === ticket.device)) return refuse(401, 'Unauthorized');
    const key = request.headers['sec-websocket-key'];
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') return refuse(400, 'Bad Request');
    const target = this.host.screenTarget?.(); const service = !target && this.host.screenService?.() && this.host.openScreenService;
    if (!target && !service) return refuse(409, 'Conflict');
    // The setting is read again here: it may have been turned off since the ticket was given.
    if (service) { const now = this.devices().find((device) => device.id === ticket.device); if (!now || !this.me(now).canRun) return refuse(403, 'Forbidden'); }
    if (this.screens.size >= MAX_SCREENS) return refuse(429, 'Too Many Requests');
    this.screens.add(socket); this.screenOwners.set(socket, { device: ticket.device, service: Boolean(service) });
    // The phone's WebSocket carries the VNC bytes both ways, once the server is there.
    const pipe = (server: Duplex, first: Buffer) => {
      const end = () => { this.screens.delete(socket); this.screenOwners.delete(socket); server.destroy(); socket.destroy(); };
      const protocol = String(request.headers['sec-websocket-protocol'] ?? '').split(',')[0].trim();
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`);
      if (first.length) socket.write(frame(first));
      const reader = new FrameReader();
      const receive = (chunk: Buffer) => {
        try {
          for (const event of reader.push(chunk)) {
            if (event.type === 'data') server.write(event.data);
            else if (event.type === 'ping') socket.write(frame(event.data, 0xa));
            else { socket.write(frame(Buffer.alloc(0), 0x8)); end(); return; }
          }
        } catch { end(); }
      };
      if (head.length) receive(head);
      socket.on('data', receive);
      server.on('data', (data: Buffer) => socket.write(frame(data)));
      server.once('close', end); server.on('error', end); socket.once('close', end); socket.once('error', end);
    };
    if (service) {
      const phone = this.devices().find((device) => device.id === ticket.device)?.name ?? 'A phone';
      // Taken away (or the phone gone) while the service was answering: nothing is passed on.
      try { const opened = await service(phone); if (socket.destroyed || !this.screenOwners.has(socket)) { opened.socket.destroy(); this.screens.delete(socket); this.screenOwners.delete(socket); socket.destroy(); return; } pipe(opened.socket, opened.head); }
      catch { this.screens.delete(socket); this.screenOwners.delete(socket); if (!socket.writableEnded) refuse(502, 'Bad Gateway'); }
      return;
    }
    const server = net.connect(target!.port, target!.host);
    const failed = () => { this.screens.delete(socket); this.screenOwners.delete(socket); if (!socket.writableEnded) refuse(502, 'Bad Gateway'); server.destroy(); socket.destroy(); };
    server.once('error', failed); server.once('connect', () => { server.off('error', failed); if (!this.screenOwners.has(socket)) { server.destroy(); return; } pipe(server, Buffer.alloc(0)); });
  }
  get address() { return this.server ? (this.server.address() as AddressInfo).port : null; }

  /** Starts pairing: a code good for five minutes and ten tries, shown on this computer as a QR link. */
  /**
   * The code decides what pairs: a phone (watch and type) or another computer (also start and stop channels). What the
   * other side asks for does not, so a phone's code can never link a computer.
   */
  pair(kind: RemoteDeviceKind = 'phone') {
    if (!this.server) throw new HubError('REMOTE_OFF', 'Turn on phone access first.');
    if (this.devices().length >= 20) throw new HubError('REMOTE_LIMIT', 'Up to 20 phones and computers can be paired. Remove one first.');
    const bytes = randomBytes(10); const code = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
    this.pairing = { code, expires: Date.now() + PAIRING_MINUTES * 60000, attempts: 0, kind };
    return this.status();
  }
  cancelPairing() { this.pairing = null; return this.status(); }
  /** Closes the phones' screen connections that match, open or still connecting (a pending one sees it is gone). */
  private closeScreens(matches: (owner: { device: string; service: boolean }) => boolean) {
    for (const [socket, owner] of [...this.screenOwners]) if (matches(owner)) { this.screenOwners.delete(socket); this.screens.delete(socket); socket.destroy(); }
  }
  /**
   * Devices that are gone (removed here, removed through the linked computer that gave them their key, or their key
   * replaced): their streams end, their screens close (open or still connecting), and their unused screen tickets go,
   * so removing one locks it out at once.
   */
  private dropped(ids: Set<string>) {
    if (!ids.size) return;
    for (const stream of this.streams) if (ids.has(stream.device)) { stream.response.end(); this.streams.delete(stream); }
    this.closeScreens((owner) => ids.has(owner.device));
    for (const [value, ticket] of [...this.screenTickets]) if (ids.has(ticket.device)) this.screenTickets.delete(value);
  }
  revoke(id: string) {
    const devices = this.devices(); const device = devices.find((item) => item.id === id); if (!device) throw new HubError('REMOTE_DEVICE', 'That phone is no longer paired.');
    // A linked computer's phones were given keys here through it (relayKey `<its id>:<phone>`): they go with it.
    const removed = new Set([id, ...devices.filter((item) => item.relayKey?.startsWith(id + ':')).map((item) => item.id)]);
    this.saveDevices(devices.filter((item) => !removed.has(item.id)));
    this.dropped(removed);
    // A phone of this computer was given keys on linked computers through this one: ask them to forget those too.
    if (!device.kind || device.kind === 'phone') void this.relay?.revokePhone?.(id).catch(() => {});
    return this.status();
  }
  /** Lets a phone start, stop, restart and add channels, or takes that away; its open streams hear at once (`me`). */
  setCanRun(id: string, canRun: boolean) {
    const devices = this.devices(); const device = devices.find((item) => item.id === id); if (!device) throw new HubError('REMOTE_DEVICE', 'That phone is no longer paired.');
    if (device.kind === 'computer') throw new HubError('REMOTE_COMPUTER', 'A linked computer can always start and stop channels. Remove it under Other computers to stop that.');
    if (canRun) device.canRun = true; else delete device.canRun; this.saveDevices(devices);
    // Taken away: its open screens from Trace's screen service close (a Mac's own Screen Sharing asks its own password).
    if (!canRun) this.closeScreens((owner) => owner.device === id && owner.service);
    const payload = `event: me\ndata: ${eventJSON(this.me(device))}\n\n`; for (const stream of this.streams) if (stream.device === id) this.write(stream, payload);
    return this.status();
  }
  private me(device: Device): RemoteMe { const kind = device.kind ?? 'phone'; return { id: device.id, name: device.name, kind, canRun: kind === 'computer' || device.canRun === true, computer: this.identity?.id ?? null }; }
  /** The device as stored now: a request whose body took a while is judged on the latest permission, or refused if removed. */
  private current(id: string) { return this.devices().find((item) => item.id === id) ?? null; }
  status(): RemoteStatus {
    const base = this.tailscale.serving && this.tailscale.host ? `https://${this.tailscale.host}/` : null;
    const pairing = this.pairing && this.pairing.expires > Date.now() ? { code: this.pairing.code, url: (base ?? `http://127.0.0.1:${this.port}/`) + PAIRING_PREFIX + this.pairing.code, expiresAt: new Date(this.pairing.expires).toISOString(), kind: this.pairing.kind } : null;
    return { enabled: this.enabled, listening: Boolean(this.server), port: this.port, url: base, error: this.error, tailscale: this.tailscale, pairing, serveProblem: this.tailscale.serving ? null : this.serveProblem, autoLink: this.autoLink,
      devices: this.devices().map(({ id, name, createdAt, lastSeen, push, kind, canRun }): RemoteDevice => ({ id, name, createdAt, lastSeen, notifications: Boolean(push), kind: kind ?? 'phone', canRun: kind === 'computer' || canRun === true })) };
  }

  /** Every session event passes through here: output is kept for replay and sent to phones watching that channel. */
  onSessionEvent(event: SessionEvent) {
    if (event.type === 'started' || event.type === 'exit') { this.phoneSizes.delete(event.sessionId); this.wants.delete(event.sessionId); }
    if (event.type === 'started') {
      this.forget(event.sessionId); if (this.server) this.mirror(event.sessionId, event.runId);
      this.attention.delete(event.sessionId); this.failures.delete(event.sessionId); this.broadcastChannels(); return;
    }
    if (event.type === 'data') { this.output(event.sessionId, event.runId, event.data); return; }
    if (event.type === 'attention') {
      this.attention.set(event.sessionId, { runId: event.runId, message: event.message }); this.broadcastChannels();
      if (this.server) void this.alert(event.sessionId, 'waiting', `${this.channelLabel(event.sessionId)} needs you`, event.message).catch(() => {});
      return;
    }
    // The phone shows why a CLI stopped the way the desktop does.
    if (event.type === 'exit') this.output(event.sessionId, event.runId, exitNotice(event.exitCode, event.signal, event.diagnostic));
    // A run that failed carries a diagnostic; a run the person stopped does not.
    if (event.type === 'exit' && event.exitCode !== 0 && event.diagnostic) this.failures.set(event.sessionId, event.diagnostic.split('\n')[0].slice(0, 160));
    if (event.type === 'exit' && event.exitCode !== 0 && event.diagnostic && this.server) void this.alert(event.sessionId, 'failed', `${this.channelLabel(event.sessionId)} stopped with an error`, event.diagnostic.split('\n')[0].slice(0, 160)).catch(() => {});
    if (event.type === 'answered' || event.type === 'exit') { this.attention.delete(event.sessionId); this.broadcastChannels(); }
  }
  /**
   * Every chat event the owning window gets: kept for replay, and sent to phones following that channel and to linked
   * computers (which pass it on to their own phones and tabs).
   */
  onChat(envelope: ChatEnvelope) {
    this.chats.record(envelope);
    const payload = `event: chat\ndata: ${eventJSON(envelope)}\n\n`;
    for (const stream of this.streams) if (stream.sessionId === envelope.sessionId || stream.all) this.write(stream, payload);
  }
  /** A chat event from a channel on a linked computer, for this computer's phones following it. */
  relayChat(envelope: ChatEnvelope) {
    const payload = `event: chat\ndata: ${eventJSON(envelope)}\n\n`;
    for (const stream of this.streams) if (stream.kind === 'phone' && stream.sessionId === envelope.sessionId) this.write(stream, payload);
  }
  /** A chat's recent events, here or (for phones) on the linked computer that runs it. */
  private chatReplay(sessionId: string, kind: RemoteDeviceKind): ChatReplay | null {
    if (this.local(sessionId)) return this.chats.take(sessionId);
    return kind === 'phone' ? this.relay?.relayChatReplay?.(sessionId) ?? null : null;
  }
  private output(sessionId: string, runId: string, data: string) {
    const mirror = this.replay.get(sessionId); if (mirror?.runId === runId) mirror.write(data);
    const payload = `event: output\ndata: ${eventJSON({ sessionId, runId, data })}\n\n`;
    for (const stream of this.streams) if (stream.sessionId === sessionId || stream.all) this.write(stream, payload);
  }
  /** Screens are kept only while phone access is on; turned on mid-run, a channel's screen starts from that point. */
  private mirror(sessionId: string, runId: string) {
    const run = this.host.running().find((item) => item.runId === runId);
    this.replay.set(sessionId, new ScreenMirror(runId, run?.cols ?? 80, run?.rows ?? 24));
    while (this.replay.size > REPLAY_CHANNELS) this.forget(this.replay.keys().next().value!);
  }
  private forget(sessionId: string) { this.replay.get(sessionId)?.dispose(); this.replay.delete(sessionId); }
  /**
   * The saved workspace changed (channels added, removed, renamed or reordered) or a terminal was resized. Both come
   * often, so phones are told shortly after, and only when the channel list they see is different.
   */
  channelsChanged() {
    // Channels that left the workspace keep no screen or prompt here, whether or not a phone is connected.
    const current = new Set(this.host.sessions().map((session) => session.id));
    for (const id of [...this.replay.keys()]) if (!current.has(id)) this.forget(id);
    for (const id of this.chats.sessionIds()) if (!current.has(id)) this.chats.forget(id);
    for (const id of [...this.attention.keys()]) if (!current.has(id)) this.attention.delete(id);
    for (const key of [...this.alerted.keys()]) if (!current.has(key.slice(0, key.lastIndexOf(':')))) this.alerted.delete(key);
    if (this.channelsTimer || !this.streams.size) return;
    this.channelsTimer = setTimeout(() => { this.channelsTimer = null; if (JSON.stringify(this.channels()) !== this.sentChannels) this.broadcastChannels(); }, 250);
  }
  /**
   * A terminal was resized. Phones watching it get the new size at once, ahead of any output the CLI draws at that
   * size (output is batched for a few milliseconds before it is sent), so the phone's screen lays it out the same way.
   */
  resized(sessionId: string) {
    const run = this.host.running().find((item) => item.sessionId === sessionId);
    if (run?.cols && run.rows) { const mirror = this.replay.get(sessionId); if (mirror?.runId === run.runId) mirror.resize(run.cols, run.rows); const payload = `event: resize\ndata: ${eventJSON({ sessionId, runId: run.runId, cols: run.cols, rows: run.rows })}\n\n`; for (const stream of this.streams) if (stream.sessionId === sessionId || stream.all) this.write(stream, payload); }
    this.channelsChanged();
  }
  /** The person typed on the desktop: a waiting prompt is answered there, and a channel a phone resized is given back. */
  personInput(sessionId: string, data: string) {
    if (isPersonInput(data) && this.attention.delete(sessionId)) this.broadcastChannels();
    const hold = this.phoneSizes.get(sessionId); if (hold && isPersonInput(data)) this.release(sessionId, hold.device);
  }
  /**
   * The desktop window resized a channel (its layout changed, a tile was selected, the window moved). While a phone
   * shows that channel at the phone's size, the phone's size stays: changing it under the phone would leave the phone's
   * screen drawn for the wrong size. The desktop's new size is kept and put back when the phone lets go. Returns true
   * when the resize is held back.
   */
  desktopResize(sessionId: string, runId: string, cols: number, rows: number) {
    const hold = this.phoneSizes.get(sessionId); if (!hold || hold.runId !== runId) return false;
    hold.desktop = { cols, rows }; return true;
  }
  /**
   * A phone asking to draw a channel at its own size. The desktop wins while the person is using this computer: the
   * request is kept and applied once the computer has gone unused for DESKTOP_IDLE_SECONDS, and given back as soon as it
   * is used again (`checkDesktop`). `force` (the phone's "Fit to phone") applies it at once, until the person types in
   * that channel on the desktop. Returns whether the phone now has its size.
   */
  private phoneSize(device: string, sessionId: string, runId: string, cols: number, rows: number, force = false): boolean {
    const run = this.host.running().find((item) => item.sessionId === sessionId && item.runId === runId);
    if (!run || !this.host.resize) throw new HubError('STALE_SESSION', 'This channel is not running.');
    if (!force && !this.desktopAway(device)) { this.wants.set(sessionId, { device, runId, cols, rows }); this.watchDesktop(); return false; }
    this.wants.delete(sessionId); this.apply(device, sessionId, runId, cols, rows, force); return true;
  }
  /** Draws a channel at a phone's size, remembering the desktop's size the first time. */
  private apply(device: string, sessionId: string, runId: string, cols: number, rows: number, forced: boolean) {
    const run = this.host.running().find((item) => item.sessionId === sessionId && item.runId === runId); if (!run || !this.host.resize) return;
    const hold = this.phoneSizes.get(sessionId);
    const desktop = hold?.runId === runId ? hold.desktop : { cols: run.cols ?? 80, rows: run.rows ?? 24 };
    this.phoneSizes.set(sessionId, { device, runId, desktop, cols, rows, forced });
    if (run.cols !== cols || run.rows !== rows) { this.host.resize({ sessionId, runId }, cols, rows); this.resized(sessionId); }
    this.watchDesktop();
  }
  /**
   * Seconds since the person last used this computer: here, or through a linked computer showing its channels
   * (`/api/active`). A linked computer that asked for a channel at its own size does not count against that size.
   */
  private idle(device?: string) {
    const own = this.host.idleSeconds?.(); if (own === undefined) return undefined;
    let last = 0; for (const [id, time] of this.usedFrom) if (id !== device) last = Math.max(last, time);
    return Math.min(own, (Date.now() - last) / 1000);
  }
  private desktopAway(device?: string) { const idle = this.idle(device); return idle === undefined || idle >= DESKTOP_IDLE_SECONDS; }
  /** While phones want or hold a size, follows whether the person is at this computer. */
  private watchDesktop() {
    if (this.desktopTimer || !this.host.idleSeconds) return;
    this.desktopTimer = setInterval(() => this.checkDesktop(), 2000); this.desktopTimer.unref?.();
  }
  /** Gives automatic phone sizes back the moment the computer is used, and applies waiting ones once it is idle. */
  checkDesktop() {
    if (this.idle() === undefined) return;
    for (const [sessionId, hold] of [...this.phoneSizes]) if (!hold.forced && this.idle(hold.device)! < 3) { this.wants.set(sessionId, { device: hold.device, runId: hold.runId, cols: hold.cols, rows: hold.rows }); this.release(sessionId, hold.device, true); }
    for (const [sessionId, want] of [...this.wants]) if (this.idle(want.device)! >= DESKTOP_IDLE_SECONDS) { this.wants.delete(sessionId); this.apply(want.device, sessionId, want.runId, want.cols, want.rows, false); }
    if (!this.wants.size && ![...this.phoneSizes.values()].some((hold) => !hold.forced) && this.desktopTimer) { clearInterval(this.desktopTimer); this.desktopTimer = null; }
  }
  /** Puts back the desktop's size, if this device is the one holding the channel at its size. */
  private release(sessionId: string, device: string, keepWant = false) {
    if (!keepWant && this.wants.get(sessionId)?.device === device) this.wants.delete(sessionId);
    const hold = this.phoneSizes.get(sessionId); if (!hold || hold.device !== device) return;
    this.phoneSizes.delete(sessionId);
    const run = this.host.running().find((item) => item.sessionId === sessionId && item.runId === hold.runId);
    if (run && this.host.resize) try { this.host.resize({ sessionId, runId: hold.runId }, hold.desktop.cols, hold.desktop.rows); this.resized(sessionId); } catch { /* The run ended. */ }
  }
  /** One of this computer's phones left a linked computer's channel: gives it back there only if that phone sized it. */
  private async relayRelease(sessionId: string, device: string) {
    if (!this.relay || this.relaySizes.get(sessionId) !== device) return;
    this.relaySizes.delete(sessionId); await this.relay.size(sessionId, '', null);
  }

  /**
   * This computer's channels, and for phones also those of linked computers. A linked computer is never given channels
   * this one passes on, so two linked computers cannot echo each other's channels back and forth.
   */
  channels(kind: RemoteDeviceKind = 'phone'): RemoteChannel[] {
    const running = new Map(this.host.running().map((run) => [run.sessionId, run]));
    // A Round Table is one channel: its partner is left out, and an approval it waits for shows on the lead.
    const sessions = this.host.sessions();
    const local = sessions.filter((session) => !session.seatedAt).map((session, index): RemoteChannel => {
      const run = running.get(session.id); const own = this.attention.get(session.id);
      const seat = sessions.find((item) => item.seatedAt === session.id); const seatRun = seat ? running.get(seat.id) : undefined; const seatWaiting = seat ? this.attention.get(seat.id) : undefined;
      const waiting = run && own?.runId === run.runId ? own : seat && seatRun && seatWaiting?.runId === seatRun.runId ? { runId: run?.runId ?? '', message: `${seat.engine === 'codex' ? 'Codex' : 'Claude'}: ${seatWaiting.message}` } : undefined;
      const topic = run?.title ? sessionTopic(run.title, session.engine, session.title) : null;
      return { sessionId: session.id, channel: index + 1, title: session.title, engine: session.engine, runId: run?.runId ?? null, running: Boolean(run), attention: run && waiting?.runId === run.runId ? waiting.message : null, ...(!run && this.failures.has(session.id) ? { failed: this.failures.get(session.id)! } : {}), ...coached(this.host.coaching?.(session.id) ?? null), cols: run?.cols ?? null, rows: run?.rows ?? null, ...(topic ? { topic } : {}), ...(session.chat ? { chat: true as const } : {}), ...(session.chat && seat && seat.engine !== 'shell' ? { table: seat.engine } : {}), ...(session.account ? { account: session.account } : {}) };
    });
    if (kind !== 'phone') return local;
    // Phones are told which computer each channel is on, so one app can switch between them.
    const own = this.identity ? local.map((channel) => ({ ...channel, computer: this.identity! })) : local;
    return this.relay ? [...own, ...this.relay.channels()] : own;
  }
  private broadcastChannels() {
    if (!this.streams.size) return;
    const phone = JSON.stringify(this.channels('phone')); const computer = JSON.stringify(this.channels('computer')); this.sentChannels = phone;
    for (const stream of this.streams) this.write(stream, `event: channels\ndata: ${stream.kind === 'computer' ? computer : phone}\n\n`);
  }

  /** Linked computers' channels are passed on to phones through this. */
  setRelay(relay: RemoteRelay | null) { this.relay = relay; this.relayChanged(); }
  /** A linked computer's channel list changed. */
  relayChanged() { if (this.channelsTimer || !this.streams.size) return; this.channelsTimer = setTimeout(() => { this.channelsTimer = null; if (JSON.stringify(this.channels()) !== this.sentChannels) this.broadcastChannels(); }, 250); }
  /** Output from a channel on a linked computer, for phones watching it. */
  relayOutput(sessionId: string, runId: string, data: string) {
    const payload = `event: output\ndata: ${eventJSON({ sessionId, runId, data })}\n\n`;
    for (const stream of this.streams) if (stream.kind === 'phone' && stream.sessionId === sessionId) this.write(stream, payload);
  }
  relayResize(sessionId: string, runId: string, cols: number, rows: number) {
    const payload = `event: resize\ndata: ${eventJSON({ sessionId, runId, cols, rows })}\n\n`;
    for (const stream of this.streams) if (stream.kind === 'phone' && stream.sessionId === sessionId) this.write(stream, payload);
  }
  private local(sessionId: string) { return this.host.sessions().some((session) => session.id === sessionId); }
  private write(stream: Stream, text: string) {
    if (stream.held) { stream.held.push(text); return; }
    // A phone that stops reading (asleep, out of signal) is dropped; it reconnects and gets the replay.
    if (stream.response.writableLength > STREAM_BUFFER) { stream.response.destroy(); this.streams.delete(stream); return; }
    stream.response.write(text);
  }

  private send(response: http.ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(JSON.stringify(body));
  }
  private async body(request: http.IncomingMessage, limit = 16384) {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > limit) throw new HubError('REMOTE_BODY', 'Request too large.'); chunks.push(chunk as Buffer); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  }
  /** Makes a key for a phone or computer that proved itself, and keeps only its hash. */
  private issue(kind: RemoteDeviceKind, rawName: string, machineId: string | undefined) {
    const token = randomBytes(32).toString('base64url'); const name = rawName.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60) || (kind === 'computer' ? 'Computer' : 'Phone');
    const device: Device = { id: randomUUID(), name, tokenHash: hash(token), createdAt: new Date().toISOString(), lastSeen: null, ...(kind === 'computer' ? { kind, ...(machineId ? { machineId } : {}) } : {}) };
    // Linking the same computer again replaces its old key rather than leaving it working too.
    const all = this.devices(); const kept = all.filter((item) => !(machineId && item.kind === 'computer' && item.machineId === machineId));
    const replaced = new Set(all.filter((item) => !kept.includes(item)).map((item) => item.id));
    // Its phones (keys given here through it, relayKey `<its id>:<phone>`) move to its new id: the same computer still
    // speaks for them, so it can remove them later, and removing the computer here takes them with it.
    for (const item of kept) { const owner = item.relayKey?.split(':')[0]; if (owner && replaced.has(owner)) item.relayKey = `${device.id}${item.relayKey!.slice(owner.length)}`; }
    this.saveDevices([...kept, device]); this.dropped(replaced);
    return { token, device: { id: device.id, name: device.name, kind }, ...(kind === 'computer' && this.identity ? { computer: this.identity } : {}) };
  }
  /**
   * The request came through `tailscale serve` from a computer signed in to the same Tailscale login as this one.
   * Serve removes any Tailscale-User-* headers the sender wrote and sets its own from the tailnet's record of who is
   * connecting; it sets none for tagged devices or Funnel (refused in `handle`). A program on this computer could call
   * the loopback port with the header written in, but it already runs as the person and can read Trace's keys.
   */
  private owner(request: http.IncomingMessage) {
    const login = request.headers['tailscale-user-login'];
    return this.autoLink && this.tailscale.serving && Boolean(this.tailscale.login) && typeof login === 'string' && login.trim().toLowerCase() === this.tailscale.login;
  }
  private device(request: http.IncomingMessage): Device | null {
    const header = request.headers.authorization; if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = hash(token); const devices = this.devices(); const device = devices.find((item) => same(item.tokenHash, tokenHash)) ?? null;
    if (device && (!device.lastSeen || Date.now() - Date.parse(device.lastSeen) > 300000)) { device.lastSeen = new Date().toISOString(); this.saveDevices(devices); }
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
    const origin = request.headers.origin;
    const sibling = Boolean(origin) && !this.allowedHost(URL.canParse(origin!) ? new URL(origin!).host : '') && this.allowedOrigins().includes(origin!.replace(/\/$/, '').toLowerCase());
    if (origin && !sibling && !this.allowedHost(URL.canParse(origin) ? new URL(origin).host : '')) return this.send(response, 403, { error: 'Cross-site request refused.' });
    if (sibling) {
      // The phone app from another of the person's computers, calling this one directly; it still needs its own key.
      response.setHeader('Access-Control-Allow-Origin', origin!); response.setHeader('Vary', 'Origin');
      if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' }); return void response.end(); }
    }
    const url = new URL(request.url ?? '/', 'http://remote');
    const file = request.method === 'GET' && !url.pathname.startsWith('/api/') ? phoneFile(this.phoneRoot, url.pathname) : null;
    if (file) {
      response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        // xterm.js sets inline styles for its rows and cursor; scripts stay limited to the app's own files.
        // The app may also call the person's other computers directly (see allowedOrigins).
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src ${['\'self\'', ...this.allowedOrigins()].join(' ')}; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
      return void response.end(file.body);
    }
    if (request.method === 'POST' && url.pathname === '/api/pair') {
      const parsed = pairSchema.safeParse(await this.body(request)); const pairing = this.pairing;
      if (!parsed.success || !pairing || pairing.expires < Date.now()) return this.send(response, 401, { error: 'This pairing code has expired. Start pairing again on the computer.' });
      if (++pairing.attempts > PAIRING_ATTEMPTS) { this.pairing = null; return this.send(response, 401, { error: 'Too many tries. Start pairing again on the computer.' }); }
      if (!same(hash(parsed.data.code.toUpperCase()), hash(pairing.code))) return this.send(response, 401, { error: 'That pairing code is not right.' });
      this.pairing = null;
      return this.send(response, 200, this.issue(pairing.kind, parsed.data.name, pairing.kind === 'computer' ? parsed.data.machineId : undefined));
    }
    // The person's other computers find this one on the tailnet and link to it without a code (see `owner`).
    if (request.method === 'GET' && url.pathname === '/api/hello') {
      if (!this.owner(request) || !this.identity) return this.send(response, 403, { error: 'Link with a code from Settings → Other computers.' });
      return this.send(response, 200, { computer: this.identity });
    }
    if (request.method === 'POST' && url.pathname === '/api/auto-link') {
      if (!this.owner(request)) return this.send(response, 403, { error: 'Link with a code from Settings → Other computers.' });
      const parsed = autoLinkSchema.safeParse(await this.body(request));
      if (!parsed.success || parsed.data.machineId === this.identity?.id) return this.send(response, 400, { error: 'Not a computer to link.' });
      const others = this.devices().filter((item) => !(item.kind === 'computer' && item.machineId === parsed.data.machineId));
      if (others.length >= 20) return this.send(response, 409, { error: 'Up to 20 phones and computers can be paired. Remove one first.' });
      return this.send(response, 200, this.issue('computer', parsed.data.name, parsed.data.machineId));
    }
    if (!url.pathname.startsWith('/api/')) return this.send(response, 404, { error: 'Not found.' });
    const device = this.device(request); if (!device) return this.send(response, 401, { error: 'This phone is not paired. Pair it again from Settings on the computer.' });
    const kind: RemoteDeviceKind = device.kind ?? 'phone';
    if (request.method === 'GET' && url.pathname === '/api/channels') return this.send(response, 200, this.channels(kind));
    if (request.method === 'GET' && url.pathname === '/api/me') return this.send(response, 200, this.me(device));
    if (request.method === 'GET' && url.pathname === '/api/chat-history') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const replay = sessionId ? this.chatReplay(sessionId, kind) : null;
      return replay ? this.send(response, 200, replay) : this.send(response, 400, { error: 'Unknown channel.' });
    }
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const parsed = chatRequestSchema.safeParse(await this.body(request, CHAT_BODY)); if (!parsed.success) return this.send(response, 400, { error: 'Invalid chat request. Images must be PNG, JPEG, GIF or WebP, at most 10 per message.' });
      const now = this.current(device.id); if (!now) return this.send(response, 401, { error: 'This phone is not paired. Pair it again from Settings on the computer.' });
      const chat = parsed.data; const local = this.local(chat.sessionId);
      // Seating a partner joins a second running agent to the conversation: that takes the same permission as starting one.
      if (chat.action === 'table-open' && !this.me(now).canRun) return this.send(response, 403, { error: RUN_REFUSED });
      if (chat.action === 'table-open' && local && !this.local(chat.partner.sessionId)) return this.send(response, 400, { error: 'Unknown channel.' });
      try {
        if (local) { if (!this.host.chat) return this.send(response, 409, { error: 'This computer cannot take chat messages from here right now.' }); this.host.chat(chat); }
        else if (kind === 'phone' && this.relay?.relayChat) {
          if (chat.action === 'table-open') return this.send(response, 403, { error: 'Open a Round Table on another computer’s channel from that computer.' });
          await this.relay.relayChat(chat);
        }
        else return this.send(response, 400, { error: 'Unknown channel.' });
      } catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The chat request could not be delivered.' }); }
      return this.send(response, 200, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      const sessionId = url.searchParams.get('sessionId'); const all = url.searchParams.get('all') === '1';
      if (all && kind !== 'computer') return this.send(response, 403, { error: 'Only a linked computer can follow every channel.' });
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      const stream: Stream = { device: device.id, kind, response, sessionId: all ? null : sessionId, all }; this.streams.add(stream);
      request.on('close', () => {
        this.streams.delete(stream);
        // A phone that goes away (closed, asleep, out of signal) gives the channel back to the desktop's size.
        if (sessionId && !all) { if (this.local(sessionId)) this.release(sessionId, device.id); else if (kind === 'phone') void this.relayRelease(sessionId, device.id).catch(() => {}); }
        // A linked computer that closed (or lost the connection) gives back every channel it showed at its size.
        if (all) { this.usedFrom.delete(device.id); for (const id of new Set([...this.phoneSizes.keys(), ...this.wants.keys()])) this.release(id, device.id); }
      });
      this.write(stream, `event: channels\ndata: ${eventJSON(this.channels(kind))}\n\n`);
      // A chat's recent thread, ahead of its live events (written now, before any screen replay holds the stream back).
      for (const replay of all ? this.chats.sessionIds().filter((id) => this.local(id)).map((id) => this.chats.take(id)) : sessionId ? [this.chatReplay(sessionId, kind)] : [])
        if (replay?.runId) this.write(stream, `event: chat-replay\ndata: ${eventJSON(replay)}\n\n`);
      // Each channel's screen as it is now, then everything that came after it.
      const screens: { sessionId: string; take: (callback: (screen: { runId: string; cols: number; rows: number; data: string }) => void) => boolean }[] = all
        ? [...this.replay].map(([id, mirror]) => ({ sessionId: id, take: (callback) => { mirror.snapshot((screen) => callback({ runId: mirror.runId, ...screen })); return true; } }))
        : sessionId && this.replay.has(sessionId) ? [{ sessionId, take: (callback) => { const mirror = this.replay.get(sessionId)!; mirror.snapshot((screen) => callback({ runId: mirror.runId, ...screen })); return true; } }]
        : sessionId && kind === 'phone' && this.relay && !this.local(sessionId) ? [{ sessionId, take: (callback) => this.relay?.snapshot(sessionId, callback) ?? false }] : [];
      if (screens.length) {
        stream.held = []; let waiting = screens.length; const ready: string[] = [];
        const done = () => { if (--waiting) return; const later = stream.held ?? []; stream.held = undefined; if (!this.streams.has(stream)) return; for (const text of [...ready, ...later]) this.write(stream, text); };
        for (const screen of screens) if (!screen.take((value) => { ready.push(`event: replay\ndata: ${eventJSON({ sessionId: screen.sessionId, ...value })}\n\n`); done(); })) done();
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/input') {
      const parsed = inputSchema.safeParse(await this.body(request)); if (!parsed.success) return this.send(response, 400, { error: 'Invalid input.' });
      // The phone may have been removed while its request body was arriving.
      if (!this.devices().some((item) => item.id === device.id)) return this.send(response, 401, { error: 'This phone is not paired. Pair it again from Settings on the computer.' });
      try {
        if (kind === 'phone' && this.relay && !this.local(parsed.data.sessionId)) await this.relay.write(parsed.data.sessionId, parsed.data.runId, parsed.data.data);
        else this.host.write({ sessionId: parsed.data.sessionId, runId: parsed.data.runId }, parsed.data.data);
      } catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'Input could not be delivered.' }); }
      if (isPersonInput(parsed.data.data) && this.attention.delete(parsed.data.sessionId)) this.broadcastChannels();
      return this.send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/phone-key/revoke') {
      // A linked computer removed one of its phones: the key this computer gave that phone through it stops working.
      if (kind !== 'computer') return this.send(response, 403, { error: 'Only a linked computer can withdraw a phone key.' });
      const parsed = phoneKeyRevokeSchema.safeParse(await this.body(request)); if (!parsed.success) return this.send(response, 400, { error: 'Invalid request.' });
      const relayKey = `${device.id}:${parsed.data.relayKey}`; const gone = this.devices().filter((item) => item.relayKey === relayKey).map((item) => item.id);
      if (gone.length) { this.saveDevices(this.devices().filter((item) => !gone.includes(item.id))); this.dropped(new Set(gone)); }
      return this.send(response, 200, { ok: true, removed: gone.length });
    }
    if (request.method === 'POST' && url.pathname === '/api/phone-key') {
      // A linked computer passing on a phone of its own: the phone gets a phone's key here, never more.
      if (kind !== 'computer') return this.send(response, 403, { error: 'Only a linked computer can ask for a phone key.' });
      const parsed = phoneKeySchema.safeParse(await this.body(request)); if (!parsed.success) return this.send(response, 400, { error: 'Invalid request.' });
      // The computer may have been removed while its request body was arriving: it is given nothing.
      if (!this.devices().some((item) => item.id === device.id)) return this.send(response, 401, { error: 'This computer is no longer linked.' });
      const relayKey = `${device.id}:${parsed.data.relayKey}`; const kept = this.devices().filter((item) => item.relayKey !== relayKey);
      if (kept.length >= 20) return this.send(response, 409, { error: 'Up to 20 phones and computers can be paired. Remove one first.' });
      const token = randomBytes(32).toString('base64url'); const name = parsed.data.name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60) || 'Phone';
      // The phone's earlier key here stops working, and whatever it had open closes.
      const replaced = new Set(this.devices().filter((item) => item.relayKey === relayKey).map((item) => item.id));
      this.saveDevices([...kept, { id: randomUUID(), name, tokenHash: hash(token), createdAt: new Date().toISOString(), lastSeen: null, relayKey }]); this.dropped(replaced);
      return this.send(response, 200, { token, computer: this.identity, url: this.status().url });
    }
    if (request.method === 'GET' && url.pathname === '/api/computers') {
      // The phone learns which computer this is and which others it could reach directly.
      const others = new Map<string, string>(); for (const channel of this.relay?.channels() ?? []) if (channel.computer) others.set(channel.computer.id, channel.computer.name);
      return this.send(response, 200, { self: this.identity, url: this.status().url, others: [...others].map(([id, name]) => ({ id, name })) });
    }
    if (request.method === 'POST' && url.pathname === '/api/computer-key') {
      if (kind !== 'phone' || !this.relay || !this.identity) return this.send(response, 403, { error: 'Only a phone can ask for a key to another computer.' });
      const parsed = computerKeySchema.safeParse(await this.body(request)); if (!parsed.success) return this.send(response, 400, { error: 'Invalid request.' });
      if (!this.devices().some((item) => item.id === device.id)) return this.send(response, 401, { error: 'This phone is not paired. Pair it again from Settings on the computer.' });
      try { return this.send(response, 200, await this.relay.phoneKey(parsed.data.id, `${device.name} (through ${this.identity.name})`, device.id)); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'That computer could not be reached.' }); }
    }
    // Both names: a Windows computer that shares its screen has `tailscale serve` send /api/screen to its screen
    // service, so the phone uses /api/phone-screen… there (and everywhere, from this version on).
    if (request.method === 'POST' && (url.pathname === '/api/screen-ticket' || url.pathname === '/api/phone-screen-ticket')) {
      if (kind !== 'phone') return this.send(response, 403, { error: 'Only a phone opens this computer\'s screen here.' });
      const target = this.host.screenTarget?.(); const service = !target && this.host.screenService?.();
      if (service && !this.me(device).canRun) return this.send(response, 403, { error: SCREEN_REFUSED });
      if (!target && !service) return this.send(response, 409,{ error: 'This computer does not share its screen. On a Mac, turn on System Settings → General → Sharing → Screen Sharing. On Windows, in Trace, turn on Settings → Other computers → Share this screen.' });
      for (const [id, item] of this.screenTickets) if (item.expires < Date.now()) this.screenTickets.delete(id);
      const ticket = randomBytes(24).toString('base64url'); this.screenTickets.set(ticket, { device: device.id, expires: Date.now() + SCREEN_TICKET_MS });
      return this.send(response, 200, { ticket });
    }
    if (request.method === 'GET' && url.pathname === '/api/transcript') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (this.local(sessionId)) return this.send(response, 200, { transcript: this.host.transcript?.(sessionId) ?? null });
      if (kind === 'phone' && this.relay?.relayTranscript) {
        try { return this.send(response, 200, { transcript: await this.relay.relayTranscript(sessionId) }); }
        catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'That conversation could not be read.' }); }
      }
      return this.send(response, 400, { error: 'Unknown channel.' });
    }
    if (request.method === 'GET' && url.pathname === '/api/screen-state') {
      // A locked Mac sends its screen to viewers other than Apple's as black: the linked computer says so instead.
      if (kind !== 'computer') return this.send(response, 403, { error: 'Only a linked computer can ask about this screen.' });
      return this.send(response, 200, { locked: (await this.host.screenLocked?.()) ?? null });
    }
    if (request.method === 'POST' && url.pathname === '/api/active') {
      // A linked computer is showing this one's channels and its person is using it: that counts as using this one.
      if (kind !== 'computer') return this.send(response, 403, { error: 'Only a linked computer can report that it is in use.' });
      this.usedFrom.set(device.id, Date.now()); this.checkDesktop(); return this.send(response, 200, { ok: true });
    }
    if (url.pathname === '/api/size' && (request.method === 'POST' || request.method === 'DELETE')) {
      const body = await this.body(request);
      if (!this.devices().some((item) => item.id === device.id)) return this.send(response, 401, { error: 'This phone is not paired. Pair it again from Settings on the computer.' });
      try {
        if (request.method === 'DELETE') {
          const parsed = releaseSchema.safeParse(body); if (!parsed.success) return this.send(response, 400, { error: 'Invalid request.' });
          if (this.local(parsed.data.sessionId)) this.release(parsed.data.sessionId, device.id); else if (kind === 'phone') await this.relayRelease(parsed.data.sessionId, device.id);
        } else {
          const parsed = sizeSchema.safeParse(body); if (!parsed.success) return this.send(response, 400, { error: 'Invalid size.' });
          const { sessionId, runId, cols, rows, force } = parsed.data;
          // `held`: whether the channel is now drawn at the phone's size (false while the desktop is in use).
          if (this.local(sessionId)) return this.send(response, 200, { ok: true, held: this.phoneSize(device.id, sessionId, runId, cols, rows, force) });
          else if (kind === 'phone' && this.relay) { await this.relay.size(sessionId, runId, { cols, rows }); this.relaySizes.set(sessionId, device.id); }
          else return this.send(response, 400, { error: 'Unknown channel.' });
        }
      } catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The channel could not be resized.' }); }
      return this.send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/channel-add') {
      if (!this.me(device).canRun) return this.send(response, 403, { error: RUN_REFUSED });
      const parsed = addSchema.safeParse(await this.body(request)); if (!parsed.success) return this.send(response, 400, { error: 'Invalid channel.' });
      const now = this.current(device.id); if (!now) return this.send(response, 401, { error: kind === 'computer' ? 'This computer is no longer linked.' : 'This phone is not paired. Pair it again from Settings on the computer.' });
      if (!this.me(now).canRun) return this.send(response, 403, { error: RUN_REFUSED });
      if (!this.host.add) return this.send(response, 409, { error: 'This computer cannot add channels right now.' });
      if (parsed.data.like && !this.local(parsed.data.like)) return this.send(response, 400, { error: 'Unknown channel.' });
      try { await this.host.add(parsed.data.engine, parsed.data.chat === true, parsed.data.like); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The channel could not be added.' }); }
      return this.send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/paste-image') {
      if (kind !== 'computer') return this.send(response, 403, { error: 'Only a linked computer can paste images.' });
      const parsed = pasteSchema.safeParse(await this.body(request, Math.ceil(IMAGE_LIMIT / 3) * 4 + 1024)); if (!parsed.success) return this.send(response, 400, { error: 'That image is too large or not an image (PNG or JPEG, up to 15 MB).' });
      if (!this.devices().some((item) => item.id === device.id)) return this.send(response, 401, { error: 'This computer is no longer linked.' });
      const image = Buffer.from(parsed.data.image, 'base64');
      const png = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); const jpeg = image[0] === 0xff && image[1] === 0xd8;
      if (!png && !jpeg) return this.send(response, 400, { error: 'Only PNG and JPEG images can be pasted.' });
      if (!this.host.pasteImage) return this.send(response, 409, { error: 'This computer cannot take pasted images right now.' });
      try { await this.host.pasteImage({ sessionId: parsed.data.sessionId, runId: parsed.data.runId }, image); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The image could not be pasted.' }); }
      return this.send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/control') {
      if (!this.me(device).canRun) return this.send(response, 403, { error: RUN_REFUSED });
      const parsed = controlSchema.safeParse(await this.body(request)); if (!parsed.success || !this.local(parsed.data.sessionId)) return this.send(response, 400, { error: 'Unknown channel.' });
      const now = this.current(device.id); if (!now) return this.send(response, 401, { error: kind === 'computer' ? 'This computer is no longer linked.' : 'This phone is not paired. Pair it again from Settings on the computer.' });
      if (!this.me(now).canRun) return this.send(response, 403, { error: RUN_REFUSED });
      if (!this.host.control) return this.send(response, 409, { error: 'This computer cannot start or stop channels right now.' });
      try { await this.host.control(parsed.data.sessionId, parsed.data.control); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The channel could not be changed.' }); }
      return this.send(response, 200, { ok: true });
    }
    // Usage, tasks, CLI history and memory cover this computer only; a phone asks each linked computer directly for its own.
    const unpaired = kind === 'computer' ? 'This computer is no longer linked.' : 'This phone is not paired. Pair it again from Settings on the computer.';
    if (request.method === 'GET' && url.pathname === '/api/usage') {
      if (!this.host.usage) return this.send(response, 409, { error: 'This computer cannot show its usage right now.' });
      const { today, limits, budget } = this.host.usage(); return this.send(response, 200, remoteUsage(today, limits, budget));
    }
    if (request.method === 'GET' && url.pathname === '/api/tasks') {
      if (!this.host.tasks) return this.send(response, 409, { error: 'This computer cannot show its tasks right now.' });
      return this.send(response, 200, remoteTasks(this.host.tasks(), this.host.sessions().map((session) => session.id)));
    }
    if (request.method === 'POST' && url.pathname === '/api/task-status') {
      // Reading the board is open to every paired device; moving a card takes the same permission as starting agents.
      if (!this.me(device).canRun) return this.send(response, 403, { error: RUN_REFUSED });
      const parsed = taskStatusSchema.safeParse(await this.body(request)); if (!parsed.success) return this.send(response, 400, { error: 'Invalid task status.' });
      const now = this.current(device.id); if (!now) return this.send(response, 401, { error: unpaired });
      if (!this.me(now).canRun) return this.send(response, 403, { error: RUN_REFUSED });
      if (!this.host.tasks || !this.host.taskStatus) return this.send(response, 409, { error: 'This computer cannot change its tasks right now.' });
      if (!this.host.tasks().some((task) => task.id === parsed.data.id)) return this.send(response, 400, { error: 'Unknown task.' });
      try { await this.host.taskStatus(parsed.data.id, FROM_PHONE[parsed.data.status]); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The task could not be moved.' }); }
      return this.send(response, 200, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/history') {
      if (!this.host.history) return this.send(response, 409, { error: 'This computer cannot show its CLI history right now.' });
      try { return this.send(response, 200, remoteHistory(await this.host.history())); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The CLI history could not be read.' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/history-resume') {
      if (!this.me(device).canRun) return this.send(response, 403, { error: RUN_REFUSED });
      const parsed = resumeSchema.safeParse(await this.body(request)); if (!parsed.success) return this.send(response, 400, { error: 'Unknown conversation.' });
      const now = this.current(device.id); if (!now) return this.send(response, 401, { error: unpaired });
      if (!this.me(now).canRun) return this.send(response, 403, { error: RUN_REFUSED });
      if (!this.host.resume) return this.send(response, 409, { error: 'This computer cannot resume conversations right now.' });
      try { await this.host.resume(parsed.data.key); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The conversation could not be resumed.' }); }
      return this.send(response, 200, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/memory') {
      if (!this.host.memoryProjects || !this.host.memoryNotes) return this.send(response, 409, { error: 'This computer cannot show its memory right now.' });
      try { return this.send(response, 200, this.host.memoryProjects().map((project) => remoteMemory(project, this.host.memoryNotes!(project.project)))); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'Memory could not be read.' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/memory') {
      // A handoff is notes for the agents, not running one, so any paired device may write it.
      const parsed = handoffSchema.safeParse(await this.body(request, 256 * 1024)); if (!parsed.success) return this.send(response, 400, { error: 'A handoff needs a title (up to 200 characters) and notes (up to 60,000).' });
      if (!this.current(device.id)) return this.send(response, 401, { error: unpaired });
      if (!this.host.memoryProjects || !this.host.writeMemory) return this.send(response, 409, { error: 'This computer cannot save handoffs right now.' });
      if (!this.host.memoryProjects().some((project) => project.project === parsed.data.project)) return this.send(response, 400, { error: 'Unknown project.' });
      try { this.host.writeMemory(parsed.data.project, parsed.data.title, parsed.data.content); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The handoff could not be saved.' }); }
      return this.send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/coaching-review') {
      const parsed = z.object({ id: z.uuid() }).strict().safeParse(await this.body(request)); if (!parsed.success) return this.send(response, 400, { error: 'Unknown prompt.' });
      if (!this.host.askCoach) return this.send(response, 409, { error: 'Live coaching is not available on this computer.' });
      try { await this.host.askCoach(parsed.data.id); } catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'The prompt could not be reviewed.' }); }
      this.channelsChanged(); return this.send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/update') {
      if (kind !== 'computer') return this.send(response, 403, { error: 'Only a linked computer can update Trace here.' });
      if (!this.devices().some((item) => item.id === device.id)) return this.send(response, 401, { error: 'This computer is no longer linked.' });
      if (!this.host.update) return this.send(response, 409, { error: 'This computer cannot update Trace right now.' });
      try { return this.send(response, 200, { message: await this.host.update() }); }
      catch (error) { return this.send(response, 409, { error: error instanceof HubError ? error.message : 'Trace could not be updated there.' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/unpair') { this.revoke(device.id); return this.send(response, 200, { ok: true }); }
    if (request.method === 'GET' && url.pathname === '/api/alerts') return this.send(response, 200, { publicKey: this.vapid().publicKey, on: Boolean(device.push) });
    if (request.method === 'POST' && url.pathname === '/api/alerts') {
      const parsed = subscribeSchema.safeParse(await this.body(request));
      const push = parsed.success ? subscriptionSchema.safeParse({ endpoint: parsed.data.endpoint, p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth }) : null;
      if (!push?.success) return this.send(response, 400, { error: 'This browser’s push service is not supported.' });
      if (!this.setPush(device.id, push.data)) return this.send(response, 401, { error: 'This phone is not paired. Pair it again from Settings on the computer.' });
      return this.send(response, 200, { on: true });
    }
    if (request.method === 'DELETE' && url.pathname === '/api/alerts') { this.setPush(device.id, undefined); return this.send(response, 200, { on: false }); }
    return this.send(response, 404, { error: 'Not found.' });
  }
}
