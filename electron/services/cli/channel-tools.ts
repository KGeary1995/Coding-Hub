import http from 'node:http';
import { listenLoopback, savedToken } from './loopback';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SessionEvent } from '../../../shared/ipc';
import type { ChatEnvelope } from '../../../shared/chat';
import { HubError } from './engine-adapter';
import { runTaskTool, type TaskAction, type TaskToolsHost } from './task-tools';

/**
 * Channel tools (1.33.0, from herdr's agent automation): an agent in one channel can list this computer's channels,
 * read another's recent replies, send it a message, and wait for its turn to end. Off unless the person turns on
 * Settings → Preferences → "Let agents see and message other channels". Each agent run gets its own secret address here
 * (loopback only), which says which run is asking; Trace's channel-tools MCP server calls it for the agent. The task tools
 * (task-tools.ts) ride the same server and address behind their own setting, "Let agents read and update Tasks".
 */
export interface ChannelSummary { channel: number; sessionId: string; name: string; engine: string; running: boolean; waiting: string | null; folder: string | null }
export interface ChannelToolsHost {
  enabled(): boolean;
  /** This computer's channels in order, Round Table seats left out (the lead stands for its table). */
  channels(): ChannelSummary[];
  /** The session a run belongs to. */
  sessionOf(runId: string): string | null;
  /** The last `count` replies of a channel's conversation, as text. */
  replies(sessionId: string, count: number): string[];
  /** Types `text` into a running channel as a message, as a phone would. */
  send(sessionId: string, text: string): Promise<void>;
}
export type WaitOutcome = 'turn-ended' | 'waiting' | 'stopped' | 'timeout';
type Action = 'list' | 'read' | 'send' | 'wait' | 'tools' | TaskAction;

const listSchema = z.object({}).strict();
const readSchema = z.object({ channel: z.number().int().min(1).max(64), replies: z.number().int().min(1).max(20).default(3) }).strict();
const sendSchema = z.object({ channel: z.number().int().min(1).max(64), text: z.string().trim().min(1).max(8000) }).strict();
const waitSchema = z.object({ channel: z.number().int().min(1).max(64), timeoutSeconds: z.number().int().min(1).max(1800).default(600) }).strict();

export class ChannelTools {
  private server: http.Server | null = null;
  private port: number | null = null;
  private runs = new Map<string, Buffer>();
  /** Waits for a channel's next turn end, approval or stop, by session. */
  private waiters = new Map<string, Set<(outcome: WaitOutcome) => void>>();
  /** What each channel waits for the person to answer, from its last approval request until it carries on. */
  private asking = new Map<string, string>();
  /** The task tools' host, set once Trace's tasks are loaded; until then (and in the smoke) they are off. */
  tasks: TaskToolsHost | null = null;
  constructor(private host: ChannelToolsHost) {}
  private tasksOn() { return this.tasks?.enabled() === true; }

  /** Listens on loopback, on `port` (the one it had last time) when free, so agents still running from before reach it. */
  async start(port?: number | null) {
    const server = http.createServer((request, response) => void this.handle(request, response));
    this.port = await listenLoopback(server, port); this.server = server; server.on('error', () => {});
  }
  get listening() { return this.port; }
  /** The address for one run, or null while both groups of tools are off or it is not listening. */
  register(runId: string) {
    if (this.port === null || !this.host.enabled() && !this.tasksOn()) return null;
    const token = randomBytes(32); this.runs.set(runId, token);
    return `http://127.0.0.1:${this.port}/channels/${runId}/${token.toString('hex')}`;
  }
  unregister(runId: string) { this.runs.delete(runId); }
  /** A run's token, kept with its terminal in the background runner. */
  token(runId: string) { return this.runs.get(runId)?.toString('hex') ?? null; }
  /** A run the background runner kept while Trace was closed: its agent still calls with the token it was started with. */
  restore(runId: string, hex: unknown) { const token = savedToken(hex); if (token) this.runs.set(runId, token); }
  close() { this.runs.clear(); for (const set of this.waiters.values()) for (const done of set) done('stopped'); this.waiters.clear(); this.server?.close(); this.server = null; this.port = null; }

  /** A channel's turn ended, it asks for an approval, or it stopped: anyone waiting on it hears so. */
  onSessionEvent(event: SessionEvent) {
    if (event.type === 'answered' || event.type === 'started' || event.type === 'exit') this.asking.delete(event.sessionId);
    if (event.type === 'answered' && event.finished) this.settle(event.sessionId, 'turn-ended');
    else if (event.type === 'attention') { this.asking.set(event.sessionId, event.message); this.settle(event.sessionId, 'waiting'); }
    else if (event.type === 'exit') { this.settle(event.sessionId, 'stopped'); this.unregister(event.runId); }
  }
  onChat(envelope: ChatEnvelope) { if (envelope.event.type === 'done') this.settle(envelope.sessionId, 'turn-ended'); }
  /** The next turn end, approval request or stop of a running channel, or 'timeout' (also used by the plugin API). */
  waitFor(sessionId: string, timeoutSeconds: number) {
    return new Promise<WaitOutcome>((resolve) => {
      const set = this.waiters.get(sessionId) ?? new Set(); this.waiters.set(sessionId, set);
      const done = (value: WaitOutcome) => { clearTimeout(timer); set.delete(done); resolve(value); };
      const timer = setTimeout(() => done('timeout'), timeoutSeconds * 1000); set.add(done);
    });
  }
  /** What a channel waits for the person to answer, if anything. */
  waitingOf(sessionId: string) { return this.asking.get(sessionId) ?? null; }
  private settle(sessionId: string, outcome: WaitOutcome) { const set = this.waiters.get(sessionId); if (!set) return; this.waiters.delete(sessionId); for (const done of set) done(outcome); }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const answer = (status: number, body: unknown) => { if (response.headersSent) return; response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    const match = /^\/channels\/([0-9a-f-]{36})\/([0-9a-f]{64})\/(list|read|send|wait|tools|task-list|task-add|task-update)$/.exec(request.url ?? '');
    const token = match && this.runs.get(match[1]);
    if (request.method !== 'POST' || !match || !token || !timingSafeEqual(token, Buffer.from(match[2], 'hex'))) { request.resume(); answer(404, { error: 'Not found.' }); return; }
    let size = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 64 * 1024) throw new HubError('CHANNEL_TOOLS_INPUT', 'That request is too large.'); chunks.push(chunk as Buffer); }
      const action = match[3] as Action; const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
      // Which tools the server lists: each group only while its setting is on.
      if (action === 'tools') { answer(200, { channels: this.host.enabled(), tasks: this.tasksOn() }); return; }
      // Turned off since the run started: its tools stop working at once.
      if (action.startsWith('task-')) { if (!this.tasksOn()) throw new HubError('TASK_TOOLS_OFF', 'Task tools are off. The person can turn them on in Trace: Settings → Preferences → Let agents read and update Tasks.'); }
      else if (!this.host.enabled()) throw new HubError('CHANNEL_TOOLS_OFF', 'Channel tools are off. The person can turn them on in Trace: Settings → Preferences → Let agents see and message other channels.');
      answer(200, await this.run(match[1], action as Exclude<Action, 'tools'>, body));
    } catch (error) { answer(error instanceof HubError ? 409 : 400, { error: error instanceof HubError ? error.message : error instanceof z.ZodError ? `Invalid request: ${error.issues.slice(0, 3).map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ')}` : 'The request could not be read.' }); }
  }

  /** What each tool does, for the run asking (`runId`). */
  async run(runId: string, action: Exclude<Action, 'tools'>, body: unknown): Promise<unknown> {
    const self = this.host.sessionOf(runId);
    const channels = this.host.channels().map((item) => ({ ...item, waiting: item.waiting ?? this.asking.get(item.sessionId) ?? null }));
    if (action.startsWith('task-')) {
      if (!this.tasks) throw new HubError('TASK_TOOLS_OFF', 'Task tools are not ready yet. Try again in a moment.');
      const own = channels.find((item) => item.sessionId === self);
      return runTaskTool(this.tasks, { runId, sessionId: self, label: own ? `CH${own.channel}` : 'Agent', name: own?.name ?? null }, action as TaskAction, body);
    }
    const target = (channel: number) => { const found = channels.find((item) => item.channel === channel); if (!found) throw new HubError('CHANNEL_TOOLS_CHANNEL', `There is no CH${channel}. list_channels lists them.`); return found; };
    if (action === 'list') { listSchema.parse(body); return { channels: channels.map(({ sessionId, ...item }) => ({ ...item, you: sessionId === self })) }; }
    if (action === 'read') { const request = readSchema.parse(body); const channel = target(request.channel); return { channel: channel.channel, name: channel.name, replies: this.host.replies(channel.sessionId, request.replies) }; }
    if (action === 'send') {
      const request = sendSchema.parse(body); const channel = target(request.channel); const from = channels.find((item) => item.sessionId === self);
      if (channel.sessionId === self) throw new HubError('CHANNEL_TOOLS_SELF', 'That is your own channel.');
      if (!channel.running) throw new HubError('CHANNEL_TOOLS_STOPPED', `CH${channel.channel} is not running. The person can start it.`);
      // Its Enter would answer the approval it waits for: that is the person's to answer.
      if (channel.waiting) throw new HubError('CHANNEL_TOOLS_WAITING', `CH${channel.channel} is waiting for the person to answer: ${channel.waiting}. It can be messaged once they have.`);
      await this.host.send(channel.sessionId, `[Message from ${from ? `CH${from.channel} (${from.name})` : 'another channel'}: an agent, not the person]\n${request.text}`);
      return { sent: true, channel: channel.channel };
    }
    const request = waitSchema.parse(body); const channel = target(request.channel);
    if (channel.sessionId === self) throw new HubError('CHANNEL_TOOLS_SELF', 'That is your own channel.');
    if (!channel.running) return { channel: channel.channel, outcome: 'stopped' };
    if (channel.waiting) return { channel: channel.channel, outcome: 'waiting', waiting: channel.waiting };
    return { channel: channel.channel, outcome: await this.waitFor(channel.sessionId, request.timeoutSeconds) };
  }
}
