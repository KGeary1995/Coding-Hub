import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { CLIEngineConfig } from '../../../shared/types';
import { timed } from '../storage/host-health';
import type { AgentRunningSession, EngineInfo } from '../../../shared/ipc';
import { localDay, newTokens, type UsageRecord, type PriceRate } from '../../../shared/hub';

type Json = Record<string, any>;
interface Snapshot { key: string; model: string; input: number; output: number; cached: number; cacheWrite: number; reasoning: number | null; context: UsageRecord['context'];
  /** The local day the event was logged on. Codex reports a running total, so a Codex run counts on its latest day. */
  day?: string }
const reported = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
export function parseUsage(engine: 'claude' | 'codex', raw: Json, fallbackModel: string): Snapshot | null {
  const snapshot = parseSnapshot(engine, raw, fallbackModel); const at = new Date(typeof raw.timestamp === 'string' ? raw.timestamp : NaN);
  if (snapshot && !Number.isNaN(at.getTime())) snapshot.day = localDay(at);
  return snapshot;
}
function parseSnapshot(engine: 'claude' | 'codex', raw: Json, fallbackModel: string): Snapshot | null {
  if (engine === 'claude') {
    if (raw.type !== 'assistant' || !raw.message?.id || !raw.message?.usage) return null;
    const u = raw.message.usage;
    if (!reported(u.input_tokens) || !reported(u.output_tokens)) return null;
    // The reply's whole prompt (new, cached and newly cached input) plus its output is what the next turn carries.
    // The transcript does not record the window size, so the limit stays 0 (unknown) here; runUsage adds the size the
    // running Claude reported (setContextWindow), and without one no percentage is derived.
    const used = number(u.input_tokens) + number(u.cache_read_input_tokens) + number(u.cache_creation_input_tokens) + number(u.output_tokens);
    return { key: String(raw.message.id).slice(0, 200), model: String(raw.message.model ?? fallbackModel), input: number(u.input_tokens), output: number(u.output_tokens), cached: number(u.cache_read_input_tokens), cacheWrite: number(u.cache_creation_input_tokens), reasoning: typeof u.reasoning_tokens === 'number' ? number(u.reasoning_tokens) : null, context: used > 0 ? { used, limit: 0 } : null };
  }
  const event = raw.type === 'event_msg' ? raw.payload : raw;
  if (event?.type !== 'token_count' || !event.info?.total_token_usage) return null;
  const u = event.info.total_token_usage; if (!reported(u.input_tokens) || !reported(u.output_tokens)) return null; const last = event.info.last_token_usage; const limit = number(event.info.model_context_window);
  return { key: 'cumulative', model: fallbackModel, input: number(u.input_tokens), output: number(u.output_tokens), cached: number(u.cached_input_tokens), cacheWrite: number(u.cache_write_input_tokens), reasoning: typeof u.reasoning_output_tokens === 'number' ? number(u.reasoning_output_tokens) : null, context: limit > 0 && last ? { used: number(last.input_tokens) + number(last.output_tokens), limit } : null };
}
/**
 * Subagent transcripts are looked for this many folders deep under `subagents/` (a workflow's agents are two down), among
 * at most this many entries, and at most this many are read, the newest: a live run walks them every few seconds.
 */
const SUBAGENT_DEPTH = 3; const SUBAGENT_ENTRIES = 50000; const SUBAGENTS = 2000;
/** A subagent transcript; `name` is its path under `subagents/` with `/`, since two workflow runs' agents can share a file name. */
export interface SubagentLog { name: string; file: string }
type WalkStep = { readdir: string } | { stat: string };
/** Where Claude Code writes subagent transcripts, written once for the synchronous and the asynchronous reader. */
function* walkSubagents(folder: string, deepest = SUBAGENT_DEPTH): Generator<WalkStep, SubagentLog[], any> {
  const found: SubagentLog[] = []; const folders: [string, string, number][] = [[folder, '', 0]]; let entries = 0;
  for (let next = folders.shift(); next && entries < SUBAGENT_ENTRIES; next = folders.shift()) {
    const [dir, prefix, depth] = next; let items: fs.Dirent[]; try { items = yield { readdir: dir }; } catch { continue; }
    for (const item of items.slice(0, SUBAGENT_ENTRIES - entries)) {
      entries++;
      if (item.isDirectory()) { if (depth < deepest) folders.push([path.join(dir, item.name), `${prefix}${item.name}/`, depth + 1]); }
      else if (item.isFile() && /^agent-[\w-]+\.jsonl$/.test(item.name)) found.push({ name: prefix + item.name, file: path.join(dir, item.name) });
    }
  }
  if (found.length <= SUBAGENTS) return found;
  const dated: [SubagentLog, number][] = []; for (const log of found) try { dated.push([log, ((yield { stat: log.file }) as fs.Stats).mtimeMs]); } catch { /* Removed meanwhile. */ }
  return dated.sort((a, b) => b[1] - a[1]).slice(0, SUBAGENTS).map(([log]) => log);
}
/**
 * A Claude conversation's subagent transcripts: `agent-*.jsonl` anywhere under `<conversation>/subagents/`. The Task tool
 * writes them there directly; a workflow writes its agents to `workflows/<run id>/`, beside files such as journal.jsonl
 * that are not transcripts. `deepest`: how many folders down to look (0: the Task tool's only).
 */
export function subagentLogs(folder: string, deepest = SUBAGENT_DEPTH): SubagentLog[] {
  const walk = walkSubagents(folder, deepest); let step = walk.next();
  while (!step.done) { const at = step.value; let value: unknown; try { value = 'readdir' in at ? fs.readdirSync(at.readdir, { withFileTypes: true }) : fs.statSync(at.stat); } catch (error) { step = walk.throw(error); continue; } step = walk.next(value); }
  return step.value;
}
/** `subagentLogs` without blocking: for DayUsage, which reads every conversation of the last 60 days. */
export async function subagentLogsAsync(folder: string): Promise<SubagentLog[]> {
  const walk = walkSubagents(folder); let step = walk.next();
  while (!step.done) { const at = step.value; let value: unknown; try { value = 'readdir' in at ? await fs.promises.readdir(at.readdir, { withFileTypes: true }) : await fs.promises.stat(at.stat); } catch (error) { step = walk.throw(error); continue; } step = walk.next(value); }
  return step.value;
}
/** Sizes of a Claude conversation's subagent transcripts, by their path under `subagents/`. */
function subagentSizes(file: string) {
  const sizes = new Map<string, number>();
  for (const log of subagentLogs(path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents'))) try { sizes.set(log.name, fs.statSync(log.file).size); } catch { /* Removed meanwhile. */ }
  return sizes;
}
/**
 * A model name in one form for comparison: without case, a release date (`claude-x-20261101` is `claude-x`) or
 * punctuation, so a rate named as people write it ("Claude Opus 5.5") matches the CLI's ID (`claude-opus-5-5`). A
 * context-size variant such as `[1m]` stays in the name (`claude-opus-5-5-1m`), since it can be priced differently.
 */
const baseModel = (model: string) => model.trim().toLowerCase().replace(/-\d{8}(?=$|\[)/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/**
 * The rate for a model: an exact match first, else the rate whose name is the same model written another way (case,
 * spaces or dots for dashes, a release date), so a rate entered as "Claude Opus 5.5" also prices `claude-opus-5-5` and
 * its dated IDs. Context-size variants such as `[1m]` are not merged, since they can be priced differently.
 */
export function rateFor(model: string, rates: PriceRate[]): PriceRate | undefined {
  const base = baseModel(model);
  return rates.find((r) => r.model === model) ?? (base ? rates.find((r) => baseModel(r.model) === base) : undefined);
}
export function usageCost(usage: UsageRecord, rates: PriceRate[]): number | null {
  const rate = rateFor(usage.model, rates); if (!rate) return null;
  const input = usage.engine === 'codex' ? Math.max(0, usage.input - usage.cached) : usage.input;
  return (input * rate.input + usage.output * rate.output + usage.cached * rate.cacheRead + usage.cacheWrite * rate.cacheWrite) / 1000000;
}
/**
 * Another computer's run priced with this computer's rates, so every estimate follows the rates configured here. Its
 * tokens are priced at its last model's rate (a synced run keeps only totals); a model with no rate leaves it unpriced.
 */
export function repriced(usage: UsageRecord, rates: PriceRate[]): UsageRecord {
  const cost = usageCost(usage, rates); return { ...usage, cost, costBasis: cost === null ? 'unpriced' : 'configured-model-rates' };
}
/** The tokens a session limit counts: new tokens, as shown everywhere in Trace (cache re-reads are not counted). */
export function totalTokens(usage: UsageRecord) { return newTokens(usage); }
/** Where a subagent transcript was read to; `grown`: when it last gained something (only recent ones are read between walks). */
interface SubagentState { offset: number; partial: Buffer; file?: string; grown?: number }
interface Watcher { requiresThread: boolean; baseline: Snapshot | null; claudeHome: string; run: AgentRunningSession; config: CLIEngineConfig; start: number; file: string | null; offset: number; partial: Buffer; model: string;
  /** Claude subagent transcripts read so far, by their path under `subagents/`; `walked`: when every one was last checked. */
  subagents?: Map<string, SubagentState>; walked?: number; timer?: ReturnType<typeof setInterval>; polling: boolean; stopped: boolean; thread: string | null; logDir: string;
  /** Reads of the CLI's usage log that failed in a row, and whether the person was told. */
  errors?: number; reported?: boolean;
  /** A conversation the run switched to whose transcript has not been found yet; the window is told once it is. */
  following?: string;
  /** While the CLI's log is not found: since when it has been looked for, and when to look next. */
  searching?: number; nextFind?: number }
/** Totals of a run's recorded usage, kept between reads: `list()` runs every 30 s and grows with a year of history. */
interface RunTotals { meta: Json; groups: Map<string, { model: string; day: string; input: number; output: number; cached: number; cacheWrite: number }>; model: string | null; reasoning: number | null; context: UsageRecord['context']; events: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class TelemetryService {
  private database: DatabaseSync;
  private watches = new Map<string, Watcher>();
  private baselines = new Map<string, { file: string; offset: number; usage: Snapshot | null; subagents?: Map<string, number> }>();
  isConversationActive(engine: 'claude' | 'codex', id: string) { return [...this.watches.values()].some((watch) => !watch.stopped && watch.run.engine === engine && (watch.config.resumeId === id || Boolean(watch.file && path.basename(watch.file).includes(id)) || (engine === 'claude' ? !watch.config.resumeId && watch.run.runId === id : watch.thread === id))); }
  setResumeSource(runId: string, file: string, engine: 'claude' | 'codex', model: string) {
    const size = fs.statSync(file).size; let usage: Snapshot | null = null; let actualModel = model || 'CLI default';
    // The resumed run counts what the rollout's running total gains after its last report. After a long tool output that
    // report can be further back than 256 KB, and without it the whole conversation would count again, so look further.
    if (engine === 'codex') { const fd = fs.openSync(file, 'r'); try { for (const tail of [262144, 2097152, 8388608]) { const bytes = Buffer.alloc(Math.min(size, tail)); fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length); for (const line of bytes.toString().split('\n')) if (line.includes('token_count') || line.includes('turn_context')) try { const event = JSON.parse(line); if (event.type === 'turn_context' && typeof event.payload?.model === 'string') actualModel = event.payload.model; usage = parseUsage(engine, event, actualModel) ?? usage; } catch {} if (usage || bytes.length === size) break; } } finally { fs.closeSync(fd); } }
    // A resumed Claude conversation's subagent transcripts were counted by the runs that wrote them; only what they gain now is this run's.
    this.baselines.set(runId, { file, offset: size, usage, subagents: engine === 'claude' ? subagentSizes(file) : new Map() });
  }
  /**
   * A Claude run moved to another conversation inside its terminal (`/clear`, `/resume`), so Claude Code writes there
   * from now on. The old transcript is read to its end first. A transcript that already exists counts only what it gains
   * from here (its earlier replies belong to the runs that wrote them); a new one counts from its start.
   */
  follow(runId: string, conversationId: string) {
    const w = this.watches.get(runId); if (!w || w.stopped || w.run.engine !== 'claude') return;
    if ((w.file ? path.basename(w.file, '.jsonl') : w.config.resumeId ?? w.run.runId) === conversationId) return;
    this.poll(w);
    w.config = { ...w.config, resumeId: conversationId }; w.file = null; w.offset = 0; w.partial = Buffer.alloc(0); w.subagents = undefined; w.walked = undefined; w.searching = undefined; w.nextFind = undefined; w.following = conversationId;
    try { const file = this.find(w); if (file) { const subagents = subagentSizes(file); w.file = file; w.offset = fs.statSync(file).size; if (subagents.size) w.subagents = new Map([...subagents].map(([name, offset]) => [name, { offset, partial: Buffer.alloc(0) }])); } } catch { /* Found by the next read. */ }
    this.poll(w);
  }
  private assigned = new Set<string>(); private closed = false; private closing = false;
  /** Each run's totals as last read from the database; a run's entry goes when its rows or metadata change. */
  private totals = new Map<string, RunTotals | null>();
  private select!: StatementSync; private upsert!: StatementSync; private writing = false;
  /** Context window sizes Claude reported for running runs (a chat's reply, a terminal's status line), by run. */
  private windows = new Map<string, number>();
  /** A run's context window as Claude reported it; its usage is published again so the bar fills at once. */
  setContextWindow(runId: string, size: number) {
    if (!Number.isInteger(size) || size < 1000 || size > 100_000_000 || this.windows.get(runId) === size || this.closed) return;
    this.windows.set(runId, size);
    const usage = this.runUsage(runId); if (usage) this.publish(usage);
  }
  /** Told once per run when its usage log keeps failing to read (main shows it); token limits depend on that log. */
  onError: (run: AgentRunningSession, message: string) => void = () => {};
  /** Each new line of a run's own transcript (not a subagent's), for live coaching; never the lines before a resume. */
  onLine: (run: AgentRunningSession, config: CLIEngineConfig, raw: Json) => void = () => {};
  /** A run's terminal switched conversation (see `follow`) and its transcript was found: resume and history go there now. */
  onConversation: (run: AgentRunningSession, conversationId: string) => void = () => {};
  constructor(readonly root: string, private rates: () => PriceRate[], private publish: (usage: UsageRecord) => void, private stopAtLimit: (run: AgentRunningSession) => void, private claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), private codexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex')) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 }); this.database = new DatabaseSync(path.join(root, 'usage.db'));
    // With WAL, NORMAL keeps the database whole after a crash and skips a disk flush per commit on the main process; a power cut can lose the last few reads, which the next start reads again from the logs.
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS usage(run TEXT NOT NULL, event TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(run,event)); CREATE TABLE IF NOT EXISTS metadata(run TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS usage_event ON usage(event);');
    const cutoff = new Date(Date.now() - 366 * 86400000).toISOString(); this.database.prepare('DELETE FROM metadata WHERE json_extract(value,\'$.timestamp\') < ?').run(cutoff); this.database.exec('DELETE FROM usage WHERE run NOT IN(SELECT run FROM metadata);');
    this.select = this.database.prepare('SELECT snapshot FROM usage WHERE run=? AND event=?'); this.upsert = this.database.prepare('INSERT INTO usage(run,event,snapshot) VALUES(?,?,?) ON CONFLICT(run,event) DO UPDATE SET snapshot=excluded.snapshot');
    // Codex log folders a run could not remove when it ended (a locked Windows TUI log) go now: no run has started yet.
    let left: fs.Dirent[] = []; try { left = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && UUID.test(entry.name)); } catch { /* Nothing to remove. */ }
    for (const entry of left) void fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => { /* Still locked: tried again next start. */ });
  }
  prepare(run: AgentRunningSession, config: CLIEngineConfig, info: EngineInfo, launch: { args: string[]; env: Record<string, string> }) {
    if (config.engine === 'claude' && !config.resumeId && info.supportsSessionId) launch.args.push('--session-id', run.runId);
    if (config.engine === 'codex' && info.supportsConfig) { const logDir = path.join(this.root, run.runId); fs.mkdirSync(logDir, { recursive: true, mode: 0o700 }); launch.args.push('--config', `log_dir=${JSON.stringify(logDir.replace(/\\/g, '/'))}`); }
  }
  start(run: AgentRunningSession, config: CLIEngineConfig, claudeHome = this.claudeHome) {
    const baseline = this.baselines.get(run.runId); this.baselines.delete(run.runId);
    const watch: Watcher = { requiresThread: false, baseline: baseline?.usage ?? null, claudeHome, run, config, start: Date.now(), file: baseline?.file ?? null, offset: baseline?.offset ?? 0, partial: Buffer.alloc(0), model: config.model || baseline?.usage?.model || 'CLI default', polling: false, stopped: false, thread: null, logDir: path.join(this.root, run.runId), ...(baseline?.subagents?.size ? { subagents: new Map([...baseline.subagents].map(([name, offset]) => [name, { offset, partial: Buffer.alloc(0) }])) } : {}) };
    this.database.prepare('INSERT OR REPLACE INTO metadata(run,value) VALUES(?,?)').run(run.runId, JSON.stringify({ runId: run.runId, sessionId: run.sessionId, engine: run.engine, model: watch.model, cwd: run.cwd, timestamp: new Date(watch.start).toISOString() })); this.totals.delete(run.runId);
    if (run.engine === 'codex') for (const other of this.watches.values()) { if (other.run.engine === 'codex' && other.run.cwd === run.cwd && !other.stopped) { other.requiresThread = true; watch.requiresThread = true; } }
    this.watches.set(run.runId, watch); watch.timer = setInterval(() => timed('telemetry-poll', () => this.poll(watch)), 750); this.poll(watch);
  }
  private find(w: Watcher): string | null {
    if (w.run.engine === 'claude') {
      const root = path.join(w.claudeHome, 'projects');
      // Claude names project folders after the cwd with non-alphanumerics replaced; try that before scanning.
      const direct = path.join(root, w.run.cwd.replace(/[^a-zA-Z0-9]/g, '-'), (w.config.resumeId ?? w.run.runId) + '.jsonl');
      try { if (fs.existsSync(direct) && fs.lstatSync(direct).isFile()) return direct; } catch { /* Fall back to scanning. */ }
      try { for (const d of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, 5000)) { const file = path.join(root, d.name, (w.config.resumeId ?? w.run.runId) + '.jsonl'); if (fs.existsSync(file) && fs.lstatSync(file).isFile()) return file; } } catch { /* CLI has not written structured output yet. */ }
      return null;
    }
    try {
      for (const entry of fs.readdirSync(w.logDir).slice(0, 10)) { const log = path.join(w.logDir, entry); if (!fs.lstatSync(log).isFile()) continue; const size = fs.statSync(log).size; const fd = fs.openSync(log, 'r'); const data = Buffer.alloc(Math.min(size, 128000)); try { fs.readSync(fd, data, 0, data.length, Math.max(0, size - data.length)); } finally { fs.closeSync(fd); } const match = data.toString().match(/(?:thread_id|session_id)[=:]?\s*["']?([0-9a-f]{8}-[0-9a-f-]{27})/i); if (match) w.thread = match[1]; }
    } catch { /* Per-run TUI log is optional. */ }
    const matches: string[] = [];
    // Codex names rollout folders by local date; keep UTC folders for older releases and tests.
    const folders = new Set<string>();
    for (let day = 0; day < 3; day++) {
      const date = new Date(w.start - day * 86400000);
      folders.add(path.join(this.codexHome, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')));
      folders.add(path.join(this.codexHome, 'sessions', String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')));
    }
    for (const dir of folders) {
      try { for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).slice(-500)) {
        const file = path.join(dir, name); if (this.assigned.has(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).mtimeMs < w.start - 2000) continue;
        if (w.thread) { if (name.includes(w.thread)) return file; continue; }
        // Read session metadata only; never expose conversation contents to the renderer.
        const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(64000); let count: number; try { count = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
        try { const meta = JSON.parse(buffer.subarray(0, count).toString().split('\n')[0]); if (meta.type === 'session_meta' && meta.payload?.cwd === w.run.cwd && Date.parse(meta.timestamp ?? meta.payload.timestamp) >= w.start - 2000) matches.push(file); } catch { /* Partial metadata. */ }
      } } catch { /* Date folder not created. */ }
    }
    // Same-cwd sessions need an explicit thread association. Do not guess.
    // The exiting watcher still participates in ambiguity checks during its final
    // poll. A short run may not have created its rollout at the initial poll.
    if (w.requiresThread || [...this.watches.values()].filter((other) => other.run.engine === 'codex' && other.run.cwd === w.run.cwd && (other === w || !other.stopped)).length > 1) return null;
    return matches.length === 1 ? matches[0] : null;
  }
  private poll(w: Watcher) {
    if (w.polling) return; w.polling = true;
    try {
      if (!w.file) {
        // After a minute without it, the log is looked for every 5 s, not every read: for Codex each look reads the run's
        // log and up to six date folders of rollouts, and two Codex channels in one folder may never tell theirs apart.
        const now = Date.now(); if (!w.stopped && now < (w.nextFind ?? 0)) return;
        w.file = this.find(w); if (w.file) this.assigned.add(w.file); else { w.searching ??= now; w.nextFind = now - w.searching < 60000 ? 0 : now + 5000; }
      }
      if (!w.file) return;
      if (w.following) { const id = w.following; w.following = undefined; try { this.onConversation(w.run, id); } catch { /* Telling the window never stops usage. */ } }
      const conversationId = path.basename(w.file).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (conversationId) { const record = this.database.prepare('SELECT value FROM metadata WHERE run=?').get(w.run.runId); if (record) { const metadata = JSON.parse(String(record.value)); if (metadata.conversationId !== conversationId) { this.database.prepare('UPDATE metadata SET value=? WHERE run=?').run(JSON.stringify({ ...metadata, conversationId }), w.run.runId); this.totals.delete(w.run.runId); } } }

      let changed = this.ingest(w, w.file, w, false);
      // Claude Code writes subagents' (the Task tool's, a workflow's) turns to their own transcripts under the
      // conversation's `subagents/` folder (see subagentLogs). They are this run's usage too, and count toward its token limit.
      if (w.run.engine === 'claude' && conversationId) {
        // Every folder is walked, and every transcript checked, when the conversation moved, at the end, and at most 5 s
        // apart. In between, only the top folder is listed for new agents (the Task tool's), and those that grew in the
        // last minute are read where they were found: a session's many finished agents and workflow runs cost little per
        // read, and a workflow's new agent is found within 5 s.
        const now = Date.now(); const all = changed || w.stopped || now - (w.walked ?? 0) >= 5000; if (all) w.walked = now; const subagents = w.subagents ??= new Map(); const folder = path.join(path.dirname(w.file), conversationId, 'subagents');
        const logs = all ? subagentLogs(folder) : [...subagentLogs(folder, 0).filter((log) => !subagents.get(log.name)?.file), ...[...subagents].flatMap(([name, state]) => state.file && now - (state.grown ?? 0) < 60000 ? [{ name, file: state.file }] : [])];
        for (const log of logs) {
          let state = subagents.get(log.name); if (!state) { state = { offset: 0, partial: Buffer.alloc(0) }; subagents.set(log.name, state); } state.file = log.file;
          const before = state.offset; changed = this.ingest(w, log.file, state, true) || changed; if (state.offset !== before) state.grown = now;
        }
      }
      if (changed) { const usage = this.runUsage(w.run.runId); if (usage) { this.publish(usage); if (w.config.engine === 'claude' && w.config.tokenLimits.maxSessionTokens && totalTokens(usage) >= w.config.tokenLimits.maxSessionTokens && !w.stopped) { w.stopped = true; this.stopAtLimit(w.run); } } }
      w.errors = 0;
    } catch (error) {
      // Telemetry failures cannot stop interactive terminal output, but they must not go unnoticed: usage would be
      // wrong, and a session token limit would silently stop working.
      w.errors = (w.errors ?? 0) + 1;
      if (w.errors >= 3 && !w.reported && !this.closed) {
        w.reported = true; const limited = w.config.engine === 'claude' && w.config.tokenLimits.maxSessionTokens !== null;
        this.onError(w.run, `This run's usage could not be read (${String((error as Error).message ?? error).split('\n')[0].slice(0, 120)}), so its usage may be incomplete${limited ? ' and its session token limit is not being enforced' : ''}.`);
      }
    }
    finally { w.polling = false; }
  }
  /**
   * Reads what a transcript gained since `state.offset` and records its usage. A subagent's replies count toward the
   * run's tokens and cost, but its context is its own, not the channel's, so it never sets the run's context.
   */
  private ingest(w: Watcher, file: string, state: { offset: number; partial: Buffer }, subagent: boolean): boolean {
    const size = fs.statSync(file).size; if (size < state.offset) { state.offset = 0; state.partial = Buffer.alloc(0); }
    const count = Math.min(512000, size - state.offset); if (count <= 0) return false;
    const buffer = Buffer.alloc(count); const fd = fs.openSync(file, 'r'); let read: number; try { read = fs.readSync(fd, buffer, 0, count, state.offset); } finally { fs.closeSync(fd); }
    const data = Buffer.concat([state.partial, buffer.subarray(0, read)]); let start = 0; let changed = false;
    // One transaction per read: committed one row at a time, a catch-up read took 1-2 ms a reply line. What was read
    // counts as read only once it is committed, so a failed commit is read again.
    const own = !this.writing; if (own) { this.database.exec('BEGIN'); this.writing = true; }
    try {
      for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
        if (end - start <= 2 * 1024 * 1024) try {
          const raw = JSON.parse(data.subarray(start, end).toString()); if (!subagent && !this.closing) try { this.onLine(w.run, w.config, raw); } catch { /* Coaching never affects usage. */ } if (!subagent && raw.type === 'turn_context' && typeof raw.payload?.model === 'string') w.model = raw.payload.model;
          const parsed = parseUsage(w.run.engine, raw, w.model); if (parsed && subagent) parsed.context = null;
          if (parsed) { if (w.baseline && w.run.engine === 'codex') { for (const key of ['input', 'output', 'cached', 'cacheWrite'] as const) parsed[key] = Math.max(0, parsed[key] - w.baseline[key]); if (parsed.reasoning !== null) parsed.reasoning = Math.max(0, parsed.reasoning - (w.baseline.reasoning ?? 0)); } const old = this.select.get(w.run.runId, parsed.key); if (old) { const prev = JSON.parse(String(old.snapshot)) as Snapshot; for (const key of ['input', 'output', 'cached', 'cacheWrite'] as const) parsed[key] = Math.max(parsed[key], prev[key]); if (prev.reasoning !== null) parsed.reasoning = Math.max(parsed.reasoning ?? 0, prev.reasoning); }
            this.upsert.run(w.run.runId, parsed.key, JSON.stringify(parsed)); changed = true;
          }
        } catch { /* Non-usage events and malformed partial records are ignored. */ }
        start = end + 1;
      }
      if (own) this.database.exec('COMMIT');
    } catch (error) { if (own) try { this.database.exec('ROLLBACK'); } catch { /* Not open. */ } throw error; }
    finally { if (own) this.writing = false; }
    state.offset += read;
    // A copy: a view would keep the whole piece read in memory until the transcript grows again.
    state.partial = data.length - start <= 2 * 1024 * 1024 ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    if (changed) this.totals.delete(w.run.runId);
    return changed;
  }
  /** Unreadable preferences leave usage unpriced; they must not stop usage recording or token limits. */
  private safeRates(): PriceRate[] { try { return this.rates(); } catch { return []; } }
  /** A run's recorded usage summed by model and day, read from the database once and again only after it changes. */
  private tally(runId: string): RunTotals | null {
    const kept = this.totals.get(runId); if (kept !== undefined) return kept;
    const meta = this.database.prepare('SELECT value FROM metadata WHERE run=?').get(runId); if (!meta) return null;
    // A Claude reply (by message id) counts once, for the run that recorded it first: before 1.15, a resumed run read its
    // conversation's old subagent transcripts again. Codex keeps one running total per run, so it is never shared.
    const rows = this.database.prepare("SELECT snapshot FROM usage u WHERE run=? AND (event='cumulative' OR NOT EXISTS (SELECT 1 FROM usage o WHERE o.event=u.event AND o.run<>u.run AND o.rowid<u.rowid)) ORDER BY rowid").all(runId);
    const totals: RunTotals | null = rows.length ? { meta: JSON.parse(String(meta.value)), groups: new Map(), model: null, reasoning: null, context: null, events: rows.length } : null;
    if (totals) { const started = localDay(new Date(totals.meta.timestamp));
      for (const row of rows) { const snapshot = JSON.parse(String(row.snapshot)) as Snapshot;
        // Claude writes zero-usage `<synthetic>` entries for API errors; they cost nothing and are not the run's model.
        if (!snapshot.input && !snapshot.output && !snapshot.cached && !snapshot.cacheWrite && !snapshot.reasoning) continue;
        // Cost and new tokens are sums over a run's replies (Codex has one running total), so summing by model and day first gives the same.
        const day = snapshot.day ?? started; const key = `${snapshot.model}\n${day}`; const group = totals.groups.get(key) ?? { model: snapshot.model, day, input: 0, output: 0, cached: 0, cacheWrite: 0 }; totals.groups.set(key, group);
        for (const name of ['input', 'output', 'cached', 'cacheWrite'] as const) group[name] += snapshot[name]; totals.model = snapshot.model; if (snapshot.reasoning !== null) totals.reasoning = (totals.reasoning ?? 0) + snapshot.reasoning; if (snapshot.context) totals.context = snapshot.context; }
    }
    this.totals.set(runId, totals); return totals;
  }
  runUsage(runId: string, rates = this.safeRates()): UsageRecord | null {
    const totals = this.tally(runId); if (!totals) return null;
    const usage: UsageRecord = { ...totals.meta, input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: totals.reasoning, context: totals.context && { ...totals.context }, cost: null } as UsageRecord; if (totals.model !== null) usage.model = totals.model;
    let cost = 0; let priced = true; const days: NonNullable<UsageRecord['days']> = {};
    for (const group of totals.groups.values()) {
      const event = { ...usage, ...group }; const eventCost = usageCost(event, rates); if (eventCost === null) priced = false; else cost += eventCost;
      const day = days[group.day] ??= { tokens: 0, cost: 0 }; day.tokens += newTokens(event); day.cost = eventCost === null || day.cost === null ? null : day.cost + eventCost; for (const key of ['input', 'output', 'cached', 'cacheWrite'] as const) usage[key] += group[key]; }
    // Claude's transcript has the tokens in context but not the window; a running Claude reports that elsewhere.
    const window = this.windows.get(runId); if (usage.context && usage.context.limit === 0 && window) usage.context = { ...usage.context, limit: window };
    usage.cost = priced ? cost : null; usage.source = usage.engine === 'claude' ? 'claude-session-jsonl' : 'codex-rollout-jsonl'; usage.confidence = 'reported'; usage.costBasis = priced ? 'configured-model-rates' : 'unpriced'; usage.eventCount = totals.events; usage.days = days; return usage;
  }
  list(): UsageRecord[] { const rates = this.safeRates(); return this.database.prepare('SELECT run FROM metadata ORDER BY rowid DESC LIMIT 2000').all().map((r) => this.runUsage(String(r.run), rates)).filter((r): r is UsageRecord => r !== null); }
  /**
   * Usage recorded before Trace kept each reply's day counts on the day its run started. For Claude runs, each reply's
   * day is read once from Claude Code's transcripts (in `homes`, by the reply's message id), so older days are right
   * too; replies it cannot find, and Codex runs (one running total), stay as they were. Returns how many were dated.
   */
  backfillDays(homes: string[]): number {
    const marker = path.join(this.root, 'days-backfilled'); if (fs.existsSync(marker)) return 0;
    const missing = this.database.prepare("SELECT u.run, u.event, u.snapshot, json_extract(m.value,'$.conversationId') conversation FROM usage u JOIN metadata m ON m.run=u.run WHERE json_extract(m.value,'$.engine')='claude' AND json_extract(u.snapshot,'$.day') IS NULL").all() as { run: string; event: string; snapshot: string; conversation: string | null }[];
    const days = new Map<string, string>(); const read = new Set<string>();
    const scan = (file: string) => {
      if (read.has(file)) return; read.add(file);
      let text: string; try { if (fs.statSync(file).size > 256 * 1024 * 1024) return; text = fs.readFileSync(file, 'utf8'); } catch { return; }
      for (const line of text.split('\n')) { if (!line.includes('"usage"')) continue; try { const raw = JSON.parse(line); const at = new Date(raw.timestamp); if (raw.type === 'assistant' && raw.message?.id && !Number.isNaN(at.getTime())) days.set(String(raw.message.id).slice(0, 200), localDay(at)); } catch { /* Partial line. */ } }
    };
    for (const id of new Set(missing.map((row) => row.conversation ?? row.run))) for (const home of homes) {
      let projects: string[] = []; try { projects = fs.readdirSync(path.join(home, 'projects')); } catch { continue; }
      for (const project of projects) {
        const file = path.join(home, 'projects', project, id + '.jsonl'); if (!fs.existsSync(file)) continue; scan(file);
        for (const log of subagentLogs(path.join(home, 'projects', project, id, 'subagents'))) scan(log.file);
      }
    }
    let dated = 0; const update = this.database.prepare('UPDATE usage SET snapshot=? WHERE run=? AND event=?');
    // One commit for all of them, not one per reply.
    this.database.exec('BEGIN');
    try { for (const row of missing) { const day = days.get(row.event); if (!day) continue; update.run(JSON.stringify({ ...JSON.parse(row.snapshot), day }), row.run, row.event); dated++; } this.database.exec('COMMIT'); }
    catch (error) { try { this.database.exec('ROLLBACK'); } catch { /* Not open. */ } throw error; }
    if (dated) this.totals.clear();
    try { fs.writeFileSync(marker, new Date().toISOString(), { mode: 0o600 }); } catch { /* Tried again next start. */ }
    return dated;
  }
  /** A run that was prepared but never started: its resume baseline and Codex log folder go. */
  abandon(runId: string) { this.baselines.delete(runId); if (!this.watches.has(runId)) try { fs.rmSync(path.join(this.root, runId), { recursive: true, force: true }); } catch { /* Removed at the next start (constructor). */ } }
  /** The CLI's own session file for a run, once it has been located. */
  transcript(runId: string): string | null { return this.watches.get(runId)?.file ?? null; }
  /**
   * A run ended: read the rest of its usage log, up to the size it has now, in steps that leave the app responsive.
   * A log that cannot be read to that point marks the run incomplete, so Usage does not present partial totals as final.
   */
  end(runId: string): Promise<string | null> {
    const w = this.watches.get(runId); if (!w) return Promise.resolve(null);
    clearInterval(w.timer); w.stopped = true;
    // The log's size is taken once it has been found (the first read may be what finds it).
    let target = -1;
    return new Promise<string | null>((resolve) => {
      const step = () => {
        if (this.closed) return resolve(w.file);
        const before = w.offset; this.poll(w); if (target < 0) target = Math.max(this.size(w), w.offset);
        if (w.file && w.offset < target && w.offset !== before) { setImmediate(step); return; }
        this.finish(w, target); resolve(w.file);
      };
      step();
    });
  }
  /** On quit every log is read to its end before the database closes. */
  close() {
    this.closing = true;
    for (const w of [...this.watches.values()]) { clearInterval(w.timer); w.stopped = true; this.poll(w); const target = Math.max(this.size(w), w.offset); for (let before = -1; w.file && w.offset < target && w.offset !== before;) { before = w.offset; this.poll(w); } this.finish(w, target); }
    this.closed = true; this.database.close();
  }
  private size(w: Watcher) { try { return w.file ? fs.statSync(w.file).size : 0; } catch { return 0; } }
  private finish(w: Watcher, target: number) {
    if (w.file && w.offset < target) try {
      const record = this.database.prepare('SELECT value FROM metadata WHERE run=?').get(w.run.runId);
      if (record) { this.database.prepare('UPDATE metadata SET value=? WHERE run=?').run(JSON.stringify({ ...JSON.parse(String(record.value)), incomplete: true }), w.run.runId); this.totals.delete(w.run.runId); }
      // The window shows the warning now, not only after its next reload of usage.
      const usage = this.closing ? null : this.runUsage(w.run.runId); if (usage) this.publish(usage);
    } catch { /* Storage is closing. */ }
    this.watches.delete(w.run.runId);
    try { fs.rmSync(w.logDir, { recursive: true, force: true }); } catch { /* A locked Windows TUI log is removed at the next start (constructor). */ }
  }
}
