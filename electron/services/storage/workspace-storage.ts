import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CLIEngineConfig, RunLog, SavedWorkspace, SessionHistoryRun, StorageInfo } from '../../../shared/types';
import type { RunningSession } from '../../../shared/ipc';
import { readRunLogSchema, savedWorkspaceSchema } from '../../../shared/schemas';
import { HubError } from '../cli/engine-adapter';

interface ActiveLog { fd: number; bytes: number; truncated: boolean; pending: string; timer?: ReturnType<typeof setTimeout> }
type StoredRow = Omit<SessionHistoryRun, 'config' | 'logTruncated'> & { config: string; logTruncated: number };

/** Only the host chooses paths; renderer requests are validated IDs and settings. */
export class WorkspaceStorage {
  readonly info: StorageInfo;
  private database: DatabaseSync;
  private active = new Map<string, ActiveLog>();
  private closed = false;

  constructor(root: string, private onError: (message: string) => void = () => {}, limits: Partial<Pick<StorageInfo, 'maxLogBytes' | 'maxCompletedRuns' | 'retentionDays'>> = {}) {
    if (!path.isAbsolute(root)) throw new HubError('STORAGE_PATH', 'The local storage directory must be absolute.');
    this.info = { databasePath: path.join(root, 'storage.db'), logsDirectory: path.join(root, 'logs'), maxLogBytes: 5 * 1024 * 1024, maxCompletedRuns: 100, retentionDays: 30, ...limits };
    mkdirSync(this.info.logsDirectory, { recursive: true, mode: 0o700 });
    closeSync(openSync(this.info.databasePath, 'a', 0o600));
    this.database = new DatabaseSync(this.info.databasePath);
    try {
      const version = Number(this.database.prepare('PRAGMA user_version').get()?.user_version);
      if (version > 1) throw new HubError('STORAGE_VERSION', 'This database requires a newer version of AI Coding Hub. Existing data was preserved.');
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
        try { bytes = statSync(this.logPath(String(row.runId))).size; } catch { /* An absent log is surfaced when opened. */ }
        this.database.prepare("UPDATE runs SET status='interrupted', endedAt=?, recordedBytes=? WHERE runId=?").run(new Date().toISOString(), bytes, String(row.runId));
      }
      this.prune();
    } catch (error) { this.database.close(); throw error; }
  }

  load(): SavedWorkspace | null {
    const row = this.database.prepare('SELECT snapshot FROM workspace WHERE id=1').get();
    if (!row) return null;
    try { return savedWorkspaceSchema.parse(JSON.parse(String(row.snapshot))); }
    catch { throw new HubError('INVALID_SAVED_WORKSPACE', 'Saved workspace settings could not be read. Existing data was preserved; automatic saving is disabled for this launch.'); }
  }

  save(payload: unknown) {
    const result = savedWorkspaceSchema.safeParse(payload);
    if (!result.success) throw new HubError('INVALID_WORKSPACE', result.error.issues.map((issue) => issue.message).join(' '));
    this.database.prepare('INSERT INTO workspace(id,snapshot) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot').run(JSON.stringify(result.data));
  }

  beginRun(run: RunningSession, config: CLIEngineConfig) {
    const file = openSync(this.logPath(run.runId), 'wx', 0o600);
    try {
      this.database.prepare("INSERT INTO runs(runId,sessionId,engine,config,cwd,startedAt,status) VALUES(?,?,?,?,?,?,'running')").run(run.runId, run.sessionId, run.engine, JSON.stringify(config), run.cwd, new Date().toISOString());
      this.active.set(run.runId, { fd: file, bytes: 0, truncated: false, pending: '' });
    } catch (error) { closeSync(file); throw error; }
  }

  append(runId: string, data: string) {
    const log = this.active.get(runId);
    if (!log || log.truncated) return;
    log.pending += data;
    if (log.pending.length >= 128 * 1024) this.flush(runId);
    else if (!log.timer) log.timer = setTimeout(() => {
      try { this.flush(runId); } catch { this.onError('Session output could not be saved. Live terminal output remains available.'); }
    }, 200);
  }

  private flush(runId: string, final = false) {
    const log = this.active.get(runId);
    if (!log) return;
    clearTimeout(log.timer); log.timer = undefined;
    let text = log.pending;
    log.pending = '';
    // PTY/IPC chunks can split UTF-16 surrogate pairs. Hold the trailing half.
    if (!final && /[\uD800-\uDBFF]$/.test(text)) { log.pending = text.slice(-1); text = text.slice(0, -1); }
    let buffer = Buffer.from(text, 'utf8');
    const remaining = this.info.maxLogBytes - log.bytes;
    if (buffer.length > remaining) {
      let end = remaining;
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      buffer = buffer.subarray(0, end); log.truncated = true; log.pending = '';
    }
    for (let offset = 0; offset < buffer.length;) {
      const written = writeSync(log.fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error('Could not write session output.');
      offset += written; log.bytes += written;
    }
    this.database.prepare('UPDATE runs SET recordedBytes=?, logTruncated=? WHERE runId=?').run(log.bytes, Number(log.truncated), runId);
  }

  endRun(runId: string, exitCode: number) {
    const log = this.active.get(runId);
    if (!log) return;
    try { this.flush(runId, true); }
    finally { closeSync(log.fd); this.active.delete(runId); }
    this.database.prepare("UPDATE runs SET status='completed', endedAt=?, exitCode=? WHERE runId=?").run(new Date().toISOString(), exitCode, runId);
    this.prune();
  }

  history(): SessionHistoryRun[] {
    for (const runId of this.active.keys()) this.flush(runId);
    return (this.database.prepare('SELECT * FROM runs ORDER BY startedAt DESC, rowid DESC LIMIT ?').all(this.info.maxCompletedRuns + 4) as unknown as StoredRow[]).map((row) => ({ ...row, config: JSON.parse(row.config) as CLIEngineConfig, logTruncated: Boolean(row.logTruncated) }));
  }

  readLog(payload: unknown): RunLog {
    const parsed = readRunLogSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_LOG_REFERENCE', 'Choose a valid session history entry.');
    const { runId } = parsed.data;
    this.flush(runId);
    const record = this.database.prepare('SELECT logTruncated FROM runs WHERE runId=?').get(runId);
    if (!record) throw new HubError('LOG_NOT_FOUND', 'This session history entry is no longer available.');
    let fd: number;
    try { fd = openSync(this.logPath(runId), 'r'); }
    catch { throw new HubError('LOG_NOT_FOUND', 'The saved output file is no longer available.'); }
    try {
      const size = statSync(this.logPath(runId)).size;
      const offset = Math.max(0, size - 1024 * 1024);
      const buffer = Buffer.alloc(size - offset);
      let read = 0;
      while (read < buffer.length) { const count = readSync(fd, buffer, read, buffer.length - read, offset + read); if (!count) break; read += count; }
      let start = 0;
      if (offset > 0) while (start < read && (buffer[start] & 0xc0) === 0x80) start++;
      return { runId, text: stripVTControlCharacters(buffer.subarray(start, read).toString('utf8')), tailOnly: offset > 0, logTruncated: Boolean(record.logTruncated) };
    } finally { closeSync(fd); }
  }

  private logPath(runId: string) {
    if (!readRunLogSchema.safeParse({ runId }).success) throw new HubError('INVALID_LOG_REFERENCE', 'Invalid run ID in local history.');
    return path.join(this.info.logsDirectory, runId + '.log');
  }

  private prune() {
    const cutoff = new Date(Date.now() - this.info.retentionDays * 86400000).toISOString();
    const completed = this.database.prepare("SELECT runId, endedAt FROM runs WHERE status!='running' ORDER BY startedAt DESC, rowid DESC").all();
    completed.forEach((row, index) => {
      if (index < this.info.maxCompletedRuns && String(row.endedAt) >= cutoff) return;
      try { unlinkSync(this.logPath(String(row.runId))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.database.prepare('DELETE FROM runs WHERE runId=?').run(String(row.runId));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const runId of [...this.active.keys()]) {
      const log = this.active.get(runId)!;
      try { this.flush(runId, true); }
      catch { this.onError('Final session output could not be saved.'); }
      finally { clearTimeout(log.timer); closeSync(log.fd); this.active.delete(runId); }
    }
    this.database.close();
  }
}
