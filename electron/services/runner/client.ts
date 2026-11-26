import net from 'node:net';
import { encode, FrameReader, json, Kind, RUNNER_PROTOCOL, type Frame, type RunnerTerminal, type SpawnRequest } from './protocol';
import { decodeJournal, type JournalEntry } from './journal';

type Listener<T> = (value: T) => void;

/**
 * A terminal the background runner holds, with the part of node-pty's IPty that Trace uses (pty-manager.ts,
 * stop-process.ts), so PtyManager treats it as any terminal.
 */
export class RunnerPty {
  cols: number; rows: number; private data: Listener<string>[] = []; private errors: Listener<string>[] = []; private exits: Listener<{ exitCode: number; signal?: number }>[] = []; private ended = false;
  constructor(private client: RunnerClient, readonly term: number, readonly pid: number, cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  onData(listener: Listener<string>) { this.data.push(listener); return { dispose: () => { this.data = this.data.filter((item) => item !== listener); } }; }
  onExit(listener: Listener<{ exitCode: number; signal?: number }>) { this.exits.push(listener); return { dispose: () => { this.exits = this.exits.filter((item) => item !== listener); } }; }
  /** A pipe run's stderr (chat-process.ts's ChatProcess has the same). */
  onStderr(listener: Listener<string>) { this.errors.push(listener); }
  write(data: string) { this.client.send(Kind.input, this.term, Buffer.from(data, 'utf8')); }
  resize(cols: number, rows: number) { if (this.ended) throw new Error('The terminal has ended.'); this.cols = cols; this.rows = rows; this.client.send(Kind.resize, this.term, { cols, rows }); }
  pause() { this.client.send(Kind.pause, this.term); }
  resume() { this.client.send(Kind.resume, this.term); }
  /** Closes the terminal. Trace's stopProcess ends the process tree by its id first, as for a terminal of its own. */
  kill() { if (!this.ended) this.client.send(Kind.signal, this.term, { signal: 'stop' }); }
  /** @internal */ emitData(text: string) { if (!this.ended) for (const listener of this.data) listener(text); }
  /** @internal */ emitStderr(text: string) { if (!this.ended) for (const listener of this.errors) listener(text); }
  /** @internal */ emitExit(exitCode: number, signal?: number) { if (this.ended) return; this.ended = true; for (const listener of this.exits) listener({ exitCode, ...(signal ? { signal } : {}) }); }
}

/**
 * Trace's connection to the background runner (docs/background-runner.md). One at a time; requests that expect an
 * answer of a kind (list, a terminal's tail) are answered in the order sent.
 */
export class RunnerClient {
  private socket: net.Socket | null = null; private ptys = new Map<number, RunnerPty>();
  private spawns = new Map<string, { resolve: (pty: RunnerPty) => void; reject: (error: Error) => void; request: SpawnRequest }>();
  private lists: ((terminals: RunnerTerminal[]) => void)[] = []; private tails = new Map<number, ((bytes: Buffer) => void)[]>();
  private journals = new Map<number, ((journal: { overflowed: boolean; entries: JournalEntry[] } | null) => void)[]>();
  private decoders = new Map<number, TextDecoder>();
  /** The runner went away (it was stopped, or it failed): its terminals are reported ended. */
  onLost?: () => void;
  /** The runner held output back because Trace fell behind; `redraw` gets the terminal's whole kept output. */
  onSkipped?: (pty: RunnerPty, redraw: Buffer) => void;
  /** Whether the runner answering takes chats too (pipe runs, 1.47.0); an older one only takes terminals. */
  pipes = false;
  constructor(private address: string, private secret: string) {}

  get connected() { return Boolean(this.socket && !this.socket.destroyed); }

  /** Connects and says hello; resolves with the runner's welcome. Rejects when nothing answers, or on another protocol. */
  connect(timeoutMs = 3000): Promise<{ version: number; pid: number; draining: boolean; home?: string; pipes?: boolean }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.address); const reader = new FrameReader(); let welcomed = false;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('The background runner did not answer.')); }, timeoutMs);
      socket.on('error', (error) => { if (!welcomed) { clearTimeout(timer); reject(error); } });
      socket.on('close', () => { if (this.socket === socket) this.lost(); });
      socket.on('data', (chunk: Buffer) => {
        let frames: Frame[]; try { frames = reader.push(chunk); } catch { socket.destroy(); return; }
        for (const frame of frames) {
          if (!welcomed) {
            if (frame.kind !== Kind.welcome) { socket.destroy(); return; }
            welcomed = true; clearTimeout(timer); const welcome = json<{ version: number; pid: number; draining: boolean; home?: string; pipes?: boolean }>(frame);
            if (welcome.version !== RUNNER_PROTOCOL || welcome.draining) { socket.destroy(); reject(Object.assign(new Error(`The background runner speaks protocol ${welcome.version}.`), { welcome })); return; }
            this.socket = socket; this.pipes = welcome.pipes === true; resolve(welcome); continue;
          }
          this.receive(frame);
        }
      });
      socket.once('connect', () => socket.write(encode(Kind.hello, 0, { version: RUNNER_PROTOCOL, secret: this.secret })));
    });
  }

  /** Asks a runner on another protocol (one an update left behind) to close once its terminals end. */
  static async drainOld(address: string, secret: string) {
    await new Promise<void>((resolve) => {
      const socket = net.connect(address); const done = () => { socket.destroy(); resolve(); };
      socket.on('error', done); setTimeout(done, 3000).unref?.();
      socket.once('connect', () => { socket.write(encode(Kind.hello, 0, { version: RUNNER_PROTOCOL, secret })); socket.write(encode(Kind.drain, 0)); setTimeout(done, 200); });
    });
  }

  spawn(request: SpawnRequest): Promise<RunnerPty> {
    if (!this.connected) return Promise.reject(new Error('The background runner is not connected.'));
    return new Promise((resolve, reject) => { this.spawns.set(request.id, { resolve, reject, request }); this.send(Kind.spawn, 0, request); });
  }
  list(): Promise<RunnerTerminal[]> {
    if (!this.connected) return Promise.resolve([]);
    return new Promise((resolve) => { this.lists.push(resolve); this.send(Kind.list, 0); });
  }
  tail(term: number): Promise<Buffer> {
    if (!this.connected) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve) => { const waiting = this.tails.get(term) ?? []; waiting.push(resolve); this.tails.set(term, waiting); this.send(Kind.tail, term); });
  }
  /** A chat run's journal (every chunk both ways, in order); null when the runner has none for it or went away. */
  journal(term: number): Promise<{ overflowed: boolean; entries: JournalEntry[] } | null> {
    if (!this.connected || !this.pipes) return Promise.resolve(null);
    return new Promise((resolve) => { const waiting = this.journals.get(term) ?? []; waiting.push(resolve); this.journals.set(term, waiting); this.send(Kind.journal, term); });
  }
  /** A terminal the runner kept while Trace was closed, taken up again. */
  adopt(terminal: RunnerTerminal): RunnerPty { const pty = new RunnerPty(this, terminal.term, terminal.pid, terminal.cols, terminal.rows); this.ptys.set(terminal.term, pty); return pty; }
  forget(term: number) { this.send(Kind.forget, term); }
  /** Lets go without stopping anything: the runner keeps every terminal running. */
  close() { const socket = this.socket; this.socket = null; socket?.end(); }

  /** @internal */ send(kind: number, term: number, payload?: Buffer | string | object) { if (this.connected) this.socket!.write(encode(kind as never, term, payload)); }

  private receive(frame: Frame) {
    if (frame.kind === Kind.output) { const pty = this.ptys.get(frame.term); if (pty) pty.emitData(this.decode(frame.term, frame.payload)); return; }
    if (frame.kind === Kind.spawned) {
      const { id, term, pid } = json<{ id: string; term: number; pid: number }>(frame); const waiting = this.spawns.get(id); if (!waiting) return;
      this.spawns.delete(id); const pty = new RunnerPty(this, term, pid, waiting.request.cols, waiting.request.rows); this.ptys.set(term, pty); waiting.resolve(pty); return;
    }
    if (frame.kind === Kind.exited) {
      const pty = this.ptys.get(frame.term); if (!pty) return; const { exitCode, signal } = json<{ exitCode: number; signal?: number }>(frame);
      this.ptys.delete(frame.term); this.decoders.delete(frame.term); pty.emitExit(exitCode, signal); this.forget(frame.term); return;
    }
    if (frame.kind === Kind.list) { this.lists.shift()?.(json<RunnerTerminal[]>(frame)); return; }
    if (frame.kind === Kind.tail) { const waiting = this.tails.get(frame.term); waiting?.shift()?.(frame.payload); if (waiting && !waiting.length) this.tails.delete(frame.term); return; }
    if (frame.kind === Kind.stderr) { const pty = this.ptys.get(frame.term); if (pty) pty.emitStderr(frame.payload.toString('utf8')); return; }
    if (frame.kind === Kind.journal) { const waiting = this.journals.get(frame.term); let journal: { overflowed: boolean; entries: JournalEntry[] } | null = null; try { journal = decodeJournal(frame.payload); } catch { /* Not one: none. */ } waiting?.shift()?.(journal); if (waiting && !waiting.length) this.journals.delete(frame.term); return; }
    if (frame.kind === Kind.skipped) { const pty = this.ptys.get(frame.term); if (pty) void this.tail(frame.term).then((bytes) => this.onSkipped?.(pty, bytes)); return; }
    if (frame.kind === Kind.error) {
      const { id, message } = json<{ id?: string; message: string }>(frame); const waiting = id ? this.spawns.get(id) : undefined;
      if (waiting && id) { this.spawns.delete(id); waiting.reject(new Error(message)); }
      // A journal asked of a terminal that is not a chat.
      else if (frame.term) { const journals = this.journals.get(frame.term); journals?.shift()?.(null); if (journals && !journals.length) this.journals.delete(frame.term); }
    }
  }

  /** Output is raw bytes: a character split between two frames is joined (node-pty decoded it in one piece before). */
  private decode(term: number, bytes: Buffer) { let decoder = this.decoders.get(term); if (!decoder) { decoder = new TextDecoder('utf-8'); this.decoders.set(term, decoder); } return decoder.decode(bytes, { stream: true }); }

  private lost() {
    this.socket = null;
    for (const waiting of this.spawns.values()) waiting.reject(new Error('The background runner went away.')); this.spawns.clear();
    for (const resolve of this.lists.splice(0)) resolve([]); for (const waiting of this.tails.values()) for (const resolve of waiting) resolve(Buffer.alloc(0)); this.tails.clear();
    for (const waiting of this.journals.values()) for (const resolve of waiting) resolve(null); this.journals.clear();
    const ptys = [...this.ptys.values()]; this.ptys.clear(); this.decoders.clear();
    for (const pty of ptys) pty.emitExit(1);
    this.onLost?.();
  }
}
