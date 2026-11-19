import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { DriveStatus, HubPreferences, MemoryConflict, MemoryNote } from '../../../shared/hub';
import { MemoryService, noteSchema } from './memory';
import { HubError } from '../cli/engine-adapter';

/**
 * Why a Drive folder cannot be used, or null when it can. A Windows path such as `G:\My Drive` is not a full path on a
 * Mac, and sync used to stop there without saying so.
 */
export function driveFolderProblem(directory: string, isAbsolute: (value: string) => boolean = path.isAbsolute): string | null {
  if (!directory.trim()) return 'No Google Drive folder is selected. Choose the folder Google Drive for desktop keeps on this computer.';
  if (!isAbsolute(directory)) return `${directory} is not a full folder path on this computer. Choose the folder Google Drive for desktop keeps here.`;
  try { if (fs.statSync(directory).isDirectory()) return null; } catch { /* Below. */ }
  return `${directory} was not found. Start Google Drive for desktop, or choose the folder it keeps on this computer.`;
}

/** Pairs compared before, kept beside the local notes: by Drive project folder, then note id, "size here:size on Drive". */
export const COMPARED_FILE = '.drive-compared.json';
const comparedSchema = z.record(z.string(), z.record(z.string(), z.string().regex(/^\d+:\d+$/)));
const CONFLICT = 'A Drive note has conflicting contents. No notes were overwritten. Review that file before syncing.';
const hash = (note: MemoryNote) => createHash('sha256').update(JSON.stringify(note)).digest('hex');

/**
 * Google Drive for desktop owns authentication and cloud transport. Only curated notes sync. Everything that touches
 * the Drive folder runs without holding the main process: Drive answers each file in about half a millisecond and
 * downloads files it has not cached, so reading a project's notes there froze the window and terminals for seconds.
 */
export class DriveMirror {
  constructor(private local: MemoryService, private preferences: () => HubPreferences) {}
  status(): DriveStatus { const p = this.preferences(); const problem = driveFolderProblem(p.driveDirectory); return { connected: !problem, clientConfigured: !!p.driveDirectory, persistent: true, folderId: p.folderId, problem }; }
  /** The Drive copy of the notes. Offline or misplaced folders throw; local notes stay usable. */
  private async mirror(): Promise<MemoryService> {
    const problem = this.status().problem;
    if (problem) throw new HubError('DRIVE_OFFLINE', `${problem} Local handoffs remain available.`);
    const root = path.join(await fs.promises.realpath(this.preferences().driveDirectory), 'AI-Coding-Hub-Memory');
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    if (await fs.promises.realpath(root) === await fs.promises.realpath(this.local.root)) throw new HubError('DRIVE_PATH', 'Choose a shared folder outside the local memory folder.');
    // Made once per folder: its constructor checks the folder synchronously.
    let mirror = this.mirrors.get(root); if (!mirror) this.mirrors.set(root, mirror = new MemoryService(root));
    return mirror;
  }
  private mirrors = new Map<string, MemoryService>();
  /** Whether Drive has a folder for this project, or null when Drive cannot be read (not mounted yet, say). */
  async hasProject(project: string): Promise<boolean | null> {
    let mirror: MemoryService; try { mirror = await this.mirror(); } catch { return null; }
    try { return (await fs.promises.stat(await mirror.directoryLater(project))).isDirectory(); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null; }
  }
  async conflicts(project: string): Promise<MemoryConflict[]> {
    const mirror = await this.mirror(); const [mine, theirs] = await Promise.all([this.local.listLater(project), mirror.listLater(project)]);
    const local = new Map(mine.map((note) => [note.id, note]));
    return theirs.filter((note) => local.has(note.id) && hash(local.get(note.id)!) !== hash(note)).map((remote) => ({ id: remote.id, local: local.get(remote.id)!, remote, localHash: hash(local.get(remote.id)!), remoteHash: hash(remote) }));
  }
  /** Keeps both versions of a conflicting note. Waits for a sync of the project that is running. */
  resolve(project: string, id: string, localHash: string, remoteHash: string): Promise<void> {
    return this.exclusive(project, async () => {
      const conflict = (await this.conflicts(project)).find((item) => item.id === id);
      if (!conflict || conflict.localHash !== localHash || conflict.remoteHash !== remoteHash) throw new HubError('MEMORY_CHANGED', 'Conflict changed. Refresh before resolving.');
      const mirror = await this.mirror(); const file = path.join(mirror.directory(project), id + '.json');
      if (fs.lstatSync(file).isSymbolicLink()) throw new HubError('MEMORY_PATH', 'Conflict file cannot be a link.');
      const before = fs.readFileSync(file, 'utf8');
      if (hash(noteSchema.parse(JSON.parse(before)) as MemoryNote) !== remoteHash) throw new HubError('MEMORY_CHANGED', 'Drive conflict changed. Refresh before resolving.');
      // Both content versions remain: the original local ID plus a new remote-version ID.
      const preserved: MemoryNote = { ...conflict.remote, id: randomUUID(), title: ('Drive conflict: ' + conflict.remote.title).slice(0, 200), supersedes: id };
      this.local.import(preserved); const { failure } = await mirror.importLater(project, [preserved]); if (failure) throw failure;
      fs.writeFileSync(file + '.conflict-backup-' + randomUUID(), before, { flag: 'wx', mode: 0o600 });
      const temporary = file + '.tmp-' + randomUUID();
      try {
        fs.writeFileSync(temporary, JSON.stringify(conflict.local, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        const currentLocal = this.local.note(project, id);
        if (!currentLocal || hash(currentLocal) !== localHash || fs.readFileSync(file, 'utf8') !== before) throw new HubError('MEMORY_CHANGED', 'Drive file changed during resolution. Both versions remain preserved; refresh.');
        fs.renameSync(temporary, file);
      } finally { try { fs.unlinkSync(temporary); } catch { /* Already renamed. */ } }
    });
  }
  /** Each project's work, one job at a time: a sync and a resolution never touch the same folder together. */
  private queues = new Map<string, Promise<void>>();
  private exclusive<T>(project: string, job: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(project) ?? Promise.resolve()).then(job, job);
    const done = next.then(() => {}, () => {}); this.queues.set(project, done);
    void done.then(() => { if (this.queues.get(project) === done) this.queues.delete(project); });
    return next;
  }
  /** A sync waiting for its project's running one: later requests join it, as it reads both folders after they were made. */
  private waiting = new Map<string, Promise<{ uploaded: number; downloaded: number }>>();
  /**
   * Syncs one project's notes with Drive, without holding the process. A request while one runs waits for it and then
   * runs once more (joined by any other request in that time), so a note written meanwhile is not left for the next tick.
   */
  syncLater(project: string): Promise<{ uploaded: number; downloaded: number }> {
    const waiting = this.waiting.get(project); if (waiting) return waiting;
    const run = this.exclusive(project, () => { this.waiting.delete(project); return this.run(project); });
    this.waiting.set(project, run); return run;
  }
  /** Pairs already compared and found the same, read once from COMPARED_FILE and kept up to date in it. */
  private comparing: Promise<Map<string, Map<string, string>>> | null = null;
  private compared() {
    return this.comparing ??= fs.promises.readFile(path.join(this.local.root, COMPARED_FILE), 'utf8')
      .then((text) => new Map(Object.entries(comparedSchema.parse(JSON.parse(text))).map(([folder, pairs]) => [folder, new Map(Object.entries(pairs))])))
      .catch(() => new Map<string, Map<string, string>>()); // Missing or unreadable: compared again once.
  }
  private saving: Promise<void> = Promise.resolve();
  /** Written beside the notes (temporary file, then renamed), one write at a time. Only a cache: a failed write is compared again next start. */
  private saveCompared(all: Map<string, Map<string, string>>) {
    this.saving = this.saving.then(async () => {
      const file = path.join(this.local.root, COMPARED_FILE); const temporary = path.join(this.local.root, `.${randomUUID()}.tmp`);
      const text = JSON.stringify(Object.fromEntries([...all].map(([folder, pairs]) => [folder, Object.fromEntries(pairs)])));
      try { await fs.promises.writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await fs.promises.rename(temporary, file); }
      catch { /* Compared again after the next start. */ }
      finally { await fs.promises.unlink(temporary).catch(() => { /* Renamed. */ }); }
    });
    return this.saving;
  }
  private async run(project: string) {
    const mirror = await this.mirror();
    const [here, there] = await Promise.all([this.local.listing(project), mirror.listing(project)]);
    // Notes are immutable files named by their id, so a note with the same size on both sides is the same note, and
    // is not read. A note whose sizes differ (another program rewrote its line endings, say) is read once on each
    // side; when the two hold the same note, the pair of sizes is kept in COMPARED_FILE so it is never read again.
    const all = await this.compared(); const folder = path.join(mirror.root, project); const known = all.get(folder) ?? new Map<string, string>();
    const same = new Map<string, string>(); const differ: string[] = [];
    // A note either computer archived (moved aside when the project was full) is neither compared nor copied again.
    for (const [id, size] of here.sizes) {
      const other = there.sizes.get(id); if (other === undefined || other === size || here.archived.has(id) || there.archived.has(id)) continue;
      if (known.get(id) === `${size}:${other}`) same.set(id, `${size}:${other}`); else differ.push(id);
    }
    // One unreadable or conflicting file must not stop every other note from syncing; neither is ever overwritten.
    let conflict: HubError | null = null; let failure: unknown = null;
    if (differ.length) {
      const [locals, remotes] = await Promise.all([this.local.notesLater(project, differ), mirror.notesLater(project, differ)]);
      for (const id of differ) {
        const local = locals.get(id); const remote = remotes.get(id);
        if (local && remote) { if (JSON.stringify(local) === JSON.stringify(remote)) same.set(id, `${here.sizes.get(id)}:${there.sizes.get(id)}`); else conflict ??= new HubError('MEMORY_CONFLICT', CONFLICT); }
        // One copy cannot be read (truncated, half-synced): both files stay, and it is reported after the rest has synced.
        else if (local || remote) failure ??= new HubError('MEMORY_CONFLICT', 'A remote handoff conflicts with a local ID. Both files were preserved; inspect the remote note before importing.');
      }
    }
    if (same.size !== known.size || [...same].some(([id, pair]) => known.get(id) !== pair)) { if (same.size) all.set(folder, same); else all.delete(folder); await this.saveCompared(all); }
    const copy = async (from: MemoryService, to: MemoryService, ids: string[]) => {
      if (!ids.length) return 0;
      try { const notes = [...(await from.notesLater(project, ids)).values()].filter((note): note is MemoryNote => note !== null); const { imported, failure: failed } = await to.importLater(project, notes); failure ??= failed; return imported; }
      catch (error) { failure ??= error; return 0; }
    };
    const downloaded = await copy(mirror, this.local, [...there.sizes.keys()].filter((id) => !here.sizes.has(id) && !there.archived.has(id)));
    const uploaded = await copy(this.local, mirror, [...here.sizes.keys()].filter((id) => !there.sizes.has(id) && !here.archived.has(id)));
    if (conflict ?? failure) throw conflict ?? failure;
    return { uploaded, downloaded };
  }
}
