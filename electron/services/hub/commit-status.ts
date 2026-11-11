import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readOnlyGitOptions } from '../repository/git-safety';
import { isSha, MAX_REFS, type CommitStatus } from '../../../shared/commit-refs';

/**
 * Whether commits a note names are in this clone and on remote-tracking branches. Read-only Git, no network: remote
 * branches are as the last fetch left them, so the answer carries when that was. Null outside a Git folder.
 */
export async function commitStatus(cwd: string, shas: string[]): Promise<CommitStatus | null> {
  const run = promisify(execFile);
  let safe: string[]; try { safe = await readOnlyGitOptions(cwd); } catch { return null; }
  const git = async (args: string[]) => (await run('git', ['--no-optional-locks', ...safe, '-C', cwd, ...args], { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  let fetchedAt: string | null = null;
  try { const file = await git(['rev-parse', '--git-path', 'FETCH_HEAD']); fetchedAt = fs.statSync(path.resolve(cwd, file)).mtime.toISOString(); } catch { /* Never fetched, or not a repository. */ }
  try { await git(['rev-parse', '--git-dir']); } catch { return null; }
  const commits: CommitStatus['commits'] = [];
  for (const sha of shas.filter(isSha).slice(0, MAX_REFS)) {
    try { await git(['cat-file', '-e', `${sha}^{commit}`]); } catch { commits.push({ sha, known: false, remotes: [] }); continue; }
    let remotes: string[] = []; try { remotes = (await git(['branch', '-r', '--contains', sha, '--format=%(refname:short)'])).split('\n').map((line) => line.trim()).filter((line) => line && !line.endsWith('/HEAD')); } catch { /* Listed as on none. */ }
    commits.push({ sha, known: true, remotes });
  }
  return { checkedAt: new Date().toISOString(), fetchedAt, commits };
}
