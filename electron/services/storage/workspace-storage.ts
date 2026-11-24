import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { AgentConfig, RunLog, SavedWorkspace, SessionHistoryRun, StorageInfo } from '../../../shared/types';
import type { AgentRunningSession } from '../../../shared/ipc';
import { legacyWorkspaceSchema, readRunLogSchema, savedWorkspaceSchema } from '../../../shared/schemas';
import { migrateWorkspace } from '../../../shared/workspace-migration';
import { HubError } from '../cli/engine-adapter';

/**
 * A run's output: the start in `<runId>.log`, then, once that is full, the newest output in `.tail.log` with the segment
 * before it in `.tail-1.log` (renamed, never rewritten). `bytes` counts what is kept; `truncated`: something was dropped.
 */
interface ActiveLog { fd: number; bytes: number; head: number; tail: { fd: number; bytes: number; previous: number } | null; truncated: boolean; pending: string; timer?: ReturnType<typeof setTimeout> }
type StoredRow = Omit<SessionHistoryRun, 'config' | 'logTruncated'> & { config: string; logTruncated: number };

function write(fd: number, buffer: Buffer) {
  for (let offset = 0; offset < buffer.length;) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('Could not write session output.');
    offset += written;
  }
}

/** Only the host chooses paths; renderer requests are validated IDs and settings. */
export class WorkspaceStorage {
  readonly info: StorageInfo;
  private database: DatabaseSync;
  private active = new Map<string, ActiveLog>();
  private closed = false;
  /**
   * The saved workspace as last read or saved. Phones, linked computers and alerts read it on every keystroke and channel
   * change, and with a table's images it is megabytes to parse and validate. Callers must not change it.
   */
  private saved: ReturnType<typeof migrateWorkspace> | null = null;

  constructor(root: string, private onError: (message: string) => void = () => {}, limits: Partial<Pick<StorageInfo, 'maxLogBytes' | 'maxCompletedRuns' | 'retentionDays'>> = {}) {
    if (!path.isAbsolute(root)) throw new HubError('STORAGE_PATH', 'The local storage folder must be absolute.');
    this.info = { databasePath: path.join(root, 'storage.db'), logsDirectory: path.join(root, 'logs'), maxLogBytes: 5 * 1024 * 1024, maxCompletedRuns: 100, retentionDays: 30, ...limits };
    mkdirSync(this.info.logsDirectory, { recursive: true, mode: 0o700 });
    closeSync(openSync(this.info.databasePath, 'a', 0o600));
    this.database = new DatabaseSync(this.info.databasePath);
    try {
      const version = Number(this.database.prepare('PRAGMA user_version').get()?.user_version);
      if (version > 1) throw new HubError('STORAGE_VERSION', 'This database requires a newer version of Trace. Existing data was preserved.');
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');
      if (version === 0) this.database.exec(`BEGIN;
        CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL);
        CREATE TABLE runs (runId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, engine TEXT NOT NULL, config TEXT NOT NULL, cwd TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, status TEXT NOT NULL, exitCode INTEGER, recordedBytes INTEGER NOT NULL DEFAULT 0, logTruncated INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX runs_started ON runs(startedAt DESC);
        PRAGMA user_version=1; COMMIT;`);
      // A prior host cannot own processes after this restart. Never reattach old PIDs.
      const interrupted = this.database.prepare("SELECT runId FROM runs WHERE status='running'").all();
      for (const row of interrupted) {
        let bytes = 0;
        for (const file of this.logFiles(String(row.runId))) try { bytes += statSync(file).size; } catch { /* An absent log is surfaced when opened. */ }
        this.database.prepare("UPDATE runs SET status='interrupted', endedAt=?, recordedBytes=? WHERE runId=?").run(new Date().toISOString(), bytes, String(row.runId));
      }
      this.prune();
    } catch (error) { this.database.close(); throw error; }
  }

  load(): SavedWorkspace | null { return this.loadMigrated().workspace; }
  /**
   * The saved workspace in today's shape: one saved by 1.20 can hold hidden Gemini seats, which are dropped
   * (migrateWorkspace). `removedChannels`: how many of those the person could see, so the window can say so.
   */
  loadMigrated(): { workspace: SavedWorkspace | null; removedChannels: number; rootDirectory: string | null } {
    if (this.saved) return this.saved;
    const row = this.database.prepare('SELECT snapshot FROM workspace WHERE id=1').get();
    if (!row) return { workspace: null, removedChannels: 0, rootDirectory: null };
    let saved;
    try { saved = legacyWorkspaceSchema.parse(JSON.parse(String(row.snapshot))); }
    catch { throw new HubError('INVALID_SAVED_WORKSPACE', 'Saved workspace settings could not be read. Existing data was preserved; automatic saving is disabled for this launch.'); }
    return this.saved = migrateWorkspace(saved);
  }

  save(payload: unknown) {
    const result = savedWorkspaceSchema.safeParse(payload);
    if (!result.success) throw new HubError('INVALID_WORKSPACE', result.error.issues.map((issue) => issue.message).join(' '));
    this.database.prepare('INSERT INTO workspace(id,snapshot) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot').run(JSON.stringify(result.data));
    // What a read of the row just written gives (it has no Gemini seats left to drop), without reading it back.
    this.saved = migrateWorkspace(result.data);
  }

  beginRun(run: AgentRunningSession, config: AgentConfig) {
    const file = openSync(this.logPath(run.runId), 'wx', 0o600);
    try {
      this.database.prepare("INSERT INTO runs(runId,sessionId,engine,config,cwd,startedAt,status) VALUES(?,?,?,?,?,?,'running')").run(run.runId, run.sessionId, run.engine, JSON.stringify(config), run.cwd, new Date().toISOString());
      this.active.set(run.runId, { fd: file, bytes: 0, head: 0, tail: null, truncated: false, pending: '' });
    } catch (error) { closeSync(file); throw error; }
  }

  append(runId: string, data: string) {
    const log = this.active.get(runId);
    if (!log) return;
    log.pending += data;
    if (log.pending.length >= 128 * 1024) this.flush(runId);
    else if (!log.timer) log.timer = setTimeout(() => {
      try { this.flush(runId); } catch { this.onError('Session output could not be saved. Live terminal output remains available.'); }
    }, 200);
  }

  /** The newest output kept once the start is full: two segments, each a fifth of the per-run limit. */
  private get segment() { return Math.max(1, Math.floor(this.info.maxLogBytes / 5)); }

  /**
   * `record`: also write the byte count to the database. The 200 ms flushes skip it: one synchronous commit each, per
   * printing channel, was steady main-process work. History, reading a log and the end of a run record it, and a
   * restart takes it from the files (constructor).
   */
  private flush(runId: string, final = false, record = false) {
    const log = this.active.get(runId);
    if (!log) return;
    clearTimeout(log.timer); log.timer = undefined;
    let text = log.pending;
    log.pending = '';
    // PTY/IPC chunks can split UTF-16 surrogate pairs. Hold the trailing half.
    if (!final && /[\uD800-\uDBFF]$/.test(text)) { log.pending = text.slice(-1); text = text.slice(0, -1); }
    let buffer = Buffer.from(text, 'utf8'); const truncated = log.truncated;
    if (!log.tail) {
      const room = this.info.maxLogBytes - 2 * this.segment - log.head; let end = Math.min(buffer.length, Math.max(0, room));
      if (end < buffer.length) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      write(log.fd, buffer.subarray(0, end)); log.head += end; log.bytes = log.head; buffer = buffer.subarray(end);
    }
    if (buffer.length) this.writeTail(runId, log, buffer);
    if (record || log.truncated !== truncated) this.database.prepare('UPDATE runs SET recordedBytes=?, logTruncated=? WHERE runId=?').run(log.bytes, Number(log.truncated), runId);
  }

  /** Appends to the newest segment; a full one is renamed to `.tail-1.log`, replacing (dropping) the one before. */
  private writeTail(runId: string, log: ActiveLog, data: Buffer) {
    const [, current, previous] = this.logFiles(runId); let buffer = data; let kept = log.tail?.previous ?? 0;
    const drop = () => { try { unlinkSync(previous); } catch { /* None yet. */ } kept = 0; };
    if (buffer.length > this.segment) {
      // One flush larger than a segment: keep its end only, and nothing older from the tail.
      let start = buffer.length - this.segment; while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
      buffer = buffer.subarray(start); log.truncated = true;
      if (log.tail) { closeSync(log.tail.fd); log.tail = null; } drop();
    } else if (log.tail && log.tail.bytes + buffer.length > this.segment) {
      closeSync(log.tail.fd); if (kept) log.truncated = true;
      // A segment another program holds open (Windows) cannot be renamed: start the tail again rather than stop saving.
      try { renameSync(current, previous); kept = log.tail.bytes; } catch { log.truncated = true; drop(); }
      log.tail = null;
    }
    if (!log.tail) log.tail = { fd: openSync(current, 'w', 0o600), bytes: 0, previous: kept };
    write(log.tail.fd, buffer); log.tail.bytes += buffer.length; log.bytes = log.head + log.tail.bytes + log.tail.previous;
  }

  endRun(runId: string, exitCode: number) {
    const log = this.active.get(runId);
    if (!log) return;
    try { this.flush(runId, true, true); }
    finally { closeSync(log.fd); if (log.tail) closeSync(log.tail.fd); this.active.delete(runId); }
    this.database.prepare("UPDATE runs SET status='completed', endedAt=?, exitCode=? WHERE runId=?").run(new Date().toISOString(), exitCode, runId);
    this.prune();
  }

  history(): SessionHistoryRun[] {
    for (const runId of this.active.keys()) this.flush(runId, false, true);
    return (this.database.prepare('SELECT * FROM runs ORDER BY startedAt DESC, rowid DESC LIMIT ?').all(this.info.maxCompletedRuns + Math.max(4, this.active.size)) as unknown as StoredRow[]).map((row) => ({ ...row, config: JSON.parse(row.config) as AgentConfig, logTruncated: Boolean(row.logTruncated) }));
  }

  readLog(payload: unknown): RunLog {
    const parsed = readRunLogSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_LOG_REFERENCE', 'Choose a valid session history entry.');
    const { runId } = parsed.data;
    this.flush(runId, false, true);
    const record = this.database.prepare('SELECT logTruncated FROM runs WHERE runId=?').get(runId);
    if (!record) throw new HubError('LOG_NOT_FOUND', 'This session history entry is no longer available.');
    const [head, current, previous] = this.logFiles(runId);
    try { statSync(head); } catch { throw new HubError('LOG_NOT_FOUND', 'The saved output file is no longer available.'); }
    // With a gap (logTruncated) the start no longer leads into the tail, so only the newest output is shown. A run
    // saved by 1.22.0 or earlier has no tail files: its log is the start alone (it stopped at the limit), so that is read.
    const sized = (files: string[]) => files.map((file) => { try { return { file, size: statSync(file).size }; } catch { return { file, size: 0 }; } });
    const tails = sized([previous, current]); const parts = record.logTruncated && tails.some((part) => part.size) ? tails : sized([head, previous, current]);
    const total = parts.reduce((sum, part) => sum + part.size, 0); const limit = 1024 * 1024; let skip = Math.max(0, total - limit);
    const buffer = Buffer.alloc(total - skip); let read = 0;
    for (const part of parts) {
      if (skip >= part.size) { skip -= part.size; continue; }
      const fd = openSync(part.file, 'r');
      try { for (let position = skip; position < part.size && read < buffer.length;) { const count = readSync(fd, buffer, read, Math.min(part.size - position, buffer.length - read), position); if (!count) break; read += count; position += count; } }
      finally { closeSync(fd); }
      skip = 0;
    }
    let start = 0;
    if (total > limit || record.logTruncated) while (start < read && (buffer[start] & 0xc0) === 0x80) start++;
    return { runId, text: stripVTControlCharacters(buffer.subarray(start, read).toString('utf8')), tailOnly: total > limit || Boolean(record.logTruncated), logTruncated: Boolean(record.logTruncated) };
  }

  private logPath(runId: string) {
    if (!readRunLogSchema.safeParse({ runId }).success) throw new HubError('INVALID_LOG_REFERENCE', 'Invalid run ID in local history.');
    return path.join(this.info.logsDirectory, runId + '.log');
  }
  /** The start, the newest segment and the one before it. */
  private logFiles(runId: string) { const head = this.logPath(runId); return [head, head.replace(/\.log$/, '.tail.log'), head.replace(/\.log$/, '.tail-1.log')] as const; }

  private prune() {
    const cutoff = new Date(Date.now() - this.info.retentionDays * 86400000).toISOString();
    const completed = this.database.prepare("SELECT runId, endedAt FROM runs WHERE status!='running' ORDER BY startedAt DESC, rowid DESC").all();
    completed.forEach((row, index) => {
      if (index < this.info.maxCompletedRuns && String(row.endedAt) >= cutoff) return;
      // A log Windows will not delete now (locked, read-only) stays, with its record, and is tried again next time:
      // one stubborn file must not turn storage off for the whole launch.
      const [head, ...tail] = this.logFiles(String(row.runId));
      try { unlinkSync(head); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      for (const file of tail) try { unlinkSync(file); } catch { /* Absent. */ }
      this.database.prepare('DELETE FROM runs WHERE runId=?').run(String(row.runId));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const runId of [...this.active.keys()]) {
      const log = this.active.get(runId)!;
      try { this.flush(runId, true, true); }
      catch { this.onError('Final session output could not be saved.'); }
      finally { clearTimeout(log.timer); closeSync(log.fd); if (log.tail) closeSync(log.tail.fd); this.active.delete(runId); }
    }
    this.database.close();
  }
}
