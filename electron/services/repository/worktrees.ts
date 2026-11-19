import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ManagedWorktree, ProjectToolsResponse } from '../../../shared/project-tools';
import { HubError } from '../cli/engine-adapter';
import { noHookGitOptions, readOnlyGitOptions } from './git-safety';
import { execFileTree } from './process-tree';
const recordSchema = z.object({ id: z.uuid(), repository: z.string(), directory: z.string(), branch: z.string(), createdAt: z.string() }).strict();
const requestSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('worktree-list') }).strict(), z.object({ action: z.literal('worktree-create'), directory: z.string().min(1).max(4096).refine((v) => path.isAbsolute(v) && !v.includes('\0')) }).strict(), z.object({ action: z.literal('worktree-remove'), id: z.uuid() }).strict()]);
/**
 * Reads use readOnlyGitOptions; `worktree add` checks files out, which needs the repository's filters (`checkout`).
 * A checkout of a large repository can take minutes; a time limit ends Git and everything it started (execFileTree).
 */
async function git(directory: string, args: string[], checkout = false): Promise<string> {
  const safe = checkout ? noHookGitOptions() : await readOnlyGitOptions(directory);
  try { return (await execFileTree('git', [...safe, ...args], { cwd: directory, timeout: checkout ? 300_000 : 30_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.toString('utf8').trim(); }
  catch { throw new HubError('WORKTREE_GIT_FAILED', 'Git could not complete the worktree operation. Check that the repository has a commit, is unlocked, and has no unsaved changes before removal.'); }
}
/**
 * Deletes Trace's worktree branches (`coding-hub/<id>`) in a repository that no worktree uses any more, but only those
 * already merged (`git branch -d`): a branch with commits that exist nowhere else is kept, so no work is lost.
 */
export async function pruneBranches(repository: string, keep: string[] = []) {
  let branches: string[]; let used: string;
  try { branches = (await git(repository, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/coding-hub/'])).split(/\r?\n/).filter(Boolean); used = await git(repository, ['worktree', 'list', '--porcelain']); } catch { return; }
  for (const branch of branches) {
    if (keep.includes(branch) || used.includes(`branch refs/heads/${branch}`)) continue;
    try { await git(repository, ['branch', '-d', branch], true); } catch { /* Not merged: kept. */ }
  }
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
  /** The branches of the other worktrees Trace manages, which pruning leaves alone. */
  private branches(records: ManagedWorktree[], removed: ManagedWorktree) { return records.filter((item) => item.id !== removed.id).map((item) => item.branch); }
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
        // Recorded first: a checkout that fails or times out can still leave a worktree and branch behind, which Trace
        // must then remove or at least list.
        try { this.save([...records, record]); } catch { throw new HubError('WORKTREE_STORAGE', 'Worktree records could not be saved, so no worktree was created. Check that Trace’s data folder is writable.'); }
        try { await git(repository, ['worktree', 'add', '-b', branch, directory, 'HEAD'], true); }
        catch (error) {
          // The new branch is at HEAD and nothing was done in the new folder yet, so forcing both away loses no work.
          let left = false;
          if (fs.existsSync(directory)) { try { await git(repository, ['worktree', 'remove', '--force', directory], true); } catch { left = true; } }
          try { await git(repository, ['worktree', 'prune']); if (await git(repository, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`])) await git(repository, ['branch', '-D', branch], true); } catch { left = true; }
          if (!left) this.save(records);
          throw left ? new HubError('WORKTREE_GIT_FAILED', `Git could not finish creating the worktree, and part of it is left at ${directory}. Remove it with git worktree remove --force in that repository, then remove it from the list here.`) : error;
        }
        return record;
      }
      const record = records.find((item) => item.id === request.id);
      // Records restored from a backup keep their original storage folder (worktrees are not copied).
      let root = this.root; try { root = fs.realpathSync(root); } catch { /* No worktrees created in this storage yet. */ }
      const managedLocation = record && (path.dirname(record.directory) === root || (path.basename(record.directory) === record.id && path.basename(path.dirname(record.directory)) === 'worktrees'));
      if (!record || !managedLocation) throw new HubError('UNKNOWN_WORKTREE', 'This worktree is not managed by Trace.');
      if (this.inUse(record.directory)) throw new HubError('WORKTREE_IN_USE', 'Unbind all channels from this worktree before removing it.');
      // Removed outside the app (terminal, agent, restore elsewhere): let Git forget it and drop the record.
      if (!fs.existsSync(record.directory)) {
        if (fs.existsSync(record.repository)) { try { await git(record.repository, ['worktree', 'prune']); } catch { /* The record is still stale. */ } }
        this.save(records.filter((item) => item.id !== record.id));
        if (fs.existsSync(record.repository)) await pruneBranches(record.repository, this.branches(records, record));
        return null;
      }
      const directory = fs.realpathSync(record.directory);
      if (directory !== record.directory) throw new HubError('WORKTREE_PATH', 'Worktree path changed. Inspect it before removal.');
      // `git worktree remove` deletes ignored files (.env, local databases, build output), so they count as changes.
      // `normal` collapses ignored folders (`!! node_modules/`) so large ones stay within the output limit; it is
      // explicit because `status.showUntrackedFiles=no` would otherwise hide untracked files that removal deletes.
      // Submodules are not looked into (their own filters would run); `git worktree remove` refuses one that has them.
      if (await git(directory, ['status', '--porcelain', '--ignored', '--untracked-files=normal', '--ignore-submodules=dirty'])) throw new HubError('WORKTREE_DIRTY', 'This worktree has changes or ignored files (for example .env or build output). Review and preserve them before removal.');
      // Commits made on a detached HEAD belong to no branch, and would be lost with the worktree.
      // `symbolic-ref` fails only on a detached HEAD; a branch with no commit yet (`checkout --orphan`) is not one.
      if (await git(directory, ['symbolic-ref', '-q', 'HEAD']).then(() => false, () => true)) {
        const head = await git(directory, ['rev-parse', 'HEAD']);
        if (!await git(record.repository, ['for-each-ref', '--count=1', '--format=%(refname)', `--contains=${head}`, 'refs/heads', 'refs/remotes', 'refs/tags'])) throw new HubError('WORKTREE_DIRTY', 'This worktree has commits on a detached HEAD that no branch holds. Create a branch for them before removal.');
      }
      await git(record.repository, ['worktree', 'remove', record.directory]);
      this.save(records.filter((item) => item.id !== record.id));
      await pruneBranches(record.repository, this.branches(records, record));
      return null;
    } finally { this.busy = false; }
  }
}
