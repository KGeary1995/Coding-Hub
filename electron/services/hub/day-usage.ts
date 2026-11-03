import fs from 'node:fs';
import path from 'node:path';
import { localDay, type DayUsage as DayUsageTotals, type PriceRate, type UsageRecord } from '../../../shared/hub';
import { usageCost } from './telemetry';

type Json = Record<string, any>;
interface Tokens { input: number; output: number; cached: number; cacheWrite: number }
interface FileState { offset: number; partial: Buffer; model: string; before: Tokens | null; last: Tokens | null }
export interface UsageSource { engine: 'claude' | 'codex'; root: string }
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const zero = (): Tokens => ({ input: 0, output: 0, cached: 0, cacheWrite: 0 });
/** Each pass reads at most this much of the CLIs' logs, so a first read of a long day stays responsive; the rest follows. */
const READ_BUDGET = 16 * 1024 * 1024;
const VISITED = 50000;

/**
 * Today's usage on this computer from the CLIs' own logs (Claude Code's transcripts and Codex's rollouts), whether or
 * not Trace ran them or was open at the time. A Claude reply counts once by its message id, on the local day it was
 * written; a Codex session counts what its running total gained today. Logs are read where the last pass stopped.
 */
export class DayUsage {
  private day = ''; private files = new Map<string, FileState>(); private seen = new Set<string>(); private claude = new Map<string, Tokens>();
  constructor(private sources: () => UsageSource[], private rates: () => PriceRate[], private now = () => new Date()) {}
  totals(): DayUsageTotals {
    const now = this.now(); const day = localDay(now);
    if (day !== this.day) { this.day = day; this.files.clear(); this.seen.clear(); this.claude.clear(); }
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); let budget = READ_BUDGET; let complete = true;
    for (const source of this.sources()) for (const file of this.candidates(source, since, now)) { if (budget <= 0) { complete = false; break; } const read = this.read(source.engine, file, budget); budget -= read.bytes; if (!read.done) complete = false; }
    let rates: PriceRate[] = []; try { rates = this.rates(); } catch { /* Unpriced. */ }
    const totals: DayUsageTotals = { day, claude: 0, codex: 0, cost: null, complete };
    const add = (engine: 'claude' | 'codex', model: string, used: Tokens) => {
      totals[engine] += (engine === 'codex' ? Math.max(0, used.input - used.cached) : used.input) + used.output;
      const cost = usageCost({ engine, model, ...used } as UsageRecord, rates); if (cost !== null) totals.cost = (totals.cost ?? 0) + cost;
    };
    for (const [model, used] of this.claude) add('claude', model, used);
    for (const state of this.files.values()) if (state.last) { const before = state.before ?? zero(); add('codex', state.model, { input: Math.max(0, state.last.input - before.input), output: Math.max(0, state.last.output - before.output), cached: Math.max(0, state.last.cached - before.cached), cacheWrite: Math.max(0, state.last.cacheWrite - before.cacheWrite) }); }
    return totals;
  }
  /**
   * Log files changed today: Claude's conversations (`projects/<project>/<id>.jsonl`) and, for those, their subagents'
   * (`<id>/subagents/agent-*.jsonl`); Codex's rollouts in the last week's date folders.
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
    } else for (let back = 0; back < 7; back++) { const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back); found.push(...logs(path.join(source.root, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')))); }
    return found;
  }
  /** Reads what a log gained, up to `budget` bytes: how much was read, and whether that reached its end. */
  private read(engine: 'claude' | 'codex', file: string, budget: number): { bytes: number; done: boolean } {
    let state = this.files.get(file); if (!state) { state = { offset: 0, partial: Buffer.alloc(0), model: 'CLI default', before: null, last: null }; this.files.set(file, state); }
    let size: number; try { size = fs.statSync(file).size; } catch { return { bytes: 0, done: true }; }
    if (size < state.offset) Object.assign(state, { offset: 0, partial: Buffer.alloc(0), before: null, last: null });
    const length = Math.min(budget, size - state.offset); if (length <= 0) return { bytes: 0, done: true };
    const buffer = Buffer.alloc(length); let read = 0;
    try { const fd = fs.openSync(file, 'r'); try { read = fs.readSync(fd, buffer, 0, length, state.offset); } finally { fs.closeSync(fd); } } catch { return { bytes: 0, done: true }; }
    state.offset += read; const data = Buffer.concat([state.partial, buffer.subarray(0, read)]); let start = 0;
    for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
      if (end - start <= 2 * 1024 * 1024) try { this.line(engine, state, JSON.parse(data.subarray(start, end).toString())); } catch { /* Not JSON, or a partial line. */ }
      start = end + 1;
    }
    state.partial = data.length - start <= 2 * 1024 * 1024 ? data.subarray(start) : Buffer.alloc(0);
    return { bytes: read, done: state.offset >= size };
  }
  private line(engine: 'claude' | 'codex', state: FileState, raw: Json) {
    const at = new Date(typeof raw.timestamp === 'string' ? raw.timestamp : NaN); const today = !Number.isNaN(at.getTime()) && localDay(at) === this.day;
    if (engine === 'claude') {
      const usage = raw.message?.usage; const id = raw.message?.id;
      if (raw.type !== 'assistant' || !usage || typeof id !== 'string' || !today || this.seen.has(id)) return;
      this.seen.add(id); const model = String(raw.message.model ?? 'CLI default'); const used = this.claude.get(model) ?? zero();
      used.input += count(usage.input_tokens); used.output += count(usage.output_tokens); used.cached += count(usage.cache_read_input_tokens); used.cacheWrite += count(usage.cache_creation_input_tokens);
      this.claude.set(model, used); return;
    }
    if (raw.type === 'turn_context' && typeof raw.payload?.model === 'string') { state.model = raw.payload.model; return; }
    const total = raw.type === 'event_msg' && raw.payload?.type === 'token_count' ? raw.payload.info?.total_token_usage : null; if (!total) return;
    const tokens = { input: count(total.input_tokens), output: count(total.output_tokens), cached: count(total.cached_input_tokens), cacheWrite: count(total.cache_write_input_tokens) };
    if (today) state.last = tokens; else if (!state.last) state.before = tokens;
  }
}
