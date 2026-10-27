import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AttentionServer, OscNotifications, claudeAttentionSettings, cleanMessage, supportsHttpHooks, withLoopbackNoProxy } from './attention';

describe('OSC 9 notifications', () => {
  it('reads notifications ended by BEL or ST and ignores progress reports', () => {
    const osc = new OscNotifications();
    expect(osc.push('output \x1b]9;Approval requested: npm test\x07 more \x1b]9;4;1;50\x07 \x1b]9;Second\x1b\\')).toEqual(['Approval requested: npm test', 'Second']);
  });
  it('joins a sequence split across chunks, including inside its opening bytes', () => {
    const osc = new OscNotifications();
    expect(osc.push('text \x1b')).toEqual([]); expect(osc.push(']9;Run rm')).toEqual([]); expect(osc.push(' -rf build?\x07after')).toEqual(['Run rm -rf build?']);
    expect(osc.push('plain output with no sequence')).toEqual([]);
  });
  it('strips control characters and bounds message length', () => {
    expect(cleanMessage('a\x1b[31mb\nc' + 'x'.repeat(400)).length).toBe(200);
    expect(cleanMessage('  Approve\tedit\r\n ')).toBe('Approve edit');
  });
});

describe('Claude attention endpoint', () => {
  const servers: AttentionServer[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.close(); });
  async function setup() {
    const seen: [string, string][] = [];
    const server = new AttentionServer((runId, message) => seen.push([runId, message])); servers.push(server); await server.start();
    return { server, seen };
  }
  const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('reports permission prompts for a registered run and ignores idle notices', async () => {
    const { server, seen } = await setup(); const runId = randomUUID(); const url = server.register(runId)!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f-]{36}\/[0-9a-f]{64}$/);
    expect((await post(url, { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })).status).toBe(200);
    expect((await post(url, { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })).status).toBe(200);
    expect(seen).toEqual([[runId, 'Claude needs your permission to use Bash']]);
  });
  it('rejects unknown runs, wrong tokens, other methods and oversized bodies', async () => {
    const { server, seen } = await setup(); const runId = randomUUID(); const url = server.register(runId)!;
    expect((await post(url.replace(/[0-9a-f]{64}$/, '0'.repeat(64)), { notification_type: 'permission_prompt' })).status).toBe(404);
    expect((await post(url.replace(runId, randomUUID()), { notification_type: 'permission_prompt' })).status).toBe(404);
    expect((await fetch(url)).status).toBe(404);
    expect((await post(url, JSON.stringify({ notification_type: 'permission_prompt', message: 'x'.repeat(70 * 1024) }))).status).toBe(200);
    server.unregister(runId); expect((await post(url, { notification_type: 'permission_prompt' })).status).toBe(404);
    expect(seen).toEqual([]);
  });
  it('builds Claude settings with an HTTP Notification hook', () => {
    const resolved = [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/hook/x/y/resolved', timeout: 5 }] }];
    expect(JSON.parse(claudeAttentionSettings('http://127.0.0.1:1/hook/x/y'))).toEqual({ hooks: { Notification: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/hook/x/y', timeout: 5 }] }], PostToolUse: resolved, Stop: resolved } });
  });
  it('reports a finished tool or turn as resolved without reading its body, only for a valid token', async () => {
    const resolved: string[] = []; const seen: [string, string][] = [];
    const server = new AttentionServer((runId, message) => seen.push([runId, message]), (runId) => resolved.push(runId)); servers.push(server); await server.start();
    const runId = randomUUID(); const url = server.register(runId)!;
    expect((await post(url + '/resolved', JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(200 * 1024) }))).status).toBe(200);
    expect((await post(url.replace(/[0-9a-f]{64}$/, '0'.repeat(64)) + '/resolved', {})).status).toBe(404);
    expect(resolved).toEqual([runId]); expect(seen).toEqual([]);
  });
});

describe('launch helpers', () => {
  it('enables Claude HTTP hooks only from 2.1.63', () => {
    expect(supportsHttpHooks('2.1.310 (Claude Code)')).toBe(true); expect(supportsHttpHooks('2.1.63')).toBe(true); expect(supportsHttpHooks('3.0.0')).toBe(true);
    expect(supportsHttpHooks('2.1.62')).toBe(false); expect(supportsHttpHooks('2.0.99')).toBe(false); expect(supportsHttpHooks(null)).toBe(false);
  });
  it('adds loopback to NO_PROXY without dropping existing entries', () => {
    expect(withLoopbackNoProxy({ NO_PROXY: 'corp.example, localhost' })).toEqual({ NO_PROXY: 'corp.example,localhost,127.0.0.1', no_proxy: 'corp.example,localhost,127.0.0.1' });
    expect(withLoopbackNoProxy({}).NO_PROXY).toBe('127.0.0.1,localhost');
  });
});
