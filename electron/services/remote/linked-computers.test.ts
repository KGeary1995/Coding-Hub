import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunReference, RunningSession } from '../../../shared/ipc';
import type { ChannelControl, LinkedComputerEvent } from '../../../shared/remote';
import { DESKTOP_IDLE_SECONDS, RemoteServer, type RemoteHost } from './remote-server';
import { LinkedComputers, linkableAddress } from './linked-computers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); });
const until = async (check: () => boolean, what: string) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!check()) throw new Error('Timed out waiting for ' + what); };
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

/** A computer's remote with one running Claude channel, standing in for Trace on the other computer. */
async function computer(id: string, name: string, sessionId: string, idle?: { seconds: number }) {
  const running: RunningSession[] = [{ sessionId, runId: 'run-' + sessionId, pid: 1, cwd: '/p', engine: 'claude' }];
  const writes: { reference: RunReference; data: string }[] = []; const controls: { sessionId: string; control: ChannelControl }[] = [];
  const size = { cols: 100, rows: 30 }; const sizes: string[] = [];
  const host: RemoteHost = {
    sessions: () => [{ id: sessionId, title: 'Claude Code', engine: 'claude' }],
    running: () => running.map((run) => ({ ...run, ...size })),
    resize: (_reference, cols, rows) => { Object.assign(size, { cols, rows }); sizes.push(`${cols}x${rows}`); },
    write: (reference, data) => { writes.push({ reference, data }); },
    control: async (target, control) => { controls.push({ sessionId: target, control }); },
    ...(idle ? { idleSeconds: () => idle.seconds } : {}),
  };
  const server = new RemoteServer(temporary(), host, 0, '', async () => 'sent'); cleanup.push(() => server.stop());
  server.identity = { id, name }; await server.setEnabled(true);
  return { server, writes, controls, sizes, url: `http://127.0.0.1:${server.address}/` };
}
async function phoneToken(server: RemoteServer) {
  const code = server.pair('phone').pairing!.code;
  return (await (await fetch(`http://127.0.0.1:${server.address}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Phone' }) })).json() as { token: string }).token;
}

const PC = '11111111-1111-4111-8111-111111111111'; const MAC = '22222222-2222-4222-8222-222222222222';

describe('linked computers', () => {
  it('links with a computer code, follows every channel, types, and starts and stops channels there', async () => {
    const pc = await computer(PC, 'Obsidian-Halo', 'pc-1');
    const events: LinkedComputerEvent[] = []; const relayed: string[] = [];
    const mac = new LinkedComputers(temporary(), () => ({ id: MAC, name: 'MacBook' }), () => [{ id: PC, name: 'Obsidian-Halo', url: pc.url }, { id: MAC, name: 'MacBook', url: null }], (event) => events.push(event),
      { output: (_s, _r, data) => relayed.push(data), resize: () => {}, changed: () => {} });
    cleanup.push(() => mac.stop());
    // This computer is not offered as something to link to.
    expect(mac.status().map((item) => item.id)).toEqual([PC]);

    // A phone's code is refused: it would give a key that cannot start or stop anything.
    await expect(mac.link(PC, pc.server.pair('phone').pairing!.code)).rejects.toMatchObject({ code: 'LINK_PHONE_CODE' });
    await expect(mac.link(PC, 'WRONGCODE1')).rejects.toMatchObject({ code: 'LINK_REFUSED' });
    const status = await mac.link(PC, pc.server.pair('computer').pairing!.code);
    expect(status[0]).toMatchObject({ id: PC, linked: true });
    expect(pc.server.status().devices).toEqual([expect.objectContaining({ name: 'MacBook', kind: 'computer' })]);
    await until(() => mac.status()[0].connected && mac.status()[0].channels.length === 1, 'the stream');
    expect(mac.status()[0].channels[0]).toMatchObject({ sessionId: 'pc-1', running: true, computer: { id: PC, name: 'Obsidian-Halo' } });

    // With the computer's tab closed, its output still reaches phones but not the desktop window.
    pc.server.onSessionEvent({ type: 'data', sessionId: 'pc-1', runId: 'run-pc-1', data: 'before the tab opened' });
    await until(() => relayed.includes('before the tab opened'), 'relayed output');
    expect(events.some((event) => event.type === 'output')).toBe(false);
    mac.watch(PC);
    pc.server.onSessionEvent({ type: 'data', sessionId: 'pc-1', runId: 'run-pc-1', data: 'hello from the PC' });
    await until(() => events.some((event) => event.type === 'output' && event.data === 'hello from the PC'), 'output');
    expect(relayed).toEqual(['before the tab opened', 'hello from the PC']);

    await mac.input(PC, 'pc-1', 'run-pc-1', 'y\r');
    expect(pc.writes).toEqual([{ reference: { sessionId: 'pc-1', runId: 'run-pc-1' }, data: 'y\r' }]);
    await mac.control(PC, 'pc-1', 'restart');
    expect(pc.controls).toEqual([{ sessionId: 'pc-1', control: 'restart' }]);
    await expect(mac.control(PC, 'not-a-channel', 'stop')).rejects.toMatchObject({ code: 'LINK_FAILED' });

    // The desktop opening the tab gets the screen as it is now.
    events.length = 0; mac.watch(PC);
    await until(() => events.some((event) => event.type === 'replay'), 'the replay');
    expect(events.find((event) => event.type === 'replay')).toMatchObject({ sessionId: 'pc-1', runId: 'run-pc-1', cols: 100, rows: 30 });

    // Unlinking removes the key on both computers.
    await mac.unlink(PC);
    expect(mac.status()[0]).toMatchObject({ linked: false, connected: false });
    expect(pc.server.status().devices).toEqual([]);
  });

  it('lets a phone paired with one computer see and type into the other computer’s channels, and never relays back', async () => {
    const pc = await computer(PC, 'Obsidian-Halo', 'pc-1'); const mac = await computer(MAC, 'MacBook', 'mac-1');
    const link = new LinkedComputers(temporary(), () => ({ id: MAC, name: 'MacBook' }), () => [{ id: PC, name: 'Obsidian-Halo', url: pc.url }], () => {},
      { output: (sessionId, runId, data) => mac.server.relayOutput(sessionId, runId, data), resize: (sessionId, runId, cols, rows) => mac.server.relayResize(sessionId, runId, cols, rows), changed: () => mac.server.relayChanged() });
    cleanup.push(() => link.stop()); mac.server.setRelay(link);
    await link.link(PC, pc.server.pair('computer').pairing!.code);
    await until(() => link.channels().length === 1, 'the PC channels');

    const phone = await phoneToken(mac.server);
    const channels = await (await fetch(`${mac.url}api/channels`, { headers: { Authorization: `Bearer ${phone}` } })).json() as { sessionId: string; computer?: { name: string } }[];
    expect(channels.map((channel) => [channel.sessionId, channel.computer?.name ?? null])).toEqual([['mac-1', 'MacBook'], ['pc-1', 'Obsidian-Halo']]);
    // Typing on the phone into the PC's channel goes through the Mac to the PC.
    const typed = await fetch(`${mac.url}api/input`, { method: 'POST', headers: { Authorization: `Bearer ${phone}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'pc-1', runId: 'run-pc-1', data: 'n' }) });
    expect(typed.status).toBe(200); expect(pc.writes.map((write) => write.data)).toEqual(['n']); expect(mac.writes).toEqual([]);
    // A phone cannot start or stop channels, or follow every channel at once.
    expect((await fetch(`${mac.url}api/control`, { method: 'POST', headers: { Authorization: `Bearer ${phone}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'mac-1', control: 'stop' }) })).status).toBe(403);
    expect((await fetch(`${mac.url}api/stream?all=1`, { headers: { Authorization: `Bearer ${phone}` } })).status).toBe(403);
    // What the Mac gives a linked computer holds only its own channels, so nothing loops back to the PC.
    expect(mac.server.channels('computer').map((channel) => channel.sessionId)).toEqual(['mac-1']);
  });

  it('gives a phone on one computer its own key to the other, so it can reach that one directly when the first is off', async () => {
    const pc = await computer(PC, 'Obsidian-Halo', 'pc-1'); const mac = await computer(MAC, 'MacBook', 'mac-1');
    const link = new LinkedComputers(temporary(), () => ({ id: MAC, name: 'MacBook' }), () => [{ id: PC, name: 'Obsidian-Halo', url: pc.url }], () => {}, { output: () => {}, resize: () => {}, changed: () => mac.server.relayChanged() });
    cleanup.push(() => link.stop()); mac.server.setRelay(link);
    await link.link(PC, pc.server.pair('computer').pairing!.code); await until(() => link.channels().length === 1, 'the PC channels');
    const phone = await phoneToken(mac.server); const auth = { Authorization: `Bearer ${phone}`, 'Content-Type': 'application/json' };
    expect(await (await fetch(`${mac.url}api/computers`, { headers: auth })).json()).toMatchObject({ self: { id: MAC, name: 'MacBook' }, others: [{ id: PC, name: 'Obsidian-Halo' }] });
    const first = await (await fetch(`${mac.url}api/computer-key`, { method: 'POST', headers: auth, body: JSON.stringify({ id: PC }) })).json() as { id: string; url: string; token: string };
    expect(first).toMatchObject({ id: PC, name: 'Obsidian-Halo', url: pc.url });
    // Straight to the PC with that key: a phone there, which sees the PC's channels and cannot control them.
    const direct = { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' };
    expect((await (await fetch(`${pc.url}api/channels`, { headers: direct })).json() as { sessionId: string }[]).map((channel) => channel.sessionId)).toEqual(['pc-1']);
    expect((await fetch(`${pc.url}api/control`, { method: 'POST', headers: direct, body: JSON.stringify({ sessionId: 'pc-1', control: 'stop' }) })).status).toBe(403);
    expect(pc.server.status().devices.find((device) => device.kind === 'phone')?.name).toBe('Phone (through MacBook)');
    // Asking again replaces that key rather than piling up keys on the PC.
    const second = await (await fetch(`${mac.url}api/computer-key`, { method: 'POST', headers: auth, body: JSON.stringify({ id: PC }) })).json() as { token: string };
    expect((await fetch(`${pc.url}api/channels`, { headers: direct })).status).toBe(401);
    expect((await fetch(`${pc.url}api/channels`, { headers: { Authorization: `Bearer ${second.token}` } })).status).toBe(200);
    expect(pc.server.status().devices.filter((device) => device.kind === 'phone')).toHaveLength(1);
    // A linked computer cannot use the phone route, and a phone cannot use the computer route.
    expect((await fetch(`${mac.url}api/phone-key`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'x', relayKey: 'y' }) })).status).toBe(403);
    expect((await fetch(`${mac.url}api/phone-key/revoke`, { method: 'POST', headers: auth, body: JSON.stringify({ relayKey: 'y' }) })).status).toBe(403);
  });

  it('withdraws the keys a phone got on linked computers when it is removed, or its computer is unlinked', async () => {
    const pc = await computer(PC, 'Obsidian-Halo', 'pc-1'); const mac = await computer(MAC, 'MacBook', 'mac-1');
    const link = new LinkedComputers(temporary(), () => ({ id: MAC, name: 'MacBook' }), () => [{ id: PC, name: 'Obsidian-Halo', url: pc.url }], () => {}, { output: () => {}, resize: () => {}, changed: () => mac.server.relayChanged() });
    cleanup.push(() => link.stop()); mac.server.setRelay(link);
    await link.link(PC, pc.server.pair('computer').pairing!.code); await until(() => link.channels().length === 1, 'the PC channels');
    const keyOnPc = async () => { const phone = await phoneToken(mac.server); const auth = { Authorization: `Bearer ${phone}`, 'Content-Type': 'application/json' }; return (await (await fetch(`${mac.url}api/computer-key`, { method: 'POST', headers: auth, body: JSON.stringify({ id: PC }) })).json() as { token: string }).token; };
    const works = async (token: string) => (await fetch(`${pc.url}api/channels`, { headers: { Authorization: `Bearer ${token}` } })).status === 200;
    // Removing the phone on the Mac (lost, replaced) also stops the key the PC gave it.
    const lost = await keyOnPc(); expect(await works(lost)).toBe(true);
    const phoneId = mac.server.status().devices.find((device) => device.kind === 'phone')!.id; mac.server.revoke(phoneId);
    for (let i = 0; i < 100 && await works(lost); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await works(lost)).toBe(false);
    // Unlinking the Mac from the PC (from either side) takes every key the PC gave the Mac's phones with it.
    const kept = await keyOnPc(); expect(await works(kept)).toBe(true);
    const macOnPc = pc.server.status().devices.find((device) => device.kind === 'computer')!.id; pc.server.revoke(macOnPc);
    expect(await works(kept)).toBe(false); expect(pc.server.status().devices).toEqual([]);
  });

  it('lets the phone app from the other computer call this one directly, and no other site', async () => {
    const pc = await computer(PC, 'Obsidian-Halo', 'pc-1'); const token = await phoneToken(pc.server);
    pc.server.allowedOrigins = () => ['https://macbook.tail1234.ts.net'];
    const preflight = await fetch(`${pc.url}api/channels`, { method: 'OPTIONS', headers: { Origin: 'https://macbook.tail1234.ts.net', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe('https://macbook.tail1234.ts.net');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const allowed = await fetch(`${pc.url}api/channels`, { headers: { Origin: 'https://macbook.tail1234.ts.net', Authorization: `Bearer ${token}` } });
    expect(allowed.status).toBe(200); expect(allowed.headers.get('access-control-allow-origin')).toBe('https://macbook.tail1234.ts.net');
    expect((await fetch(`${pc.url}api/channels`, { headers: { Origin: 'https://evil.example.com', Authorization: `Bearer ${token}` } })).status).toBe(403);
    // Without a key the other computer's app gets nothing, origin or not.
    expect((await fetch(`${pc.url}api/channels`, { headers: { Origin: 'https://macbook.tail1234.ts.net' } })).status).toBe(401);
  });

  it('draws a channel at the phone’s size while the phone shows it, and gives it back to the desktop', async () => {
    const pc = await computer(PC, 'Obsidian-Halo', 'pc-1'); const mac = await computer(MAC, 'MacBook', 'mac-1');
    const link = new LinkedComputers(temporary(), () => ({ id: MAC, name: 'MacBook' }), () => [{ id: PC, name: 'Obsidian-Halo', url: pc.url }], () => {}, { output: () => {}, resize: () => {}, changed: () => mac.server.relayChanged() });
    cleanup.push(() => link.stop()); mac.server.setRelay(link);
    await link.link(PC, pc.server.pair('computer').pairing!.code); await until(() => link.channels().length === 1, 'the PC channels');
    const phone = await phoneToken(mac.server); const auth = { Authorization: `Bearer ${phone}`, 'Content-Type': 'application/json' };
    const size = (sessionId: string, cols: number, rows: number) => fetch(`${mac.url}api/size`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId, runId: 'run-' + sessionId, cols, rows }) });
    const release = (sessionId: string) => fetch(`${mac.url}api/size`, { method: 'DELETE', headers: auth, body: JSON.stringify({ sessionId }) });

    // The phone's size, then a new one (keyboard opened), then back to the desktop's own 100x30.
    expect((await size('mac-1', 44, 30)).status).toBe(200); expect((await size('mac-1', 44, 18)).status).toBe(200);
    expect((await release('mac-1')).status).toBe(200);
    expect(mac.sizes).toEqual(['44x30', '44x18', '100x30']);
    // Typing at the desktop gives the channel back too.
    await size('mac-1', 50, 20); mac.server.personInput('mac-1', 'a');
    expect(mac.sizes.slice(-2)).toEqual(['50x20', '100x30']);
    // While the phone shows it, a desktop resize (a tile selected, the window moved) does not change it under the
    // phone; the desktop's new size is the one put back when the phone lets go.
    await size('mac-1', 50, 20); expect(mac.server.desktopResize('mac-1', 'run-mac-1', 120, 40)).toBe(true);
    expect(mac.sizes.slice(-1)).toEqual(['50x20']);
    await release('mac-1'); expect(mac.sizes.slice(-1)).toEqual(['120x40']);
    // Without a phone holding it, the desktop resizes normally.
    expect(mac.server.desktopResize('mac-1', 'run-mac-1', 100, 30)).toBe(false);

    // The other computer's channel is resized there, through this one.
    expect((await size('pc-1', 40, 22)).status).toBe(200); expect((await release('pc-1')).status).toBe(200);
    expect(pc.sizes).toEqual(['40x22', '100x30']); expect(mac.sizes.slice(-1)).toEqual(['120x40']);
    // Out-of-range sizes are refused.
    expect((await size('mac-1', 5, 2)).status).toBe(400);
  });

  it('keeps the desktop size while the computer is in use, and gives the phone its size once it is idle or asked', async () => {
    const idle = { seconds: 5 }; const mac = await computer(MAC, 'MacBook', 'mac-1', idle);
    const phone = await phoneToken(mac.server); const auth = { Authorization: `Bearer ${phone}`, 'Content-Type': 'application/json' };
    const size = async (cols: number, rows: number, force?: boolean) => (await (await fetch(`${mac.url}api/size`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'mac-1', runId: 'run-mac-1', cols, rows, ...(force ? { force } : {}) }) })).json()) as { held: boolean };
    // The person is at the computer: the phone's request waits, and the desktop tile keeps its size.
    expect(await size(44, 30)).toEqual({ ok: true, held: false }); expect(mac.sizes).toEqual([]);
    // Two minutes without keyboard or mouse: the phone gets its size.
    idle.seconds = DESKTOP_IDLE_SECONDS; mac.server.checkDesktop(); expect(mac.sizes).toEqual(['44x30']);
    // The person is back: the desktop size returns at once, and the phone's size waits for the next idle spell.
    idle.seconds = 1; mac.server.checkDesktop(); expect(mac.sizes).toEqual(['44x30', '100x30']);
    idle.seconds = DESKTOP_IDLE_SECONDS; mac.server.checkDesktop(); expect(mac.sizes.slice(-1)).toEqual(['44x30']);
    idle.seconds = 1; mac.server.checkDesktop(); expect(mac.sizes.slice(-1)).toEqual(['100x30']);
    // "Fit to phone" applies it now and keeps it while the computer is used, until the person types in that channel.
    expect(await size(44, 30, true)).toEqual({ ok: true, held: true }); expect(mac.sizes.slice(-1)).toEqual(['44x30']);
    mac.server.checkDesktop(); expect(mac.sizes.slice(-1)).toEqual(['44x30']);
    mac.server.personInput('mac-1', 'a'); expect(mac.sizes.slice(-1)).toEqual(['100x30']);
    // Typing at the desktop also drops the waiting request: an idle spell does not shrink the channel again by itself.
    idle.seconds = DESKTOP_IDLE_SECONDS; mac.server.checkDesktop(); expect(mac.sizes.slice(-1)).toEqual(['100x30']);
  });

  it('only sends codes and keys to tailnet HTTPS addresses (or loopback in tests)', () => {
    expect(linkableAddress('https://desk.tail1234.ts.net/')).toBe('https://desk.tail1234.ts.net/');
    expect(linkableAddress('https://desk.tail1234.ts.net/some/path')).toBe('https://desk.tail1234.ts.net/');
    expect(linkableAddress('http://desk.tail1234.ts.net/')).toBeNull();
    expect(linkableAddress('https://evil.example.com/')).toBeNull();
    expect(linkableAddress('https://user:pass@desk.tail1234.ts.net/')).toBeNull();
    expect(linkableAddress('http://127.0.0.1:47821/')).toBe('http://127.0.0.1:47821/');
    expect(linkableAddress(null)).toBeNull();
  });
});
