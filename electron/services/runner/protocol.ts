/**
 * The background runner's wire format (docs/background-runner.md, after herdr-core's holder_proto.rs): a 9-byte header
 * (kind, terminal, payload length) and the payload. Control messages carry JSON; terminal input and output carry raw
 * bytes, so a busy terminal costs no JSON encoding. Terminal 0 is the connection itself.
 */
export const RUNNER_PROTOCOL = 1;
export const HEADER_BYTES = 9;
/** Larger than any tail (1 MB) or message: a frame beyond it means the stream is corrupt, and the connection is closed. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const Kind = {
  /** Trace → runner: `{ version, secret }`. The newest connection that says hello takes over; the older is closed. */
  hello: 1,
  /** Runner → Trace: `{ version, pid, draining }`, the answer to hello. */
  welcome: 2,
  /** Trace → runner: `{ id, file, args, cwd, env, cols, rows }`. The runner answers spawned or failed. */
  spawn: 3,
  /** Runner → Trace: `{ id, term, pid }`; the terminal number is used by every later frame for it. */
  spawned: 4,
  input: 5,
  /** Trace → runner: `{ cols, rows }`. */
  resize: 6,
  /** Trace → runner: `{ signal: 'interrupt' | 'stop' }`. */
  signal: 7,
  /** Trace → runner (empty), answered with the terminal's kept output (its tail). */
  tail: 8,
  /** Trace → runner (empty), answered with `RunnerTerminal[]`: running terminals and ended ones not yet forgotten. */
  list: 9,
  output: 10,
  /** Runner → Trace: `{ exitCode, signal? }`. */
  exited: 11,
  /** Trace → runner: take no new terminals, and exit once the last one ends (an update with a new protocol). */
  drain: 12,
  /** Trace → runner: an ended terminal Trace has dealt with; it leaves the list. */
  forget: 13,
  /** Runner → Trace: output was not sent because Trace fell behind; read the tail to draw the screen again. */
  skipped: 14,
  /** Runner → Trace: `{ id?, message }`, a request that failed (a spawn names its id). */
  error: 15,
  /** Trace → runner: stop reading the program for now (Trace's window is behind; xterm.js flow control). The program
   * waits to write; nothing is lost. Every paused terminal is resumed when Trace disconnects. */
  pause: 16,
  resume: 17,
} as const;
export type FrameKind = typeof Kind[keyof typeof Kind];

export interface Frame { kind: number; term: number; payload: Buffer }
/** `meta`: the channel's details from Trace, kept by the runner without reading them and given back in the list, so a
 * Trace that opens again knows which channel each terminal is. */
export interface RunnerTerminal { term: number; id: string; pid: number; cols: number; rows: number; exitCode?: number; meta?: unknown }
export interface SpawnRequest { id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number; meta?: unknown }

export function encode(kind: FrameKind, term: number, payload: Buffer | string | object = Buffer.alloc(0)): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const header = Buffer.alloc(HEADER_BYTES); header.writeUInt8(kind, 0); header.writeUInt32BE(term >>> 0, 1); header.writeUInt32BE(body.length, 5);
  return Buffer.concat([header, body]);
}

export function json<T>(frame: Frame): T { return JSON.parse(frame.payload.toString('utf8')) as T; }

/** Reads frames out of a byte stream that arrives in pieces of any size. */
export class FrameReader {
  private chunks: Buffer[] = []; private size = 0;
  /** The frames now complete. Throws on a frame larger than MAX_FRAME_BYTES; the caller closes the connection. */
  push(chunk: Buffer): Frame[] {
    this.chunks.push(chunk); this.size += chunk.length; const frames: Frame[] = [];
    while (this.size >= HEADER_BYTES) {
      const head = this.peek(HEADER_BYTES); const length = head.readUInt32BE(5);
      if (length > MAX_FRAME_BYTES) throw new Error(`A runner frame of ${length} bytes is larger than allowed.`);
      if (this.size < HEADER_BYTES + length) break;
      const all = this.take(HEADER_BYTES + length);
      frames.push({ kind: all.readUInt8(0), term: all.readUInt32BE(1), payload: all.subarray(HEADER_BYTES) });
    }
    return frames;
  }
  private peek(count: number) { if (this.chunks[0].length < count) this.chunks = [Buffer.concat(this.chunks)]; return this.chunks[0].subarray(0, count); }
  private take(count: number) {
    if (this.chunks[0].length < count) this.chunks = [Buffer.concat(this.chunks)];
    const first = this.chunks[0]; const taken = first.subarray(0, count);
    if (first.length === count) this.chunks.shift(); else this.chunks[0] = first.subarray(count);
    this.size -= count; return taken;
  }
}
