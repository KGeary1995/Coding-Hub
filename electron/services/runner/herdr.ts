import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IPty, IPtyForkOptions } from 'node-pty';
import type { HeldMeta, HeldTerminals } from '../cli/pty-manager';
import { AGENT_SESSION, withoutAgentSession } from '../cli/discovery';

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
/** How long a line Trace ends keeps hc connect to deliver what was written last (a size, close) before it is ended. */
const CLOSE_GRACE_MS = 1500;
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
    // A core this starts starts with Trace's own environment, without an agent session's variables (withoutAgentSession).
    this.child = spawn(hc, ['connect'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: withoutAgentSession(process.env as Record<string, string>) });
    this.child.stdout.on('data', (chunk: Buffer) => this.received(chunk));
    this.child.stderr.on('data', () => { /* hc's own diagnostics; its core.log keeps them. */ });
    const gone = this.gone = () => { if (this.lost) return; this.lost = true; for (const waiting of this.pending.values()) waiting.reject(new Error('hc connect ended.')); this.pending.clear(); for (const stream of this.streams.values()) stream.closed('lost'); this.streams.clear(); this.onLost?.(); };
    // A write after hc connect ended (EPIPE, write after end) is an error on stdin: the line is lost, not a crash.
    this.child.on('exit', gone); this.child.on('error', gone); this.child.stdin.on('error', gone); this.child.stdout.on('error', gone);
    this.ready = this.call('hello', { framed: true, generation: GENERATION }).then(() => undefined);
  }
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.lost) return Promise.reject(new Error('hc connect ended.'));
    const id = this.next++; const message = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    const answer = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
    // Plain mode until hello's answer: one message a line; framed after.
    if (method === 'hello' || !this.framed) this.write(Buffer.concat([message, Buffer.from('\n')])); else this.frame(0, FRAME.data, message);
    return answer;
  }
  frame(channel: number, kind: number, payload: Buffer) { if (this.lost) return; const head = Buffer.alloc(9); head.writeUInt32LE(channel, 0); head.writeUInt8(kind, 4); head.writeUInt32LE(payload.length, 5); this.write(Buffer.concat([head, payload])); }
  /** To hc connect while its stdin takes writes; once lost or closed, nothing more is written. */
  private write(bytes: Buffer) { if (!this.lost && this.child.stdin.writable) this.child.stdin.write(bytes); }
  /** A stream's first frames can come in the same read as attach's answer, before its HerdrPty exists: kept for it. */
  private early = new Map<number, { data: Buffer[]; closed?: string }>();
  stream(channel: number, data: (bytes: Buffer) => void, closed: (reason: string) => void) {
    this.streams.set(channel, { data, closed }); const early = this.early.get(channel); this.early.delete(channel);
    for (const bytes of early?.data ?? []) data(bytes);
    if (early?.closed !== undefined) { this.streams.delete(channel); closed(early.closed); }
  }
  /**
   * Ends the line on purpose (Trace letting go of hc): its terminals keep running in hc, and are not attached again
   * (their streams are dropped before the line is marked lost), and nothing is written after it.
   */
  close() { this.streams.clear(); this.early.clear(); this.gone?.(); this.child.stdin.end(); setTimeout(() => this.child.kill(), CLOSE_GRACE_MS).unref?.(); }
  private gone?: () => void;
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

/** What HerdrPty needs of HerdrTerminals: the connection now (a new one after a lost line), and where sizes are kept. */
interface PtyOwner { connect(): Promise<HcConnection>; sized(address: string, cols: number, rows: number): void; problem(message: string): void; readonly disposed: boolean }
type Exit = { exitCode: number; signal?: number };

/**
 * An hc terminal as the part of node-pty's IPty that Trace uses (pty-manager.ts, stop-process.ts), like RunnerPty.
 * Paused, it holds back hc's flow-control credit, so hc stops sending until resumed. A stream that closes while its
 * program still runs (the line to hc lost, or hc restarted) is attached again; only a program hc says ended is an exit.
 */
export class HerdrPty {
  cols: number; rows: number; private data: Listener<string>[] = []; private exits: Listener<Exit>[] = []; private ended: Exit | null = null;
  private paused = false; private owed = 0; private decoder = new TextDecoder('utf-8');
  private connection: HcConnection | null = null; private channel = 0;
  /** Output and an exit before anyone listens (PtyManager listens after spawn or take returns): given to the first listener. */
  private early = '';
  /** `first`: the first paint (screen and history) goes there until it has been quiet for a moment, not to listeners. */
  constructor(private owner: PtyOwner, readonly address: string, readonly pid: number, cols: number, rows: number, private first?: (text: string) => void) { this.cols = cols; this.rows = rows; }
  /** On an attach stream. */
  bind(connection: HcConnection, channel: number) {
    this.connection = connection; this.channel = channel; this.decoder = new TextDecoder('utf-8');
    connection.stream(channel, (bytes) => {
      const text = this.decoder.decode(bytes, { stream: true });
      if (this.paused) this.owed += bytes.length; else this.credit(bytes.length);
      if (this.first) { this.first(text); return; }
      if (this.ended || !text) return;
      if (!this.data.length) { this.early += text; return; }
      for (const listener of this.data) listener(text);
    }, () => void this.closed());
    // hc sends a stream only as far as its viewer has credited (paints included): a window to start with, then each
    // read is credited back (pause holds that back), as PtyManager's own flow control expects of a terminal.
    this.owed = 0; this.credit(WINDOW);
  }
  /** The first paint is over: what comes now is the program's output. */
  painted() { this.first = undefined; }
  onData(listener: Listener<string>) {
    this.data.push(listener);
    if (this.early) { const early = this.early; this.early = ''; queueMicrotask(() => listener(early)); }
    return { dispose: () => { this.data = this.data.filter((item) => item !== listener); } };
  }
  onExit(listener: Listener<Exit>) {
    this.exits.push(listener);
    // Ended before anyone listened (while a channel was taken up, or before it was attached): told now.
    if (this.ended) { const ended = this.ended; queueMicrotask(() => listener(ended)); }
    return { dispose: () => { this.exits = this.exits.filter((item) => item !== listener); } };
  }
  write(data: string) { if (!this.ended && this.connection) this.connection.frame(this.channel, FRAME.data, Buffer.from(data, 'utf8')); }
  resize(cols: number, rows: number) {
    if (this.ended) throw new Error('The terminal has ended.'); this.cols = cols; this.rows = rows;
    const size = Buffer.alloc(4); size.writeUInt16LE(cols, 0); size.writeUInt16LE(rows, 2); this.connection?.frame(this.channel, FRAME.resize, size);
    this.owner.sized(this.address, cols, rows);
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; if (this.owed) { const owed = this.owed; this.owed = 0; this.credit(owed); } }
  /** Ends the program (hc: hangup, then terminate, then kill). Trace's stopProcess ends its process tree by id first. */
  kill() { if (!this.ended) void this.owner.connect().then((connection) => connection.call('terminal.kill', { terminal: this.address })).catch(() => {}); }
  /** What it showed, for one that ended before it was attached: given to the first listener, as output before one is. */
  wrote(text: string) { this.early += text; }
  /** It ended: told to the listeners now, or to the first one later. */
  end(exit: Exit) { if (this.ended) return; this.ended = exit; for (const listener of this.exits) listener(exit); }
  private credit(bytes: number) { const amount = Buffer.alloc(4); amount.writeUInt32LE(bytes, 0); this.connection?.frame(this.channel, FRAME.credit, amount); }
  /**
   * The stream closed: an exit when hc says the program ended (with its code), else attached again (a lost line, a
   * restarted hc), a few times over about ten seconds. Only when hc cannot be reached at all is it taken as ended,
   * and the person told the program may still run there.
   */
  private async closed() {
    // Trace let go of hc (closing): nothing is attached again, and the program keeps running there.
    for (let attempt = 0; attempt < 6 && !this.ended; attempt++) {
      if (this.owner.disposed) return;
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      try {
        if (this.owner.disposed) return;
        const connection = await this.owner.connect(); const facts = await connection.call<Facts>('terminal.get', { terminal: this.address });
        if (facts.state !== 'live') { this.end(exitOf(facts)); return; }
        const attached = await connection.call<{ channel: number }>('terminal.attach', { terminal: this.address, cols: this.cols, rows: this.rows });
        if (this.owner.disposed) return;
        this.bind(connection, attached.channel); return;
      } catch { /* hc not back yet: tried again. */ }
    }
    if (!this.ended && !this.owner.disposed) { this.owner.problem(`Trace lost its line to herdr-core for terminal ${this.address}. Its program may still be running there: hc ls lists it.`); this.end({ exitCode: 1 }); }
  }
}
const exitOf = (facts: Facts): Exit => ({ exitCode: facts.exit_code ?? 1, ...(facts.signal ? { signal: facts.signal } : {}) });

/** Lines of history a channel taken up again is shown, beside its screen (Trace's own runner keeps its last 1 MB). */
const KEPT_HISTORY = 2000;
/**
 * hc document names: 1-32 of a-z 0-9 - _ . and not shaped like a terminal's address (t7), which `t` and a run id
 * starting with a digit was. `trace-` and the run id without dashes, shortened.
 */
export const docName = (runId: string) => `trace-${runId.replace(/-/g, '').toLowerCase().slice(0, 26)}`;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Trace's channels' terminals in herdr-core: HeldTerminals, as BackgroundRunner is for Trace's own runner. */
export class HerdrTerminals implements HeldTerminals, PtyOwner {
  private connection: HcConnection | null = null; private connecting: Promise<HcConnection> | null = null;
  private left = new Map<string, Facts>(); private listed: Promise<void> | null = null;
  /** The names in hc's own environment (Unix), which a terminal would inherit unless unset (spawn). */
  private coreNames: Promise<string[]> | null = null;
  /** Sizes not yet kept as labels (sized), by terminal: kept at once when Trace lets go of hc (close). */
  private sizes = new Map<string, { timer: ReturnType<typeof setTimeout>; cols: number; rows: number }>();
  /** Trace let go of hc (close): no new line, and no terminal attached again. */
  disposed = false;
  private warnedWindows = false;
  meta?: (meta: HeldMeta) => Record<string, unknown>;
  onProblem?: (message: string) => void;
  constructor(private hc: string) {}

  async spawn(file: string, args: string[], options: IPtyForkOptions, meta: HeldMeta): Promise<IPty> {
    const connection = await this.connect(); const cols = options.cols ?? 80; const rows = options.rows ?? 24;
    const env = { ...(options.env ?? {}) } as Record<string, string>;
    const name = docName(meta.session.runId); const kept = await connection.call<{ version: number }>('doc.get', { name });
    await connection.call('doc.set', { name, value: { ...meta, ...this.meta?.(meta) }, version: kept.version ?? 0 });
    // hc lays the environment given over its own, so a variable Trace left out (an agent session's, withoutAgentSession)
    // would come back from a core started inside an agent's terminal: on Unix the program starts through env -u for
    // each such name (names only, never values, on its command line). Windows has no such command; hc connect starts
    // a core with Trace's own cleaned environment (HcConnection).
    const unset = (await this.coreEnvironment(connection)).filter((variable) => !(variable in env) && !variable.startsWith('HC_'));
    // Windows has no env -u: an agent session's variables are given empty instead (read as not set by a check for
    // a value), and the person told once that hc started inside an agent should be restarted from a clean terminal.
    const windows = process.platform === 'win32'; const emptied = windows ? unset.filter((variable) => AGENT_SESSION.test(variable)) : [];
    if (emptied.length && !this.warnedWindows) { this.warnedWindows = true; this.problem(`herdr-core was started inside an agent (it has ${emptied.slice(0, 3).join(', ')}): Trace gives them empty to the channels it starts there. Run hc server restart --fresh from a terminal outside any agent to start it clean.`); }
    if (emptied.length) Object.assign(env, Object.fromEntries(emptied.map((variable) => [variable, ''])));
    const argv = unset.length && !windows ? ['/usr/bin/env', ...unset.flatMap((variable) => ['-u', variable]), file, ...args] : [file, ...args];
    // The size is kept as labels (updated on each resize, sized): with no viewer hc sets a terminal to its headless size
    // (200 by 120), and a screen painted at that size would be scrolled out of a tile taken up again.
    const run = await connection.call<{ address: string }>('terminal.run', { argv, cwd: options.cwd ?? process.cwd(), env, size: { cols, rows }, labels: { trace: '1', session: meta.session.sessionId, run: meta.session.runId, cols: String(cols), rows: String(rows) }, no_parent: true, no_notify: true });
    // From here the program runs: never rejected, or PtyManager would start it a second time in a terminal of its own.
    try { return await this.attach(run.address, cols, rows) as unknown as IPty; }
    catch {
      // It ended before it could be attached (a quick command), or hc cannot attach it: its last screen and its exit.
      const pty = new HerdrPty(this, run.address, 0, cols, rows);
      const facts = await connection.call<Facts>('terminal.get', { terminal: run.address }).catch(() => null);
      if (facts && facts.state !== 'live') {
        const screen = await connection.call<{ text: string }>('terminal.read', { terminal: run.address, lines: KEPT_HISTORY }).catch(() => null);
        if (screen?.text) pty.wrote(screen.text.replace(/\r?\n/g, '\r\n'));
        pty.end(exitOf(facts));
      } else { void connection.call('terminal.kill', { terminal: run.address }).catch(() => {}); this.problem(`Trace could not attach terminal ${run.address} in herdr-core, so it was stopped.`); pty.end({ exitCode: 1 }); }
      return pty as unknown as IPty;
    }
  }

  async take(sessionId: string): Promise<{ pty: IPty; meta: HeldMeta; tail: string } | null> {
    await this.leftOver();
    const facts = this.left.get(sessionId); if (!facts) return null;
    this.left.delete(sessionId);
    const runId = facts.labels?.run; if (!runId) return null;
    const connection = await this.connect();
    const document = await connection.call<{ value: HeldMeta | null }>('doc.get', { name: docName(runId) }).catch(() => null); if (!document?.value) return null;
    // The screen as it is, with its history, comes first and in pieces: kept as the channel's output until 250 ms pass
    // without more (2 s at most), as Trace's own runner hands back what it kept.
    let tail = ''; let last = Date.now();
    const cols = Number(facts.labels?.cols) || 80; const rows = Number(facts.labels?.rows) || 24;
    const pty = await this.attach(facts.address, cols, rows, (text) => { tail += text; last = Date.now(); }, KEPT_HISTORY);
    for (const end = Date.now() + 2000; Date.now() < end && Date.now() - last < 250 || !tail && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 50));
    pty.painted();
    return { pty: pty as unknown as IPty, meta: document.value, tail };
  }

  /** The channels whose terminals kept running while Trace was closed. */
  async kept(): Promise<string[]> { await this.leftOver(); return [...this.left.keys()]; }
  /** Lets go of hc, which keeps every terminal running. */
  close() {
    this.disposed = true; const connection = this.connection && !this.connection.lost ? this.connection : null;
    // A size not yet kept is kept now, on the line about to end (it has a moment to deliver it: CLOSE_GRACE_MS).
    for (const [address, pending] of this.sizes) { clearTimeout(pending.timer); if (connection) void connection.call('terminal.label', { terminal: address, labels: { cols: String(pending.cols), rows: String(pending.rows) } }).catch(() => {}); }
    this.sizes.clear(); this.connection?.close(); this.connection = null;
  }
  /** A terminal's new size, kept as its labels half a second after the last change (take attaches at it). */
  sized(address: string, cols: number, rows: number) {
    clearTimeout(this.sizes.get(address)?.timer);
    const timer = setTimeout(() => { this.sizes.delete(address); void this.connect().then((connection) => connection.call('terminal.label', { terminal: address, labels: { cols: String(cols), rows: String(rows) } })).catch(() => {}); }, 500);
    this.sizes.set(address, { timer, cols, rows });
  }
  problem(message: string) { this.onProblem?.(message); }

  private async attach(address: string, cols: number, rows: number, first?: (text: string) => void, history = 0) {
    const connection = await this.connect();
    const facts = await connection.call<Facts>('terminal.get', { terminal: address });
    const pty = new HerdrPty(this, address, facts.pid ?? 0, cols, rows, first);
    const attached = await connection.call<{ channel: number }>('terminal.attach', { terminal: address, cols, rows, history });
    pty.bind(connection, attached.channel); return pty;
  }
  /** The names in hc's own environment: env -0 on Unix, cmd's set on Windows. */
  private coreEnvironment(connection: HcConnection): Promise<string[]> {
    const windows = process.platform === 'win32';
    this.coreNames ??= connection.call<{ code: number | null; stdout: string }>('machine.exec', { argv: windows ? ['cmd.exe', '/d', '/c', 'set'] : ['/usr/bin/env', '-0'], timeout: 10 })
      .then((result) => result.code === 0 ? Buffer.from(result.stdout, 'base64').toString('utf8').split(windows ? /\r?\n/ : '\0').map((entry) => entry.split('=')[0]).filter((variable) => VARIABLE.test(variable)) : [], () => []);
    return this.coreNames;
  }
  private leftOver(): Promise<void> {
    this.listed ??= (async () => {
      let connection: HcConnection; try { connection = await this.connect(); } catch { return; }
      const listed = await connection.call<{ terminals: Facts[] }>('terminal.list', { labels: { trace: '1' } }).catch(() => ({ terminals: [] }));
      for (const terminal of listed.terminals) { const sessionId = terminal.labels?.session; if (terminal.state === 'live' && sessionId) this.left.set(sessionId, terminal); }
    })();
    return this.listed;
  }
  /** The connection to hc: one at a time, made once however many ask together, made again after a lost line; none once closed. */
  connect(): Promise<HcConnection> {
    if (this.disposed) return Promise.reject(new Error('Trace let go of herdr-core.'));
    if (this.connection && !this.connection.lost) return Promise.resolve(this.connection);
    this.connecting ??= (async () => {
      const connection = new HcConnection(this.hc);
      // A new line may reach a restarted hc: its terminals are listed again, and its environment read again.
      connection.onLost = () => { if (this.connection === connection) { this.connection = null; this.listed = null; this.left.clear(); this.coreNames = null; } };
      await connection.ready;
      // Closed while this line was being made (a recovery in flight): ended at once, never kept.
      if (this.disposed) { connection.close(); throw new Error('Trace let go of herdr-core.'); }
      this.connection = connection; return connection;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
}
