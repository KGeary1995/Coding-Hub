import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostEnvironment } from '../cli/discovery';
import { readOnlyGitOptions } from '../repository/git-safety';

/** Files Git sees as changed in a project folder (relative to it), with their signatures; null when it is not a repository. */
export async function changedFiles(cwd: string): Promise<Map<string, string> | null> {
  try {
    // Hidden console, the host's PATH and no prompts, as for every other Git call; and the repository's own config
    // must not run programs while it is only read (readOnlyGitOptions).
    const command = promisify(execFile); const safe = await readOnlyGitOptions(cwd); const options = { timeout: 8000, windowsHide: true, env: { ...hostEnvironment(), GIT_TERMINAL_PROMPT: '0' } };
    const { stdout: repository } = await command('git', [...safe, '-C', cwd, 'rev-parse', '--show-toplevel'], { ...options, maxBuffer: 65536 });
    const { stdout } = await command('git', ['--no-optional-locks', ...safe, '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { ...options, maxBuffer: 1048576 });
    const entries = stdout.split('\0'); const prefix = path.relative(repository.trim(), cwd).replace(/\\/g, '/'); const files = new Map<string, string>();
    for (let i = 0; i < entries.length && files.size < 500; i++) {
      if (!entries[i]) continue;
      // Renames and copies carry their source path as the next entry; a moved-away path is a change too.
      const names = [entries[i].slice(3)]; if (/[RC]/.test(entries[i].slice(0, 2)) && entries[i + 1]) names.push(entries[++i]);
      for (const name of names) {
        const relative = prefix && name.startsWith(prefix + '/') ? name.slice(prefix.length + 1) : name;
        let mark = 'gone'; try { const stat = fs.statSync(path.join(cwd, relative)); mark = `${stat.size}:${Math.round(stat.mtimeMs)}`; } catch { /* Deleted. */ }
        files.set(relative, mark);
      }
    }
    return files;
  } catch { return null; }
}

/**
 * What a project folder holds right now, as one hash: the commit checked out and every file Git sees as changed, with its
 * size and when it last changed. Equal hashes mean the same files as far as Git and the file system can tell. Null when
 * the folder is not a Git repository or Git does not answer.
 */
export async function repositoryState(cwd: string): Promise<string | null> {
  const files = await changedFiles(cwd); if (!files) return null;
  let head = 'none';
  try { const safe = await readOnlyGitOptions(cwd); head = (await promisify(execFile)('git', [...safe, '-C', cwd, 'rev-parse', '--verify', '-q', 'HEAD'], { timeout: 8000, windowsHide: true, env: { ...hostEnvironment(), GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 65536 })).stdout.trim() || 'none'; } catch { /* No commits yet. */ }
  return createHash('sha256').update(JSON.stringify([head, [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])).digest('hex');
}
