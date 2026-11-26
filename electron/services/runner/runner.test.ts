import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { encode, FrameReader, Kind, RUNNER_PROTOCOL, type Frame, type SpawnRequest } from './protocol';
import { Runner, type RunnerPty } from './runner';
import { Tail } from './tail';

class FakePty implements RunnerPty {
  pause?: () => void; resume?: () => void;
  pid = 4242; written: string[] = []; size: [number, number] | null = null; killed = false; calls: string[] = [];
  private data: ((data: string) => void)[] = []; private exit: ((event: { exitCode: number }) => void)[] = [];
  onData(listener: (data: string) => void) { this.data.push(listener); }
  onExit(listener: (event: { exitCode: number }) => void) { this.exit.push(listener); }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.size = [cols, rows]; }
  kill() { this.killed = true; this.end(130); }
  emit(text: string) { for (const listener of this.data) listener(text); }
  end(exitCode: number) { for (const listener of this.exit) listener({ exitCode }); }
}

/** A connection to the runner that collects frames and waits for one of a kind. */
class Client {
  frames: Frame[] = []; private reader = new FrameReader(); private waiters: (() => void)[] = []; closed = false;
  constructor(public socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => { this.frames.push(...this.reader.push(chunk)); for (const wake of this.waiters.splice(0)) wake(); });
    socket.on('close', () => { this.closed = true; for (const wake of this.waiters.splice(0)) wake(); });
  }
  send(kind: number, term: number, payload?: Buffer | string | object) { this.socket.write(encode(kind as never, term, payload)); }
  async next(kind: number, timeout = 3000): Promise<Frame> {
    const until = Date.now() + timeout;
    for (;;) {
      const index = this.frames.findIndex((frame) => frame.kind === kind);
      if (index >= 0) return this.frames.splice(index, 1)[0];
      if (this.closed || Date.now() > until) throw new Error(`No frame of kind ${kind}`);
      await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 50); });
    }
  }
  async gone(timeout = 3000) { const until = Date.now() + timeout; while (!this.closed && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20)); return this.closed; }
}

const servers: net.Server[] = []; const sockets: net.Socket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.destroy(); for (const server of servers.splice(0)) server.close(); });

async function start(options: { idleMs?: number; sendLimit?: number; tailBytes?: number } = {}) {
  const ptys: FakePty[] = []; const spawned: SpawnRequest[] = []; let exited = 0;
  const runner = new Runner('the-secret', { spawn: (request) => { spawned.push(request); const pty = new FakePty(); ptys.push(pty); return pty; }, exit: () => { exited++; }, ...options });
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\trace-runner-test-${randomBytes(6).toString('hex')}` : path.join(os.tmpdir(), `trace-runner-${randomBytes(6).toString('hex')}.sock`);
  const server = net.createServer((socket) => runner.connect(socket)); servers.push(server);
  await new Promise<void>((resolve) => server.listen(address, resolve));
  const connect = async (secret = 'the-secret', version = RUNNER_PROTOCOL) => {
    const socket = net.connect(address); sockets.push(socket); await new Promise((resolve) => socket.once('connect', resolve));
    const client = new Client(socket); client.send(Kind.hello, 0, { version, secret }); return client;
  };
  return { runner, ptys, spawned, connect, exits: () => exited };
}
const spawnRequest = (id: string): SpawnRequest => ({ id, file: 'claude', args: ['--x'], cwd: '/work', env: { A: '1' }, cols: 100, rows: 30 });
const body = <T>(frame: Frame) => JSON.parse(frame.payload.toString('utf8')) as T;

describe('runner protocol', () => {
  it('reads frames split across chunks and several in one chunk', () => {
    const reader = new FrameReader();
    const all = Buffer.concat([encode(Kind.output, 7, Buffer.from('héllo')), encode(Kind.list, 0, { a: 1 }), encode(Kind.tail, 2)]);
    const frames = [...reader.push(all.subarray(0, 4)), ...reader.push(all.subarray(4, 15)), ...reader.push(all.subarray(15))];
    expect(frames.map((frame) => [frame.kind, frame.term])).toEqual([[Kind.output, 7], [Kind.list, 0], [Kind.tail, 2]]);
    expect(frames[0].payload.toString('utf8')).toBe('héllo'); expect(body(frames[1])).toEqual({ a: 1 }); expect(frames[2].payload.length).toBe(0);
  });
  it('refuses a frame larger than allowed', () => {
    const header = Buffer.alloc(9); header.writeUInt8(Kind.output, 0); header.writeUInt32BE(64 * 1024 * 1024, 5);
    expect(() => new FrameReader().push(header)).toThrow(/larger than allowed/);
  });
});

describe('runner tail', () => {
  it('keeps the last bytes and never starts inside a character', () => {
    // 'abcdéfé!' is 10 bytes (é is 2). The last 6 start on a whole é; the last 5 start on the second byte of one, which is skipped.
    const whole = new Tail(6); const cut = new Tail(5);
    for (const tail of [whole, cut]) for (const part of ['abc', 'déf', 'é!']) tail.append(Buffer.from(part));
    expect(whole.read().toString('utf8')).toBe('éfé!'); expect(cut.length).toBe(5); expect(cut.read().toString('utf8')).toBe('fé!');
    const big = new Tail(4); big.append(Buffer.from('0123456789')); expect(big.read().toString()).toBe('6789');
  });
});

describe('Runner', () => {
  it('only answers a Trace that knows the secret', async () => {
    const { connect } = await start();
    const stranger = await connect('wrong'); expect(await stranger.gone()).toBe(true);
    const trace = await connect(); expect(body<{ version: number }>(await trace.next(Kind.welcome)).version).toBe(RUNNER_PROTOCOL);
  });

  it('starts a terminal, passes input, size and output on, and reports its exit', async () => {
    const { connect, ptys, spawned } = await start(); const trace = await connect(); await trace.next(Kind.welcome);
    trace.send(Kind.spawn, 0, spawnRequest('run-1'));
    const { term, pid } = body<{ term: number; pid: number }>(await trace.next(Kind.spawned));
    expect(spawned[0]).toMatchObject({ id: 'run-1', file: 'claude', args: ['--x'], cols: 100 }); expect(pid).toBe(4242);
    trace.send(Kind.input, term, 'hi\r'); trace.send(Kind.resize, term, { cols: 80, rows: 24 }); trace.send(Kind.signal, term, { signal: 'interrupt' });
    await until(() => ptys[0].written.length === 2);
    ptys[0].emit('hello');
    const output = await trace.next(Kind.output); expect([output.term, output.payload.toString()]).toEqual([term, 'hello']);
    expect(ptys[0].written).toEqual(['hi\r', '\x03']); expect(ptys[0].size).toEqual([80, 24]);
    ptys[0].end(3); const exited = await trace.next(Kind.exited); expect([exited.term, body<{ exitCode: number }>(exited).exitCode]).toEqual([term, 3]);
  });

  it('keeps terminals running while no Trace is connected, and gives them back with their output', async () => {
    const { connect, ptys } = await start(); const first = await connect(); await first.next(Kind.welcome);
    first.send(Kind.spawn, 0, spawnRequest('run-1')); const { term } = body<{ term: number }>(await first.next(Kind.spawned));
    first.socket.destroy(); await first.gone();
    // Trace is gone (closed, crashed or updating): the program goes on writing.
    ptys[0].emit('while '); ptys[0].emit('away');
    const again = await connect(); await again.next(Kind.welcome);
    again.send(Kind.list, 0); expect(body(await again.next(Kind.list))).toEqual([{ term, id: 'run-1', pid: 4242, cols: 100, rows: 30 }]);
    again.send(Kind.tail, term); expect((await again.next(Kind.tail)).payload.toString()).toBe('while away');
    expect(ptys[0].killed).toBe(false);
  });

  it('pauses a program for Trace, and resumes it when Trace goes', async () => {
    const { connect, ptys } = await start(); const trace = await connect(); await trace.next(Kind.welcome);
    trace.send(Kind.spawn, 0, spawnRequest('run-1')); const { term } = body<{ term: number }>(await trace.next(Kind.spawned));
    const calls: string[] = []; ptys[0].pause = () => calls.push('pause'); ptys[0].resume = () => calls.push('resume');
    trace.send(Kind.pause, term); trace.send(Kind.pause, term); trace.send(Kind.resume, term); trace.send(Kind.pause, term);
    await until(() => calls.length === 3); expect(calls).toEqual(['pause', 'resume', 'pause']);
    trace.socket.destroy(); await until(() => calls.length === 4); expect(calls[3]).toBe('resume');
  });

  it('gives back the channel details a terminal was started with', async () => {
    const { connect } = await start(); const trace = await connect(); await trace.next(Kind.welcome);
    const meta = { sessionId: 's-1', engine: 'claude', token: 'abc' };
    trace.send(Kind.spawn, 0, { ...spawnRequest('run-1'), meta }); await trace.next(Kind.spawned);
    trace.send(Kind.list, 0); expect(body<{ meta?: unknown }[]>(await trace.next(Kind.list))[0].meta).toEqual(meta);
  });

  it('lets the newest Trace take over, and closes the older one', async () => {
    const { connect } = await start(); const old = await connect(); await old.next(Kind.welcome);
    const fresh = await connect(); await fresh.next(Kind.welcome);
    expect(await old.gone()).toBe(true);
    fresh.send(Kind.list, 0); expect(body(await fresh.next(Kind.list))).toEqual([]);
  });

  it('lists an ended terminal until Trace forgets it', async () => {
    const { connect, ptys } = await start(); const trace = await connect(); await trace.next(Kind.welcome);
    trace.send(Kind.spawn, 0, spawnRequest('run-1')); const { term } = body<{ term: number }>(await trace.next(Kind.spawned));
    trace.socket.destroy(); await trace.gone(); ptys[0].end(0);
    const again = await connect(); await again.next(Kind.welcome);
    again.send(Kind.list, 0); expect(body<{ exitCode?: number }[]>(await again.next(Kind.list))[0].exitCode).toBe(0);
    again.send(Kind.forget, term); again.send(Kind.list, 0); expect(body(await again.next(Kind.list))).toEqual([]);
  });

  it('stops a terminal through the stop it was given', async () => {
    const { connect, ptys } = await start(); const trace = await connect(); await trace.next(Kind.welcome);
    trace.send(Kind.spawn, 0, spawnRequest('run-1')); const { term } = body<{ term: number }>(await trace.next(Kind.spawned));
    trace.send(Kind.signal, term, { signal: 'stop' }); expect(body<{ exitCode: number }>(await trace.next(Kind.exited)).exitCode).toBe(130); expect(ptys[0].killed).toBe(true);
  });

  it('reports a spawn that fails, by its id', async () => {
    const runner = new Runner('s', { spawn: () => { throw new Error('claude was not found'); }, exit: () => {} });
    const [a, b] = await pair(); runner.connect(a); const trace = new Client(b);
    trace.send(Kind.hello, 0, { version: RUNNER_PROTOCOL, secret: 's' }); await trace.next(Kind.welcome);
    trace.send(Kind.spawn, 0, spawnRequest('run-9')); expect(body(await trace.next(Kind.error))).toEqual({ id: 'run-9', message: 'claude was not found' });
  });

  it('drains for an update: takes no new terminals and exits once the last one ends', async () => {
    const { connect, ptys, exits } = await start(); const trace = await connect(); await trace.next(Kind.welcome);
    trace.send(Kind.spawn, 0, spawnRequest('run-1')); await trace.next(Kind.spawned);
    // A Trace on a newer protocol may only drain.
    const newer = await connect('the-secret', RUNNER_PROTOCOL + 1); await newer.next(Kind.welcome);
    newer.send(Kind.list, 0); await newer.next(Kind.error); newer.send(Kind.drain, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    trace.send(Kind.spawn, 0, spawnRequest('run-2')); expect(body<{ id: string }>(await trace.next(Kind.error)).id).toBe('run-2');
    expect(exits()).toBe(0); ptys[0].end(0); await trace.next(Kind.exited); expect(exits()).toBe(1);
  });

  it('leaves on its own when nothing runs and no Trace is connected', async () => {
    const { connect, exits } = await start({ idleMs: 100 }); const trace = await connect(); await trace.next(Kind.welcome);
    await new Promise((resolve) => setTimeout(resolve, 200)); expect(exits()).toBe(0);
    trace.socket.destroy(); await trace.gone(); await new Promise((resolve) => setTimeout(resolve, 250)); expect(exits()).toBe(1);
  });

  it('runs a chat with pipes: says it can, never sends it Ctrl+C, and pauses it for a slow Trace instead of skipping its output', async () => {
    const { connect, ptys } = await start({ sendLimit: 1 }); const trace = await connect(); expect(body<{ pipes?: boolean }>(await trace.next(Kind.welcome)).pipes).toBe(true);
    trace.send(Kind.spawn, 0, { ...spawnRequest('chat-1'), pipe: true }); const { term } = body<{ term: number }>(await trace.next(Kind.spawned));
    ptys[0].pause = () => ptys[0].calls.push('pause'); ptys[0].resume = () => ptys[0].calls.push('resume');
    trace.send(Kind.signal, term, { signal: 'interrupt' }); trace.send(Kind.input, term, '{"type":"user"}\n'); await until(() => ptys[0].written.length === 1);
    expect(ptys[0].written).toEqual(['{"type":"user"}\n']);
    ptys[0].emit('x'.repeat(64 * 1024));
    const output = await trace.next(Kind.output); expect(output.payload.length).toBe(64 * 1024);
    expect(trace.frames.some((frame) => frame.kind === Kind.skipped)).toBe(false);
    await until(() => ptys[0].calls.includes('resume')); expect(ptys[0].calls).toEqual(['pause', 'resume']);
    trace.send(Kind.journal, term); const journal = await trace.next(Kind.journal); expect(journal.payload.readUInt8(0)).toBe(0);
  });
  it('keeps reading a terminal Trace cannot keep up with, and says so', async () => {
    const { connect, ptys } = await start({ sendLimit: 0 }); const trace = await connect(); await trace.next(Kind.welcome);
    trace.send(Kind.spawn, 0, spawnRequest('run-1')); const { term } = body<{ term: number }>(await trace.next(Kind.spawned));
    // With no room at all, the first write fills the queue and later output goes only to the tail.
    (trace.socket as unknown as { pause(): void }).pause();
    for (let index = 0; index < 2000; index++) ptys[0].emit('x'.repeat(1024));
    trace.socket.resume();
    expect((await trace.next(Kind.skipped, 5000)).term).toBe(term);
    trace.send(Kind.tail, term); expect((await trace.next(Kind.tail, 5000)).payload.length).toBe(1024 * 1024);
  }, 15000);
});

async function until(check: () => boolean, timeout = 3000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); } }

/** Two connected sockets without a server address. */
async function pair(): Promise<[net.Socket, net.Socket]> {
  const server = net.createServer(); servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
  const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1'); sockets.push(client);
  const inside = await accepted; sockets.push(inside); return [inside, client];
}
