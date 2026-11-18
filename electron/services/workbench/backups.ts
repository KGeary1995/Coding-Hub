import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { BackupRecord, BackupResult } from '../../../shared/workbench';
import { HubError } from '../cli/engine-adapter';
import { load, save } from './local-store';
const MAX = 64 * 1024 * 1024;
/** Plain files stay small; the databases (usage.db grows with every day of use) may take the whole backup's limit. */
const FILE_MAX = 16 * 1024 * 1024;
/**
 * This computer's own identity, phone pairings, links to other computers and screen settings. Backups never carry
 * them (a restore on another computer must not take this one's keys); a restore copies the current ones over instead.
 * device-sync.json is not one: it is the sync baseline of the current data, and beside the backup's older rules and
 * templates it would make every difference look like a change made here (deleting templates made since, replacing
 * newer rules). Without it the next sync starts a new baseline: shared templates come back and rule differences wait.
 */
const MACHINE_FILES = ['machine.json', 'remote.json', 'remote-devices.json', 'remote-push.json', 'remote-unlinked.json', 'linked-computers.json', 'linked-computers-declined.json', 'screen-sharing.json', 'screen-share.json', 'screen-service-local.json'];
const zipped = (data: Buffer) => new Promise<Buffer>((resolve, reject) => gzip(data, (error, result) => error ? reject(error) : resolve(result)));
const unzipped = (data: Buffer) => new Promise<Buffer>((resolve, reject) => gunzip(data, { maxOutputLength: 96 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
const recordSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime(), appVersion: z.string().max(60), files: z.number().int().min(0).max(10000), bytes: z.number().int().min(0).max(MAX), includesLogs: z.boolean() }).strict();
const entrySchema = z.object({ path: z.string().min(1).max(500), hash: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().max(Math.ceil(MAX / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict();
const manifestSchema = z.object({ version: z.literal(1), sourceRoot: z.string().max(4096).optional(), record: recordSchema, entries: z.array(entrySchema).max(10000) }).strict();
/** design-annotations.json and designs/ belong to the removed Design workspace. They stay in backups so existing copies are kept and restore as before; nothing reads them now. */
const exact = ['storage.db', 'telemetry/usage.db', 'preferences.json', 'shared-rules.json', 'updates.json', 'worktrees.json', 'claude-profiles/profiles.json', 'tasks.json', 'experiments.json', 'verification.json', 'design-annotations.json', 'conversation-labels.json', 'project-templates.json'];
function allowed(name: string, logs: boolean) { return !name.includes('\\') && !name.startsWith('/') && !name.split('/').some((p) => !p || p === '.' || p === '..') && !name.includes(':') && (exact.includes(name) || ['memory/', 'designs/', 'coaching/', ...(logs ? ['logs/'] : [])].some((prefix) => name.startsWith(prefix))) && !name.endsWith('.credentials.json') && !name.endsWith('-wal') && !name.endsWith('-shm') && !name.endsWith('.tmp'); }
export function resolveStorageRoot(base: string, profile: string) {
  try { const pointer = JSON.parse(fs.readFileSync(path.join(profile, 'storage-location.json'), 'utf8')); const prefix = path.join(base, 'restores') + path.sep; if (pointer.base === base && typeof pointer.directory === 'string' && pointer.directory.startsWith(prefix) && pointer.directory === path.join(base, 'restores', path.basename(pointer.directory)) && z.uuid().safeParse(path.basename(pointer.directory)).success && !fs.lstatSync(pointer.directory).isSymbolicLink() && fs.statSync(pointer.directory).isDirectory()) return pointer.directory; } catch {}
  return base;
}
/**
 * A backup keeps Claude account profiles' names but not their conversations (they live in each profile's own folder,
 * beside its credentials), so a restored channel on a named profile cannot resume one: it starts a new conversation
 * instead of refusing to start.
 */
function withoutProfileResumes(workspace: unknown): unknown {
  if (!workspace || typeof workspace !== 'object' || !Array.isArray((workspace as { sessions?: unknown }).sessions)) return workspace;
  const sessions = (workspace as { sessions: unknown[] }).sessions.map((session) => {
    const config = session && typeof session === 'object' ? (session as { config?: Record<string, unknown> }).config : undefined;
    if (!config || config.engine !== 'claude' || !config.accountProfileId || !config.resumeId) return session;
    const { resumeId: _resumeId, ...rest } = config; return { ...(session as object), config: rest };
  });
  return { ...(workspace as object), sessions };
}
export class Backups {
  restartRequired = false;
  busy = false;
  private root: string;
  constructor(private base: string, private active: string, private profile: string, private version: string, private callbacks: { ready: () => Promise<void>; exportFile: () => Promise<string | null>; importFile: () => Promise<string | null>; confirmRestore: (record: BackupRecord) => Promise<boolean>; confirmDelete?: (record: BackupRecord) => Promise<boolean> }) { this.root = path.join(base, 'backups'); }
  list(): BackupRecord[] { return load(this.root, 'index.json', z.array(recordSchema).max(50), []); }
  /** File reads and gzip run off the main thread (they took seconds there); hashing and parsing still run on it. */
  private async manifest(file: string) {
    if ((await fs.promises.stat(file)).size > 80 * 1024 * 1024) throw new HubError('BACKUP_SIZE', 'Backup file exceeds the supported limit.');
    const value = manifestSchema.parse(JSON.parse((await unzipped(await fs.promises.readFile(file))).toString('utf8')));
    let size = 0; const names = new Set<string>();
    for (const entry of value.entries) { if (!allowed(entry.path, value.record.includesLogs) || names.has(entry.path)) throw new HubError('BACKUP_PATH', 'Backup includes an invalid or duplicate path. Nothing was restored.'); names.add(entry.path); const bytes = Buffer.from(entry.content, 'base64'); size += bytes.length; if (size > MAX || createHash('sha256').update(bytes).digest('hex') !== entry.hash) throw new HubError('BACKUP_HASH', 'Backup integrity failed. Nothing was restored.'); }
    if (size !== value.record.bytes || value.entries.length !== value.record.files) throw new HubError('BACKUP_HASH', 'Backup metadata does not match its contents.'); return value;
  }
  private rebase(restored: string, source: string) {
    const old = source.replace(/\\/g, '/').replace(/\/$/, '');
    // Managed worktrees are live Git checkouts that backups never copy; keep pointing at the originals.
    const convert = (value: string) => { const normal = value.replace(/\\/g, '/'); return normal === old ? restored : normal.startsWith(old + '/') && !normal.startsWith(old + '/worktrees/') ? path.join(restored, ...normal.slice(old.length + 1).split('/')) : value; };
    const walk = (value: unknown, key = ''): unknown => {
      if (typeof value === 'string' && ['directory', 'directories', 'cwd', 'rootDirectory', 'repository'].includes(key)) return convert(value);
      if (Array.isArray(value)) return value.map((item) => walk(item, key));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
      return value;
    };
    for (const file of ['shared-rules.json', 'tasks.json', 'verification.json', 'worktrees.json', 'project-templates.json']) { const target = path.join(restored, file); if (fs.existsSync(target)) save(restored, file, walk(JSON.parse(fs.readFileSync(target, 'utf8')))); }
    for (const file of ['storage.db', 'telemetry/usage.db']) {
      const target = path.join(restored, file); if (!fs.existsSync(target)) continue; const db = new DatabaseSync(target);
      try {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
        if (tables.has('workspace')) { const row = db.prepare('SELECT snapshot FROM workspace WHERE id=1').get(); if (row) db.prepare('UPDATE workspace SET snapshot=? WHERE id=1').run(JSON.stringify(withoutProfileResumes(walk(JSON.parse(String(row.snapshot)))))); }
        if (tables.has('runs')) for (const row of db.prepare('SELECT runId,cwd FROM runs').all()) db.prepare('UPDATE runs SET cwd=? WHERE runId=?').run(convert(String(row.cwd)), String(row.runId));
        if (file.endsWith('usage.db') && tables.has('metadata')) for (const row of db.prepare('SELECT run,value FROM metadata').all()) db.prepare('UPDATE metadata SET value=? WHERE run=?').run(JSON.stringify(walk(JSON.parse(String(row.value)))), String(row.run));
      } finally { db.close(); }
    }
  }
  async execute(input: unknown): Promise<BackupRecord[] | BackupResult | null> {
    if (input && typeof input === 'object' && 'action' in input && input.action === 'backup-list') return this.operation(input);
    if (this.busy) throw new HubError('BACKUP_BUSY', 'Another backup operation is running.'); this.busy = true;
    try { return await this.operation(input); } finally { this.busy = false; }
  }
  private async operation(input: unknown): Promise<BackupRecord[] | BackupResult | null> {
    const request = z.discriminatedUnion('action', [z.object({ action: z.literal('backup-list') }).strict(), z.object({ action: z.literal('backup-create'), includeLogs: z.boolean() }).strict(), z.object({ action: z.literal('backup-export'), id: z.uuid() }).strict(), z.object({ action: z.literal('backup-restore'), id: z.uuid() }).strict(), z.object({ action: z.literal('backup-import') }).strict(), z.object({ action: z.literal('backup-delete'), id: z.uuid() }).strict()]).parse(input);
    if (request.action === 'backup-list') return this.list();
    if (request.action === 'backup-create') {
      await this.callbacks.ready(); const existing = this.list(); if (existing.length >= 50) throw new HubError('BACKUP_LIMIT', 'Up to 50 local backups are supported. Export any you want to keep, then delete older ones before adding more.');
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); if (fs.lstatSync(this.root).isSymbolicLink()) throw new HubError('BACKUP_PATH', 'Backup directory must not be a link.');
      const temporary = path.join(this.root, '.' + randomUUID()); fs.mkdirSync(temporary, { mode: 0o700 });
      const entries: z.infer<typeof entrySchema>[] = []; let total = 0;
      const tooLarge = (relative: string) => new HubError('BACKUP_SIZE', `${relative} is too large to back up (over ${relative.endsWith('.db') ? 64 : 16} MiB). Back it up by copying the file yourself.`);
      // A database is copied with VACUUM INTO, so the copy holds its WAL contents and no half-written page.
      const add = async (relative: string, file: string) => {
        let source = file; if (relative.endsWith('.db')) { source = path.join(temporary, randomUUID() + '.db'); const db = new DatabaseSync(file, { readOnly: true }); try { db.prepare('VACUUM INTO ?').run(source); } finally { db.close(); } }
        if ((await fs.promises.stat(source)).size > (relative.endsWith('.db') ? MAX : FILE_MAX)) throw tooLarge(relative);
        const bytes = await fs.promises.readFile(source); if (bytes.length > (relative.endsWith('.db') ? MAX : FILE_MAX)) throw tooLarge(relative);
        total += bytes.length; if (total > MAX || entries.length >= 10000) throw new HubError('BACKUP_SIZE', `The backup would exceed 64 MiB or 10,000 files at ${relative}.${request.includeLogs ? ' Try again without session output logs.' : ''}`);
        entries.push({ path: relative, hash: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') });
      };
      const scan = async (folder: string, prefix: string, depth: number) => {
        if (depth > 12) throw new HubError('BACKUP_LIMIT', 'Backup directory nesting exceeds the supported limit.');
        for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue; const relative = prefix ? prefix + '/' + entry.name : entry.name; const file = path.join(folder, entry.name);
          if (entry.isDirectory()) { if (['memory', 'designs', 'coaching', ...(request.includeLogs ? ['logs'] : [])].includes(relative) || ['memory/', 'designs/', 'coaching/', ...(request.includeLogs ? ['logs/'] : [])].some((p) => relative.startsWith(p))) await scan(file, relative, depth + 1); continue; }
          if (!entry.isFile() || !allowed(relative, request.includeLogs)) continue;
          await add(relative, file);
        }
      };
      try {
        await scan(this.active, '', 0);
        // Nested databases and the profile-label registry are explicit additions.
        for (const relative of ['telemetry/usage.db', 'claude-profiles/profiles.json']) { const file = path.join(this.active, relative); if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || fs.lstatSync(path.dirname(file)).isSymbolicLink()) continue; await add(relative, file); }
        const record: BackupRecord = { id: randomUUID(), createdAt: new Date().toISOString(), appVersion: this.version, files: entries.length, bytes: total, includesLogs: request.includeLogs };
        const bundle = await zipped(Buffer.from(JSON.stringify({ version: 1, sourceRoot: this.active, record, entries }))); const file = path.join(this.root, record.id + '.hub-backup.gz'); await fs.promises.writeFile(file, bundle, { flag: 'wx', mode: 0o600 }); await this.manifest(file); save(this.root, 'index.json', [record, ...existing]); return { record };
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }
    if (request.action === 'backup-delete') {
      const existing = this.list(); const record = existing.find((item) => item.id === request.id); if (!record) throw new HubError('BACKUP_MISSING', 'That backup is no longer in the list. Refresh it.');
      // The window is not trusted to delete on its own: without the host's own confirmation nothing is deleted.
      if (!this.callbacks.confirmDelete) throw new HubError('BACKUP_DELETE_UNAVAILABLE', 'Trace cannot ask to confirm deleting a backup here, so nothing was deleted.');
      if (!await this.callbacks.confirmDelete(record)) return null;
      // The index goes first: a file left behind is harmless, an index entry with no file is a backup that cannot restore.
      save(this.root, 'index.json', existing.filter((item) => item.id !== request.id)); fs.rmSync(path.join(this.root, request.id + '.hub-backup.gz'), { force: true }); return this.list();
    }
    let file: string;
    if (request.action === 'backup-import') { const selected = await this.callbacks.importFile(); if (!selected) return null; file = selected; }
    else { if (!this.list().some((r) => r.id === request.id)) throw new HubError('BACKUP_MISSING', 'Select an available backup.'); file = path.join(this.root, request.id + '.hub-backup.gz'); }
    const manifest = await this.manifest(file);
    const parsedVersion = (value: string) => value.split('.').map(Number); const incoming = parsedVersion(manifest.record.appVersion); const current = parsedVersion(this.version); if (incoming.every(Number.isFinite) && current.every(Number.isFinite) && incoming.some((value, index) => value > (current[index] ?? 0) && incoming.slice(0, index).every((prior, i) => prior === current[i]))) throw new HubError('BACKUP_VERSION', 'This backup is from a newer application version. Update the app before restoring.');
    if (request.action === 'backup-export') { const selected = await this.callbacks.exportFile(); if (!selected) return null; if (path.resolve(selected) !== path.resolve(file)) await fs.promises.copyFile(file, selected); return { record: manifest.record }; }
    await this.callbacks.ready();
    const restored = path.join(this.base, 'restores', randomUUID());
    if (fs.existsSync(path.dirname(restored)) && fs.lstatSync(path.dirname(restored)).isSymbolicLink()) throw new HubError('BACKUP_PATH', 'Restore directory must not be a link.');
    fs.mkdirSync(restored, { recursive: true, mode: 0o700 });
    try {
      for (const entry of manifest.entries) { const target = path.join(restored, ...entry.path.split('/')); await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.promises.writeFile(target, Buffer.from(entry.content, 'base64'), { flag: 'wx', mode: 0o600 }); }
      // Verify copied bytes before offering activation. Current storage is untouched.
      for (const entry of manifest.entries) if (createHash('sha256').update(await fs.promises.readFile(path.join(restored, entry.path))).digest('hex') !== entry.hash) throw new HubError('BACKUP_HASH', 'Restored bytes failed verification.');
      if (manifest.sourceRoot) this.rebase(restored, manifest.sourceRoot);
      // This computer stays itself after the restore: same sync identity, paired phones and linked computers.
      for (const name of MACHINE_FILES) { const source = path.join(this.active, name); try { if (!fs.lstatSync(source).isFile()) continue; } catch { continue; } fs.copyFileSync(source, path.join(restored, name), fs.constants.COPYFILE_EXCL); }
      if (!await this.callbacks.confirmRestore(manifest.record)) { fs.rmSync(restored, { recursive: true, force: true }); return null; }
      save(this.profile, 'storage-location.json', { base: this.base, directory: restored }); this.restartRequired = true; return { record: manifest.record, restoredPath: restored, restartRequired: true };
    } catch (error) { fs.rmSync(restored, { recursive: true, force: true }); throw error; }
  }
}
