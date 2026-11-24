import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { GitChange, GitCommit, GitCommitDetail, GitCommitFile, GitFileDiff, GitLog, GitRef, GitStatus } from '../../../shared/types';
import { gitCommitSchema, gitDiffSchema } from '../../../shared/schemas';
import { HubError } from '../cli/engine-adapter';
import { hostEnvironment } from '../cli/discovery';
import { readTextFile, RepositoryFiles, validateRelativePath } from './filesystem';
import { readOnlyGitOptions } from './git-safety';

const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;
const STATUS_ENTRY_LIMIT = 1000;
export const LOG_LIMIT = 200;
const COMMIT_FILE_LIMIT = 500;
/** A field per NUL, a commit per NUL (`-z`): names and subjects hold no NUL, so nothing in them can shift a field. */
const LOG_FORMAT = '--format=%H%x00%P%x00%aI%x00%an%x00%s';
/** What every history read passes: no signature checks (`log.showSignature` would run gpg), no colour, UTF-8 text. */
const HISTORY_OPTIONS = ['--no-show-signature', '--no-color', '--encoding=UTF-8'];
const DIFF_OPTIONS = ['--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-color'];

async function git(directory: string, args: string[]): Promise<Buffer> {
  const safe = await readOnlyGitOptions(directory);
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', '--no-optional-locks', ...safe, ...args], {
      cwd: directory, env: { ...hostEnvironment(), GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      encoding: 'buffer', windowsHide: true, timeout: 10000, maxBuffer: GIT_OUTPUT_LIMIT,
    }, (error, stdout) => {
      if (!error) { resolve(stdout); return; }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') reject(new HubError('GIT_NOT_FOUND', 'Git was not found on PATH. Install Git and restart Trace.'));
      else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new HubError('GIT_OUTPUT_LIMIT', 'This Git result exceeds the 2 MiB preview limit. Inspect it with your local Git tools.'));
      else reject(new HubError('GIT_FAILED', 'Git could not read this repository. Check repository access, Git trust settings, and whether it was moved.'));
    });
  });
}

/** NUL-delimited records preserve whitespace, Unicode, and renamed file paths. */
export function parseStatus(output: Buffer, root: string): GitStatus {
  const result: GitStatus = { root, branch: null, head: null, changes: [], limited: false };
  const records = output.toString('utf8').split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('# branch.oid ')) { const oid = record.slice(13); result.head = oid === '(initial)' ? null : oid; continue; }
    if (record.startsWith('# branch.head ')) { const branch = record.slice(14); result.branch = branch === '(detached)' ? null : branch; continue; }
    if (record.startsWith('# branch.upstream ')) { result.upstream = record.slice(18); continue; }
    if (record.startsWith('# branch.ab ')) { const counts = /^\+(\d+) -(\d+)$/.exec(record.slice(12)); if (counts) { result.ahead = Number(counts[1]); result.behind = Number(counts[2]); } continue; }
    let change: GitChange | null = null;
    if (record.startsWith('? ')) change = { path: record.slice(2), originalPath: null, indexStatus: '?', worktreeStatus: '?', untracked: true, conflicted: false, submodule: false };
    else if (/^[12u] /.test(record)) {
      const fields = record.split(' ');
      const kind = fields[0];
      const pathname = fields.slice(kind === '1' ? 8 : kind === '2' ? 9 : 10).join(' ');
      const xy = fields[1];
      change = { path: pathname, originalPath: kind === '2' ? records[++index] ?? null : null,
        indexStatus: xy[0] === '.' ? ' ' : xy[0], worktreeStatus: xy[1] === '.' ? ' ' : xy[1], untracked: false, conflicted: kind === 'u', submodule: fields[2] !== 'N...' };
    }
    if (change) {
      if (result.changes.length < STATUS_ENTRY_LIMIT) result.changes.push(change);
      else result.limited = true;
    }
  }
  return result;
}

interface RefLine { current: boolean; refname: string; target: string; upstream: string }
/** `for-each-ref` lines of `%(HEAD)`, refname, target (peeled for an annotated tag) and upstream, NUL between fields. */
export function parseRefs(output: Buffer): RefLine[] {
  return output.toString('utf8').split('\n').map((line) => line.split('\0')).filter((fields) => fields.length >= 5 && fields[1])
    .map(([head, refname, object, peeled, upstream]) => ({ current: head === '*', refname, target: peeled || object, upstream }));
}
/** The badges each commit carries: the current branch first, then branches, remote branches and tags. A remote's own HEAD is noise. */
export function decorations(refs: RefLine[]): Map<string, GitRef[]> {
  const result = new Map<string, GitRef[]>(); const order = { branch: 1, remote: 2, tag: 3 };
  for (const ref of refs) {
    const match = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(ref.refname); if (!match || (match[1] === 'remotes' && /\/HEAD$/.test(match[2]))) continue;
    const item: GitRef = { name: match[2], kind: match[1] === 'heads' ? 'branch' : match[1] === 'remotes' ? 'remote' : 'tag', ...(ref.current ? { current: true as const } : {}) };
    result.set(ref.target, [...result.get(ref.target) ?? [], item]);
  }
  for (const list of result.values()) list.sort((a, b) => Number(!a.current) - Number(!b.current) || order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  return result;
}
export function parseLog(output: Buffer, refs: Map<string, GitRef[]>): { commits: GitCommit[]; limited: boolean } {
  const fields = output.toString('utf8').split('\0'); const commits: GitCommit[] = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [sha, parents, date, author, subject] = fields.slice(index, index + 5);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) continue;
    commits.push({ sha, parents: parents ? parents.split(' ') : [], date, author: author.slice(0, 100), subject: subject.slice(0, 200), refs: refs.get(sha) ?? [] });
  }
  return { commits: commits.slice(0, LOG_LIMIT), limited: commits.length > LOG_LIMIT };
}
/** `--numstat -z`: `added\tdeleted\tpath`, or for a rename `added\tdeleted\t` then the old and the new path; `-` counts for a binary file. */
export function parseNumstat(output: Buffer): { files: GitCommitFile[]; limited: boolean } {
  const tokens = output.toString('utf8').split('\0'); const files: GitCommitFile[] = []; let limited = false;
  const count = (value: string) => value === '-' ? null : Number(value);
  for (let index = 0; index < tokens.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(tokens[index]); if (!match) continue;
    const renamed = !match[3]; const file = { path: renamed ? tokens[index + 2] ?? '' : match[3], originalPath: renamed ? tokens[index + 1] ?? null : null, additions: count(match[1]), deletions: count(match[2]) };
    if (renamed) index += 2;
    if (files.length < COMMIT_FILE_LIMIT) files.push(file); else limited = true;
  }
  return { files, limited };
}

export class RepositoryGit {
  constructor(private files: RepositoryFiles) {}

  /** The working tree's top folder, for a repository view this window opened. */
  private async root(owner: number, payload: unknown): Promise<string> {
    const context = this.files.owned(owner, payload);
    try {
      const top = (await git(context.directory, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\r?\n$/, '');
      return await realpath(top);
    } catch (error) {
      if (error instanceof HubError && error.code === 'GIT_FAILED') throw new HubError('NOT_A_REPOSITORY', 'This folder is not an accessible Git working tree. File browsing is still available.');
      throw error;
    }
  }

  async status(owner: number, payload: unknown): Promise<GitStatus> {
    const root = await this.root(owner, payload);
    const output = await git(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty']);
    return parseStatus(output, root);
  }

  async diff(owner: number, payload: unknown): Promise<GitFileDiff> {
    const parsed = gitDiffSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_DIFF', 'Invalid Git diff request.');
    const { repositoryId, path: pathname, area } = parsed.data;
    // Git lists an untracked nested repository or worktree as `dir/`.
    const nested = area === 'untracked' && pathname.endsWith('/');
    validateRelativePath(nested ? pathname.slice(0, -1) : pathname);
    const status = await this.status(owner, { repositoryId });
    const change = status.changes.find((item) => item.path === pathname);
    if (!change || (area === 'untracked' ? !change.untracked : change.untracked || (area === 'staged' ? change.indexStatus : change.worktreeStatus) === ' ')) {
      throw new HubError('CHANGE_UNAVAILABLE', 'This change is no longer present in the selected area. Refresh the change list.');
    }
    if (change.originalPath) validateRelativePath(change.originalPath);
    const result: GitFileDiff = { path: pathname, area, patch: '', binary: false, truncated: false, conflicted: change.conflicted };
    if (nested) { result.patch = `Untracked nested repository or worktree: ${pathname}\nReview it with your local Git tools.\n`; return result; }
    if (area === 'untracked') {
      let preview;
      try { preview = await readTextFile(status.root, pathname); }
      catch (error) { if (error instanceof HubError) throw error; throw new HubError('FILE_UNAVAILABLE', 'The untracked file could not be read. Refresh the change list.'); }
      result.binary = preview.binary; result.truncated = preview.truncated;
      if (preview.text !== null) {
        const lines = preview.text.split('\n');
        const newline = preview.text.endsWith('\n');
        if (newline || !preview.text) lines.pop();
        result.patch = `--- /dev/null\n+++ ${JSON.stringify('b/' + pathname)}\n${lines.length ? `@@ -0,0 +1,${lines.length} @@\n` : ''}` + lines.map((line) => '+' + line).join('\n') + (lines.length ? '\n' : '') + (!newline && lines.length ? '\\ No newline at end of file\n' : '');
      }
      return result;
    }
    const paths = change.originalPath ? [change.originalPath, pathname] : [pathname];
    const output = await git(status.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short', '--ignore-submodules=dirty', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', ...(area === 'staged' ? ['--cached'] : []), '--', ...paths]);
    try { result.patch = new TextDecoder('utf-8', { fatal: true }).decode(output); }
    catch { throw new HubError('DIFF_ENCODING', 'This Git diff uses an unsupported text encoding. Inspect it with your local Git tools.'); }
    result.binary = /^Binary files .* differ$/m.test(result.patch);
    return result;
  }

  /**
   * The history Changes → History draws: HEAD, every local branch and each one's upstream, newest first (children always
   * before their parents, which the lane layout needs). Other remote branches are left out so a busy remote does not bury
   * the branches being worked on. Read-only: nothing here checks out, merges or rewrites.
   */
  async log(owner: number, payload: unknown): Promise<GitLog> {
    const root = await this.root(owner, payload);
    const refs = parseRefs(await git(root, ['for-each-ref', '--format=%(HEAD)%00%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00', 'refs/heads', 'refs/remotes', 'refs/tags']));
    const current = refs.find((ref) => ref.current && ref.refname.startsWith('refs/heads/'));
    // Detached, or a branch with no commits yet: `rev-parse` fails on the latter, which is an empty history, not an error.
    const head = current ? current.target : await git(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']).then((output) => output.toString('utf8').trim() || null, () => null);
    const names = new Set(refs.map((ref) => ref.refname)); const branches = refs.filter((ref) => ref.refname.startsWith('refs/heads/'));
    // Full ref names (`refs/…`) never start with a dash. An upstream that is gone is skipped: Git would refuse the whole log.
    const tips = [...new Set([...branches.map((ref) => ref.refname), ...branches.map((ref) => ref.upstream).filter((name) => names.has(name))])];
    // Hundreds of branches would make a command line too long for Windows: then every branch and remote branch instead.
    const revisions = [...head ? ['HEAD'] : [], ...tips.length > 400 ? ['--branches', '--remotes'] : tips];
    const result: GitLog = { head, branch: current ? current.refname.slice('refs/heads/'.length) : null, commits: [], limited: false };
    if (!revisions.length) return result;
    const output = await git(root, ['log', '--date-order', `--max-count=${LOG_LIMIT + 1}`, ...HISTORY_OPTIONS, '-z', LOG_FORMAT, ...revisions, '--']);
    return { ...result, ...parseLog(output, decorations(refs)) };
  }

  /** One commit's message and changed files (against its first parent), for the commit chosen in History. */
  async commit(owner: number, payload: unknown): Promise<GitCommitDetail> {
    const parsed = gitCommitSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_COMMIT', 'Invalid commit request.');
    const { repositoryId, sha } = parsed.data; const root = await this.root(owner, { repositoryId });
    let header: string[];
    try { header = (await git(root, ['show', '-s', ...HISTORY_OPTIONS, '--format=%P%x00%an%x00%aI%x00%B', `${sha}^{commit}`, '--'])).toString('utf8').split('\0'); }
    catch (error) { if (error instanceof HubError && error.code === 'GIT_FAILED') throw new HubError('COMMIT_UNAVAILABLE', 'This commit is no longer in the repository. Refresh the history.'); throw error; }
    const [parentList = '', author = '', date = '', ...message] = header; const parents = parentList ? parentList.split(' ') : [];
    // More files than the 2 MiB preview holds: the message still shows, and the list says it was cut.
    const stat = await git(root, parents.length ? ['diff', ...DIFF_OPTIONS, parents[0], sha, '--'] : ['diff-tree', '--root', '-r', '--no-commit-id', ...DIFF_OPTIONS, sha, '--'])
      .then(parseNumstat, (error: unknown) => { if (error instanceof HubError && error.code === 'GIT_OUTPUT_LIMIT') return { files: [], limited: true }; throw error; });
    return { sha, parents, author: author.slice(0, 100), date, message: message.join(' ').replace(/\s+$/, '').slice(0, 20000), ...stat };
  }
}
