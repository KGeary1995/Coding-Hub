import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostEnvironment } from '../cli/discovery';
import { readOnlyGitOptions } from '../repository/git-safety';

/** The most changed files, and bytes in them, repositoryState reads before it says it cannot tell. */
const STATE_FILES = 5000; const STATE_BYTES = 256 * 1024 * 1024;

/** Files Git sees as changed in a project folder (relative to it), with their size and change time; null when it is not a repository. At most `limit`. */
export async function changedFiles(cwd: string, limit = 500): Promise<Map<string, string> | null> {
  try {
    // Hidden console, the host's PATH and no prompts, as for every other Git call; and the repository's own config
    // must not run programs while it is only read (readOnlyGitOptions).
    const command = promisify(execFile); const safe = await readOnlyGitOptions(cwd); const options = { timeout: 8000, windowsHide: true, env: { ...hostEnvironment(), GIT_TERMINAL_PROMPT: '0' } };
    const { stdout: repository } = await command('git', [...safe, '-C', cwd, 'rev-parse', '--show-toplevel'], { ...options, maxBuffer: 65536 });
    const { stdout } = await command('git', ['--no-optional-locks', ...safe, '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--', '.'], { ...options, maxBuffer: 1048576 });
    const entries = stdout.split('\0'); const prefix = path.relative(repository.trim(), cwd).replace(/\\/g, '/'); const names = new Set<string>();
    for (let i = 0; i < entries.length && names.size < limit; i++) {
      if (!entries[i]) continue;
      // Renames and copies carry their source path as the next entry; a moved-away path is a change too.
      const listed = [entries[i].slice(3)]; if (/[RC]/.test(entries[i].slice(0, 2)) && entries[i + 1]) listed.push(entries[++i]);
      for (const name of listed) names.add(prefix && name.startsWith(prefix + '/') ? name.slice(prefix.length + 1) : name);
    }
    // Asynchronous stats in small batches: thousands of synchronous ones held the main process (Round Tables, task checks).
    const files = new Map<string, string>(); const list = [...names];
    for (let i = 0; i < list.length; i += 32) {
      const marks = await Promise.all(list.slice(i, i + 32).map((relative) => fs.promises.stat(path.join(cwd, relative)).then((stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`, () => 'gone')));
      marks.forEach((mark, index) => files.set(list[i + index], mark));
    }
    return files;
  } catch { return null; }
}

/**
 * What a project folder holds right now, as one hash: the commit checked out and the content of every file Git sees as
 * changed (ignored files are not part of it). Null, meaning "cannot tell", when the folder is not a Git repository, Git
 * does not answer, or there are more changed files or bytes than it reads (STATE_FILES, STATE_BYTES).
 */
export async function repositoryState(cwd: string): Promise<string | null> {
  const files = await changedFiles(cwd, STATE_FILES + 1); if (!files || files.size > STATE_FILES) return null;
  const hash = createHash('sha256'); let bytes = 0;
  for (const relative of [...files.keys()].sort()) {
    hash.update(relative + '\0');
    // Read as a stream and awaited file by file, so the main process keeps answering while a large tree is hashed.
    try { const file = path.join(cwd, relative); const stat = await fs.promises.stat(file); if (!stat.isFile()) { hash.update('special\0'); continue; } bytes += stat.size; if (bytes > STATE_BYTES) return null; const digest = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) digest.update(chunk as Buffer); hash.update(digest.digest('hex') + '\0'); } catch { hash.update('gone\0'); }
  }
  let head = 'none';
  try { const safe = await readOnlyGitOptions(cwd); head = (await promisify(execFile)('git', [...safe, '-C', cwd, 'rev-parse', '--verify', '-q', 'HEAD'], { timeout: 8000, windowsHide: true, env: { ...hostEnvironment(), GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 65536 })).stdout.trim() || 'none'; } catch { /* No commits yet. */ }
  return hash.update('head:' + head).digest('hex');
}
