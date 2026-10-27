import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/** Strips control characters and bounds the length of a CLI-provided message before it reaches the UI. */
export function cleanMessage(text: string) {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Extracts OSC 9 desktop notifications (`ESC ] 9 ; message BEL|ST`) from terminal output.
 * Chunks can split a sequence, so an unfinished one is carried into the next call.
 * `OSC 9;4` is ConEmu/Windows Terminal progress, not a notification, and is ignored.
 */
export class OscNotifications {
  private carry = '';
  push(chunk: string): string[] {
    const text = this.carry + chunk; this.carry = '';
    const messages: string[] = []; let index = 0;
    for (;;) {
      const start = text.indexOf('\x1b]9;', index);
      if (start < 0) break;
      const end = text.slice(start).search(/\x07|\x1b\\/);
      if (end < 0) { if (text.length - start <= 2048) this.carry = text.slice(start); break; }
      const body = text.slice(start + 4, start + end);
      if (!/^4;/.test(body)) { const message = cleanMessage(body); if (message) messages.push(message); }
      index = start + end + 1;
    }
    // A sequence can also be cut inside its opening bytes.
    if (!this.carry) { const tail = text.slice(-3); const partial = ['\x1b', '\x1b]', '\x1b]9'].find((prefix) => tail.endsWith(prefix)); if (partial) this.carry = partial; }
    return messages;
  }
}

/** Claude Code notification types that mean the person has to act before the agent continues. */
const NEEDS_PERSON = new Set(['permission_prompt', 'elicitation_dialog']);

/**
 * A loopback endpoint for Claude Code's HTTP `Notification` hook. Each run gets its own secret
 * path, so only the CLI the app launched can report that it is waiting.
 */
export class AttentionServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private runs = new Map<string, Buffer>();
  /** `onResolved` hears that the agent carried on (a tool finished or the turn ended), so a waiting prompt was answered. */
  constructor(private onAttention: (runId: string, message: string) => void, private onResolved: (runId: string) => void = () => {}) {}

  /** Starts listening on a random loopback port. Sessions started before it is ready run without attention hooks. */
  start() {
    return new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => this.handle(request, response));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { this.server = server; this.port = (server.address() as AddressInfo).port; resolve(); });
    });
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const done = (status: number) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end('{}'); };
    const match = /^\/hook\/([0-9a-f-]{36})\/([0-9a-f]{64})(\/resolved)?$/.exec(request.url ?? '');
    const token = match && this.runs.get(match[1]);
    if (request.method !== 'POST' || !match || !token || !timingSafeEqual(token, Buffer.from(match[2], 'hex'))) { request.resume(); done(404); return; }
    // The path alone says the agent moved on; tool results can be large, so the body is never read.
    if (match[3]) { request.resume(); done(200); this.onResolved(match[1]); return; }
    let size = 0; const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 64 * 1024) chunks.push(chunk); });
    request.on('end', () => {
      done(200);
      if (size > 64 * 1024) return;
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { notification_type?: unknown; message?: unknown };
        if (typeof input.notification_type === 'string' && NEEDS_PERSON.has(input.notification_type)) this.onAttention(match[1], cleanMessage(typeof input.message === 'string' ? input.message : '') || 'Waiting for your approval');
      } catch { /* Not a hook payload. */ }
    });
  }

  /** Returns the hook URL for a run, or null while the endpoint is unavailable. */
  register(runId: string) {
    if (this.port === null) return null;
    const token = randomBytes(32); this.runs.set(runId, token);
    return `http://127.0.0.1:${this.port}/hook/${runId}/${token.toString('hex')}`;
  }
  unregister(runId: string) { this.runs.delete(runId); }
  close() { this.runs.clear(); this.server?.close(); this.server = null; this.port = null; }
}

/**
 * Claude `--settings` JSON that sends Notification hooks to the app (the type is filtered on arrival), and reports
 * finished tools and turns so a permission prompt answered before its notification arrived still clears.
 */
export function claudeAttentionSettings(url: string) {
  const resolved = [{ hooks: [{ type: 'http', url: `${url}/resolved`, timeout: 5 }] }];
  return JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: 'http', url, timeout: 5 }] }], PostToolUse: resolved, Stop: resolved } });
}

/** Codex config that reports approval requests as OSC 9 notifications in its terminal. */
export const CODEX_ATTENTION_CONFIG = ['tui.notifications=["approval-requested"]', 'tui.notification_method="osc9"', 'tui.notification_condition="always"'];

/** HTTP hooks arrived in Claude Code 2.1.63; older versions do not document how they treat an unknown hook type. */
export function supportsHttpHooks(version: string | null) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 63)));
}

/** Keeps the loopback hook request away from any configured HTTP proxy. */
export function withLoopbackNoProxy(env: Record<string, string | undefined>) {
  const current = env.NO_PROXY ?? env.no_proxy ?? '';
  const value = [...new Set([...current.split(',').map((entry) => entry.trim()).filter(Boolean), '127.0.0.1', 'localhost'])].join(',');
  return { NO_PROXY: value, no_proxy: value };
}
