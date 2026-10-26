import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunReference, RunningSession } from '../../../shared/ipc';
import type { ChannelControl, LinkedComputerEvent } from '../../../shared/remote';
import { RemoteServer, type RemoteHost } from './remote-server';
import { LinkedComputers, linkableAddress } from './linked-computers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); });
const until = async (check: () => boolean, what: string) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!check()) throw new Error('Timed out waiting for ' + what); };
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

/** A computer's remote with one running Claude channel, standing in for Trace on the other computer. */
async function computer(id: string, name: string, sessionId: string) {
  const running: RunningSession[] = [{ sessionId, runId: 'run-' + sessionId, pid: 1, cwd: '/p', engine: 'claude' }];
  const writes: { reference: RunReference; data: string }[] = []; const controls: { sessionId: string; control: ChannelControl }[] = [];
  const host: RemoteHost = {
    sessions: () => [{ id: sessionId, title: 'Claude Code', engine: 'claude' }],
    running: () => running.map((run) => ({ ...run, cols: 100, rows: 30 })),
    write: (reference, data) => { writes.push({ reference, data }); },
    control: async (target, control) => { controls.push({ sessionId: target, control }); },
  };
  const server = new RemoteServer(temporary(), host, 0, '', async () => 'sent'); cleanup.push(() => server.stop());
  server.identity = { id, name }; await server.setEnabled(true);
  return { server, writes, controls, url: `http://127.0.0.1:${server.address}/` };
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

    pc.server.onSessionEvent({ type: 'data', sessionId: 'pc-1', runId: 'run-pc-1', data: 'hello from the PC' });
    await until(() => events.some((event) => event.type === 'output' && event.data === 'hello from the PC'), 'output');
    expect(relayed).toEqual(['hello from the PC']);

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
