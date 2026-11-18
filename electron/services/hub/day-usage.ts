import fs from 'node:fs';
import path from 'node:path';
import { localDay, LOG_DAYS, type DayUsage as DayUsageTotals, type LogDay, type LogUsage, type PriceRate, type UsageRecord } from '../../../shared/hub';
import { subagentLogsAsync, usageCost } from './telemetry';

type Json = Record<string, any>;
type Engine = 'claude' | 'codex';
interface Tokens { input: number; output: number; cached: number; cacheWrite: number }
/** Where a log was read to; for Codex, the session's running total so far and its model. */
interface FileState { engine: Engine; offset: number; partial: Buffer; model: string; total: Tokens }
export interface UsageSource { engine: Engine; root: string }
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const zero = (): Tokens => ({ input: 0, output: 0, cached: 0, cacheWrite: 0 });
/** Each read takes at most this much of a log, so parsing it never holds the main process for long; the next piece follows after the I/O. */
const READ_CHUNK = 1024 * 1024;
const VISITED = 50000;
/** A read that finished this recently answers the window's quick follow-up questions instead of starting another. */
const FRESH = 2000;
/** What was read is saved at most this often while logs grow, and when a catch-up finishes. */
const SAVE_EVERY = 60000;
const SAVED_VERSION = 1;
/** Only lines holding one of these are parsed: most of a transcript is prompts and tool output. */
const WANTED: Record<Engine, Buffer[]> = { claude: [Buffer.from('"usage"')], codex: [Buffer.from('"turn_context"'), Buffer.from('"token_count"')] };
const tokens = (value: unknown): Tokens => { if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => count(n) === n)) throw new Error('Not tokens.'); return { input: value[0], output: value[1], cached: value[2], cacheWrite: value[3] }; };
const list = (used: Tokens) => [used.input, used.output, used.cached, used.cacheWrite];
/** The day of a Codex rollout's date folder (`sessions/YYYY/MM/DD/`), the only folder it is listed from. */
const folderDay = (file: string) => { const match = /(\d{4})[\\/](\d{2})[\\/](\d{2})[\\/][^\\/]+$/.exec(file); return match ? `${match[1]}-${match[2]}-${match[3]}` : null; };

/**
 * This computer's usage by local day from the CLIs' own logs (Claude Code's transcripts and Codex's rollouts), for the
 * last LOG_DAYS days, whether or not Trace ran them or was open at the time. A Claude reply counts once by its message
 * id, on the day it was written; a Codex session counts what its running total gained on each day.
 *
 * Logs are read in the background (`refresh`, asynchronous, a piece at a time) where the last read stopped, and where it
 * stopped is saved with the totals (`file`), so a start reads only what the logs gained since: 60 days of logs can be
 * over a gigabyte. `days` and `totals` answer at once from what has been read, and start a read when the last is old.
 */
export class DayUsage {
  private files = new Map<string, FileState>();
  /** Claude message ids counted so far, with their day, so ids older than the window can go. */
  private seen = new Map<string, string>();
  /** Tokens by day, engine and model. */
  private used = new Map<string, Map<string, Tokens>>();
  private complete = false; private reading: Promise<void> | null = null; private readAt = 0; private loaded = false; private dirty = false; private savedAt = 0; private saving: Promise<void> | null = null;
  constructor(private sources: () => UsageSource[], private rates: () => PriceRate[], private now = () => new Date(), private file: string | null = null) {}
  /** Every day's totals from what has been read; `complete` is false while a read is still going (see `settled`). */
  days(): LogUsage {
    if (!this.reading && Date.now() - this.readAt >= FRESH) void this.refresh();
    const oldest = localDay(this.first(this.now()));
    let rates: PriceRate[] = []; try { rates = this.rates(); } catch { /* Unpriced. */ }
    const days: LogUsage['days'] = {};
    for (const [key, models] of this.used) {
      const [day, engine] = key.split('\n') as [string, Engine]; if (day < oldest) continue;
      const entry = (days[day] ??= {}); const total: LogDay = entry[engine] ??= { input: 0, output: 0, cached: 0, cacheWrite: 0, cost: null };
      for (const [model, used] of models) {
        // `input` is input outside the cache: Codex counts cached input inside its input, Claude reports it separately.
        total.input += engine === 'codex' ? Math.max(0, used.input - used.cached) : used.input; total.output += used.output; total.cached += used.cached; total.cacheWrite += used.cacheWrite;
        const cost = usageCost({ engine, model, ...used } as UsageRecord, rates); if (cost !== null) total.cost = (total.cost ?? 0) + cost;
      }
    }
    return { days, complete: this.complete && !this.reading };
  }
  /** Today's totals, for the status bar. */
  totals(): DayUsageTotals {
    const { days, complete } = this.days(); const day = localDay(this.now()); const today = days[day] ?? {};
    const cost = [today.claude?.cost, today.codex?.cost].reduce<number | null>((sum, value) => value === null || value === undefined ? sum : (sum ?? 0) + value, null);
    return { day, claude: today.claude ? today.claude.input + today.claude.cacheWrite + today.claude.output : 0, codex: today.codex ? today.codex.input + today.codex.output : 0, cost, complete };
  }
  /** Reads what the logs gained since the last read; calls while one runs share it. Never rejects. */
  refresh(): Promise<void> {
    this.reading ??= this.scan().catch(() => { /* Unreadable logs leave the totals as they were; the next read tries again. */ }).finally(() => { this.reading = null; this.readAt = Date.now(); });
    return this.reading;
  }
  /**
   * Waits for a read of what the logs gained, at most `wait` ms, so a caller that asks once (the phone, the budget alerts)
   * gets current numbers and `complete` from `days`/`totals` right after; a start's long catch-up is not waited for.
   */
  async settled(wait = 2000): Promise<void> {
    const reading = this.reading ?? (Date.now() - this.readAt >= FRESH ? this.refresh() : null); if (!reading) return;
    let timer: ReturnType<typeof setTimeout> | undefined; await Promise.race([reading, new Promise<void>((resolve) => { timer = setTimeout(resolve, wait); })]); clearTimeout(timer);
  }
  /** Saves where each log was read to and the totals (written to a temporary file, then renamed), if anything changed. */
  save(): Promise<void> {
    if (!this.file || !this.dirty) return this.saving ?? Promise.resolve();
    const files: Record<string, { engine: Engine; offset: number; model: string; total: number[] }> = {};
    // A line not yet complete is read again from its start next time.
    for (const [file, state] of this.files) files[file] = { engine: state.engine, offset: state.offset - state.partial.length, model: state.model, total: list(state.total) };
    const used: Record<string, Record<string, number[]>> = {}; for (const [key, models] of this.used) used[key] = Object.fromEntries([...models].map(([model, value]) => [model, list(value)]));
    const seen: Record<string, string[]> = {}; for (const [id, day] of this.seen) (seen[day] ??= []).push(id);
    // One name (saves run one at a time, and one Trace runs at a time), so a save cut short is overwritten by the next.
    const text = JSON.stringify({ version: SAVED_VERSION, files, used, seen }); const target = this.file; const temporary = `${target}.tmp`;
    this.dirty = false; this.savedAt = Date.now();
    const write = async () => { await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.promises.writeFile(temporary, text, { mode: 0o600 }); await fs.promises.rename(temporary, target); };
    const next: Promise<void> = (this.saving ?? Promise.resolve()).then(write).catch(async () => { this.dirty = true; /* Saved again after the next read. */ await fs.promises.unlink(temporary).catch(() => {}); }).finally(() => { if (this.saving === next) this.saving = null; });
    this.saving = next; return next;
  }
  private first(now: Date) { return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (LOG_DAYS - 1)); }
  private async scan() {
    if (!this.loaded) { this.loaded = true; await this.load(); }
    const now = this.now(); const first = this.first(now); const oldest = localDay(first); const found = new Set<string>(); let cut = false;
    for (const source of this.sources()) { const candidates = await this.candidates(source, first.getTime(), now); cut ||= candidates.cut; for (const { file, size } of candidates.files) { found.add(file); await this.read(source.engine, file, size, oldest); } }
    // Logs that left the window, and replies and days older than it, are not needed again. A Codex rollout keeps its
    // running total until its date folder leaves the window: one listing without it (moved away and back, a failed stat)
    // must not read it again from its start with a zero total and count it twice. Claude replies count once by id.
    for (const [file, state] of this.files) {
      const day = state.engine === 'codex' ? folderDay(file) : null;
      if (day ? day < oldest : !cut && !found.has(file)) { this.files.delete(file); this.dirty = true; }
    }
    for (const [id, day] of this.seen) if (day < oldest) { this.seen.delete(id); this.dirty = true; }
    for (const key of this.used.keys()) if (key.split('\n')[0] < oldest) { this.used.delete(key); this.dirty = true; }
    const caughtUp = !this.complete; this.complete = true;
    if (this.dirty && (caughtUp || Date.now() - this.savedAt >= SAVE_EVERY)) await this.save();
  }
  /** What an earlier start saved; a missing, unreadable or older-format file means the logs are read again. */
  private async load() {
    if (!this.file) return;
    let saved: Json; try { saved = JSON.parse(await fs.promises.readFile(this.file, 'utf8')); } catch { return; }
    try {
      if (saved?.version !== SAVED_VERSION) return;
      for (const [file, state] of Object.entries(saved.files as Record<string, Json>)) { if (count(state.offset) !== state.offset || typeof state.model !== 'string' || (state.engine !== 'claude' && state.engine !== 'codex')) throw new Error('Not a log.'); this.files.set(file, { engine: state.engine, offset: state.offset, partial: Buffer.alloc(0), model: state.model, total: tokens(state.total) }); }
      for (const [key, models] of Object.entries(saved.used as Record<string, Record<string, unknown>>)) { if (!/^\d{4}-\d{2}-\d{2}\n(claude|codex)$/.test(key)) throw new Error('Not a day.'); this.used.set(key, new Map(Object.entries(models).map(([model, value]) => [model, tokens(value)]))); }
      for (const [day, ids] of Object.entries(saved.seen as Record<string, unknown>)) { if (!Array.isArray(ids)) throw new Error('Not ids.'); for (const id of ids) if (typeof id === 'string') this.seen.set(id, day); }
    } catch { this.files.clear(); this.used.clear(); this.seen.clear(); }
  }
  private add(day: string, engine: Engine, model: string, tokens: Tokens) {
    const key = `${day}\n${engine}`; let models = this.used.get(key); if (!models) { models = new Map(); this.used.set(key, models); }
    const used = models.get(model) ?? zero(); for (const name of ['input', 'output', 'cached', 'cacheWrite'] as const) used[name] += tokens[name]; models.set(model, used);
  }
  /**
   * Logs changed since `since`: Claude's conversations (`projects/<project>/<id>.jsonl`) and, for those, their
   * subagents' (see subagentLogs); Codex's rollouts in the date folders of the same days. `cut`: the listing was cut short.
   */
  private async candidates(source: UsageSource, since: number, now: Date): Promise<{ files: { file: string; size: number }[]; cut: boolean }> {
    const found: { file: string; size: number }[] = []; let visited = 0; let cut = false;
    const changed = async (file: string) => { try { const stat = await fs.promises.stat(file); return stat.isFile() && stat.mtimeMs >= since ? { file, size: stat.size } : null; } catch { return null; } };
    const logs = async (folder: string) => {
      let names: string[]; try { names = await fs.promises.readdir(folder); } catch { return []; }
      const files: { file: string; size: number }[] = [];
      for (const name of names) { if (++visited > VISITED) { cut = true; break; } const log = name.endsWith('.jsonl') ? await changed(path.join(folder, name)) : null; if (log) files.push(log); }
      return files;
    };
    if (source.engine === 'claude') {
      const projects = path.join(source.root, 'projects'); let folders: string[] = []; try { folders = await fs.promises.readdir(projects); } catch { /* No conversations yet. */ }
      for (const project of folders) for (const conversation of await logs(path.join(projects, project))) { found.push(conversation); for (const { file } of await subagentLogsAsync(path.join(conversation.file.slice(0, -'.jsonl'.length), 'subagents'))) { const log = await changed(file); if (log) found.push(log); } }
    } else for (let back = 0; back < LOG_DAYS; back++) { const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back); found.push(...await logs(path.join(source.root, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')))); }
    return { files: found, cut };
  }
  /** Reads what a log gained up to `size` (its size when listed), a piece at a time; a log that did not grow is not opened. */
  private async read(engine: Engine, file: string, size: number, oldest: string) {
    let state = this.files.get(file); if (!state) { state = { engine, offset: 0, partial: Buffer.alloc(0), model: 'CLI default', total: zero() }; this.files.set(file, state); }
    // A log that got shorter was rewritten: read it again from its start. Claude's replies count once by id, and a Codex
    // session keeps its running total, so what was counted before is not counted twice.
    if (size < state.offset) { state.offset = 0; state.partial = Buffer.alloc(0); this.dirty = true; }
    if (state.offset >= size) return;
    let handle: fs.promises.FileHandle; try { handle = await fs.promises.open(file, 'r'); } catch { return; }
    try {
      while (state.offset < size) {
        const buffer = Buffer.alloc(Math.min(READ_CHUNK, size - state.offset)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset); if (!bytesRead) break;
        this.parse(engine, state, buffer.subarray(0, bytesRead), oldest);
      }
    } catch { /* Locked or removed meanwhile: the next read goes on from here. */ }
    finally { await handle.close().catch(() => {}); }
  }
  private parse(engine: Engine, state: FileState, piece: Buffer, oldest: string) {
    const data = state.partial.length ? Buffer.concat([state.partial, piece]) : piece; let start = 0;
    for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
      const line = data.subarray(start, end);
      if (line.length <= 2 * 1024 * 1024 && WANTED[engine].some((wanted) => line.includes(wanted))) try { this.line(engine, state, JSON.parse(line.toString()), oldest); } catch { /* Not JSON. */ }
      start = end + 1;
    }
    // A copy: a view would keep the whole piece read in memory until the log grows again.
    state.offset += piece.length; state.partial = data.length - start <= 2 * 1024 * 1024 ? Buffer.from(data.subarray(start)) : Buffer.alloc(0); this.dirty = true;
  }
  private line(engine: Engine, state: FileState, raw: Json, oldest: string) {
    const at = new Date(typeof raw.timestamp === 'string' ? raw.timestamp : NaN); const day = Number.isNaN(at.getTime()) ? null : localDay(at);
    if (engine === 'claude') {
      const usage = raw.message?.usage; const id = raw.message?.id;
      if (raw.type !== 'assistant' || !usage || typeof id !== 'string' || !day || day < oldest || this.seen.has(id)) return;
      this.seen.set(id, day);
      this.add(day, 'claude', String(raw.message.model ?? 'CLI default'), { input: count(usage.input_tokens), output: count(usage.output_tokens), cached: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens) });
      return;
    }
    if (raw.type === 'turn_context' && typeof raw.payload?.model === 'string') { state.model = raw.payload.model; return; }
    const total = raw.type === 'event_msg' && raw.payload?.type === 'token_count' ? raw.payload.info?.total_token_usage : null; if (!total) return;
    // What the session's running total gained since its last report counts on the day of this report.
    const next = { input: count(total.input_tokens), output: count(total.output_tokens), cached: count(total.cached_input_tokens), cacheWrite: count(total.cache_write_input_tokens) };
    const gained = { input: Math.max(0, next.input - state.total.input), output: Math.max(0, next.output - state.total.output), cached: Math.max(0, next.cached - state.total.cached), cacheWrite: Math.max(0, next.cacheWrite - state.total.cacheWrite) };
    // Never lower: a rewritten log read again from its start must not count its earlier reports again.
    state.total = { input: Math.max(next.input, state.total.input), output: Math.max(next.output, state.total.output), cached: Math.max(next.cached, state.total.cached), cacheWrite: Math.max(next.cacheWrite, state.total.cacheWrite) }; if (day && day >= oldest) this.add(day, 'codex', state.model, gained);
  }
}
