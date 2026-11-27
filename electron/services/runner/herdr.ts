import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IPty, IPtyForkOptions } from 'node-pty';
import type { HeldMeta, HeldTerminals } from '../cli/pty-manager';

/**
 * Trial (2026-11-27, the owner's request): channels' terminals held by herdr-core (`hc`, github.com/herdrdev/herdr-core,
 * Apache-2.0) instead of Trace's own background runner, behind CODING_HUB_HERDR=<path to hc>. It speaks hc's API over
 * `hc connect` (stdin/stdout; its schema/README.md): JSON-RPC in framed mode, each channel's terminal an attach stream.
 * Each terminal carries labels naming its channel and run, and its HeldMeta is kept as an hc document, so a Trace that
 * opens again takes its channels back as it does from its own runner. Not used unless that variable is set.
 */
const FRAME = { data: 0, credit: 1, close: 2, resize: 3 } as const;
/** How far ahead hc may send a terminal's output (bytes not yet read): PtyManager's HIGH_WATER. */
const WINDOW = 1024 * 1024;
/** hc's protocol generation this speaks (hello). */
const GENERATION = 1;
type Listener<T> = (value: T) => void;
interface Facts { address: string; pid: number | null; state: string; exit_code: number | null; signal: number | null; cols?: number; rows?: number; labels?: Record<string, string> }

/** One `hc connect`, in framed mode: requests on channel 0, each attached terminal on a channel of its own. */
class HcConnection {
  private child: ChildProcessWithoutNullStreams; private buffer = Buffer.alloc(0); private next = 1; private framed = false; private line = '';
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private streams = new Map<number, { data: (bytes: Buffer) => void; closed: (reason: string) => void }>();
  ready: Promise<void>; lost = false; onLost?: () => void;
  constructor(hc: string) {
    this.child = spawn(hc, ['connect'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.on('data', (chunk: Buffer) => this.received(chunk));
    this.child.stderr.on('data', () => { /* hc's own diagnostics; its core.log keeps them. */ });
    const gone = () => { if (this.lost) return; this.lost = true; for (const waiting of this.pending.values()) waiting.reject(new Error('hc connect ended.')); this.pending.clear(); for (const stream of this.streams.values()) stream.closed('lost'); this.streams.clear(); this.onLost?.(); };
    this.child.on('exit', gone); this.child.on('error', gone);
    this.ready = this.call('hello', { framed: true, generation: GENERATION }).then(() => undefined);
  }
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.lost) return Promise.reject(new Error('hc connect ended.'));
    const id = this.next++; const message = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    const answer = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
    // Plain mode until hello's answer: one message a line; framed after.
    if (method === 'hello' || !this.framed) this.child.stdin.write(Buffer.concat([message, Buffer.from('\n')])); else this.frame(0, FRAME.data, message);
    return answer;
  }
  frame(channel: number, kind: number, payload: Buffer) { if (this.lost) return; const head = Buffer.alloc(9); head.writeUInt32LE(channel, 0); head.writeUInt8(kind, 4); head.writeUInt32LE(payload.length, 5); this.child.stdin.write(Buffer.concat([head, payload])); }
  /** A stream's first frames can come in the same read as attach's answer, before its HerdrPty exists: kept for it. */
  private early = new Map<number, { data: Buffer[]; closed?: string }>();
  stream(channel: number, data: (bytes: Buffer) => void, closed: (reason: string) => void) {
    this.streams.set(channel, { data, closed }); const early = this.early.get(channel); this.early.delete(channel);
    for (const bytes of early?.data ?? []) data(bytes);
    if (early?.closed !== undefined) { this.streams.delete(channel); closed(early.closed); }
  }
  close() { this.child.stdin.end(); this.child.kill(); }
  private answer(message: { id?: number; result?: unknown; error?: { message?: string; data?: unknown } }) {
    const waiting = message.id === undefined ? undefined : this.pending.get(message.id); if (!waiting) return; this.pending.delete(message.id!);
    if (message.error) waiting.reject(new Error(`hc: ${message.error.message ?? 'error'} ${JSON.stringify(message.error.data ?? '')}`)); else waiting.resolve(message.result);
  }
  private received(chunk: Buffer) {
    if (!this.framed) {
      // hello's answer is a line; what follows it is already framed.
      this.line += chunk.toString('latin1'); const at = this.line.indexOf('\n'); if (at < 0) return;
      const message = JSON.parse(this.line.slice(0, at)); this.framed = true; this.buffer = Buffer.from(this.line.slice(at + 1), 'latin1'); this.line = ''; this.answer(message);
    } else this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 9) {
      const channel = this.buffer.readUInt32LE(0); const kind = this.buffer.readUInt8(4); const length = this.buffer.readUInt32LE(5);
      if (this.buffer.length < 9 + length) break;
      const payload = this.buffer.subarray(9, 9 + length); this.buffer = this.buffer.subarray(9 + length);
      if (channel === 0 && kind === FRAME.data) { try { this.answer(JSON.parse(payload.toString('utf8'))); } catch { /* Not a message. */ } continue; }
      const stream = this.streams.get(channel);
      if (!stream) { const early = this.early.get(channel) ?? { data: [] }; this.early.set(channel, early); if (kind === FRAME.data) early.data.push(Buffer.from(payload)); else if (kind === FRAME.close) early.closed = payload.toString('utf8'); continue; }
      if (kind === FRAME.data) stream.data(Buffer.from(payload));
      else if (kind === FRAME.close) { this.streams.delete(channel); stream.closed(payload.toString('utf8')); }
    }
  }
}

/**
 * An hc terminal as the part of node-pty's IPty that Trace uses (pty-manager.ts, stop-process.ts), like RunnerPty.
 * Paused, it holds back hc's flow-control credit, so hc stops sending until resumed.
 */
export class HerdrPty {
  cols: number; rows: number; private data: Listener<string>[] = []; private exits: Listener<{ exitCode: number; signal?: number }>[] = []; private ended = false;
  private paused = false; private owed = 0; private decoder = new TextDecoder('utf-8');
  /** Output before anyone listens (PtyManager attaches its listener after take returns): given to the first listener. */
  private early = '';
  /** `first`: the first paint (screen and history) goes there until it has been quiet for a moment, not to listeners. */
  constructor(private connection: HcConnection, private channel: number, readonly address: string, readonly pid: number, cols: number, rows: number, private first?: (text: string) => void) {
    this.cols = cols; this.rows = rows;
    connection.stream(channel, (bytes) => {
      const text = this.decoder.decode(bytes, { stream: true });
      if (this.paused) this.owed += bytes.length; else this.credit(bytes.length);
      if (this.first) { this.first(text); return; }
      if (this.ended || !text) return;
      if (!this.data.length) { this.early += text; return; }
      for (const listener of this.data) listener(text);
    }, () => void this.finished());
    // hc sends a stream only as far as its viewer has credited (paints included): a window to start with, then each
    // read is credited back (pause holds that back), as PtyManager's own flow control expects of a terminal.
    this.credit(WINDOW);
  }
  /** The first paint is over: what comes now is the program's output. */
  painted() { this.first = undefined; }
  onData(listener: Listener<string>) {
    this.data.push(listener);
    if (this.early) { const early = this.early; this.early = ''; queueMicrotask(() => { if (!this.ended) listener(early); }); }
    return { dispose: () => { this.data = this.data.filter((item) => item !== listener); } };
  }
  onExit(listener: Listener<{ exitCode: number; signal?: number }>) { this.exits.push(listener); return { dispose: () => { this.exits = this.exits.filter((item) => item !== listener); } }; }
  write(data: string) { if (!this.ended) this.connection.frame(this.channel, FRAME.data, Buffer.from(data, 'utf8')); }
  resize(cols: number, rows: number) { if (this.ended) throw new Error('The terminal has ended.'); this.cols = cols; this.rows = rows; const size = Buffer.alloc(4); size.writeUInt16LE(cols, 0); size.writeUInt16LE(rows, 2); this.connection.frame(this.channel, FRAME.resize, size); }
  pause() { this.paused = true; }
  resume() { this.paused = false; if (this.owed) { const owed = this.owed; this.owed = 0; this.credit(owed); } }
  /** Ends the program (hc: hangup, then terminate, then kill). Trace's stopProcess ends its process tree by id first. */
  kill() { if (!this.ended) void this.connection.call('terminal.kill', { terminal: this.address }).catch(() => {}); }
  private credit(bytes: number) { const amount = Buffer.alloc(4); amount.writeUInt32LE(bytes, 0); this.connection.frame(this.channel, FRAME.credit, amount); }
  /** The stream closed: the program exited (its code from hc), or hc went away (the channel shows stopped). */
  private async finished() {
    if (this.ended) return;
    const facts = await this.connection.call<Facts>('terminal.get', { terminal: this.address }).catch(() => null);
    this.ended = true; const exitCode = facts?.exit_code ?? 1; const signal = facts?.signal ?? undefined;
    for (const listener of this.exits) listener({ exitCode, ...(signal ? { signal } : {}) });
  }
}

/** Lines of history a channel taken up again is shown, beside its screen (Trace's own runner keeps its last 1 MB). */
const KEPT_HISTORY = 2000;
/** hc labels and document names allow 1-32 of a-z 0-9 - _ (hc run --help): a run's id without its dashes, shortened. */
const docName = (runId: string) => `t${runId.replace(/-/g, '').toLowerCase().slice(0, 31)}`;

/** Trace's channels' terminals in herdr-core: HeldTerminals, as BackgroundRunner is for Trace's own runner. */
export class HerdrTerminals implements HeldTerminals {
  private connection: HcConnection | null = null; private left = new Map<string, Facts>(); private listed: Promise<void> | null = null;
  meta?: (meta: HeldMeta) => Record<string, unknown>;
  onProblem?: (message: string) => void;
  constructor(private hc: string) {}

  async spawn(file: string, args: string[], options: IPtyForkOptions, meta: HeldMeta): Promise<IPty> {
    const connection = await this.connect(); const cols = options.cols ?? 80; const rows = options.rows ?? 24;
    // Its size too: with no viewer hc sets a terminal to its headless size (200 by 120), and a screen painted at that
    // size would be scrolled out of a tile taken up again.
    const value = { ...meta, ...this.meta?.(meta), herdrSize: { cols, rows } };
    const name = docName(meta.session.runId); const kept = await connection.call<{ version: number }>('doc.get', { name });
    await connection.call('doc.set', { name, value, version: kept.version ?? 0 });
    // Trace passes the whole environment the CLI needs; hc lays it over the core's own.
    const run = await connection.call<{ address: string }>('terminal.run', { argv: [file, ...args], cwd: options.cwd ?? process.cwd(), env: (options.env ?? {}) as Record<string, string>, size: { cols, rows }, labels: { trace: '1', session: meta.session.sessionId, run: meta.session.runId }, no_parent: true, no_notify: true });
    return await this.attach(connection, run.address, cols, rows) as unknown as IPty;
  }

  async take(sessionId: string): Promise<{ pty: IPty; meta: HeldMeta; tail: string } | null> {
    await this.leftOver();
    const facts = this.left.get(sessionId); if (!facts || !this.connection) return null;
    this.left.delete(sessionId);
    const runId = facts.labels?.run; if (!runId) return null;
    const document = await this.connection.call<{ value: HeldMeta | null }>('doc.get', { name: docName(runId) }).catch(() => null); if (!document?.value) return null;
    // The screen as it is, with its history, comes first and in pieces: kept as the channel's output until 250 ms pass
    // without more (2 s at most), as Trace's own runner hands back what it kept.
    let tail = ''; let last = Date.now();
    const size = (document.value as HeldMeta & { herdrSize?: { cols: number; rows: number } }).herdrSize ?? { cols: 80, rows: 24 };
    const pty = await this.attach(this.connection, facts.address, size.cols, size.rows, (text) => { tail += text; last = Date.now(); }, KEPT_HISTORY);
    for (const end = Date.now() + 2000; Date.now() < end && Date.now() - last < 250 || !tail && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 50));
    pty.painted();
    return { pty: pty as unknown as IPty, meta: document.value, tail };
  }

  /** The channels whose terminals kept running while Trace was closed. */
  async kept(): Promise<string[]> { await this.leftOver(); return [...this.left.keys()]; }
  /** Lets go of hc, which keeps every terminal running. */
  close() { this.connection?.close(); this.connection = null; }

  private async attach(connection: HcConnection, address: string, cols: number, rows: number, first?: (text: string) => void, history = 0) {
    const facts = await connection.call<Facts>('terminal.get', { terminal: address });
    const attached = await connection.call<{ channel: number }>('terminal.attach', { terminal: address, cols, rows, history });
    return new HerdrPty(connection, attached.channel, address, facts.pid ?? 0, cols, rows, first);
  }
  private leftOver(): Promise<void> {
    this.listed ??= (async () => {
      let connection: HcConnection; try { connection = await this.connect(); } catch { return; }
      const listed = await connection.call<{ terminals: Facts[] }>('terminal.list', { labels: { trace: '1' } }).catch(() => ({ terminals: [] }));
      for (const terminal of listed.terminals) { const sessionId = terminal.labels?.session; if (terminal.state === 'live' && sessionId) this.left.set(sessionId, terminal); }
    })();
    return this.listed;
  }
  private async connect(): Promise<HcConnection> {
    if (this.connection && !this.connection.lost) return this.connection;
    const connection = new HcConnection(this.hc);
    connection.onLost = () => { if (this.connection === connection) { this.connection = null; this.onProblem?.('herdr-core (hc) went away, so Trace lost hold of the channels it runs there. They may still be running: hc ls lists them.'); } };
    await connection.ready; this.connection = connection; return connection;
  }
}
