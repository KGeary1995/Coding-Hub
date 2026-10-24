import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ManagedWorktree, ProjectToolsResponse } from '../../../shared/project-tools';
import { HubError } from '../cli/engine-adapter';
const recordSchema = z.object({ id: z.uuid(), repository: z.string(), directory: z.string(), branch: z.string(), createdAt: z.string() }).strict();
const requestSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('worktree-list') }).strict(), z.object({ action: z.literal('worktree-create'), directory: z.string().min(1).max(4096).refine((v) => path.isAbsolute(v) && !v.includes('\0')) }).strict(), z.object({ action: z.literal('worktree-remove'), id: z.uuid() }).strict()]);
function git(directory: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['-c', 'core.hooksPath=', ...args], { cwd: directory, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(new HubError('WORKTREE_GIT_FAILED', 'Git could not complete the worktree operation. Check that the repository has a commit, is unlocked, and has no unsaved changes before removal.')) : resolve(stdout.trim())));
}
export class WorktreeService {
  private busy = false;
  get active() { return this.busy; }
  private file: string;
  private root: string;
  constructor(storage: string, private inUse: (directory: string) => boolean) { this.file = path.join(storage, 'worktrees.json'); this.root = path.join(storage, 'worktrees'); }
  list(): ManagedWorktree[] {
    if (!fs.existsSync(this.file)) return [];
    try { return z.array(recordSchema).max(100).parse(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { throw new HubError('WORKTREE_STORAGE', 'Worktree records are unreadable. The existing file was preserved.'); }
  }
  private save(records: ManagedWorktree[]) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const temporary = this.file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(records, null, 2), { mode: 0o600 }); fs.renameSync(temporary, this.file); }
  async execute(input: unknown): Promise<ProjectToolsResponse> {
    const parsed = requestSchema.safeParse(input); if (!parsed.success) throw new HubError('INVALID_WORKTREE_REQUEST', 'Invalid worktree request.');
    const request = parsed.data; if (request.action === 'worktree-list') return this.list();
    if (this.busy) throw new HubError('WORKTREE_BUSY', 'A worktree operation is already in progress.');
    this.busy = true;
    try {
      const records = this.list();
      if (request.action === 'worktree-create') {
        if (records.length >= 100) throw new HubError('WORKTREE_LIMIT', 'Remove unused worktrees before creating more.');
        const selected = fs.realpathSync(request.directory);
        const repository = await git(selected, ['rev-parse', '--show-toplevel']);
        await git(repository, ['rev-parse', '--verify', 'HEAD']);
        fs.mkdirSync(this.root, { recursive: true });
        const id = randomUUID(); const directory = path.join(fs.realpathSync(this.root), id); const branch = `coding-hub/${id}`;
        const record = { id, repository, directory, branch, createdAt: new Date().toISOString() };
        await git(repository, ['worktree', 'add', '-b', branch, directory, 'HEAD']);
        try { this.save([...records, record]); }
        catch { throw new HubError('WORKTREE_STORAGE', `Worktree created at ${directory}, but its record could not be saved. It remains intact; use git worktree list to locate it.`); }
        return record;
      }
      const record = records.find((item) => item.id === request.id);
      // Records restored from a backup keep their original storage folder (worktrees are not copied).
      let root = this.root; try { root = fs.realpathSync(root); } catch { /* No worktrees created in this storage yet. */ }
      const managedLocation = record && (path.dirname(record.directory) === root || (path.basename(record.directory) === record.id && path.basename(path.dirname(record.directory)) === 'worktrees'));
      if (!record || !managedLocation) throw new HubError('UNKNOWN_WORKTREE', 'This worktree is not managed by Trace.');
      if (this.inUse(record.directory)) throw new HubError('WORKTREE_IN_USE', 'Unbind all session panels from this worktree before removing it.');
      // Removed outside the app (terminal, agent, restore elsewhere): let Git forget it and drop the record.
      if (!fs.existsSync(record.directory)) {
        if (fs.existsSync(record.repository)) { try { await git(record.repository, ['worktree', 'prune']); } catch { /* The record is still stale. */ } }
        this.save(records.filter((item) => item.id !== record.id)); return null;
      }
      const directory = fs.realpathSync(record.directory);
      if (directory !== record.directory) throw new HubError('WORKTREE_PATH', 'Worktree path changed. Inspect it before removal.');
      // `git worktree remove` deletes ignored files (.env, local databases, build output), so they count as changes.
      // `normal` collapses ignored folders (`!! node_modules/`) so large ones stay within the output limit; it is
      // explicit because `status.showUntrackedFiles=no` would otherwise hide untracked files that removal deletes.
      if (await git(directory, ['status', '--porcelain', '--ignored', '--untracked-files=normal'])) throw new HubError('WORKTREE_DIRTY', 'This worktree has changes or ignored files (for example .env or build output). Review and preserve them before removal.');
      await git(record.repository, ['worktree', 'remove', record.directory]);
      this.save(records.filter((item) => item.id !== record.id));
      return null;
    } finally { this.busy = false; }
  }
}
