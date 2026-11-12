import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import type { RunReference, RunningSession } from '../../../shared/ipc';
import { eventJSON, RemoteServer, type RemoteHost } from './remote-server';
import { HubError } from '../cli/engine-adapter';
import { localScreenToken, ScreenService, SHARE_FILE } from './screen-service-server';
import { openTraceScreen } from './screen-sharing';
import { serveFailure, stopServing, TAILSCALE_DNS_SETTINGS, tailscaleEnvironment, tailscaleExecutable, tailscalePeers, tailscaleState } from './tailscale';

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
  const phone = path.join(root, 'phone'); fs.mkdirSync(path.join(phone, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(phone, 'index.html'), '<h1>Pair this phone</h1>'); fs.writeFileSync(path.join(phone, 'assets', 'app-1a2b.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'secret.json'), '{"secret":true}');
  const alerts: { device: string; message: Record<string, unknown>; topic: string }[] = []; let result: 'sent' | 'gone' = 'sent';
  const server = new RemoteServer(root, host, 0, phone, async (subscription, message, { topic }) => { alerts.push({ device: subscription.endpoint, message: message as Record<string, unknown>, topic }); return result; }); cleanup.push(() => server.stop());
  return { root, server, writes, running, alerts, gone: () => { result = 'gone'; } };
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
/** Links a computer (pairing with its machine id), returning its key. */
async function computer(server: RemoteServer) {
  const code = server.pair('computer').pairing!.code;
  const response = await fetch(base(server) + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Laptop', machineId: '6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e0f' }) });
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

  it('serves only the phone app build: its page, top-level files and assets, never anything outside it', async () => {
    const { server } = await remote(); await server.setEnabled(true);
    const asset = await fetch(base(server) + '/assets/app-1a2b.js');
    expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toMatch(/javascript/); expect(asset.headers.get('cache-control')).toMatch(/immutable/);
    expect((await fetch(base(server) + '/')).headers.get('content-security-policy')).toMatch(/script-src 'self';/);
    for (const pathname of ['/../secret.json', '/assets/../../secret.json', '/%2e%2e/secret.json', '/missing.js', '/assets/', '/.hidden.js', '/index.txt']) expect((await request(server, pathname)).status, pathname).toBe(404);
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

  it('links the person\'s own computers without a code only when Tailscale Serve vouches for the same login', async () => {
    const { server, root } = await remote(); await server.setEnabled(true); server.identity = { id: '11111111-1111-4111-8111-111111111111', name: 'Desk' };
    const MACHINE = '6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e0f'; const me = { 'Tailscale-User-Login': 'Person@Example.com' };
    const hello = (headers: Record<string, string>) => fetch(base(server) + '/api/hello', { headers });
    const autoLink = (headers: Record<string, string>, machineId = MACHINE) => fetch(base(server) + '/api/auto-link', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ name: 'Laptop', machineId }) });
    // Not serving on the tailnet, or no login known: nobody is vouched for.
    expect((await hello(me)).status).toBe(403); expect((await autoLink(me)).status).toBe(403);
    server.tailscale = { ...server.tailscale, host: 'desk.example.ts.net', serving: true, login: 'person@example.com' };
    // Someone else's login, a tagged device or a request without Serve's header, and Funnel traffic, are refused.
    for (const headers of [{}, { 'Tailscale-User-Login': 'someone@else.com' }, { ...me, 'Tailscale-Funnel-Request': '?1' }]) { expect((await hello(headers)).status).toBe(403); expect((await autoLink(headers)).status).toBe(403); }
    expect(await (await hello(me)).json()).toEqual({ computer: { id: '11111111-1111-4111-8111-111111111111', name: 'Desk' } });
    // Its own identity is not a computer to link, and a phone cannot get a key this way.
    expect((await autoLink(me, '11111111-1111-4111-8111-111111111111')).status).toBe(400);
    const response = await autoLink(me); expect(response.status).toBe(200);
    const body = await response.json() as { token: string; device: { kind: string }; computer: { id: string } };
    expect(body.device.kind).toBe('computer'); expect(body.computer.id).toBe('11111111-1111-4111-8111-111111111111');
    expect((await fetch(base(server) + '/api/channels', { headers: { Authorization: `Bearer ${body.token}` } })).status).toBe(200);
    expect(fs.readFileSync(path.join(root, 'remote-devices.json'), 'utf8')).not.toContain(body.token);
    // Linking again replaces the key rather than adding a second one.
    await autoLink(me); expect(server.status().devices.filter((device) => device.kind === 'computer')).toHaveLength(1);
    // Turned off, a code is needed again; turning phone access off and on keeps the choice.
    expect(server.setAutoLink(false).autoLink).toBe(false); expect((await autoLink(me)).status).toBe(403);
    await server.setEnabled(false); await server.setEnabled(true); expect(server.autoLink).toBe(false);
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
    expect(seen[1].data).toMatchObject({ sessionId: 's1', runId: 'r1', cols: 80, rows: 24 }); expect((seen[1].data as { data: string }).data).toContain('earlier output');
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

  it('gives no phone key to a computer removed while its request was still arriving', async () => {
    const { server } = await remote(); await server.setEnabled(true); const token = await computer(server);
    const result = new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address!, path: '/api/phone-key', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (response) => { response.resume(); resolve(response.statusCode!); });
      req.on('error', reject); req.write('{"name":"Phone",');
      setTimeout(() => { server.revoke(server.status().devices[0].id); req.end('"relayKey":"k"}'); }, 100);
    });
    expect(await result).toBe(401); expect(server.status().devices).toEqual([]);
  });

  it('keeps the paired devices readable whatever relay key a linked computer sends', async () => {
    const { server } = await remote(); await server.setEnabled(true); const token = await computer(server);
    const response = await fetch(base(server) + '/api/phone-key', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Phone', relayKey: 'k'.repeat(100) }) });
    expect(response.status).toBe(200); expect(server.status().devices).toHaveLength(2);
  });

  it('tells connected phones when the saved channels change, and only when the list they see is different', async () => {
    const { server } = await remote(); await server.setEnabled(true); const token = await paired(server);
    const seen = await events(server, token, null, 2, () => { titles[0] = 'Renamed'; server.channelsChanged(); });
    expect((seen[1].data as { title: string }[])[0].title).toBe('Renamed');
  });

  it('sends a new terminal size ahead of the output drawn at that size', async () => {
    const { server, running } = await remote(); await server.setEnabled(true); const token = await paired(server);
    Object.assign(running[0], { cols: 80, rows: 24 });
    const seen = await events(server, token, 's1', 4, () => {
      Object.assign(running[0], { cols: 120, rows: 40 }); server.resized('s1');
      server.onSessionEvent({ type: 'data', sessionId: 's1', runId: 'r1', data: 'redrawn' });
    });
    expect(seen[1].type).toBe('replay');
    expect(seen.slice(2)).toEqual([{ type: 'resize', data: { sessionId: 's1', runId: 'r1', cols: 120, rows: 40 } }, { type: 'output', data: { sessionId: 's1', runId: 'r1', data: 'redrawn' } }]);
  });

  it('replays the screen as it is now: full-screen mode kept however long ago it began, and why a CLI stopped', async () => {
    const { server, running } = await remote(); await server.setEnabled(true); const token = await paired(server);
    Object.assign(running[0], { cols: 40, rows: 10 });
    server.onSessionEvent({ type: 'started', sessionId: 's1', runId: 'r1', pid: 1, cwd: '/p', engine: 'codex' });
    server.onSessionEvent({ type: 'data', sessionId: 's1', runId: 'r1', data: '\x1b[?1049h' + 'x'.repeat(400 * 1024) + '\x1b[2J\x1b[HWorking' });
    Object.assign(running[0], { cols: 60, rows: 12 }); server.resized('s1');
    const [, replay] = await events(server, token, 's1', 2) as { data: { data: string; cols: number; rows: number } }[];
    expect(replay.data).toMatchObject({ cols: 60, rows: 12 }); expect(replay.data.data).toContain('\x1b[?1049h'); expect(replay.data.data).toContain('Working'); expect(replay.data.data.length).toBeLessThan(10000);
    const exited = await events(server, token, 's1', 3, () => {
      server.onSessionEvent({ type: 'data', sessionId: 's1', runId: 'r1', data: 'Error: model not available' });
      server.onSessionEvent({ type: 'exit', sessionId: 's1', runId: 'r1', exitCode: 1, diagnostic: 'Error: model not available' });
    }) as { type: string; data: { data: string } }[];
    expect(exited.filter((item) => item.type === 'output').at(-1)?.data.data).toMatch(/^\x1b\[\?1049l[\s\S]*Process exited · code 1[\s\S]*Error: model not available/);
  });

  it('drops the screens of channels that left the workspace, and keeps at most 32', async () => {
    const { server } = await remote(); await server.setEnabled(true);
    for (let i = 0; i < 40; i++) server.onSessionEvent({ type: 'started', sessionId: `old-${i}`, runId: `r${i}`, pid: 1, cwd: '/p', engine: 'claude' });
    const replay = (server as unknown as { replay: Map<string, unknown> }).replay; expect(replay.size).toBe(32);
    server.onSessionEvent({ type: 'started', sessionId: 's1', runId: 'r1', pid: 1, cwd: '/p', engine: 'claude' });
    server.channelsChanged(); expect([...replay.keys()]).toEqual(['s1']);
  });

  it('clears a waiting prompt when the person answers on the desktop, but not for focus reports', async () => {
    const { server } = await remote(); await server.setEnabled(true);
    server.onSessionEvent({ type: 'attention', sessionId: 's1', runId: 'r1', message: 'Approve?', at: new Date().toISOString() });
    server.personInput('s1', '\x1b[I'); expect(server.channels()[0].attention).toBe('Approve?');
    server.personInput('s1', '\x1b[12;40R\x1b[?1;2c'); expect(server.channels()[0].attention).toBe('Approve?');
    server.personInput('s1', 'y'); expect(server.channels()[0].attention).toBeNull();
  });
});

describe('channel controls', () => {
  it('lets a linked computer close a channel here, and never a phone', async () => {
    const { server } = await remote(); const asked: { sessionId: string; control: string }[] = [];
    (server as unknown as { host: RemoteHost }).host.control = async (sessionId, control) => { asked.push({ sessionId, control }); };
    await server.setEnabled(true);
    const post = (token: string, body: unknown) => fetch(base(server) + '/api/control', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(await computer(server), { sessionId: 's1', control: 'close' })).status).toBe(200);
    expect(asked).toEqual([{ sessionId: 's1', control: 'close' }]);
    expect((await post(await paired(server), { sessionId: 's1', control: 'close' })).status).toBe(403);
    expect(asked).toHaveLength(1);
  });
});

describe('failures, coaching and updates for other devices', () => {
  it('says why a channel stopped with an error until it starts again, and carries its coaching, reviewed on request', async () => {
    const { server } = await remote(); const host = (server as unknown as { host: RemoteHost }).host;
    const tip = { id: '3f1c2c8e-0000-4000-8000-000000000001', sessionId: 's1', engine: 'claude' as const, prompt: 'fix it', tips: ['Say what done looks like.'], at: new Date().toISOString(), review: null as null | { advice: string; rewrite: string } };
    host.coaching = (sessionId) => sessionId === 's1' ? tip : null; host.askCoach = async () => { tip.review = { advice: 'Name the page.', rewrite: 'Fix [page].' }; return tip; };
    await server.setEnabled(true);
    expect(server.channels()[0].coaching).toEqual({ id: tip.id, tips: ['Say what done looks like.'], review: null }); expect(server.channels()[1].coaching).toBeUndefined();
    const review = (token: string) => fetch(base(server) + '/api/coaching-review', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tip.id }) });
    expect((await review(await paired(server))).status).toBe(200); expect(server.channels()[0].coaching?.review?.advice).toBe('Name the page.');
    server.onSessionEvent({ type: 'exit', sessionId: 's2', runId: 'r2', exitCode: 1, signal: null, diagnostic: 'Claude Code exited with code 1\nmore' } as never);
    expect(server.channels()[1].failed).toBe('Claude Code exited with code 1');
    server.onSessionEvent({ type: 'started', sessionId: 's2', runId: 'r3', engine: 'claude', pid: 1, cwd: '/' } as never); expect(server.channels()[1].failed).toBeUndefined();
  });
  it('lets a linked computer, and never a phone, update Trace here', async () => {
    const { server } = await remote(); (server as unknown as { host: RemoteHost }).host.update = async () => 'Installing Trace 1.15.0 there.';
    await server.setEnabled(true);
    const update = (token: string) => fetch(base(server) + '/api/update', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    const answer = await update(await computer(server)); expect(answer.status).toBe(200); expect(await answer.json()).toEqual({ message: 'Installing Trace 1.15.0 there.' });
    expect((await update(await paired(server))).status).toBe(403);
  });
});

describe('channel transcripts', () => {
  it('gives phones and linked computers a channel\'s conversation, and refuses unknown channels', async () => {
    const { server } = await remote();
    const history = { type: 'history' as const, messages: [{ role: 'user' as const, text: 'hello', images: 0 }], results: {} };
    (server as unknown as { host: RemoteHost }).host.transcript = (sessionId) => sessionId === 's1' ? history : null;
    await server.setEnabled(true);
    const read = async (token: string, sessionId: string) => { const response = await fetch(base(server) + `/api/transcript?sessionId=${sessionId}`, { headers: { Authorization: `Bearer ${token}` } }); return { status: response.status, body: await response.json() as { transcript?: unknown } }; };
    expect(await read(await paired(server), 's1')).toEqual({ status: 200, body: { transcript: history } });
    expect(await read(await computer(server), 's2')).toEqual({ status: 200, body: { transcript: null } });
    expect((await read(await paired(server), 'nope')).status).toBe(400);
  });
});

describe('phone screen', () => {
  it('opens this computer\'s screen server for a phone with a one-time ticket, and nobody else', async () => {
    const received: Buffer[] = [];
    const vnc = net.createServer((socket) => { socket.write('RFB 003.889\n'); socket.on('data', (data) => received.push(data)); });
    await new Promise<void>((resolve) => vnc.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>((resolve) => vnc.close(() => resolve())));
    const { server } = await remote();
    (server as unknown as { host: RemoteHost }).host.screenTarget = () => ({ host: '127.0.0.1', port: (vnc.address() as net.AddressInfo).port });
    await server.setEnabled(true);
    const ticketFor = async (token: string) => fetch(base(server) + '/api/screen-ticket', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect((await ticketFor(await computer(server))).status).toBe(403);
    const { ticket } = await (await ticketFor(await paired(server))).json() as { ticket: string };
    const socket = new WebSocket(`ws://127.0.0.1:${server.address}/api/screen?ticket=${ticket}`); socket.binaryType = 'arraybuffer';
    const greeting = await new Promise<string>((resolve, reject) => { socket.onmessage = (event) => resolve(Buffer.from(event.data as ArrayBuffer).toString()); socket.onerror = () => reject(new Error('refused')); });
    expect(greeting).toBe('RFB 003.889\n');
    socket.send(new TextEncoder().encode('RFB 003.008\n'));
    for (let i = 0; i < 100 && !received.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Buffer.concat(received).toString()).toBe('RFB 003.008\n'); socket.close();
    // A ticket works once.
    const again = new WebSocket(`ws://127.0.0.1:${server.address}/api/screen?ticket=${ticket}`);
    expect(await new Promise((resolve) => { again.onopen = () => resolve('open'); again.onerror = () => resolve('refused'); })).toBe('refused');
  });
});

describe('phone screen of a Windows computer', () => {
  /** A remote on a Windows computer that shares its screen through a real ScreenService, and a paired phone (setting off). */
  async function windows() {
    const { server, root } = await remote();
    fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true })); const viewers: (string | null)[] = [];
    const service = new ScreenService(root, () => 'Obsidian-Halo', { open: async () => ({ source: { width: 320, height: 200, frame: async () => [] }, input: { pointer: () => {}, key: () => {}, clipboard: () => {}, close: () => {} }, stop: () => {} }), viewing: (name) => viewers.push(name) });
    const port = await service.listen(0); cleanup.push(() => service.close());
    const host = (server as unknown as { host: RemoteHost }).host;
    host.screenService = () => true; host.openScreenService = (viewer) => openTraceScreen('This computer', `http://127.0.0.1:${port}/`, localScreenToken(root)!, undefined, 0, { 'X-Trace-Viewer': viewer });
    await server.setEnabled(true); const phone = await paired(server); const id = server.status().devices.find((device) => device.name === 'Test phone')!.id;
    const ticket = () => fetch(base(server) + '/api/phone-screen-ticket', { method: 'POST', headers: { Authorization: `Bearer ${phone}` } });
    /** Opens the phone's WebSocket: the server's first bytes, or 'refused'. */
    const open = (value: string) => { const socket = new WebSocket(`ws://127.0.0.1:${server.address}/api/phone-screen?ticket=${value}`); socket.binaryType = 'arraybuffer'; cleanup.push(() => socket.close()); return { socket, first: new Promise<string>((resolve) => { socket.onmessage = (event) => resolve(Buffer.from(event.data as ArrayBuffer).toString()); socket.onerror = () => resolve('refused'); }) }; };
    return { server, port, phone, id, viewers, ticket, open };
  }
  it('reaches Trace\'s screen service with Trace\'s own key, named as the phone, on paths the service\'s own does not take', async () => {
    const { server, port, phone, id, viewers, ticket, open } = await windows(); server.setCanRun(id, true);
    // The phone's own key does not open the service; only Trace's, for a phone with a ticket.
    await expect(openTraceScreen('Obsidian-Halo', `http://127.0.0.1:${port}/`, phone)).rejects.toThrow(/through Trace/);
    const { ticket: value } = await (await ticket()).json() as { ticket: string };
    expect(await open(value).first).toBe('RFB 003.008\n');
    for (let i = 0; i < 100 && !viewers.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(viewers).toEqual(['Test phone']);
  });
  it('needs Can start and stop agents for the phone, and says where to turn it on', async () => {
    const { ticket, viewers } = await windows();
    const response = await ticket(); expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('This phone can’t see or control this computer’s screen. On the computer, turn on Settings → Phone access → Can start and stop agents for it.');
    expect(viewers).toEqual([]);
  });
  it('refuses a ticket given while the setting was on once it is turned off', async () => {
    const { server, id, ticket, open, viewers } = await windows(); server.setCanRun(id, true);
    const { ticket: value } = await (await ticket()).json() as { ticket: string }; server.setCanRun(id, false);
    expect(await open(value).first).toBe('refused'); expect(viewers).toEqual([]);
  });
  it('closes the phone\'s screen when the setting is turned off while it watches', async () => {
    const { server, id, ticket, open } = await windows(); server.setCanRun(id, true);
    const { ticket: value } = await (await ticket()).json() as { ticket: string }; const { socket, first } = open(value);
    expect(await first).toBe('RFB 003.008\n');
    const closed = new Promise<boolean>((resolve) => { socket.onclose = () => resolve(true); setTimeout(() => resolve(false), 3000); });
    server.setCanRun(id, false); expect(await closed).toBe(true);
  });
  it('removing the phone closes its open screen and drops its unused tickets', async () => {
    const { server, id, ticket, open } = await windows(); server.setCanRun(id, true);
    const { ticket: watching } = await (await ticket()).json() as { ticket: string }; const { ticket: spare } = await (await ticket()).json() as { ticket: string };
    const { socket, first } = open(watching); expect(await first).toBe('RFB 003.008\n');
    const closed = new Promise<boolean>((resolve) => { socket.onclose = () => resolve(true); setTimeout(() => resolve(false), 3000); });
    server.revoke(id); expect(await closed).toBe(true);
    expect(await open(spare).first).toBe('refused');
  });
  it('removing the phone while its screen is still connecting passes nothing on, and lets the service go', async () => {
    const { server, root } = await remote(); fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true }));
    let answer: (value: { socket: net.Socket; head: Buffer }) => void = () => {}; let asked = false;
    const host = (server as unknown as { host: RemoteHost }).host; host.screenService = () => true;
    host.openScreenService = () => { asked = true; return new Promise((resolve) => { answer = resolve; }); };
    await server.setEnabled(true); const phone = await paired(server); const id = server.status().devices.find((device) => device.name === 'Test phone')!.id; server.setCanRun(id, true);
    const { ticket } = await (await fetch(base(server) + '/api/phone-screen-ticket', { method: 'POST', headers: { Authorization: `Bearer ${phone}` } })).json() as { ticket: string };
    const socket = new WebSocket(`ws://127.0.0.1:${server.address}/api/phone-screen?ticket=${ticket}`); cleanup.push(() => socket.close());
    const outcome = new Promise<string>((resolve) => { socket.onopen = () => resolve('open'); socket.onerror = () => resolve('refused'); });
    for (let i = 0; i < 100 && !asked; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    server.revoke(id);
    const service = new net.Socket(); answer({ socket: service, head: Buffer.alloc(0) });
    expect(await outcome).toBe('refused'); expect(service.destroyed).toBe(true);
  });
  /** A phone of a linked computer, given a key here through it (relayKey), with Can start and stop agents, watching the screen. */
  async function relayed() {
    const setup = await windows(); const { server, open } = setup; const linked = await computer(server);
    const key = (relayKey: string) => fetch(base(server) + '/api/phone-key', { method: 'POST', headers: { Authorization: `Bearer ${linked}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Relayed phone', relayKey }) }).then(async (response) => (await response.json() as { token: string }).token);
    const token = await key('p1'); const id = server.status().devices.find((device) => device.name === 'Relayed phone')!.id; server.setCanRun(id, true);
    const ticketOf = async () => (await (await fetch(base(server) + '/api/phone-screen-ticket', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json() as { ticket: string }).ticket;
    const spare = await ticketOf(); const { socket, first } = open(await ticketOf()); expect(await first).toBe('RFB 003.008\n');
    const closed = new Promise<boolean>((resolve) => { socket.onclose = () => resolve(true); setTimeout(() => resolve(false), 3000); });
    return { ...setup, linked, key, spare, closed };
  }
  it('a phone removed through the linked computer that gave it its key loses its screen at once', async () => {
    const { server, linked, spare, closed, open } = await relayed();
    const response = await fetch(base(server) + '/api/phone-key/revoke', { method: 'POST', headers: { Authorization: `Bearer ${linked}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ relayKey: 'p1' }) });
    expect(await response.json()).toEqual({ ok: true, removed: 1 }); expect(await closed).toBe(true);
    expect(await open(spare).first).toBe('refused');
  });
  it('a phone given a new key through the linked computer loses what its old key had open', async () => {
    const { key, spare, closed, open } = await relayed();
    await key('p1'); expect(await closed).toBe(true); expect(await open(spare).first).toBe('refused');
  });
  it('a computer linked again still speaks for its phones: removing one through it closes its screen', async () => {
    const { server, spare, closed, open } = await relayed();
    // The same computer (same machine id) links again: a new key and a new device id.
    const relinked = await computer(server);
    const response = await fetch(base(server) + '/api/phone-key/revoke', { method: 'POST', headers: { Authorization: `Bearer ${relinked}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ relayKey: 'p1' }) });
    expect(await response.json()).toEqual({ ok: true, removed: 1 }); expect(await closed).toBe(true);
    expect(server.status().devices.some((device) => device.name === 'Relayed phone')).toBe(false); expect(await open(spare).first).toBe('refused');
  });
  it('removing a computer linked again takes the phones it gave keys to before', async () => {
    const { server, closed } = await relayed(); await computer(server);
    const id = server.status().devices.find((device) => device.kind === 'computer')!.id; server.revoke(id);
    expect(await closed).toBe(true); expect(server.status().devices.some((device) => device.name === 'Relayed phone')).toBe(false);
  });
  it('linking another phone or computer leaves a phone\'s open screen alone', async () => {
    const { server, closed } = await relayed();
    await paired(server); await computer(server);
    expect(await closed).toBe(false);
  });
  it('survives a phone dropping its connection while the screen is still being reached, and lets that go', async () => {
    const { server, root } = await remote(); fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true }));
    let answer: (value: { socket: net.Socket; head: Buffer }) => void = () => {}; let asked = false;
    const host = (server as unknown as { host: RemoteHost }).host; host.screenService = () => true;
    host.openScreenService = () => { asked = true; return new Promise((resolve) => { answer = resolve; }); };
    await server.setEnabled(true); const phone = await paired(server); const id = server.status().devices.find((device) => device.name === 'Test phone')!.id; server.setCanRun(id, true);
    const { ticket } = await (await fetch(base(server) + '/api/phone-screen-ticket', { method: 'POST', headers: { Authorization: `Bearer ${phone}` } })).json() as { ticket: string };
    const uncaught: unknown[] = []; const catcher = (error: unknown) => uncaught.push(error); process.on('uncaughtException', catcher); cleanup.push(() => { process.off('uncaughtException', catcher); });
    // A raw connection that asks for the screen, then resets (as a phone losing its network does) before it is reached.
    const client = net.connect(server.address!, '127.0.0.1'); client.on('error', () => {});
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    client.write(`GET /api/phone-screen?ticket=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${server.address}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.alloc(16, 1).toString('base64')}\r\n\r\n`);
    for (let i = 0; i < 100 && !asked; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toBe(true); client.resetAndDestroy(); await new Promise((resolve) => setTimeout(resolve, 200));
    const service = new net.Socket(); answer({ socket: service, head: Buffer.alloc(0) }); await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uncaught).toEqual([]); expect(service.destroyed).toBe(true);
  });
  it('tells another computer there is no Trace screen service here, so it tries the computer\'s own (a Mac\'s) instead of reporting a refusal', async () => {
    const { server } = await remote(); (server as unknown as { host: RemoteHost }).host.screenTarget = () => ({ host: '127.0.0.1', port: 5900 });
    await server.setEnabled(true); const linked = await computer(server);
    await expect(openTraceScreen('MacBook', `http://127.0.0.1:${server.address}/`, linked, 5000)).rejects.toThrow('No screen service (404).');
  });
  it('removing the phone also closes a Mac screen it has open', async () => {
    const vnc = net.createServer((client) => { client.write('RFB 003.889\n'); client.on('error', () => {}); });
    await new Promise<void>((resolve) => vnc.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>((resolve) => { vnc.close(() => resolve()); vnc.unref(); }));
    const { server } = await remote(); (server as unknown as { host: RemoteHost }).host.screenTarget = () => ({ host: '127.0.0.1', port: (vnc.address() as net.AddressInfo).port });
    await server.setEnabled(true); const phone = await paired(server); const id = server.status().devices.find((device) => device.name === 'Test phone')!.id;
    const { ticket } = await (await fetch(base(server) + '/api/phone-screen-ticket', { method: 'POST', headers: { Authorization: `Bearer ${phone}` } })).json() as { ticket: string };
    const socket = new WebSocket(`ws://127.0.0.1:${server.address}/api/phone-screen?ticket=${ticket}`); cleanup.push(() => socket.close());
    expect(await new Promise((resolve) => { socket.onmessage = () => resolve('data'); socket.onerror = () => resolve('refused'); })).toBe('data');
    const closed = new Promise<boolean>((resolve) => { socket.onclose = () => resolve(true); setTimeout(() => resolve(false), 3000); });
    server.revoke(id); expect(await closed).toBe(true);
  });
  it('leaves a Mac\'s own Screen Sharing to its password: no setting needed there', async () => {
    const { server } = await remote(); (server as unknown as { host: RemoteHost }).host.screenTarget = () => ({ host: '127.0.0.1', port: 5900 });
    await server.setEnabled(true);
    expect((await fetch(base(server) + '/api/phone-screen-ticket', { method: 'POST', headers: { Authorization: `Bearer ${await paired(server)}` } })).status).toBe(200);
  });
  it('says how to turn sharing on when the computer shares no screen', async () => {
    const { server } = await remote(); await server.setEnabled(true);
    const response = await fetch(base(server) + '/api/phone-screen-ticket', { method: 'POST', headers: { Authorization: `Bearer ${await paired(server)}` } });
    expect(response.status).toBe(409); expect((await response.json() as { error: string }).error).toContain('Share this screen');
  });
});

describe('stream events', () => {
  it('escapes Unicode line and paragraph separators, which older phones read as line ends', () => {
    const LS = String.fromCharCode(0x2028); const PS = String.fromCharCode(0x2029); const raw = 'a' + LS + 'b' + PS + 'c';
    const text = eventJSON({ data: raw });
    expect(text.includes(LS) || text.includes(PS)).toBe(false); expect(JSON.parse(text)).toEqual({ data: raw });
    // The pattern phones and computers from before this change used finds the whole object.
    expect(JSON.parse(/^data: (.*)$/m.exec(`event: output\ndata: ${text}`)![1])).toEqual({ data: raw });
  });
});

describe('phone alerts', () => {
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.padEnd(87, 'A'), auth: 'A'.repeat(22) } };
  const alertsApi = (server: RemoteServer, token: string, method: string, body?: unknown) => fetch(base(server) + '/api/alerts', { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  it('lets a paired phone turn alerts on only with a real push service, and off again', async () => {
    const { server } = await remote(); await server.setEnabled(true); const token = await paired(server);
    const key = await (await alertsApi(server, token, 'GET')).json() as { publicKey: string; on: boolean }; expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/); expect(key.on).toBe(false);
    expect((await alertsApi(server, token, 'POST', { ...subscription, endpoint: 'https://192.168.1.10/hook' })).status).toBe(400);
    // Exactly what a browser's PushSubscription.toJSON() posts, expirationTime included.
    expect((await alertsApi(server, token, 'POST', { ...subscription, expirationTime: null })).status).toBe(200); expect(server.status().devices[0].notifications).toBe(true);
    expect((await alertsApi(server, token, 'DELETE')).status).toBe(200); expect(server.status().devices[0].notifications).toBe(false);
  });
  it('alerts phones when a channel needs the person or fails, at most once per 20 seconds, and forgets a gone subscription', async () => {
    const { server, alerts, gone } = await remote(); await server.setEnabled(true); const token = await paired(server);
    await alertsApi(server, token, 'POST', subscription);
    server.onSessionEvent({ type: 'attention', sessionId: 's1', runId: 'r1', message: 'Approve npm test?', at: new Date().toISOString() });
    server.onSessionEvent({ type: 'attention', sessionId: 's1', runId: 'r1', message: 'Again?', at: new Date().toISOString() });
    server.onSessionEvent({ type: 'exit', sessionId: 's1', runId: 'r1', exitCode: 1 });
    server.onSessionEvent({ type: 'exit', sessionId: 's1', runId: 'r1', exitCode: 1, diagnostic: 'Error: model not found\nmore' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alerts.map((item) => item.message)).toEqual([
      expect.objectContaining({ title: 'CH1 · Claude Code needs you', body: 'Approve npm test?', sessionId: 's1' }),
      expect.objectContaining({ title: 'CH1 · Claude Code stopped with an error', body: 'Error: model not found' }),
    ]);
    // Topics are per channel and kind and fit RFC 8030 (32 URL-safe characters), so queued alerts for other channels stay.
    server.onSessionEvent({ type: 'attention', sessionId: 's2', runId: 'r2', message: 'Approve?', at: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const topics = alerts.map((item) => item.topic); expect(new Set(topics).size).toBe(3); for (const topic of topics) expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    gone(); await server.testAlert(server.status().devices[0].id); expect(server.status().devices[0].notifications).toBe(false);
    await expect(server.testAlert(server.status().devices[0].id)).rejects.toThrow(/not on/);
  });
});

describe('tailscale state', () => {
  it('explains a failed serve, with the Tailscale page that fixes it', () => {
    const waiting = serveFailure(Object.assign(new Error('Command failed'), { timedOut: true, output: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nAbc123' }));
    expect(waiting).toMatchObject({ kind: 'approve', link: true, url: 'https://login.tailscale.com/f/serve?node=nAbc123' }); expect(waiting.message).toMatch(/allow HTTPS/);
    // Tailscale's words when HTTPS certificates are off for the tailnet (as seen on Windows).
    const certificates = serveFailure(Object.assign(new Error('Command failed: tailscale.exe serve --bg --https=443 http://127.0.0.1:47821'), { output: 'HTTPS certificates must be enabled for your tailnet in the Tailscale admin console.' }));
    expect(certificates).toMatchObject({ kind: 'certificates', link: true, url: TAILSCALE_DNS_SETTINGS });
    expect(serveFailure(Object.assign(new Error('Command failed'), { timedOut: true, output: '' }))).toMatchObject({ kind: 'certificates', url: TAILSCALE_DNS_SETTINGS });
    expect(serveFailure(Object.assign(new Error('Access denied: serve config denied'), { output: 'Access denied: serve config denied' }))).toMatchObject({ kind: 'permission', link: false, url: null, message: expect.stringMatching(/administrator/) });
    expect(serveFailure(Object.assign(new Error('some other problem'), { output: 'see https://evil.example/x' }))).toEqual({ kind: 'other', link: false, url: null, message: 'Tailscale could not set up HTTPS: some other problem' });
  });
  it('finds a Tailscale app installed after Trace started', () => {
    const installed = new Set<string>(); const candidates = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'];
    expect(tailscaleExecutable((file) => installed.has(file), candidates)).toBe('tailscale');
    installed.add(candidates[0]);
    expect(tailscaleExecutable((file) => installed.has(file), candidates)).toBe(candidates[0]);
  });
  it('runs Tailscale as a CLI when Trace was opened from the Dock, with no terminal environment', () => {
    expect(tailscaleEnvironment({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin', TERM: 'dumb' });
    expect(tailscaleEnvironment({ TERM: 'xterm-256color' }).TERM).toBe('xterm-256color');
  });
  const runner = (outputs: Record<string, string | Error>) => async (args: string[]) => { const value = outputs[args.join(' ')]; if (value instanceof Error) throw value; if (value === undefined) throw new Error('unexpected ' + args.join(' ')); return value; };
  it('takes Trace off the tailnet when phone access is turned off, and leaves a handler that is not Trace’s', async () => {
    const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desk.example.ts.net.' } }); const calls: string[] = [];
    const recording = (serve: unknown) => { const run = runner({ 'status --json': status, 'serve status --json': JSON.stringify(serve), 'serve --https=443 off': '' }); return async (args: string[]) => { calls.push(args.join(' ')); return run(args); }; };
    await stopServing(recording({ Web: { 'desk.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47821' } } } } }), 47821);
    expect(calls).toContain('serve --https=443 off');
    calls.length = 0; await stopServing(recording({ Web: { 'desk.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }), 47821);
    expect(calls).not.toContain('serve --https=443 off');
  });
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
  it('reads the login this computer is signed in with, and lists only that login\'s online computers', async () => {
    const status = { BackendState: 'Running', Self: { DNSName: 'desk.example.ts.net.', UserID: 7 }, User: { '7': { LoginName: 'Person@Example.com' }, '9': { LoginName: 'friend@example.com' } },
      Peer: {
        a: { DNSName: 'laptop.example.ts.net.', UserID: 7, Online: true, OS: 'macOS' },
        b: { DNSName: 'old.example.ts.net.', UserID: 7, Online: false, OS: 'windows' },
        c: { DNSName: 'phone.example.ts.net.', UserID: 7, Online: true, OS: 'android' },
        d: { DNSName: 'shared.example.ts.net.', UserID: 9, Online: true, OS: 'linux' },
        e: { DNSName: 'server.example.ts.net.', UserID: 7, Online: true, OS: 'linux', Tags: ['tag:server'] },
      } };
    expect(await tailscaleState(runner({ 'status --json': JSON.stringify(status), 'serve status --json': '' }), 47821)).toMatchObject({ login: 'person@example.com' });
    expect(await tailscalePeers(runner({ 'status --json': JSON.stringify(status) }))).toEqual(['https://laptop.example.ts.net/']);
    // A tagged computer belongs to no person, so nothing is linked from it either.
    expect(await tailscalePeers(runner({ 'status --json': JSON.stringify({ ...status, Self: { ...status.Self, Tags: ['tag:ci'] } }) }))).toEqual([]);
    expect(await tailscalePeers(runner({ 'status --json': JSON.stringify({ ...status, BackendState: 'Stopped' }) }))).toEqual([]);
  });
});

describe('phone permissions and chat channels', () => {
  const RUN = '11111111-2222-4333-8444-555555555555';
  /** A remote whose host records starts, stops, adds and chat requests. */
  async function chatRemote() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const controls: unknown[] = []; const adds: unknown[] = []; const chats: unknown[] = [];
    const host: RemoteHost = {
      sessions: () => [{ id: 's1', title: 'Claude Code', engine: 'claude', chat: true }, { id: 's2', title: 'Codex', engine: 'codex', chat: true }],
      running: () => [{ sessionId: 's1', runId: RUN, pid: 1, cwd: '/p', engine: 'claude' }],
      write: () => {},
      control: async (sessionId, control) => { controls.push({ sessionId, control }); },
      add: async (engine, chat) => { adds.push({ engine, chat }); },
      chat: (request) => { if (request.runId !== RUN) throw new HubError('STALE_SESSION', 'This process has ended or the session reference is stale.'); chats.push(request); },
    };
    const server = new RemoteServer(root, host, 0, '', async () => 'sent'); cleanup.push(() => server.stop()); await server.setEnabled(true);
    return { root, server, controls, adds, chats };
  }
  const post = (server: RemoteServer, token: string, pathname: string, body: unknown) => fetch(base(server) + pathname, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = async (server: RemoteServer, token: string, pathname: string) => { const response = await fetch(base(server) + pathname, { headers: { Authorization: `Bearer ${token}` } }); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
  /** Reads `count` server-sent events from /api/stream with this query, calling `during` once the stream is open. */
  async function stream(server: RemoteServer, token: string, query: string, count: number, during?: () => void) {
    const controller = new AbortController(); const response = await fetch(base(server) + '/api/stream' + query, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; const seen: { type: string; data: unknown }[] = []; let triggered = false;
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      while (seen.length < count) {
        const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
        let end; while ((end = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); const type = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1]; if (type && data) seen.push({ type, data: JSON.parse(data) }); }
        if (!triggered && during) { triggered = true; during(); }
      }
    } catch { /* Timed out: return what arrived. */ }
    clearTimeout(timer); controller.abort(); return seen;
  }

  it('keeps a phone from starting, stopping or adding channels until it is allowed, and says where to allow it', async () => {
    const { root, server, controls, adds, chats } = await chatRemote(); const token = await paired(server);
    const phone = server.status().devices[0]; expect(phone).toMatchObject({ kind: 'phone', canRun: false });
    // Records from before this setting have no canRun and load as not allowed.
    expect(JSON.parse(fs.readFileSync(path.join(root, 'remote-devices.json'), 'utf8'))[0]).not.toHaveProperty('canRun');
    expect((await get(server, token, '/api/me')).body).toMatchObject({ id: phone.id, name: 'Test phone', kind: 'phone', canRun: false });
    for (const [pathname, body] of [['/api/control', { sessionId: 's1', control: 'stop' }], ['/api/channel-add', { engine: 'claude', chat: true }], ['/api/chat', { action: 'table-open', sessionId: 's1', runId: RUN, partner: { sessionId: 's2', runId: RUN }, driver: 'claude', rounds: 1 }]] as const) {
      const response = await post(server, token, pathname, body);
      expect(response.status, pathname).toBe(403); expect((await response.json() as { error: string }).error).toMatch(/Can start and stop agents/);
    }
    expect(controls).toEqual([]); expect(adds).toEqual([]); expect(chats).toEqual([]);
  });

  it('lets an allowed phone start, stop and add channels (chat or terminal), and takes that back at once', async () => {
    const { server, controls, adds } = await chatRemote(); const token = await paired(server); const id = server.status().devices[0].id;
    const seen = await stream(server, token, '', 2, () => { server.setCanRun(id, true); });
    expect(seen[1]).toMatchObject({ type: 'me', data: { id, name: 'Test phone', kind: 'phone', canRun: true } });
    expect(server.status().devices[0].canRun).toBe(true); expect((await get(server, token, '/api/me')).body.canRun).toBe(true);
    expect((await post(server, token, '/api/control', { sessionId: 's1', control: 'restart' })).status).toBe(200);
    expect((await post(server, token, '/api/channel-add', { engine: 'codex', chat: true })).status).toBe(200);
    expect((await post(server, token, '/api/channel-add', { engine: 'shell' })).status).toBe(200);
    // A terminal cannot be a chat, and a channel on no computer here is unknown.
    expect((await post(server, token, '/api/channel-add', { engine: 'shell', chat: true })).status).toBe(400);
    // Trace runs no Gemini (removed after 1.20): a phone or older computer asking for one is refused.
    expect((await post(server, token, '/api/channel-add', { engine: 'gemini' })).status).toBe(400);
    expect((await post(server, token, '/api/control', { sessionId: 'elsewhere', control: 'stop' })).status).toBe(400);
    expect(controls).toEqual([{ sessionId: 's1', control: 'restart' }]); expect(adds).toEqual([{ engine: 'codex', chat: true }, { engine: 'shell', chat: false }]);
    server.setCanRun(id, false);
    expect((await post(server, token, '/api/control', { sessionId: 's1', control: 'stop' })).status).toBe(403); expect(controls).toHaveLength(1);
    // A linked computer always may, and its permission cannot be changed here.
    const laptop = await computer(server); expect((await get(server, laptop, '/api/me')).body).toMatchObject({ kind: 'computer', canRun: true });
    expect((await post(server, laptop, '/api/channel-add', { engine: 'claude' })).status).toBe(200);
    expect(() => server.setCanRun(server.status().devices.find((device) => device.kind === 'computer')!.id, false)).toThrow(/linked computer/);
  });

  it('locks out a removed phone at once, even one allowed to start agents', async () => {
    const { server, controls, chats } = await chatRemote(); const token = await paired(server); const id = server.status().devices[0].id;
    server.setCanRun(id, true); server.revoke(id);
    expect((await post(server, token, '/api/control', { sessionId: 's1', control: 'stop' })).status).toBe(401);
    expect((await post(server, token, '/api/chat', { action: 'interrupt', sessionId: 's1', runId: RUN })).status).toBe(401);
    expect((await get(server, token, '/api/me')).status).toBe(401);
    expect(controls).toEqual([]); expect(chats).toEqual([]);
  });

  it('passes a phone’s chat messages (with images), answers, interruptions and Round Table requests to the run', async () => {
    const { server, chats } = await chatRemote(); const token = await paired(server); const ref = { sessionId: 's1', runId: RUN };
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    const requests = [
      { action: 'send', ...ref, text: 'look at this', images: [image] },
      { action: 'answer', ...ref, requestId: 'req-1', allow: true },
      { action: 'interrupt', ...ref },
      { action: 'table-send', ...ref, text: 'both of you', images: [] },
      { action: 'table-driver', ...ref, driver: 'codex' },
      { action: 'table-rounds', ...ref, rounds: 2 },
      { action: 'table-stop', ...ref },
      { action: 'table-close', ...ref },
    ];
    for (const body of requests) expect((await post(server, token, '/api/chat', body)).status, body.action).toBe(200);
    expect(chats).toEqual(requests);
    // Seating a partner takes the phone's permission; with it, the request reaches the run.
    const open = { action: 'table-open', ...ref, partner: { sessionId: 's2', runId: RUN }, driver: 'claude', rounds: 1 };
    expect((await post(server, token, '/api/chat', open)).status).toBe(403);
    server.setCanRun(server.status().devices[0].id, true); expect((await post(server, token, '/api/chat', open)).status).toBe(200); expect(chats.at(-1)).toEqual(open);
    expect((await post(server, token, '/api/chat', { ...open, partner: { sessionId: 'elsewhere', runId: RUN } })).status).toBe(400);
    // Eleven images, an unknown image type, extra fields, an unknown channel and a stale run are refused.
    expect((await post(server, token, '/api/chat', { action: 'send', ...ref, text: '', images: Array(11).fill(image) })).status).toBe(400);
    expect((await post(server, token, '/api/chat', { action: 'send', ...ref, text: 'x', images: [{ mediaType: 'image/svg+xml', data: 'PHN2Zz4=' }] })).status).toBe(400);
    expect((await post(server, token, '/api/chat', { action: 'interrupt', ...ref, path: '/etc/passwd' })).status).toBe(400);
    expect((await post(server, token, '/api/chat', { action: 'interrupt', sessionId: 'elsewhere', runId: RUN })).status).toBe(400);
    const stale = await post(server, token, '/api/chat', { action: 'interrupt', sessionId: 's1', runId: '00000000-0000-4000-8000-000000000000' });
    expect(stale.status).toBe(409); expect((await stale.json() as { error: string }).error).toMatch(/stale/);
  });

  it('streams chat events to phones following the chat and to linked computers, after its recent thread', async () => {
    const { server } = await chatRemote(); const token = await paired(server); const laptop = await computer(server);
    server.onChat({ sessionId: 's1', runId: RUN, event: { type: 'user', text: 'hello', images: 2 } });
    server.onChat({ sessionId: 's1', runId: RUN, event: { type: 'delta', messageId: 'm1', text: 'Hi ' } });
    server.onChat({ sessionId: 's1', runId: RUN, event: { type: 'delta', messageId: 'm1', text: 'there' } });
    const replay = { sessionId: 's1', runId: RUN, events: [{ type: 'user', text: 'hello', images: 2 }, { type: 'delta', messageId: 'm1', text: 'Hi there' }] };
    const kept = (sessionId: string) => (server as unknown as { chatReplay(sessionId: string, kind: 'phone'): unknown }).chatReplay(sessionId, 'phone');
    expect(kept('s1')).toEqual(replay); expect(kept('s2')).toEqual({ sessionId: 's2', runId: null, events: [] }); expect(kept('elsewhere')).toBeNull();
    const done = { sessionId: 's1', runId: RUN, event: { type: 'assistant' as const, messageId: 'm1', blocks: [{ type: 'text' as const, text: 'Hi there' }] } };
    // A chat run also has the (empty) terminal screen every run has, as `replay`.
    const phone = stream(server, token, '?sessionId=s1', 4); const other = stream(server, token, '?sessionId=s2', 2); const linked = stream(server, laptop, '?all=1', 4);
    await new Promise((resolve) => setTimeout(resolve, 300)); server.onChat(done);
    const [mine, theirs, computers] = (await Promise.all([phone, other, linked])).map((seen) => seen.filter((event) => event.type !== 'replay'));
    expect(mine.map((event) => event.type)).toEqual(['channels', 'chat-replay', 'chat']); expect(mine[1].data).toEqual(replay); expect(mine[2].data).toEqual(done);
    // A phone following another channel does not get it (its stream times out after the channel list).
    expect(theirs.map((event) => event.type)).toEqual(['channels']);
    expect(computers.map((event) => event.type)).toEqual(['channels', 'chat-replay', 'chat']); expect(computers[2].data).toEqual(done);
    // The finished message replaced its streamed text in what is kept.
    expect((kept('s1') as { events: unknown[] }).events).toEqual([{ type: 'user', text: 'hello', images: 2 }, done.event]);
  });
});

describe('usage, tasks, history and memory for phones', () => {
  const TASK = '0f8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d'; const OTHER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  async function phoneRemote() {
    const { server } = await remote(); const host = (server as unknown as { host: RemoteHost }).host;
    const moved: { id: string; status: string }[] = []; const resumed: string[] = []; const written: { project: string; title: string; content: string }[] = [];
    let tasks: NonNullable<ReturnType<NonNullable<RemoteHost['tasks']>>> = [
      { id: TASK, title: 'Fix login', directory: 'C:\\Users\\me\\secret\\app', sessionId: 's2', scope: ['src/**'], status: 'active', notes: '', verificationId: null, createdAt: '2026-11-01T10:00:00.000Z', sentAt: '2026-11-02T10:00:00.000Z' },
      { id: OTHER, title: 'Docs', directory: '/home/me/secret/app', sessionId: 'gone', scope: ['**'], status: 'queued', notes: '', verificationId: null, createdAt: '2026-11-03T10:00:00.000Z' },
    ];
    Object.assign(host, {
      usage: () => ({ today: { day: '2026-11-07', claude: 1200, codex: 300, cost: 1.5, complete: true }, limits: [{ engine: 'claude', account: 'Default', windows: [{ label: 'Session', usedPercent: 40, resets: null }], plan: null, checkedAt: '2026-11-07T10:00:00.000Z', error: null }], budget: { dailyTokens: 50000, dailyCost: null, limitWarning: 70 } }),
      tasks: () => tasks,
      taskStatus: async (id, status) => { moved.push({ id, status }); tasks = tasks.map((task) => task.id === id ? { ...task, status } : task); },
      history: async () => Array.from({ length: 120 }, (_, index) => ({ key: `claude:default:${index}`, id: String(index), engine: index % 2 ? 'codex' : 'claude', directory: index === 0 ? null : index % 2 ? `C:\\Users\\me\\private\\proj${index}\\` : `/Users/me/private/proj${index}`, title: `Claude · proj${index} · 1234`, modifiedAt: new Date(Date.UTC(2026, 10, 7) - index * 60000).toISOString(), ...(index === 0 ? { label: 'Named' } : {}) })),
      resume: async (key) => { resumed.push(key); },
      memoryProjects: () => [{ project: 'app-0123456789', directory: 'C:\\Users\\me\\private\\app' }],
      memoryNotes: (project) => Array.from({ length: 35 }, (_, index) => ({ project, author: 'claude', id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Note ${index}`, content: 'x'.repeat(index === 34 ? 25000 : 10), createdAt: new Date(Date.UTC(2026, 10, 1) + index * 60000).toISOString() })),
      writeMemory: (project, title, content) => { written.push({ project, title, content }); },
    } satisfies Partial<RemoteHost>);
    await server.setEnabled(true);
    return { server, moved, resumed, written };
  }
  type Reply = { status: number; body: any };
  const get = async (server: RemoteServer, token: string, pathname: string): Promise<Reply> => { const response = await fetch(base(server) + pathname, { headers: { Authorization: `Bearer ${token}` } }); return { status: response.status, body: await response.json() }; };
  const post = async (server: RemoteServer, token: string, pathname: string, body: unknown): Promise<Reply> => { const response = await fetch(base(server) + pathname, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };

  it('needs a device key for every one of them', async () => {
    const { server } = await phoneRemote();
    for (const pathname of ['/api/usage', '/api/tasks', '/api/history', '/api/memory']) expect((await get(server, 'x'.repeat(43), pathname)).status).toBe(401);
    for (const pathname of ['/api/task-status', '/api/history-resume', '/api/memory']) expect((await post(server, 'x'.repeat(43), pathname, {})).status).toBe(401);
  });

  it('gives any paired phone today\'s usage, plan limits and the daily budget', async () => {
    const { server } = await phoneRemote(); const token = await paired(server);
    expect(await get(server, token, '/api/usage')).toEqual({ status: 200, body: { day: '2026-11-07', tokens: { claude: 1200, codex: 300 }, cost: 1.5, complete: true, limits: [expect.objectContaining({ engine: 'claude', account: 'Default' })], budget: { tokens: 50000, dollars: null, warnAt: 0.7 } } });
  });

  it('lists tasks under the board\'s four columns with no folder paths, and moves them only for phones allowed to run agents', async () => {
    const { server, moved } = await phoneRemote(); const token = await paired(server);
    const { status, body } = await get(server, token, '/api/tasks');
    expect(status).toBe(200);
    expect(body).toEqual([
      { id: OTHER, title: 'Docs', status: 'todo', sessionId: 'gone', channel: null, files: ['**'], updatedAt: '2026-11-03T10:00:00.000Z' },
      { id: TASK, title: 'Fix login', status: 'working', sessionId: 's2', channel: 2, files: ['src/**'], updatedAt: '2026-11-02T10:00:00.000Z' },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/secret/);
    const refused = await post(server, token, '/api/task-status', { id: TASK, status: 'review' });
    expect(refused.status).toBe(403); expect(refused.body.error).toMatch(/Can start and stop agents/); expect(moved).toEqual([]);
    server.setCanRun(server.status().devices[0].id, true);
    expect(await post(server, token, '/api/task-status', { id: TASK, status: 'review' })).toEqual({ status: 200, body: { ok: true } });
    expect(await post(server, token, '/api/task-status', { id: OTHER, status: 'working' })).toEqual({ status: 200, body: { ok: true } });
    expect(moved).toEqual([{ id: TASK, status: 'review' }, { id: OTHER, status: 'active' }]);
    // The phone uses the column names, never the stored ones.
    expect((await post(server, token, '/api/task-status', { id: TASK, status: 'queued' })).status).toBe(400);
    expect(await post(server, token, '/api/task-status', { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', status: 'done' })).toEqual({ status: 400, body: { error: 'Unknown task.' } });
  });

  it('lists the newest 100 CLI conversations with only their folder\'s name, and resumes one only for phones allowed to run agents', async () => {
    const { server, resumed } = await phoneRemote(); const token = await paired(server);
    const { status, body } = await get(server, token, '/api/history');
    expect(status).toBe(200); expect(body).toHaveLength(100);
    expect(body[0]).toEqual({ key: 'claude:default:0', engine: 'claude', title: 'Named', folder: '', modified: '2026-11-07T00:00:00.000Z' });
    expect(body[1]).toEqual({ key: 'claude:default:1', engine: 'codex', title: 'Claude · proj1 · 1234', folder: 'proj1', modified: '2026-11-06T23:59:00.000Z' });
    expect(body[2].folder).toBe('proj2');
    for (const item of body) expect(item.folder).toMatch(/^[^\\/]*$/);
    expect(JSON.stringify(body)).not.toMatch(/private|Users/);
    const refused = await post(server, token, '/api/history-resume', { key: 'claude:default:3' });
    expect(refused.status).toBe(403); expect(refused.body.error).toMatch(/Can start and stop agents/); expect(resumed).toEqual([]);
    server.setCanRun(server.status().devices[0].id, true);
    expect(await post(server, token, '/api/history-resume', { key: 'claude:default:3' })).toEqual({ status: 200, body: { ok: true } });
    expect(resumed).toEqual(['claude:default:3']);
    expect((await post(server, token, '/api/history-resume', { key: '' })).status).toBe(400);
    // The computer says why it could not (an unknown key, a closed window), and the phone shows that.
    (server as unknown as { host: RemoteHost }).host.resume = async () => { throw new HubError('NATIVE_SESSION', 'The CLI conversation is no longer available. Refresh the list.'); };
    expect(await post(server, token, '/api/history-resume', { key: 'claude:default:999' })).toEqual({ status: 409, body: { error: 'The CLI conversation is no longer available. Refresh the list.' } });
  });

  it('shows the newest 30 handoffs of each channel\'s project, capped, and lets any paired phone write one to those projects only', async () => {
    const { server, written } = await phoneRemote(); const token = await paired(server);
    const { status, body } = await get(server, token, '/api/memory');
    expect(status).toBe(200); expect(body).toHaveLength(1);
    expect(body[0].project).toBe('app-0123456789'); expect(body[0].name).toBe('app'); expect(body[0].notes).toHaveLength(30);
    expect(body[0].notes[0]).toMatchObject({ title: 'Note 34', author: 'claude' }); expect(body[0].notes[0].content).toHaveLength(20000);
    expect(Object.keys(body[0].notes[0]).sort()).toEqual(['author', 'content', 'createdAt', 'id', 'title']);
    expect(JSON.stringify(body)).not.toMatch(/private/);
    // canRun is off: a handoff is notes, not running an agent.
    expect(await post(server, token, '/api/memory', { project: 'app-0123456789', title: 'From my phone', content: 'Check the login fix.' })).toEqual({ status: 200, body: { ok: true } });
    expect(written).toEqual([{ project: 'app-0123456789', title: 'From my phone', content: 'Check the login fix.' }]);
    expect(await post(server, token, '/api/memory', { project: 'other-0123456789', title: 'x', content: 'y' })).toEqual({ status: 400, body: { error: 'Unknown project.' } });
    expect((await post(server, token, '/api/memory', { project: 'app-0123456789', title: '', content: 'y' })).status).toBe(400);
    expect((await post(server, token, '/api/memory', { project: 'app-0123456789', title: 'x', content: 'y', author: 'claude' })).status).toBe(400);
    expect(written).toHaveLength(1);
  });
});

describe('Round Tables on phones and linked computers', () => {
  it('lists a table as its lead only, numbers the channels after it as tiles, and shows the partner\'s approval on the lead', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const host: RemoteHost = {
      sessions: () => [{ id: 'lead', title: 'Claude chat', engine: 'claude', chat: true }, { id: 'seat', title: 'Codex', engine: 'codex', chat: true, seatedAt: 'lead' }, { id: 'term', title: 'Terminal', engine: 'shell' }],
      running: () => [{ sessionId: 'lead', runId: 'r1', pid: 1, cwd: '/p', engine: 'claude' }, { sessionId: 'seat', runId: 'r2', pid: 2, cwd: '/p', engine: 'codex' }],
      write: () => {},
    };
    const server = new RemoteServer(root, host, 0, '', async () => 'sent'); cleanup.push(() => server.stop());
    for (const kind of ['phone', 'computer'] as const) expect(server.channels(kind).map((channel) => [channel.sessionId, channel.channel])).toEqual([['lead', 1], ['term', 2]]);
    server.onSessionEvent({ type: 'attention', sessionId: 'seat', runId: 'r2', message: 'Approve Bash', at: new Date().toISOString() });
    expect(server.channels()[0].attention).toBe('Codex: Approve Bash');
    server.onSessionEvent({ type: 'answered', sessionId: 'seat', runId: 'r2', at: new Date().toISOString() });
    expect(server.channels()[0].attention).toBeNull();
  });
});

describe('a stream’s opening replay', () => {
  it('may be larger than the live limit, which applies again once it has drained', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const server = new RemoteServer(root, { sessions: () => [], running: () => [], write: () => {} } as unknown as RemoteHost, 0, '', async () => 'sent'); cleanup.push(() => server.stop());
    // A socket that is not reading yet: everything written stays queued.
    const response = { writableLength: 0, destroyed: false, write(text: string) { this.writableLength += text.length; return false; }, destroy() { this.destroyed = true; } };
    const stream = { device: 'computer', kind: 'computer', response, sessionId: null, all: true };
    const inner = server as unknown as { streams: Set<unknown>; opening(stream: unknown, text: string): void; write(stream: unknown, text: string): void };
    inner.streams.add(stream);
    // Two long chats' threads: 3 MB in the opening replay.
    inner.opening(stream, 'x'.repeat(1_500_000)); inner.opening(stream, 'x'.repeat(1_500_000));
    inner.write(stream, 'a live event'); expect(response.destroyed).toBe(false);
    // Drained once: a reader that stops now is dropped at the ordinary limit.
    (stream as { opening?: number }).opening = 0; inner.write(stream, 'another'); expect(response.destroyed).toBe(true);
  });
});

describe('the phone app from another of the person’s computers', () => {
  it('may open this computer’s screen directly (its own computer off), and its page allows that connection', async () => {
    const { server } = await remote(); await server.setEnabled(true);
    server.allowedOrigins = () => ['https://desktop.tail1234.ts.net'];
    const status = async (origin: string) => {
      const client = net.connect(server.address!, '127.0.0.1'); client.on('error', () => {}); cleanup.push(() => client.destroy());
      await new Promise<void>((resolve) => client.once('connect', () => resolve()));
      const first = new Promise<string>((resolve) => client.once('data', (data) => resolve(String(data).split('\r\n')[0])));
      client.write(`GET /api/phone-screen?ticket=none HTTP/1.1\r\nHost: 127.0.0.1:${server.address}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.alloc(16, 1).toString('base64')}\r\n\r\n`);
      return first;
    };
    // A sibling's page gets past the origin check (and is refused only for its missing ticket); any other site is not.
    expect(await status('https://desktop.tail1234.ts.net')).toContain('401');
    expect(await status('https://evil.example')).toContain('403');
    const page = await fetch(base(server) + '/');
    expect(page.headers.get('content-security-policy')).toContain('wss://desktop.tail1234.ts.net');
  });
});

describe('requests only one kind of device may make', () => {
  const call = (server: RemoteServer, token: string, pathname: string, body: unknown) => fetch(base(server) + pathname, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('pastes images only from a linked computer, and only PNG or JPEG', async () => {
    const { server } = await remote(); await server.setEnabled(true); const phone = await paired(server); const linked = await computer(server);
    const text = Buffer.from('plain text, not a picture').toString('base64');
    expect((await call(server, phone, '/api/paste-image', { sessionId: 's1', runId: 'r1', image: text })).status).toBe(403);
    expect((await call(server, linked, '/api/paste-image', { sessionId: 's1', runId: 'r1', image: text })).status).toBe(400);
  });
  it('gives keys to the person’s other computers only to a phone', async () => {
    const { server } = await remote(); await server.setEnabled(true); const linked = await computer(server);
    expect((await call(server, linked, '/api/computer-key', { id: '11111111-1111-4111-8111-111111111111' })).status).toBe(403);
  });
});
