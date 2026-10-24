import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { RunReference, RunningSession } from '../../../shared/ipc';
import { RemoteServer, type RemoteHost } from './remote-server';
import { tailscaleState } from './tailscale';

const cleanup: (() => Promise<void> | void)[] = [];
const titles = ['Claude Code', 'Codex'];
afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); titles.splice(0, 2, 'Claude Code', 'Codex'); });

async function remote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const running: RunningSession[] = [{ sessionId: 's1', runId: 'r1', pid: 1, cwd: '/p', engine: 'claude' }];
  const writes: { reference: RunReference; data: string }[] = [];
  const host: RemoteHost = {
    sessions: () => [{ id: 's1', title: titles[0], engine: 'claude' }, { id: 's2', title: titles[1], engine: 'codex' }],
    running: () => running,
    write: (reference, data) => { if (!running.some((run) => run.runId === reference.runId)) throw new Error('stale'); writes.push({ reference, data }); },
  };
  const server = new RemoteServer(root, host, 0); cleanup.push(() => server.stop());
  return { root, server, writes, running };
}
const base = (server: RemoteServer) => `http://127.0.0.1:${server.address}`;
const request = (server: RemoteServer, pathname: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address!, path: pathname, headers }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body })); });
  req.on('error', reject); req.end();
});
async function paired(server: RemoteServer) {
  const code = server.pair().pairing!.code;
  const response = await fetch(base(server) + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Test phone' }) });
  return (await response.json() as { token: string }).token;
}
/** Reads server-sent events from the stream until `count` have arrived. */
async function events(server: RemoteServer, token: string, sessionId: string | null, count: number, during?: () => void) {
  const controller = new AbortController(); const response = await fetch(base(server) + '/api/stream' + (sessionId ? `?sessionId=${sessionId}` : ''), { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; const seen: { type: string; data: unknown }[] = [];
  let triggered = false;
  while (seen.length < count) {
    const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
    let end; while ((end = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); const type = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1]; if (type && data) seen.push({ type, data: JSON.parse(data) }); }
    if (!triggered && during) { triggered = true; during(); }
  }
  controller.abort(); return seen;
}

describe('phone remote', () => {
  it('stays off until turned on, and then listens on loopback only', async () => {
    const { server } = await remote(); await server.start(); expect(server.address).toBeNull();
    await server.setEnabled(true); expect(server.status()).toMatchObject({ enabled: true, listening: true });
    const page = await request(server, '/'); expect(page.status).toBe(200); expect(page.body).toContain('Pair this phone');
    expect((server as unknown as { server: http.Server }).server.address()).toMatchObject({ address: '127.0.0.1' });
  });

  it('refuses unknown host names, cross-site requests and Tailscale Funnel traffic', async () => {
    const { server } = await remote(); await server.setEnabled(true);
    expect((await request(server, '/', { Host: 'evil.example' })).status).toBe(421);
    server.tailscale = { ...server.tailscale, host: 'desk.example.ts.net' };
    expect((await request(server, '/', { Host: 'desk.example.ts.net' })).status).toBe(200);
    expect((await request(server, '/api/channels', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await request(server, '/', { 'Tailscale-Funnel-Request': '?1' })).status).toBe(403);
  });

  it('pairs a phone once with a short-lived code and stores only a hash of its key', async () => {
    const { server, root } = await remote(); await server.setEnabled(true);
    const code = server.pair().pairing!.code; expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    const attempt = (value: string) => fetch(base(server) + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: value, name: 'Phone\u0007' }) });
    expect((await attempt('WRONGCODE2')).status).toBe(401);
    const response = await attempt(code.toLowerCase()); expect(response.status).toBe(200);
    const { token, device } = await response.json() as { token: string; device: { name: string } };
    expect(device.name).toBe('Phone'); expect((await attempt(code)).status).toBe(401);
    const stored = fs.readFileSync(path.join(root, 'remote-devices.json'), 'utf8'); expect(stored).not.toContain(token);
    expect(server.status().devices).toHaveLength(1); expect(server.status().pairing).toBeNull();
  });

  it('drops a pairing code after ten wrong tries', async () => {
    const { server } = await remote(); await server.setEnabled(true); const code = server.pair().pairing!.code;
    for (let i = 0; i < 10; i++) await fetch(base(server) + '/api/pair', { method: 'POST', body: JSON.stringify({ code: 'AAAAAAAAAA', name: 'x' }) });
    const last = await fetch(base(server) + '/api/pair', { method: 'POST', body: JSON.stringify({ code, name: 'x' }) });
    expect(last.status).toBe(401); expect(server.status().pairing).toBeNull();
  });

  it('needs a device key for everything but the page and pairing, and revoking one locks it out', async () => {
    const { server } = await remote(); await server.setEnabled(true); const token = await paired(server);
    expect((await fetch(base(server) + '/api/channels')).status).toBe(401);
    expect((await fetch(base(server) + '/api/channels', { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } })).status).toBe(401);
    const channels = await (await fetch(base(server) + '/api/channels', { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(channels).toEqual([expect.objectContaining({ channel: 1, title: 'Claude Code', running: true, runId: 'r1' }), expect.objectContaining({ channel: 2, running: false, runId: null })]);
    server.revoke(server.status().devices[0].id);
    expect((await fetch(base(server) + '/api/channels', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('streams the current screen, live output and waiting prompts, and passes typing to the CLI', async () => {
    const { server, writes } = await remote(); await server.setEnabled(true); const token = await paired(server);
    server.onSessionEvent({ type: 'started', sessionId: 's1', runId: 'r1', pid: 1, cwd: '/p', engine: 'claude' });
    server.onSessionEvent({ type: 'data', sessionId: 's1', runId: 'r1', data: 'earlier output\r\n' });
    const seen = await events(server, token, 's1', 4, () => {
      server.onSessionEvent({ type: 'data', sessionId: 's1', runId: 'r1', data: 'Allow command? [y/n]' });
      server.onSessionEvent({ type: 'attention', sessionId: 's1', runId: 'r1', message: 'Approval requested: npm test', at: new Date().toISOString() });
    });
    expect(seen.map((item) => item.type)).toEqual(['channels', 'replay', 'output', 'channels']);
    expect(seen[1].data).toMatchObject({ data: 'earlier output\r\n' });
    expect((seen[3].data as { attention: string | null }[])[0].attention).toBe('Approval requested: npm test');
    const send = (body: unknown) => fetch(base(server) + '/api/input', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await send({ sessionId: 's1', runId: 'r1', data: 'y' })).status).toBe(200);
    expect(writes).toEqual([{ reference: { sessionId: 's1', runId: 'r1' }, data: 'y' }]);
    expect(server.channels()[0].attention).toBeNull();
    expect((await send({ sessionId: 's1', runId: 'old', data: 'y' })).status).toBe(409);
    expect((await send({ sessionId: 's1', runId: 'r1', data: 'x'.repeat(5000) })).status).toBe(400);
  });

  it('refuses input from a phone removed while its request was still arriving', async () => {
    const { server, writes } = await remote(); await server.setEnabled(true); const token = await paired(server);
    const result = new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address!, path: '/api/input', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (response) => { response.resume(); resolve(response.statusCode!); });
      req.on('error', reject); req.write('{"sessionId":"s1","runId":"r1",');
      setTimeout(() => { server.revoke(server.status().devices[0].id); req.end('"data":"y"}'); }, 100);
    });
    expect(await result).toBe(401); expect(writes).toEqual([]);
  });

  it('tells connected phones when the saved channels change, and only when the list they see is different', async () => {
    const { server } = await remote(); await server.setEnabled(true); const token = await paired(server);
    const seen = await events(server, token, null, 2, () => { titles[0] = 'Renamed'; server.channelsChanged(); });
    expect((seen[1].data as { title: string }[])[0].title).toBe('Renamed');
  });

  it('clears a waiting prompt when the person answers on the desktop, but not for focus reports', async () => {
    const { server } = await remote(); await server.setEnabled(true);
    server.onSessionEvent({ type: 'attention', sessionId: 's1', runId: 'r1', message: 'Approve?', at: new Date().toISOString() });
    server.personInput('s1', '\x1b[I'); expect(server.channels()[0].attention).toBe('Approve?');
    server.personInput('s1', 'y'); expect(server.channels()[0].attention).toBeNull();
  });
});

describe('tailscale state', () => {
  const runner = (outputs: Record<string, string | Error>) => async (args: string[]) => { const value = outputs[args.join(' ')]; if (value instanceof Error) throw value; if (value === undefined) throw new Error('unexpected ' + args.join(' ')); return value; };
  it('reports not installed, stopped, serving and funnel', async () => {
    expect(await tailscaleState(runner({ 'status --json': Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }) }), 47821)).toMatchObject({ installed: false });
    expect(await tailscaleState(runner({ 'status --json': JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'desk.ts.net.' } }) }), 47821)).toMatchObject({ installed: true, running: false });
    const serving = { Web: { 'desk.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47821' } } } } };
    expect(await tailscaleState(runner({ 'status --json': JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desk.example.ts.net.' } }), 'serve status --json': JSON.stringify(serving) }), 47821))
      .toMatchObject({ running: true, host: 'desk.example.ts.net', serving: true, funnel: false });
    expect(await tailscaleState(runner({ 'status --json': JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desk.example.ts.net.' } }), 'serve status --json': JSON.stringify({ ...serving, AllowFunnel: { 'desk.example.ts.net:443': true } }) }), 47821))
      .toMatchObject({ serving: true, funnel: true });
    expect(await tailscaleState(runner({ 'status --json': JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desk.example.ts.net.' } }), 'serve status --json': '' }), 47821)).toMatchObject({ serving: false });
    // HTTPS on another port is not the address the pairing link uses.
    expect(await tailscaleState(runner({ 'status --json': JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desk.example.ts.net.' } }), 'serve status --json': JSON.stringify({ Web: { 'desk.example.ts.net:8443': serving.Web['desk.example.ts.net:443'] } }) }), 47821)).toMatchObject({ serving: false });
  });
});
