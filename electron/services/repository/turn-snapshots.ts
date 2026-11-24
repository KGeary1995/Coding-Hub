import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UndoResult, UndoStatus } from '../../../shared/undo';
import { HubError } from '../cli/engine-adapter';
import { hostEnvironment } from '../cli/discovery';
import { readOnlyGitOptions } from './git-safety';
import { execFileTree, type TreeError } from './process-tree';

/** Snapshots kept for each channel; older ones are let go (their files can then no longer be put back). */
export const SNAPSHOT_KEEP = 20;
/** More new (untracked, not ignored) bytes than this and no snapshot is taken: each would add them to the repository's objects. */
const NEW_BYTES_LIMIT = 200 * 1024 * 1024;
/** A turn's last file writes land within this after its end is reported; turns ending close together make one snapshot. */
const SETTLE_MS = 1500;
/** A terminal that printed within this is taken to be working (a spinner, a reply): Undo waits for it. */
const QUIET_MS = 2500;
const NOT_GIT = 'Undo last turn needs a Git repository. This folder is not one, so Trace keeps no copies of its files.';

/** A channel as the host lists it (main.ts workspaceChannels). */
export interface SnapshotChannel { id: string; engine: string; seatedAt?: string }
/** Which channels get snapshots: every agent (Claude Code, Codex, Gemini), never a shell; a Round Table's seat counts as its lead's. */
export const snapshotsFor = (channel: SnapshotChannel) => channel.engine !== 'shell' && !channel.seatedAt;
const prefix = (sessionId: string) => `refs/trace/snapshots/${sessionId}`;
const redoRef = (sessionId: string) => `refs/trace/redo/${sessionId}`;
const unavailable = (sessionId: string, reason = NOT_GIT): UndoStatus => ({ sessionId, available: false, canUndo: false, canRedo: false, reason });

interface Entry { n: number; ref: string; commit: string; tree: string }
/** One repository: its top folder, the options that keep its own config from running programs, and the empty tree (attributes source). */
interface Repo { root: string; safe: string[]; attr?: string }

/**
 * Git for snapshots: never the person's index (GIT_INDEX_FILE is a temporary one, or none), never a repository the
 * environment names, no prompts, and no line-ending or attribute conversions, so files come back byte for byte.
 */
async function run(repo: Repo, args: string[], index?: string): Promise<string> {
  const env: Record<string, string> = { ...hostEnvironment(), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_AUTHOR_NAME: 'Trace', GIT_AUTHOR_EMAIL: 'trace@localhost', GIT_COMMITTER_NAME: 'Trace', GIT_COMMITTER_EMAIL: 'trace@localhost' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|ATTR_SOURCE)$/i.test(key)) delete env[key];
  if (index) env.GIT_INDEX_FILE = index; if (repo.attr) env.GIT_ATTR_SOURCE = repo.attr;
  try { return (await execFileTree('git', ['--no-pager', ...repo.safe, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], { cwd: repo.root, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout.toString('utf8'); }
  catch (error) {
    if ((error as TreeError).code === 'ENOENT') throw new HubError('GIT_NOT_FOUND', 'Git was not found on PATH. Install Git and restart Trace.');
    throw new HubError('UNDO_GIT_FAILED', 'Trace could not copy or put back this project’s files. Close programs that may hold them open, then try again.');
  }
}

/** The repository's top folder, or null when the folder is not in a Git repository. */
export async function snapshotRoot(folder: string): Promise<string | null> {
  try {
    const safe = await readOnlyGitOptions(folder);
    const top = (await execFileTree('git', [...safe, '-C', folder, 'rev-parse', '--show-toplevel'], { timeout: 8000, maxBuffer: 65536, windowsHide: true, env: { ...hostEnvironment(), GIT_TERMINAL_PROMPT: '0' } })).stdout.toString('utf8').trim();
    return top ? await fs.promises.realpath(top) : null;
  } catch { return null; }
}

/** A temporary index for `work`, started from a copy of the person's (its file stats spare rereading every file) or empty. */
async function withIndex<T>(repo: Repo, copy: boolean, work: (index: string) => Promise<T>): Promise<T> {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trace-undo-')); const index = path.join(folder, 'index');
  try {
    if (copy) { const real = path.resolve(repo.root, (await run(repo, ['rev-parse', '--git-path', 'index'])).trim()); await fs.promises.copyFile(real, index).catch(() => { /* No commits or files yet: an empty index. */ }); }
    return await work(index);
  } finally { await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
}

async function open(root: string): Promise<Repo> {
  const repo: Repo = { root, safe: await readOnlyGitOptions(root) };
  // The empty tree as the attributes source: .gitattributes cannot pick filters or line-ending changes (Git 2.40+; older Git ignores it).
  repo.attr = (await withIndex(repo, false, (index) => run(repo, ['write-tree'], index))).trim();
  return repo;
}

/** The tree of every file in the working tree that Git does not ignore, written without touching the person's index. */
async function currentTree(repo: Repo): Promise<string> {
  const attempt = (copy: boolean) => withIndex(repo, copy, async (index) => {
    const added = (await run(repo, ['ls-files', '-z', '--others', '--exclude-standard'], index)).split('\0').filter(Boolean); let bytes = 0;
    for (const name of added) {
      bytes += await fs.promises.lstat(path.join(repo.root, name)).then((stat) => stat.isFile() ? stat.size : 0, () => 0);
      if (bytes > NEW_BYTES_LIMIT) throw new HubError('UNDO_TOO_LARGE', 'This project has over 200 MB of new files that .gitignore does not list, so Trace keeps no copies for Undo last turn. Add large files to .gitignore to turn it back on.');
    }
    await run(repo, ['add', '-A', '--', '.'], index);
    return (await run(repo, ['write-tree'], index)).trim();
  });
  // A copied index Git cannot use from another place (a split index): the same from an empty one, only slower.
  try { return await attempt(true); } catch (error) { if (error instanceof HubError && error.code === 'UNDO_GIT_FAILED') return attempt(false); throw error; }
}

async function commit(repo: Repo, tree: string) {
  const head = await run(repo, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']).then((out) => out.trim(), () => '');
  return (await run(repo, ['commit-tree', '--no-gpg-sign', ...(head ? ['-p', head] : []), '-m', 'Trace snapshot for Undo last turn', tree])).trim();
}
async function entries(repo: Repo, sessionId: string): Promise<Entry[]> {
  const out = await run(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(tree)', prefix(sessionId)]);
  return out.split('\n').map((line) => line.replace(/\r$/, '').split('\0')).filter((fields) => fields.length === 3)
    .map(([ref, sha, tree]) => ({ ref, commit: sha, tree, n: Number(ref.slice(ref.lastIndexOf('/') + 1)) })).filter((entry) => Number.isInteger(entry.n)).sort((a, b) => a.n - b.n);
}
const redoCommit = (repo: Repo, sessionId: string) => run(repo, ['rev-parse', '-q', '--verify', `${redoRef(sessionId)}^{commit}`]).then((out) => out.trim() || null, () => null);

/** The files that differ between two trees: to delete (not in `to`) and to write. Submodules are left as they are. */
async function changes(repo: Repo, from: string, to: string) {
  const fields = (await run(repo, ['diff-tree', '-r', '-z', '--no-renames', from, to])).split('\0'); const remove: string[] = []; const write: string[] = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([ADMT])$/.exec(fields[at]); if (!match) throw new HubError('UNDO_GIT_FAILED', 'Git listed the project’s changes in a form Trace does not know. Update Git, then try again.');
    const [, before, after, status] = match; const name = fields[at + 1];
    if (before !== '000000' && before !== '160000' && (status === 'D' || after === '160000')) remove.push(name);
    if (status !== 'D' && after !== '160000') write.push(name);
  }
  return { remove, write, count: new Set([...remove, ...write]).size };
}

/** Paths in groups short enough for one Windows command line. */
function groups(names: string[], limit = 6000) {
  const result: string[][] = []; let group: string[] = []; let length = 0;
  for (const name of names) { if (group.length && length + name.length > limit) { result.push(group); group = []; length = 0; } group.push(name); length += name.length + 3; }
  if (group.length) result.push(group); return result;
}

/** Makes the working tree match `to` where it differs from `from`: deletes what `to` lacks, writes the rest. Ignored files and .git are never touched. */
async function restoreFiles(repo: Repo, from: string, to: string) {
  const { remove, write, count } = await changes(repo, from, to);
  for (const name of remove) {
    const file = path.resolve(repo.root, name); if (path.relative(repo.root, file).startsWith('..')) continue;
    const stat = await fs.promises.lstat(file).catch(() => null); if (stat && !stat.isDirectory()) await fs.promises.rm(file, { force: true });
    // Folders left empty go too, as Git's own checkout does; rmdir removes only empty ones.
    for (let folder = path.dirname(file); folder.length > repo.root.length && folder.startsWith(repo.root); folder = path.dirname(folder)) { try { await fs.promises.rmdir(folder); } catch { break; } }
  }
  if (write.length) await withIndex(repo, false, async (index) => {
    await run(repo, ['read-tree', to], index);
    for (const group of groups(write)) await run(repo, ['checkout-index', '-f', '--', ...group], index);
  });
  return count;
}

interface Deps { publish(status: UndoStatus): void; settleMs?: number }

/**
 * Undo last turn (1.39.0). Before each agent turn, Trace keeps the project's files as a commit object under
 * refs/trace/snapshots/<channel>/<n>: written through a temporary index, so the person's index, HEAD, branches and
 * stash never change, and ignored files are never copied. A snapshot is taken when the channel starts and after each
 * turn ends (what the files are "before the next turn"), and skipped when nothing changed. Undo puts back the files of
 * the snapshot before the last turn, keeping what they were for one Redo. One Git job at a time per repository.
 */
export class TurnSnapshots {
  private queues = new Map<string, Promise<unknown>>(); private timers = new Map<string, ReturnType<typeof setTimeout>>(); private active = 0;
  private lastOutput = new Map<string, number>(); private working = new Set<string>();
  constructor(private deps: Deps) {}
  /** A snapshot, undo or redo is under way (updates and backups wait for it). */
  get running() { return this.active > 0; }

  private serial<T>(root: string, job: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(root) ?? Promise.resolve()).catch(() => {}).then(async () => { this.active++; try { return await job(); } finally { this.active--; } });
    this.queues.set(root, next.catch(() => {})); return next;
  }
  private async rootOf(channel: SnapshotChannel, folder: string) {
    if (!snapshotsFor(channel)) throw new HubError('UNDO_NOT_AGENT', 'Undo last turn is for agent channels.');
    const root = await snapshotRoot(folder); if (!root) throw new HubError('UNDO_NOT_GIT', NOT_GIT); return root;
  }

  /** An agent channel started, or its turn's files settled: its files now are what the next turn starts from. */
  async started(channel: SnapshotChannel, folder: string) {
    if (!snapshotsFor(channel)) return;
    const root = await snapshotRoot(folder); if (!root) { this.deps.publish(unavailable(channel.id)); return; }
    await this.serial(root, () => this.record(root, channel.id)).catch((error: unknown) => { if (error instanceof HubError && error.code === 'UNDO_TOO_LARGE') this.deps.publish(unavailable(channel.id, error.message)); else throw error; });
  }
  /** A turn ended: a snapshot once its last writes have landed (a later end in the same channel replaces this one). */
  turnEnded(channel: SnapshotChannel, folder: string): Promise<void> {
    if (!snapshotsFor(channel)) return Promise.resolve();
    clearTimeout(this.timers.get(channel.id));
    return new Promise((resolve, reject) => { this.timers.set(channel.id, setTimeout(() => { this.timers.delete(channel.id); this.started(channel, folder).then(resolve, reject); }, this.deps.settleMs ?? SETTLE_MS)); });
  }
  private async record(root: string, sessionId: string) {
    const repo = await open(root); const tree = await currentTree(repo); const list = await entries(repo, sessionId); const last = list.at(-1);
    if (last?.tree !== tree) {
      await run(repo, ['update-ref', `${prefix(sessionId)}/${(last?.n ?? 0) + 1}`, await commit(repo, tree)]);
      // Files changed since an undo: taking it back now would lose them.
      await run(repo, ['update-ref', '-d', redoRef(sessionId)]).catch(() => {});
      for (const old of list.slice(0, Math.max(0, list.length + 1 - SNAPSHOT_KEEP))) await run(repo, ['update-ref', '-d', old.ref]);
    }
    this.deps.publish(await this.statusOf(repo, sessionId));
  }
  private async statusOf(repo: Repo, sessionId: string): Promise<UndoStatus> {
    return { sessionId, available: true, canUndo: (await entries(repo, sessionId)).length >= 2, canRedo: Boolean(await redoCommit(repo, sessionId)) };
  }
  async status(channel: SnapshotChannel, folder: string): Promise<UndoStatus> {
    if (!snapshotsFor(channel)) return unavailable(channel.id, 'Undo last turn is for agent channels.');
    const root = await snapshotRoot(folder); if (!root) return unavailable(channel.id);
    return this.serial(root, async () => this.statusOf(await open(root), channel.id));
  }

  /** Where Undo or Redo puts the files: the tree now, the snapshot it restores, and for Undo the snapshot it then lets go. */
  private async plan(repo: Repo, sessionId: string, redo: boolean) {
    const now = await currentTree(repo);
    if (redo) {
      const sha = await redoCommit(repo, sessionId); if (!sha) throw new HubError('REDO_NOTHING', 'There is nothing to redo. Files changed after the undo, or it was already taken back.');
      return { now, target: { commit: sha, tree: (await run(repo, ['rev-parse', `${sha}^{tree}`])).trim() }, drop: null };
    }
    const list = await entries(repo, sessionId); const last = list.at(-1);
    // Files changed after the last snapshot (a turn whose end has not settled yet): that snapshot is how they were before it.
    if (last && last.tree !== now) return { now, target: last, drop: null };
    const before = list.at(-2); if (!before) throw new HubError('UNDO_NOTHING', 'There is nothing to undo yet. No turn of this channel has changed files.');
    return { now, target: before, drop: last! };
  }
  /** How many files Undo (or Redo) would change, and the repository's top folder. */
  async preview(channel: SnapshotChannel, folder: string, redo = false): Promise<{ root: string; files: number }> {
    const root = await this.rootOf(channel, folder);
    return this.serial(root, async () => { const repo = await open(root); const plan = await this.plan(repo, channel.id, redo); return { root, files: (await changes(repo, plan.now, plan.target.tree)).count }; });
  }
  /** Undo: the files as they were before the channel's last turn, keeping the current ones for Redo. Redo: those back. */
  async restore(channel: SnapshotChannel, folder: string, redo = false): Promise<UndoResult> {
    const root = await this.rootOf(channel, folder);
    return this.serial(root, async () => {
      const repo = await open(root); const plan = await this.plan(repo, channel.id, redo);
      // Kept before a single file changes, so a restore stopped halfway can still be taken back.
      if (!redo) await run(repo, ['update-ref', redoRef(channel.id), await commit(repo, plan.now)]);
      const files = await restoreFiles(repo, plan.now, plan.target.tree);
      if (plan.drop) await run(repo, ['update-ref', '-d', plan.drop.ref]);
      if (redo) {
        await run(repo, ['update-ref', '-d', redoRef(channel.id)]);
        const last = (await entries(repo, channel.id)).at(-1); if (last?.tree !== plan.target.tree) await run(repo, ['update-ref', `${prefix(channel.id)}/${(last?.n ?? 0) + 1}`, plan.target.commit]);
      }
      const status = await this.statusOf(repo, channel.id); this.deps.publish(status); return { files, status };
    });
  }

  /** A terminal's output, approval questions and turn ends: what tells whether its agent is mid-turn. */
  activity(event: { type: string; sessionId: string }) {
    if (event.type === 'data') this.lastOutput.set(event.sessionId, Date.now());
    else if (event.type === 'attention') this.working.add(event.sessionId);
    else if (event.type === 'answered' || event.type === 'started' || event.type === 'exit') { this.working.delete(event.sessionId); if (event.type === 'exit') this.lastOutput.delete(event.sessionId); }
  }
  /** A chat's messages: busy from the person's message until the reply is done. */
  chatActivity(sessionId: string, type: string) { if (type === 'user' || type === 'permission') this.working.add(sessionId); else if (type === 'done' || type === 'settled') this.working.delete(sessionId); }
  /** Whether the channel's agent is mid-turn: answering, asking for approval, or its terminal printed just now. */
  busy(sessionId: string) { return this.working.has(sessionId) || Date.now() - (this.lastOutput.get(sessionId) ?? 0) < QUIET_MS; }
}
