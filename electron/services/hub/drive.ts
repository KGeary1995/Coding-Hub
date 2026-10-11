import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DriveStatus, HubPreferences, MemoryConflict, MemoryNote } from '../../../shared/hub';
import { MemoryService, noteSchema } from './memory';
import { HubError } from '../cli/engine-adapter';

/** Google Drive for desktop owns authentication and cloud transport. Only curated notes sync. */
export class DriveMirror {
  private syncing = false;
  constructor(private local: MemoryService, private preferences: () => HubPreferences) {}
  status(): DriveStatus { const p = this.preferences(); let connected = false; try { connected = path.isAbsolute(p.driveDirectory) && fs.statSync(p.driveDirectory).isDirectory(); } catch { /* Drive offline or not mounted. */ } return { connected, clientConfigured: !!p.driveDirectory, persistent: true, folderId: p.folderId }; }
  private mirror(): MemoryService {
    if (!this.status().connected) throw new HubError('DRIVE_OFFLINE', 'Drive folder is unavailable. Local handoffs remain available.');
    const mirror = new MemoryService(path.join(fs.realpathSync(this.preferences().driveDirectory), 'AI-Coding-Hub-Memory'));
    if (fs.realpathSync(mirror.root) === fs.realpathSync(this.local.root)) throw new HubError('DRIVE_PATH', 'Choose a folder outside local memory.');
    return mirror;
  }
  conflicts(project: string): MemoryConflict[] {
    const mirror = this.mirror(); const local = new Map(this.local.list(project).map((note) => [note.id, note]));
    const hash = (note: MemoryNote) => createHash('sha256').update(JSON.stringify(note)).digest('hex');
    return mirror.list(project).filter((note) => local.has(note.id) && hash(local.get(note.id)!) !== hash(note)).map((remote) => ({ id: remote.id, local: local.get(remote.id)!, remote, localHash: hash(local.get(remote.id)!), remoteHash: hash(remote) }));
  }
  resolve(project: string, id: string, localHash: string, remoteHash: string) {
    if (this.syncing) throw new HubError('DRIVE_BUSY', 'Sync is already running.');
    const conflict = this.conflicts(project).find((item) => item.id === id);
    if (!conflict || conflict.localHash !== localHash || conflict.remoteHash !== remoteHash) throw new HubError('MEMORY_CHANGED', 'Conflict changed. Refresh before resolving.');
    const mirror = this.mirror(); const file = path.join(mirror.directory(project), id + '.json');
    if (fs.lstatSync(file).isSymbolicLink()) throw new HubError('MEMORY_PATH', 'Conflict file cannot be a link.');
    const before = fs.readFileSync(file, 'utf8');
    if (createHash('sha256').update(JSON.stringify(noteSchema.parse(JSON.parse(before)))).digest('hex') !== remoteHash) throw new HubError('MEMORY_CHANGED', 'Drive conflict changed. Refresh before resolving.');
    // Both content versions remain: the original local ID plus a new remote-version ID.
    const preserved: MemoryNote = { ...conflict.remote, id: randomUUID(), title: ('Drive conflict: ' + conflict.remote.title).slice(0, 200), supersedes: id };
    this.local.import(preserved); mirror.import(preserved);
    fs.writeFileSync(file + '.conflict-backup-' + randomUUID(), before, { flag: 'wx', mode: 0o600 });
    const temporary = file + '.tmp-' + randomUUID();
    try {
      fs.writeFileSync(temporary, JSON.stringify(conflict.local, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const currentLocal = this.local.list(project).find((note) => note.id === id);
      if (!currentLocal || createHash('sha256').update(JSON.stringify(currentLocal)).digest('hex') !== localHash || fs.readFileSync(file, 'utf8') !== before) throw new HubError('MEMORY_CHANGED', 'Drive file changed during resolution. Both versions remain preserved; refresh.');
      fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch { /* Already renamed. */ } }
  }
  sync(project: string) {
    if (this.syncing) throw new HubError('DRIVE_BUSY', 'A memory sync is already in progress.');
    if (!this.status().connected) throw new HubError('DRIVE_OFFLINE', 'The Drive folder is unavailable. Start Google Drive for desktop or choose its local folder. Local handoffs remain available.');
    this.syncing = true;
    try {
      const root = fs.realpathSync(this.preferences().driveDirectory);
      const mirror = new MemoryService(path.join(root, 'AI-Coding-Hub-Memory'));
      if (fs.realpathSync(mirror.root) === fs.realpathSync(this.local.root)) throw new HubError('DRIVE_PATH', 'Choose a shared folder outside the local memory directory.');
      // Preflight conflicts before writing either side. Immutable notes make retries idempotent.
      const local = this.local.list(project); const remote = mirror.list(project); const known = new Map(local.map((n) => [n.id, n]));
      for (const note of remote) if (known.has(note.id) && JSON.stringify(known.get(note.id)) !== JSON.stringify(note)) throw new HubError('MEMORY_CONFLICT', 'A Drive note has conflicting contents. No notes were overwritten. Review that file before syncing.');
      let uploaded = 0; let downloaded = 0;
      for (const note of remote) if (this.local.import(note)) downloaded++;
      for (const note of local) if (mirror.import(note)) uploaded++;
      return { uploaded, downloaded };
    } finally { this.syncing = false; }
  }
}
