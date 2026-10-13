import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { CLIEngineConfig } from '../../../shared/types';
import type { RunningSession, EngineInfo } from '../../../shared/ipc';
import type { UsageRecord, PriceRate } from '../../../shared/hub';

type Json = Record<string, any>;
interface Snapshot { key: string; model: string; input: number; output: number; cached: number; cacheWrite: number; reasoning: number | null; context: UsageRecord['context'] }
const reported = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
export function parseUsage(engine: 'claude' | 'codex', raw: Json, fallbackModel: string): Snapshot | null {
  if (engine === 'claude') {
    if (raw.type !== 'assistant' || !raw.message?.id || !raw.message?.usage) return null;
    const u = raw.message.usage;
    if (!reported(u.input_tokens) || !reported(u.output_tokens)) return null;
    return { key: String(raw.message.id).slice(0, 200), model: String(raw.message.model ?? fallbackModel), input: number(u.input_tokens), output: number(u.output_tokens), cached: number(u.cache_read_input_tokens), cacheWrite: number(u.cache_creation_input_tokens), reasoning: typeof u.reasoning_tokens === 'number' ? number(u.reasoning_tokens) : null, context: null };
  }
  const event = raw.type === 'event_msg' ? raw.payload : raw;
  if (event?.type !== 'token_count' || !event.info?.total_token_usage) return null;
  const u = event.info.total_token_usage; if (!reported(u.input_tokens) || !reported(u.output_tokens)) return null; const last = event.info.last_token_usage; const limit = number(event.info.model_context_window);
  return { key: 'cumulative', model: fallbackModel, input: number(u.input_tokens), output: number(u.output_tokens), cached: number(u.cached_input_tokens), cacheWrite: number(u.cache_write_input_tokens), reasoning: typeof u.reasoning_output_tokens === 'number' ? number(u.reasoning_output_tokens) : null, context: limit > 0 && last ? { used: number(last.input_tokens) + number(last.output_tokens), limit } : null };
}
export function usageCost(usage: UsageRecord, rates: PriceRate[]): number | null {
  const rate = rates.find((r) => r.model === usage.model); if (!rate) return null;
  const input = usage.engine === 'codex' ? Math.max(0, usage.input - usage.cached) : usage.input;
  return (input * rate.input + usage.output * rate.output + usage.cached * rate.cacheRead + usage.cacheWrite * rate.cacheWrite) / 1000000;
}
export function totalTokens(usage: UsageRecord) { return usage.input + usage.output + (usage.engine === 'claude' ? usage.cached + usage.cacheWrite : 0); }
interface Watcher { requiresThread: boolean; baseline: Snapshot | null; claudeHome: string; run: RunningSession; config: CLIEngineConfig; start: number; file: string | null; offset: number; partial: Buffer; model: string; timer?: ReturnType<typeof setInterval>; polling: boolean; stopped: boolean; thread: string | null; logDir: string }
export class TelemetryService {
  private database: DatabaseSync;
  private watches = new Map<string, Watcher>();
  private baselines = new Map<string, { file: string; offset: number; usage: Snapshot | null }>();
  isConversationActive(engine: 'claude' | 'codex', id: string) { return [...this.watches.values()].some((watch) => !watch.stopped && watch.run.engine === engine && (watch.config.resumeId === id || Boolean(watch.file && path.basename(watch.file).includes(id)) || (engine === 'claude' ? watch.run.runId === id : watch.thread === id))); }
  setResumeSource(runId: string, file: string, engine: 'claude' | 'codex', model: string) {
    const size = fs.statSync(file).size; let usage: Snapshot | null = null; let actualModel = model || 'CLI default';
    if (engine === 'codex') { const fd = fs.openSync(file, 'r'); try { const bytes = Buffer.alloc(Math.min(size, 262144)); fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length); for (const line of bytes.toString().split('\n')) try { const event = JSON.parse(line); if (event.type === 'turn_context' && typeof event.payload?.model === 'string') actualModel = event.payload.model; usage = parseUsage(engine, event, actualModel) ?? usage; } catch {} } finally { fs.closeSync(fd); } }
    this.baselines.set(runId, { file, offset: size, usage });
  }
  private assigned = new Set<string>();
  constructor(readonly root: string, private rates: () => PriceRate[], private publish: (usage: UsageRecord) => void, private stopAtLimit: (run: RunningSession) => void, private claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), private codexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex')) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 }); this.database = new DatabaseSync(path.join(root, 'usage.db'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS usage(run TEXT NOT NULL, event TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(run,event)); CREATE TABLE IF NOT EXISTS metadata(run TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const cutoff = new Date(Date.now() - 366 * 86400000).toISOString(); this.database.prepare('DELETE FROM metadata WHERE json_extract(value,\'$.timestamp\') < ?').run(cutoff); this.database.exec('DELETE FROM usage WHERE run NOT IN(SELECT run FROM metadata);');
  }
  prepare(run: RunningSession, config: CLIEngineConfig, info: EngineInfo, launch: { args: string[]; env: Record<string, string> }) {
    if (config.engine === 'claude' && !config.resumeId && info.supportsSessionId) launch.args.push('--session-id', run.runId);
    if (config.engine === 'codex' && info.supportsConfig) { const logDir = path.join(this.root, run.runId); fs.mkdirSync(logDir, { recursive: true, mode: 0o700 }); launch.args.push('--config', `log_dir=${JSON.stringify(logDir.replace(/\\/g, '/'))}`); }
  }
  start(run: RunningSession, config: CLIEngineConfig, claudeHome = this.claudeHome) {
    const baseline = this.baselines.get(run.runId); this.baselines.delete(run.runId);
    const watch: Watcher = { requiresThread: false, baseline: baseline?.usage ?? null, claudeHome, run, config, start: Date.now(), file: baseline?.file ?? null, offset: baseline?.offset ?? 0, partial: Buffer.alloc(0), model: config.model || baseline?.usage?.model || 'CLI default', polling: false, stopped: false, thread: null, logDir: path.join(this.root, run.runId) };
    this.database.prepare('INSERT OR REPLACE INTO metadata(run,value) VALUES(?,?)').run(run.runId, JSON.stringify({ runId: run.runId, sessionId: run.sessionId, engine: run.engine, model: watch.model, cwd: run.cwd, timestamp: new Date(watch.start).toISOString() }));
    if (run.engine === 'codex') for (const other of this.watches.values()) { if (other.run.engine === 'codex' && other.run.cwd === run.cwd && !other.stopped) { other.requiresThread = true; watch.requiresThread = true; } }
    this.watches.set(run.runId, watch); watch.timer = setInterval(() => this.poll(watch), 750); this.poll(watch);
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
      if (!w.file) { w.file = this.find(w); if (w.file) this.assigned.add(w.file); }
      if (!w.file) return;
      const conversationId = path.basename(w.file).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (conversationId) { const record = this.database.prepare('SELECT value FROM metadata WHERE run=?').get(w.run.runId); if (record) { const metadata = JSON.parse(String(record.value)); if (metadata.conversationId !== conversationId) this.database.prepare('UPDATE metadata SET value=? WHERE run=?').run(JSON.stringify({ ...metadata, conversationId }), w.run.runId); } }

      const size = fs.statSync(w.file).size; if (size < w.offset) { w.offset = 0; w.partial = Buffer.alloc(0); }
      const count = Math.min(512000, size - w.offset); if (count <= 0) return;
      const buffer = Buffer.alloc(count); const fd = fs.openSync(w.file, 'r'); let read: number; try { read = fs.readSync(fd, buffer, 0, count, w.offset); } finally { fs.closeSync(fd); } w.offset += read;
      const data = Buffer.concat([w.partial, buffer.subarray(0, read)]); let start = 0; let changed = false;
      for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
        if (end - start <= 2 * 1024 * 1024) try {
          const raw = JSON.parse(data.subarray(start, end).toString()); if (raw.type === 'turn_context' && typeof raw.payload?.model === 'string') w.model = raw.payload.model;
          const parsed = parseUsage(w.run.engine, raw, w.model);
          if (parsed) { if (w.baseline && w.run.engine === 'codex') { for (const key of ['input', 'output', 'cached', 'cacheWrite'] as const) parsed[key] = Math.max(0, parsed[key] - w.baseline[key]); if (parsed.reasoning !== null) parsed.reasoning = Math.max(0, parsed.reasoning - (w.baseline.reasoning ?? 0)); } const old = this.database.prepare('SELECT snapshot FROM usage WHERE run=? AND event=?').get(w.run.runId, parsed.key); if (old) { const prev = JSON.parse(String(old.snapshot)) as Snapshot; for (const key of ['input', 'output', 'cached', 'cacheWrite'] as const) parsed[key] = Math.max(parsed[key], prev[key]); if (prev.reasoning !== null) parsed.reasoning = Math.max(parsed.reasoning ?? 0, prev.reasoning); }
            this.database.prepare('INSERT INTO usage(run,event,snapshot) VALUES(?,?,?) ON CONFLICT(run,event) DO UPDATE SET snapshot=excluded.snapshot').run(w.run.runId, parsed.key, JSON.stringify(parsed)); changed = true;
          }
        } catch { /* Non-usage events and malformed partial records are ignored. */ }
        start = end + 1;
      }
      w.partial = data.subarray(start).length <= 2 * 1024 * 1024 ? data.subarray(start) : Buffer.alloc(0);
      if (changed) { const usage = this.runUsage(w.run.runId); if (usage) { this.publish(usage); if (w.config.engine === 'claude' && w.config.tokenLimits.maxSessionTokens !== null && totalTokens(usage) >= w.config.tokenLimits.maxSessionTokens && !w.stopped) { w.stopped = true; this.stopAtLimit(w.run); } } }
    } catch { /* Telemetry failures cannot stop interactive terminal output. */ }
    finally { w.polling = false; }
  }
  /** Unreadable preferences leave usage unpriced; they must not stop usage recording or token limits. */
  private safeRates(): PriceRate[] { try { return this.rates(); } catch { return []; } }
  runUsage(runId: string, rates = this.safeRates()): UsageRecord | null {
    const meta = this.database.prepare('SELECT value FROM metadata WHERE run=?').get(runId); if (!meta) return null;
    const rows = this.database.prepare('SELECT snapshot FROM usage WHERE run=? ORDER BY rowid').all(runId); if (!rows.length) return null;
    const usage: UsageRecord = { ...JSON.parse(String(meta.value)), input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: null, context: null, cost: null };
    let cost = 0; let priced = true;
    for (const row of rows) { const snapshot = JSON.parse(String(row.snapshot)) as Snapshot;
      // Claude writes zero-usage `<synthetic>` entries for API errors; they cost nothing and are not the run's model.
      if (!snapshot.input && !snapshot.output && !snapshot.cached && !snapshot.cacheWrite && !snapshot.reasoning) continue;
      const event = { ...usage, ...snapshot }; const eventCost = usageCost(event, rates); if (eventCost === null) priced = false; else cost += eventCost; usage.model = snapshot.model; for (const key of ['input', 'output', 'cached', 'cacheWrite'] as const) usage[key] += snapshot[key]; if (snapshot.reasoning !== null) usage.reasoning = (usage.reasoning ?? 0) + snapshot.reasoning; if (snapshot.context) usage.context = snapshot.context; }
    usage.cost = priced ? cost : null; usage.source = usage.engine === 'claude' ? 'claude-session-jsonl' : 'codex-rollout-jsonl'; usage.confidence = 'reported'; usage.costBasis = priced ? 'configured-model-rates' : 'unpriced'; usage.eventCount = rows.length; return usage;
  }
  list(): UsageRecord[] { const rates = this.safeRates(); return this.database.prepare('SELECT run FROM metadata ORDER BY rowid DESC LIMIT 2000').all().map((r) => this.runUsage(String(r.run), rates)).filter((r): r is UsageRecord => r !== null); }
  end(runId: string) { const w = this.watches.get(runId); if (w) { clearInterval(w.timer); w.stopped = true; for (let i = 0; i < 8; i++) { const offset = w.offset; this.poll(w); if (w.offset === offset) break; } this.watches.delete(runId); try { fs.rmSync(w.logDir, { recursive: true, force: true }); } catch { /* A locked Windows TUI log can be removed after the next restart. */ } } }
  close() { for (const id of [...this.watches.keys()]) this.end(id); this.database.close(); }
}
