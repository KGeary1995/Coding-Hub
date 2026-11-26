import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerClient } from './client';
import { Runner, type RunnerPty as HeldPty } from './runner';

class FakePty implements HeldPty {
  pid = 777; written: string[] = []; size: [number, number] | null = null; calls: string[] = [];
  private data: ((data: string) => void)[] = []; private exit: ((event: { exitCode: number }) => void)[] = []; private errors: ((data: string) => void)[] = [];
  onStderr(listener: (data: string) => void) { this.errors.push(listener); }
  complain(text: string) { for (const listener of this.errors) listener(text); }
  onData(listener: (data: string) => void) { this.data.push(listener); }
  onExit(listener: (event: { exitCode: number }) => void) { this.exit.push(listener); }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.size = [cols, rows]; }
  pause() { this.calls.push('pause'); } resume() { this.calls.push('resume'); }
  kill() { this.calls.push('kill'); this.end(130); }
  emit(text: string) { for (const listener of this.data) listener(text); }
  end(exitCode: number) { for (const listener of this.exit) listener({ exitCode }); }
}

const servers: net.Server[] = []; const clients: RunnerClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); for (const server of servers.splice(0)) server.close(); });
async function until(check: () => boolean, timeout = 3000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); } }

async function start() {
  const ptys: FakePty[] = [];
  const runner = new Runner('secret', { spawn: () => { const pty = new FakePty(); ptys.push(pty); return pty; }, exit: () => {} });
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\trace-runner-client-${randomBytes(6).toString('hex')}` : path.join(os.tmpdir(), `trace-runner-client-${randomBytes(6).toString('hex')}.sock`);
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => { sockets.push(socket); runner.connect(socket); }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(address, resolve));
  const client = async (secret = 'secret') => { const made = new RunnerClient(address, secret); clients.push(made); await made.connect(); return made; };
  return { ptys, client, address, dropAll: () => { for (const socket of sockets) socket.destroy(); } };
}
const request = (id: string) => ({ id, file: 'claude', args: [], cwd: '/w', env: {}, cols: 120, rows: 40, meta: { sessionId: `s-${id}` } });

describe('RunnerClient', () => {
  it('starts a terminal that behaves like node-pty for PtyManager', async () => {
    const { ptys, client } = await start(); const trace = await client();
    const pty = await trace.spawn(request('run-1'));
    expect([pty.pid, pty.cols, pty.rows]).toEqual([777, 120, 40]);
    const seen: string[] = []; pty.onData((text) => seen.push(text)); let exit: number | null = null; pty.onExit(({ exitCode }) => { exit = exitCode; });
    pty.write('hé\r'); pty.resize(90, 20); pty.pause(); pty.resume();
    await until(() => ptys[0].written.length === 1 && ptys[0].calls.length === 2);
    expect(ptys[0].written).toEqual(['hé\r']); expect(ptys[0].size).toEqual([90, 20]); expect(ptys[0].calls).toEqual(['pause', 'resume']); expect([pty.cols, pty.rows]).toEqual([90, 20]);
    ptys[0].emit('out ✓'); await until(() => seen.join('') === 'out ✓');
    ptys[0].end(4); await until(() => exit === 4);
  });

  it('refuses a spawn the runner could not start, by its id', async () => {
    const runner = new Runner('s', { spawn: () => { throw new Error('not found'); }, exit: () => {} });
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\trace-runner-client-${randomBytes(6).toString('hex')}` : path.join(os.tmpdir(), `trace-runner-client-${randomBytes(6).toString('hex')}.sock`);
    const server = net.createServer((socket) => runner.connect(socket)); servers.push(server); await new Promise<void>((resolve) => server.listen(address, resolve));
    const trace = new RunnerClient(address, 's'); clients.push(trace); await trace.connect();
    await expect(trace.spawn(request('run-1'))).rejects.toThrow('not found');
  });

  it('is turned away without the secret', async () => {
    const { address } = await start(); const stranger = new RunnerClient(address, 'wrong');
    await expect(stranger.connect(1000)).rejects.toThrow();
  });

  it('lets go without stopping anything, and a new Trace takes the terminal up again with its output', async () => {
    const { ptys, client } = await start(); const first = await client();
    await first.spawn(request('run-1')); first.close(); await new Promise((resolve) => setTimeout(resolve, 50));
    ptys[0].emit('kept while closed');
    const second = await client(); const [terminal] = await second.list();
    expect(terminal).toMatchObject({ id: 'run-1', pid: 777, meta: { sessionId: 's-run-1' } }); expect(ptys[0].calls).toEqual([]);
    const pty = second.adopt(terminal); expect((await second.tail(terminal.term)).toString()).toBe('kept while closed');
    const seen: string[] = []; pty.onData((text) => seen.push(text)); ptys[0].emit(' and after'); await until(() => seen.join('') === ' and after');
    pty.kill(); await until(() => ptys[0].calls.includes('kill'));
  });

  it('joins a character split between two pieces of output', async () => {
    const { ptys, client } = await start(); const trace = await client(); const pty = await trace.spawn(request('run-1'));
    const seen: string[] = []; pty.onData((text) => seen.push(text));
    // ✓ is three bytes; two output frames split it (the runner's own frames always hold whole strings, so they are fed in).
    const receive = (bytes: number[]) => (trace as unknown as { receive(frame: { kind: number; term: number; payload: Buffer }): void }).receive({ kind: 10, term: pty.term, payload: Buffer.from(bytes) });
    receive([0xe2, 0x9c]); receive([0x93, 0x21]);
    expect(seen.join('')).toBe('✓!'); expect(ptys).toHaveLength(1);
  });

  it('reports its terminals ended when the runner goes away', async () => {
    const { client, dropAll } = await start(); const trace = await client(); const pty = await trace.spawn(request('run-1'));
    let exit: number | null = null; pty.onExit(({ exitCode }) => { exit = exitCode; }); let lost = false; trace.onLost = () => { lost = true; };
    dropAll(); await until(() => lost); expect(exit).toBe(1); expect(trace.connected).toBe(false);
  });
  it('runs a chat with pipes: its journal comes back in order, kept while Trace was away, and its stderr apart', async () => {
    const { ptys, client } = await start(); const trace = await client(); expect(trace.pipes).toBe(true);
    const chat = await trace.spawn({ ...request('chat-1'), pipe: true }); const errors: string[] = []; chat.onStderr((text) => errors.push(text));
    chat.write('{"type":"user"}\n'); await until(() => ptys[0].written.length === 1);
    ptys[0].emit('{"type":"assi'); ptys[0].emit('stant"}\n'); ptys[0].complain('a warning');
    await until(() => errors.length === 1); expect(errors).toEqual(['a warning']);
    trace.close();
    // While no Trace is connected the chat goes on; a Trace that comes back reads all of it from the journal.
    ptys[0].emit('{"type":"result"}\n');
    const back = await client(); const [listed] = await back.list(); expect(listed).toMatchObject({ id: 'chat-1', pipe: true });
    const journal = await back.journal(listed.term);
    expect(journal?.overflowed).toBe(false);
    expect(journal?.entries.map((entry) => [entry.dir, entry.data.toString()])).toEqual([['in', '{"type":"user"}\n'], ['out', '{"type":"assistant"}\n{"type":"result"}\n']]);
    // A terminal has no journal.
    await back.spawn(request('term-1')); const terminals = await back.list(); expect(await back.journal(terminals[1].term)).toBeNull();
  });
});

