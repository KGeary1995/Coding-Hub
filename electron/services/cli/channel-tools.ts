import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SessionEvent } from '../../../shared/ipc';
import type { ChatEnvelope } from '../../../shared/chat';
import { HubError } from './engine-adapter';

/**
 * Channel tools (1.33.0, from herdr's agent automation): an agent in one channel can list this computer's channels,
 * read another's recent replies, send it a message, and wait for its turn to end. Off unless the person turns on
 * Settings → Preferences → "Let agents see and message other channels". Each agent run gets its own secret address here
 * (loopback only), which says which run is asking; Trace's channel-tools MCP server calls it for the agent.
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
  constructor(private host: ChannelToolsHost) {}

  start() {
    return new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => void this.handle(request, response));
      server.on('error', (error) => { if (this.server !== server) reject(error); });
      server.listen(0, '127.0.0.1', () => { this.server = server; this.port = (server.address() as AddressInfo).port; resolve(); });
    });
  }
  /** The address for one run, or null while the tools are off or not listening. */
  register(runId: string) {
    if (this.port === null || !this.host.enabled()) return null;
    const token = randomBytes(32); this.runs.set(runId, token);
    return `http://127.0.0.1:${this.port}/channels/${runId}/${token.toString('hex')}`;
  }
  unregister(runId: string) { this.runs.delete(runId); }
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
    const match = /^\/channels\/([0-9a-f-]{36})\/([0-9a-f]{64})\/(list|read|send|wait)$/.exec(request.url ?? '');
    const token = match && this.runs.get(match[1]);
    if (request.method !== 'POST' || !match || !token || !timingSafeEqual(token, Buffer.from(match[2], 'hex'))) { request.resume(); answer(404, { error: 'Not found.' }); return; }
    let size = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 64 * 1024) throw new HubError('CHANNEL_TOOLS_INPUT', 'That request is too large.'); chunks.push(chunk as Buffer); }
      // Turned off since the run started: its tools stop working at once.
      if (!this.host.enabled()) throw new HubError('CHANNEL_TOOLS_OFF', 'Channel tools are off. The person can turn them on in Trace: Settings → Preferences → Let agents see and message other channels.');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
      answer(200, await this.run(match[1], match[3] as 'list' | 'read' | 'send' | 'wait', body));
    } catch (error) { answer(error instanceof HubError ? 409 : 400, { error: error instanceof HubError ? error.message : error instanceof z.ZodError ? 'Invalid request.' : 'The request could not be read.' }); }
  }

  /** What each tool does, for the run asking (`runId`). */
  async run(runId: string, action: 'list' | 'read' | 'send' | 'wait', body: unknown): Promise<unknown> {
    const self = this.host.sessionOf(runId);
    const channels = this.host.channels().map((item) => ({ ...item, waiting: item.waiting ?? this.asking.get(item.sessionId) ?? null }));
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
