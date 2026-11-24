import fs from 'node:fs';
import { openGeminiDatabase } from '../cli/gemini-conversations';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Gemini CLI's token usage, read from its own conversation files (`<home>/conversations/<id>.db`, SQLite). Every model
 * request is a row of `gen_metadata` whose `data` is a protobuf message; Gemini CLI publishes no schema for it, so the
 * places read here were found by comparing two conversations with what its `--output-format stream-json` reported for
 * the same requests (agy 1.x, 2026-11-22):
 *   field 1 (the request's record) → field 4 (usage) → 2 input tokens outside the cache, 3 output tokens (thinking
 *   included), 5 input tokens read from the cache, 9 thinking tokens; field 1 → field 19 the model's name; field 1 →
 *   field 20, repeated key/value pairs, among them `last_step_index`: the step the request followed.
 * A step's time is `steps.metadata` field 1 → field 1 (seconds). A row that does not look like that is skipped, never
 * guessed at: usage then reads low, not wrong. Terminal channels and Round Table seats both write these files.
 */
export interface GeminiRequest { model: string; input: number; output: number; cached: number; thinking: number; /** Seconds since 1970, or null when its step has no time. */ at: number | null }

export type Visit = (field: number, wire: number, value: number, length: number) => void;
/** Walks one protobuf message's fields: `value` is a varint's value, or where a length-delimited field's bytes start. Throws on bytes that are no message. */
export function fields(buffer: Uint8Array, start: number, end: number, visit: Visit) {
  let at = start;
  const varint = () => { let result = 0; let shift = 0; for (;;) { if (at >= end) throw new Error('Cut short.'); const byte = buffer[at++]; result += (byte & 127) * 2 ** shift; if (!(byte & 128)) return result; shift += 7; if (shift > 63) throw new Error('Not a number.'); } };
  while (at < end) {
    const key = varint(); const field = Math.floor(key / 8); const wire = key % 8; if (field < 1) throw new Error('Not a field.');
    if (wire === 0) visit(field, wire, varint(), 0);
    else if (wire === 2) { const length = varint(); if (at + length > end) throw new Error('Cut short.'); visit(field, wire, at, length); at += length; }
    else if (wire === 1) at += 8; else if (wire === 5) at += 4; else throw new Error('Not a field.');
  }
}
const count = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
export const text = (buffer: Uint8Array, start: number, length: number) => Buffer.from(buffer.buffer, buffer.byteOffset + start, length).toString('utf8');

/** One `gen_metadata.data`: the request's tokens and model, and the step it followed; null when it holds no usage. */
export function parseGeminiRequest(data: Uint8Array): (Omit<GeminiRequest, 'at'> & { step: number | null }) | null {
  try {
    let record: [number, number] | null = null;
    fields(data, 0, data.length, (field, wire, value, length) => { if (field === 1 && wire === 2 && !record) record = [value, length]; });
    if (!record) return null; const [start, length] = record as [number, number];
    const usage = new Map<number, number>(); let found = false; let model = ''; let step: number | null = null;
    fields(data, start, start + length, (field, wire, value, size) => {
      if (field === 4 && wire === 2) { found = true; fields(data, value, value + size, (inner, innerWire, number) => { if (innerWire === 0) usage.set(inner, number); }); }
      else if (field === 19 && wire === 2 && size <= 200) model = text(data, value, size);
      else if (field === 20 && wire === 2 && size <= 200) { let key = ''; let entry = ''; fields(data, value, value + size, (inner, innerWire, at, innerSize) => { if (innerWire !== 2) return; if (inner === 1) key = text(data, at, innerSize); else if (inner === 2) entry = text(data, at, innerSize); }); if (key === 'last_step_index' && /^\d{1,9}$/.test(entry)) step = Number(entry); }
    });
    if (!found) return null;
    const request = { model: /^[\w.:-]{1,120}$/.test(model) ? model : 'Gemini CLI default', input: count(usage.get(2)), output: count(usage.get(3)), cached: count(usage.get(5)), thinking: count(usage.get(9)), step };
    return request.input || request.output || request.cached ? request : null;
  } catch { return null; }
}
/** A step's time from `steps.metadata` (field 1 → field 1, seconds); null when it has none. */
export function parseGeminiStepTime(metadata: Uint8Array | null): number | null {
  if (!metadata) return null;
  try {
    let seconds: number | null = null;
    fields(metadata, 0, metadata.length, (field, wire, value, length) => { if (field === 1 && wire === 2 && seconds === null) fields(metadata, value, value + length, (inner, innerWire, number) => { if (inner === 1 && innerWire === 0 && seconds === null) seconds = number; }); });
    // Between 2020 and 2100: anything else is not a time.
    return seconds !== null && seconds > 1_577_836_800 && seconds < 4_102_444_800 ? seconds : null;
  } catch { return null; }
}

/** The conversation files changed since `since` (ms), newest first, at most `limit`. */
export function geminiUsageFiles(home: string, since: number, limit = 2000): { file: string; mtime: number }[] {
  const folder = path.join(home, 'conversations'); let names: string[] = []; try { names = fs.readdirSync(folder); } catch { return []; }
  const found: { file: string; mtime: number }[] = [];
  for (const name of names) { if (!/^[0-9a-f-]{36}\.db$/.test(name)) continue; try {
      const stat = fs.statSync(path.join(folder, name)); if (!stat.isFile()) continue;
      // A running agy writes to the write-ahead log first (seen 2026-11-22: a live conversation's `-wal` was newer than its
      // file), so the later of the two times says when the conversation last changed.
      let mtime = stat.mtimeMs; try { mtime = Math.max(mtime, fs.statSync(path.join(folder, name + '-wal')).mtimeMs); } catch { /* No log: a conversation at rest. */ }
      if (mtime >= since) found.push({ file: path.join(folder, name), mtime });
    } catch { /* Gone meanwhile. */ } }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
/**
 * The requests of one conversation from row `from` on (rows are numbered from 0 in the order they were made), and how
 * many rows it has. Opened read-only; a file Gemini CLI is replacing, or of another layout, gives null.
 */
export function readGeminiRequests(file: string, from = 0): { rows: number; requests: (GeminiRequest & { row: number })[] } | null {
  let database: DatabaseSync | null = null;
  try {
    // As agy's own list is opened: a resting database read plainly would get -wal/-shm files beside agy's.
    database = openGeminiDatabase(file);
    const total = Number(database.prepare('SELECT COUNT(*) AS rows FROM gen_metadata').get()?.rows ?? 0);
    const stepTime = database.prepare('SELECT metadata FROM steps WHERE idx = ?'); const requests: (GeminiRequest & { row: number })[] = [];
    const rows = database.prepare('SELECT data FROM gen_metadata ORDER BY idx LIMIT -1 OFFSET ?').all(Math.max(0, from));
    rows.forEach((item, index) => {
      const data = item.data; if (!(data instanceof Uint8Array)) return;
      const parsed = parseGeminiRequest(data); if (!parsed) return;
      const { step, ...request } = parsed; let at: number | null = null;
      if (step !== null) { const metadata = stepTime.get(step)?.metadata; at = parseGeminiStepTime(metadata instanceof Uint8Array ? metadata : null); }
      requests.push({ ...request, at, row: from + index });
    });
    return { rows: total, requests };
  } catch { return null; }
  finally { try { database?.close(); } catch { /* Not open. */ } }
}
