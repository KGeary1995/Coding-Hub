/**
 * A chat run's journal, kept by the runner (runner step 4, docs/plans/runner-chat-channels.md): every chunk Trace wrote
 * to the program ('in') and the program wrote back ('out'), in order, so a Trace that opens again can replay it into a
 * new chat stream with its writes muted. Chunks are kept as they came, not cut into lines: the stream joins its own
 * lines, so a replay sees exactly what the first stream saw. A replay needs the whole conversation from its start, so
 * one that grows past its capacity is dropped and marked overflowed (Trace then stops the chat and resumes it instead).
 */
export type JournalDirection = 'in' | 'out';
export interface JournalEntry { dir: JournalDirection; data: Buffer }
/** 8 MB a chat: with Trace's eight channels at most, 64 MB in the runner. */
export const JOURNAL_BYTES = 8 * 1024 * 1024;

export class Journal {
  private entries: JournalEntry[] = []; private size = 0; private cut = false;
  constructor(private capacity = JOURNAL_BYTES) {}
  add(dir: JournalDirection, data: Buffer) {
    if (this.cut || !data.length) return;
    if (this.size + data.length > this.capacity) { this.entries = []; this.size = 0; this.cut = true; return; }
    const last = this.entries.at(-1);
    // Output arrives in many small pieces: one direction's run of them is one entry.
    if (last?.dir === dir) last.data = Buffer.concat([last.data, data]); else this.entries.push({ dir, data: Buffer.from(data) });
    this.size += data.length;
  }
  get overflowed() { return this.cut; }
  get length() { return this.size; }
  /** As a `journal` frame carries it: a byte saying whether it overflowed, then each entry as its direction (0 in, 1 out), its length (4 bytes) and its bytes. Binary, so the chat's own JSON is not escaped again. */
  encode(): Buffer {
    const parts: Buffer[] = [Buffer.from([this.cut ? 1 : 0])];
    for (const entry of this.entries) { const head = Buffer.alloc(5); head.writeUInt8(entry.dir === 'in' ? 0 : 1, 0); head.writeUInt32BE(entry.data.length, 1); parts.push(head, entry.data); }
    return Buffer.concat(parts);
  }
}

/** A `journal` frame's payload, read back. Throws on bytes that are not one. */
export function decodeJournal(payload: Buffer): { overflowed: boolean; entries: JournalEntry[] } {
  if (!payload.length) throw new Error('An empty journal frame.');
  const entries: JournalEntry[] = []; let at = 1;
  while (at < payload.length) {
    if (at + 5 > payload.length) throw new Error('A journal entry was cut short.');
    const dir = payload.readUInt8(at); const length = payload.readUInt32BE(at + 1); at += 5;
    if (dir > 1 || at + length > payload.length) throw new Error('A journal entry was cut short.');
    entries.push({ dir: dir === 0 ? 'in' : 'out', data: payload.subarray(at, at + length) }); at += length;
  }
  return { overflowed: payload.readUInt8(0) === 1, entries };
}
