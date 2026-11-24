import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PluginPermission, PluginSummary } from '../../../shared/plugins';
import type { ChannelSummary, WaitOutcome } from '../cli/channel-tools';
import { HubError } from '../cli/engine-adapter';

/**
 * The plugin API (docs/plugins.md, section 3): a loopback address per plugin, with its secret, that its programs (and
 * the `trace` helper) call. Each call needs a permission the plugin's manifest declares; a plugin turned off or removed
 * is refused at once.
 */
export interface PluginApiHost {
  /** The plugin a secret belongs to while it is installed and on. */
  plugin(id: string, token: string): PluginSummary | null;
  channels(): ChannelSummary[];
  replies(sessionId: string, count: number): string[];
  waiting(sessionId: string): string | null;
  wait(sessionId: string, timeoutSeconds: number): Promise<WaitOutcome>;
  send(sessionId: string, text: string): Promise<void>;
  control(sessionId: string, control: 'start' | 'stop'): Promise<void>;
  add(engine: 'claude' | 'codex' | 'gemini' | 'shell', chat: boolean): Promise<void>;
  tasks(): { id: string; title: string; status: string; channel: number | null }[];
  addTask(title: string, details: string | undefined, sessionId: string | null): Promise<{ id: string }>;
  notify(title: string, body: string): void;
}
const channel = z.number().int().min(1).max(64);
const OPS = {
  'channels.list': { permission: 'channels.read', schema: z.object({}).strict() },
  'channels.read': { permission: 'channels.read', schema: z.object({ channel, replies: z.number().int().min(1).max(20).default(3) }).strict() },
  'channels.wait': { permission: 'channels.read', schema: z.object({ channel, timeoutSeconds: z.number().int().min(1).max(1800).default(600) }).strict() },
  'channels.send': { permission: 'channels.send', schema: z.object({ channel, text: z.string().trim().min(1).max(8000) }).strict() },
  'channels.start': { permission: 'channels.control', schema: z.object({ channel }).strict() },
  'channels.stop': { permission: 'channels.control', schema: z.object({ channel }).strict() },
  'channels.add': { permission: 'channels.control', schema: z.object({ engine: z.enum(['claude', 'codex', 'gemini', 'shell']), chat: z.boolean().default(false) }).strict() },
  'tasks.list': { permission: 'tasks', schema: z.object({}).strict() },
  'tasks.add': { permission: 'tasks', schema: z.object({ title: z.string().trim().min(1).max(150), details: z.string().max(2000).optional(), channel: channel.optional() }).strict() },
  'notify': { permission: 'notify', schema: z.object({ title: z.string().trim().min(1).max(100), body: z.string().max(500).default('') }).strict() },
} as const satisfies Record<string, { permission: PluginPermission; schema: z.ZodType }>;
export type PluginOp = keyof typeof OPS;

export class PluginApi {
  private server: http.Server | null = null; private port: number | null = null;
  constructor(private host: PluginApiHost) {}
  start() {
    return new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => void this.handle(request, response));
      server.on('error', (error) => { if (this.server !== server) reject(error); });
      server.listen(0, '127.0.0.1', () => { this.server = server; this.port = (server.address() as AddressInfo).port; resolve(); });
    });
  }
  /** The address a plugin's programs call, or null while the API is not listening. */
  url(id: string, token: string) { return this.port === null ? null : `http://127.0.0.1:${this.port}/plugin/${encodeURIComponent(id)}/${token}`; }
  close() { this.server?.close(); this.server = null; this.port = null; }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const answer = (status: number, body: unknown) => { if (response.headersSent) return; response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    const match = /^\/plugin\/([^/]{1,300})\/([0-9a-f]{64})\/([a-z.]{1,40})$/.exec(request.url ?? '');
    if (request.method !== 'POST' || !match) { request.resume(); answer(404, { error: 'Not found.' }); return; }
    const id = decodeURIComponent(match[1]); const plugin = this.host.plugin(id, match[2]);
    if (!plugin) { request.resume(); answer(401, { error: 'This plugin is turned off or removed in Trace, or its address is out of date.' }); return; }
    let size = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 64 * 1024) throw new HubError('PLUGIN_API_INPUT', 'That request is too large.'); chunks.push(chunk as Buffer); }
      answer(200, await this.run(plugin, match[3], JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')));
    } catch (error) { answer(error instanceof HubError ? 409 : 400, { error: error instanceof HubError ? error.message : error instanceof z.ZodError ? `Invalid request: ${error.issues.slice(0, 2).map((issue) => `${issue.path.join('.') || 'body'} ${issue.message}`).join('; ')}.` : 'The request could not be read.' }); }
  }

  /** One call for `plugin`, with its permission checked. */
  async run(plugin: PluginSummary, op: string, body: unknown): Promise<unknown> {
    const spec = (OPS as Record<string, { permission: PluginPermission; schema: z.ZodType }>)[op];
    if (!spec) throw new HubError('PLUGIN_API_OP', `Trace has no ${op}. It has ${Object.keys(OPS).join(', ')}.`);
    if (!plugin.permissions.includes(spec.permission)) throw new HubError('PLUGIN_API_PERMISSION', `${plugin.name} did not ask for ${spec.permission} in its manifest, so it cannot use ${op}.`);
    const request = spec.schema.parse(body) as Record<string, unknown>;
    const channels = this.host.channels().map((item) => ({ ...item, waiting: item.waiting ?? this.host.waiting(item.sessionId) }));
    const target = () => { const found = channels.find((item) => item.channel === request.channel); if (!found) throw new HubError('PLUGIN_API_CHANNEL', `There is no CH${String(request.channel)}.`); return found; };
    switch (op as PluginOp) {
      case 'channels.list': return { channels: channels.map(({ sessionId: _id, ...item }) => item) };
      case 'channels.read': { const found = target(); return { channel: found.channel, name: found.name, replies: this.host.replies(found.sessionId, request.replies as number) }; }
      case 'channels.wait': { const found = target(); if (!found.running) return { channel: found.channel, outcome: 'stopped' }; if (found.waiting) return { channel: found.channel, outcome: 'waiting', waiting: found.waiting }; return { channel: found.channel, outcome: await this.host.wait(found.sessionId, request.timeoutSeconds as number) }; }
      case 'channels.send': {
        const found = target(); if (!found.running) throw new HubError('PLUGIN_API_STOPPED', `CH${found.channel} is not running.`);
        // Its Enter would answer the approval it waits for: that is the person's to answer.
        if (found.waiting) throw new HubError('PLUGIN_API_WAITING', `CH${found.channel} is waiting for the person to answer: ${found.waiting}.`);
        await this.host.send(found.sessionId, `[Message from the plugin ${plugin.name}: not the person]\n${String(request.text)}`); return { sent: true, channel: found.channel };
      }
      case 'channels.start': case 'channels.stop': { const found = target(); await this.host.control(found.sessionId, op === 'channels.start' ? 'start' : 'stop'); return { channel: found.channel, [op === 'channels.start' ? 'started' : 'stopped']: true }; }
      case 'channels.add': await this.host.add(request.engine as 'claude', request.chat as boolean); return { added: true };
      case 'tasks.list': return { tasks: this.host.tasks() };
      case 'tasks.add': { const sessionId = request.channel === undefined ? null : target().sessionId; return this.host.addTask(String(request.title), request.details as string | undefined, sessionId); }
      case 'notify': this.host.notify(`${plugin.name}: ${String(request.title)}`, String(request.body)); return { shown: true };
    }
  }
}
/** Whether two secrets match, without leaking how much of one matched. */
export const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
