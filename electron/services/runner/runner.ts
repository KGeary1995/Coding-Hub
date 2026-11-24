import { timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { encode, FrameReader, json, Kind, RUNNER_PROTOCOL, type Frame, type RunnerTerminal, type SpawnRequest } from './protocol';
import { Tail } from './tail';

/** What the runner needs of a terminal: node-pty's IPty, or a stand-in in tests. */
export interface RunnerPty {
  pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void; resize(cols: number, rows: number): void; kill(): void;
}
export interface RunnerDependencies {
  spawn(request: SpawnRequest): RunnerPty;
  /** Stops a terminal's whole process tree (stop-process.ts); without it, kill(). */
  stop?(pty: RunnerPty, exit: Promise<void>): Promise<unknown>;
  /** Called when the runner has nothing left to do: no terminals running and no Trace connected for `idleMs`, or drained. */
  exit(): void;
  idleMs?: number;
  /** Output queued for Trace beyond this is not sent (it stays in the tail), herdr's 8 MB. */
  sendLimit?: number;
  tailBytes?: number;
}

interface Terminal { term: number; id: string; pty: RunnerPty; tail: Tail; cols: number; rows: number; exitCode?: number; exited: Promise<void>; skipped: boolean }

/**
 * The background runner (docs/background-runner.md): owns every terminal so channels outlive Trace, and nothing else.
 * One Trace is connected at a time; it says hello with the secret only this user can read, and the newest hello takes
 * over. Output is always read, into each terminal's tail, whether or not a Trace is connected or keeping up.
 */
export class Runner {
  private terminals = new Map<number, Terminal>(); private next = 1; private client: Socket | null = null; private draining = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null; private ended = false;
  constructor(private secret: string, private dependencies: RunnerDependencies) { this.idle(); }

  connect(socket: Socket) {
    const reader = new FrameReader(); let greeted = false; let current = true;
    // A connection that does not say hello at once is not Trace.
    const helloTimer = setTimeout(() => { if (!greeted) socket.destroy(); }, 5000); helloTimer.unref?.();
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(helloTimer); if (this.client === socket) { this.client = null; this.idle(); } });
    socket.on('drain', () => this.caughtUp(socket));
    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[]; try { frames = reader.push(chunk); } catch { socket.destroy(); return; }
      for (const frame of frames) {
        if (socket.destroyed) return;
        if (!greeted) {
          const hello = frame.kind === Kind.hello ? safeJson<{ version?: unknown; secret?: unknown }>(frame) : null;
          if (!hello || typeof hello.secret !== 'string' || !sameSecret(hello.secret, this.secret)) { socket.destroy(); return; }
          greeted = true; clearTimeout(helloTimer); current = hello.version === RUNNER_PROTOCOL;
          // A Trace on another protocol may only drain this runner (an update): it runs its own runner beside this one.
          if (current) { const previous = this.client; this.client = socket; previous?.destroy(); this.busy(); }
          this.send(socket, encode(Kind.welcome, 0, { version: RUNNER_PROTOCOL, pid: process.pid, draining: this.draining }));
          continue;
        }
        if (!current) { if (frame.kind === Kind.drain) this.drain(); else this.send(socket, encode(Kind.error, 0, { message: `This runner speaks protocol ${RUNNER_PROTOCOL}.` })); continue; }
        // An older connection a newer Trace took over says nothing more.
        if (this.client !== socket) { socket.destroy(); return; }
        this.handle(socket, frame);
      }
    });
  }

  /** Running and ended-but-not-forgotten terminals, oldest first. */
  list(): RunnerTerminal[] { return [...this.terminals.values()].map(({ term, id, pty, cols, rows, exitCode }) => ({ term, id, pid: pty.pid, cols, rows, ...(exitCode === undefined ? {} : { exitCode }) })); }

  private handle(socket: Socket, frame: Frame) {
    if (frame.kind === Kind.spawn) { this.spawn(socket, frame); return; }
    if (frame.kind === Kind.list) { this.send(socket, encode(Kind.list, 0, this.list())); return; }
    if (frame.kind === Kind.drain) { this.drain(); return; }
    const terminal = this.terminals.get(frame.term);
    if (!terminal) { this.send(socket, encode(Kind.error, frame.term, { message: `No terminal ${frame.term}.` })); return; }
    const running = terminal.exitCode === undefined;
    if (frame.kind === Kind.input) { if (running) terminal.pty.write(frame.payload.toString('utf8')); }
    else if (frame.kind === Kind.resize) {
      const size = safeJson<{ cols?: unknown; rows?: unknown }>(frame); const cols = Number(size?.cols); const rows = Number(size?.rows);
      // node-pty throws on a resize after the process ended (Windows reports the exit late).
      if (running && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) try { terminal.pty.resize(cols, rows); terminal.cols = cols; terminal.rows = rows; } catch { /* It ended. */ }
    } else if (frame.kind === Kind.signal) {
      const signal = safeJson<{ signal?: unknown }>(frame)?.signal;
      if (!running) return;
      if (signal === 'interrupt') terminal.pty.write('\x03');
      else if (signal === 'stop') void (this.dependencies.stop ? this.dependencies.stop(terminal.pty, terminal.exited) : Promise.resolve(terminal.pty.kill())).catch(() => {});
    } else if (frame.kind === Kind.tail) this.send(socket, encode(Kind.tail, terminal.term, terminal.tail.read()));
    else if (frame.kind === Kind.forget) { if (!running) this.terminals.delete(terminal.term); this.idle(); }
  }

  private spawn(socket: Socket, frame: Frame) {
    const request = safeJson<SpawnRequest>(frame);
    if (!request || typeof request.id !== 'string' || typeof request.file !== 'string') { this.send(socket, encode(Kind.error, 0, { message: 'A spawn request needs an id and a program.' })); return; }
    if (this.draining) { this.send(socket, encode(Kind.error, 0, { id: request.id, message: 'This runner is closing after an update; a new one takes new channels.' })); return; }
    let pty: RunnerPty;
    try { pty = this.dependencies.spawn(request); } catch (error) { this.send(socket, encode(Kind.error, 0, { id: request.id, message: error instanceof Error ? error.message : String(error) })); return; }
    let ended!: () => void; const exited = new Promise<void>((resolve) => { ended = resolve; });
    const terminal: Terminal = { term: this.next++, id: request.id, pty, tail: new Tail(this.dependencies.tailBytes), cols: request.cols, rows: request.rows, exited, skipped: false };
    this.terminals.set(terminal.term, terminal); this.busy();
    pty.onData((data) => { const bytes = Buffer.from(data, 'utf8'); terminal.tail.append(bytes); this.forward(terminal, bytes); });
    pty.onExit(({ exitCode, signal }) => {
      if (terminal.exitCode !== undefined) return;
      terminal.exitCode = exitCode; ended();
      if (this.client) this.send(this.client, encode(Kind.exited, terminal.term, { exitCode, ...(signal ? { signal } : {}) }));
      if (this.draining) this.finishDrain(); else this.idle();
    });
    this.send(socket, encode(Kind.spawned, 0, { id: request.id, term: terminal.term, pid: pty.pid }));
  }

  private forward(terminal: Terminal, bytes: Buffer) {
    const client = this.client; if (!client) return;
    // Trace fell behind: the output stays in the tail, and Trace is told to read it once its queue empties.
    if (terminal.skipped || client.writableLength > (this.dependencies.sendLimit ?? 8 * 1024 * 1024)) { terminal.skipped = true; return; }
    this.send(client, encode(Kind.output, terminal.term, bytes));
  }

  /** Every write to a connection: whichever write empties its queue checks for output held back. */
  private send(socket: Socket, frame: Buffer) { socket.write(frame, () => this.caughtUp(socket)); }
  /** Trace's queue emptied: each terminal whose output was held back is named, so Trace reads its tail. 'drain' alone would
   * miss a short queue: Node raises it only after a write that filled the socket's buffer. */
  private caughtUp(socket: Socket) {
    if (this.client !== socket || socket.writableLength > 0) return;
    for (const terminal of this.terminals.values()) if (terminal.skipped) { terminal.skipped = false; this.send(socket, encode(Kind.skipped, terminal.term)); }
  }

  private drain() { this.draining = true; this.finishDrain(); }
  private finishDrain() { if (!this.live()) this.end(); }
  private live() { return [...this.terminals.values()].some((terminal) => terminal.exitCode === undefined); }
  private busy() { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } }
  /** No Trace and nothing running: the runner leaves after a while, so it never lingers on its own. */
  private idle() {
    if (this.client || this.live() || this.idleTimer || this.ended) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.client && !this.live()) this.end(); }, this.dependencies.idleMs ?? 60_000);
    this.idleTimer.unref?.();
  }
  private end() { if (this.ended) return; this.ended = true; this.busy(); this.client?.end(); this.dependencies.exit(); }
}

function safeJson<T>(frame: Frame): T | null { try { const value = json<T>(frame); return value && typeof value === 'object' ? value : null; } catch { return null; } }
function sameSecret(given: string, expected: string) { const a = Buffer.from(given); const b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }
