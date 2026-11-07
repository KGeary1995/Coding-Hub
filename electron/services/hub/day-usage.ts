import fs from 'node:fs';
import path from 'node:path';
import { localDay, LOG_DAYS, type DayUsage as DayUsageTotals, type LogDay, type LogUsage, type PriceRate, type UsageRecord } from '../../../shared/hub';
import { usageCost } from './telemetry';

type Json = Record<string, any>;
type Engine = 'claude' | 'codex';
interface Tokens { input: number; output: number; cached: number; cacheWrite: number }
/** Where a log was read to; for Codex, the session's running total so far and its model. */
interface FileState { offset: number; partial: Buffer; model: string; total: Tokens }
export interface UsageSource { engine: Engine; root: string }
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const zero = (): Tokens => ({ input: 0, output: 0, cached: 0, cacheWrite: 0 });
/** Each pass reads at most this much of the CLIs' logs, so a first read stays responsive; the rest follows. */
const READ_BUDGET = 16 * 1024 * 1024;
const VISITED = 50000;

/**
 * This computer's usage by local day from the CLIs' own logs (Claude Code's transcripts and Codex's rollouts), for the
 * last LOG_DAYS days, whether or not Trace ran them or was open at the time. A Claude reply counts once by its message
 * id, on the day it was written; a Codex session counts what its running total gained on each day. Logs are read where
 * the last pass stopped.
 */
export class DayUsage {
  private files = new Map<string, FileState>(); private seen = new Set<string>();
  /** Tokens by day, engine and model. */
  private used = new Map<string, Map<string, Tokens>>();
  private complete = false;
  constructor(private sources: () => UsageSource[], private rates: () => PriceRate[], private now = () => new Date()) {}
  /** Reads what the logs gained, then every day's totals. */
  days(): LogUsage {
    const now = this.now(); const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (LOG_DAYS - 1));
    const oldest = localDay(first); let budget = READ_BUDGET; let complete = true;
    for (const source of this.sources()) for (const file of this.candidates(source, first.getTime(), now)) { if (budget <= 0) { complete = false; break; } const read = this.read(source.engine, file, budget, oldest); budget -= read.bytes; if (!read.done) complete = false; }
    this.complete = complete;
    let rates: PriceRate[] = []; try { rates = this.rates(); } catch { /* Unpriced. */ }
    const days: LogUsage['days'] = {};
    for (const [key, models] of this.used) {
      const [day, engine] = key.split('\n') as [string, Engine]; if (day < oldest) { this.used.delete(key); continue; }
      const entry = (days[day] ??= {}); const total: LogDay = entry[engine] ??= { input: 0, output: 0, cached: 0, cacheWrite: 0, cost: null };
      for (const [model, used] of models) {
        // `input` is input outside the cache: Codex counts cached input inside its input, Claude reports it separately.
        total.input += engine === 'codex' ? Math.max(0, used.input - used.cached) : used.input; total.output += used.output; total.cached += used.cached; total.cacheWrite += used.cacheWrite;
        const cost = usageCost({ engine, model, ...used } as UsageRecord, rates); if (cost !== null) total.cost = (total.cost ?? 0) + cost;
      }
    }
    return { days, complete };
  }
  /** Today's totals, for the status bar. */
  totals(): DayUsageTotals {
    const { days, complete } = this.days(); const day = localDay(this.now()); const today = days[day] ?? {};
    const cost = [today.claude?.cost, today.codex?.cost].reduce<number | null>((sum, value) => value === null || value === undefined ? sum : (sum ?? 0) + value, null);
    return { day, claude: today.claude ? today.claude.input + today.claude.cacheWrite + today.claude.output : 0, codex: today.codex ? today.codex.input + today.codex.output : 0, cost, complete };
  }
  private add(day: string, engine: Engine, model: string, tokens: Tokens) {
    const key = `${day}\n${engine}`; let models = this.used.get(key); if (!models) { models = new Map(); this.used.set(key, models); }
    const used = models.get(model) ?? zero(); for (const name of ['input', 'output', 'cached', 'cacheWrite'] as const) used[name] += tokens[name]; models.set(model, used);
  }
  /**
   * Logs changed since `since`: Claude's conversations (`projects/<project>/<id>.jsonl`) and, for those, their
   * subagents' (`<id>/subagents/agent-*.jsonl`); Codex's rollouts in the date folders of the same days.
   */
  private candidates(source: UsageSource, since: number, now: Date): string[] {
    const found: string[] = []; let visited = 0;
    const logs = (folder: string, match = (name: string) => name.endsWith('.jsonl')) => {
      let names: string[]; try { names = fs.readdirSync(folder); } catch { return []; }
      const changed: string[] = [];
      for (const name of names) { if (++visited > VISITED) break; if (!match(name)) continue; const file = path.join(folder, name); try { const stat = fs.statSync(file); if (stat.isFile() && stat.mtimeMs >= since) changed.push(file); } catch { /* Removed meanwhile. */ } }
      return changed;
    };
    if (source.engine === 'claude') {
      const projects = path.join(source.root, 'projects'); let folders: string[] = []; try { folders = fs.readdirSync(projects); } catch { /* No conversations yet. */ }
      for (const project of folders) for (const file of logs(path.join(projects, project))) { found.push(file); found.push(...logs(path.join(file.slice(0, -'.jsonl'.length), 'subagents'), (name) => /^agent-[\w-]+\.jsonl$/.test(name))); }
    } else for (let back = 0; back < LOG_DAYS; back++) { const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back); found.push(...logs(path.join(source.root, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')))); }
    return found;
  }
  /** Reads what a log gained, up to `budget` bytes: how much was read, and whether that reached its end. */
  private read(engine: Engine, file: string, budget: number, oldest: string): { bytes: number; done: boolean } {
    let state = this.files.get(file); if (!state) { state = { offset: 0, partial: Buffer.alloc(0), model: 'CLI default', total: zero() }; this.files.set(file, state); }
    let size: number; try { size = fs.statSync(file).size; } catch { return { bytes: 0, done: true }; }
    if (size < state.offset) Object.assign(state, { offset: 0, partial: Buffer.alloc(0), total: zero() });
    const length = Math.min(budget, size - state.offset); if (length <= 0) return { bytes: 0, done: true };
    const buffer = Buffer.alloc(length); let read = 0;
    try { const fd = fs.openSync(file, 'r'); try { read = fs.readSync(fd, buffer, 0, length, state.offset); } finally { fs.closeSync(fd); } } catch { return { bytes: 0, done: true }; }
    state.offset += read; const data = Buffer.concat([state.partial, buffer.subarray(0, read)]); let start = 0;
    for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
      if (end - start <= 2 * 1024 * 1024) try { this.line(engine, state, JSON.parse(data.subarray(start, end).toString()), oldest); } catch { /* Not JSON, or a partial line. */ }
      start = end + 1;
    }
    state.partial = data.length - start <= 2 * 1024 * 1024 ? data.subarray(start) : Buffer.alloc(0);
    return { bytes: read, done: state.offset >= size };
  }
  private line(engine: Engine, state: FileState, raw: Json, oldest: string) {
    const at = new Date(typeof raw.timestamp === 'string' ? raw.timestamp : NaN); const day = Number.isNaN(at.getTime()) ? null : localDay(at);
    if (engine === 'claude') {
      const usage = raw.message?.usage; const id = raw.message?.id;
      if (raw.type !== 'assistant' || !usage || typeof id !== 'string' || !day || day < oldest || this.seen.has(id)) return;
      this.seen.add(id);
      this.add(day, 'claude', String(raw.message.model ?? 'CLI default'), { input: count(usage.input_tokens), output: count(usage.output_tokens), cached: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens) });
      return;
    }
    if (raw.type === 'turn_context' && typeof raw.payload?.model === 'string') { state.model = raw.payload.model; return; }
    const total = raw.type === 'event_msg' && raw.payload?.type === 'token_count' ? raw.payload.info?.total_token_usage : null; if (!total) return;
    // What the session's running total gained since its last report counts on the day of this report.
    const next = { input: count(total.input_tokens), output: count(total.output_tokens), cached: count(total.cached_input_tokens), cacheWrite: count(total.cache_write_input_tokens) };
    const gained = { input: Math.max(0, next.input - state.total.input), output: Math.max(0, next.output - state.total.output), cached: Math.max(0, next.cached - state.total.cached), cacheWrite: Math.max(0, next.cacheWrite - state.total.cacheWrite) };
    state.total = next; if (day && day >= oldest) this.add(day, 'codex', state.model, gained);
  }
}
