import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { GitChange, GitFileDiff, GitStatus } from '../../../shared/types';
import { gitDiffSchema } from '../../../shared/schemas';
import { HubError } from '../cli/engine-adapter';
import { hostEnvironment } from '../cli/discovery';
import { readTextFile, RepositoryFiles, validateRelativePath } from './filesystem';

const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;
const STATUS_ENTRY_LIMIT = 1000;

function git(directory: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
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

export class RepositoryGit {
  constructor(private files: RepositoryFiles) {}

  async status(owner: number, payload: unknown): Promise<GitStatus> {
    const context = this.files.owned(owner, payload);
    let root: string;
    try {
      const top = (await git(context.directory, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\r?\n$/, '');
      root = await realpath(top);
    } catch (error) {
      if (error instanceof HubError && error.code === 'GIT_FAILED') throw new HubError('NOT_A_REPOSITORY', 'This directory is not an accessible Git working tree. File browsing is still available.');
      throw error;
    }
    const output = await git(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=none']);
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
    const output = await git(status.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', ...(area === 'staged' ? ['--cached'] : []), '--', ...paths]);
    try { result.patch = new TextDecoder('utf-8', { fatal: true }).decode(output); }
    catch { throw new HubError('DIFF_ENCODING', 'This Git diff uses an unsupported text encoding. Inspect it with your local Git tools.'); }
    result.binary = /^Binary files .* differ$/m.test(result.patch);
    return result;
  }
}
