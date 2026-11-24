import fs from 'node:fs';
import path from 'node:path';
import { execFileTree, type TreeError } from './process-tree';
import { HubError } from '../cli/engine-adapter';
import { hostEnvironment } from '../cli/discovery';

/** A hooks folder that holds nothing. An empty `core.hooksPath=` is not one: Git reads it as the drive root (`/post-checkout`). */
export const noHooksPath = () => process.platform === 'win32' ? 'NUL' : '/dev/null';
/** fsmonitor and hooks off: enough for commands that never read file contents (`rev-parse`), without a lookup first. */
export const noHookGitOptions = () => ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooksPath()}`];
/**
 * What a Git command printed; nothing when it exited non-zero (no repository, no match, no such blob). Fails closed when
 * the listing itself could not be read in full (too long, timed out, no Git): a filter missing from it would not be blanked.
 */
// execFileTree, not execFile: at the output limit execFile ends only the direct child and returns at once, while Git (or the
// git the Windows shim started) went on in the repository, and its folder could not be deleted (EBUSY on CI).
const gitText = (args: string[]) => execFileTree('git', args, { timeout: 8000, maxBuffer: 256 * 1024, windowsHide: true, env: hostEnvironment() }).then((output) => output.stdout.toString(), (error: TreeError) => {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code === 'ENOENT' || error.killed) throw new HubError('GIT_UNSAFE_CONFIG', 'This repository’s Git configuration could not be read safely, so Trace did not run Git on it. Check that Git is installed, and that the repository’s .git/config is not unusually large.');
  return String(error.stdout ?? '');
});
const IGNORE = '^submodule\\..*\\.ignore$';
/** `-c` splits at the first `=`: a name holding one (or a line break) cannot be overridden, so Trace does not read at all. */
function setting(key: string, value: string) {
  if (/[=\r\n]/.test(key)) throw new HubError('GIT_UNSAFE_CONFIG', 'This repository’s Git settings name a filter or submodule whose name holds “=”, which Trace cannot switch off, so Trace will not read the repository. Rename it in .git/config or .gitmodules.');
  return ['-c', `${key}=${value}`];
}
/**
 * Git options for commands that only read a repository (status, diff, log). A repository's own `.git/config` can name
 * programs Git runs while reading it: `core.fsmonitor` on status, and filter drivers (`filter.<name>.clean`/`process`,
 * picked by `.gitattributes`) on status and diff. A folder from a zip, a shared drive or an agent's edit could use
 * them to run anything as soon as Trace looks at it. These options turn off fsmonitor and hooks, and blank out the
 * filter drivers the repository itself defines. Filters from the person's own global or system config (Git LFS) stay.
 *
 * A submodule's own config (and so its filters) is not listed here, and Git re-reads a submodule's files to see whether
 * it is dirty. So only new submodule commits are reported while reading: `diff.ignoreSubmodules=dirty`, and the same
 * for every `submodule.<name>.ignore` set in config or `.gitmodules` (worktree file, else index, else HEAD), which
 * would win over it. Status and diff should also pass `--ignore-submodules=dirty`, which wins over both.
 */
export async function readOnlyGitOptions(cwd: string): Promise<string[]> {
  const options = noHookGitOptions();
  // A blob lookup loads the index, which starts the repository's fsmonitor: `options` keep it off.
  // allSettled: a failed read must not leave the other Git processes running behind the rejection.
  const reads = await Promise.allSettled([gitText(['-C', cwd, 'config', '--show-scope', '--name-only', '--get-regexp', `^filter\\.|${IGNORE}`]), gitText(['-C', cwd, 'rev-parse', '--show-toplevel']), ...[':.gitmodules', 'HEAD:.gitmodules'].map((blob) => gitText([...options, '-C', cwd, 'config', '--blob', blob, '--name-only', '--get-regexp', IGNORE]))]);
  const failed = reads.find((read): read is PromiseRejectedResult => read.status === 'rejected'); if (failed) throw failed.reason;
  const [listed, top, indexed, committed] = reads.map((read) => (read as PromiseFulfilledResult<string>).value);
  const modules = top.trim() ? path.join(top.trim(), '.gitmodules') : ''; const present = modules ? await fs.promises.stat(modules).then((stat) => stat.isFile(), () => false) : false;
  const working = present ? await gitText(['config', '--file', modules, '--name-only', '--get-regexp', IGNORE]) : '';
  const drivers = new Set<string>(); const submodules = new Set<string>();
  // Scoped lines are `<scope>\t<name>`; a name may hold spaces, so never split on them.
  for (const line of listed.split('\n').map((item) => item.replace(/\r$/, ''))) {
    const [scope, name = ''] = line.split('\t'); const filter = /^filter\.(.+)\.[^.]+$/i.exec(name); const ignore = /^submodule\.(.+)\.ignore$/.exec(name);
    if (filter && /^(local|worktree)$/i.test(scope)) drivers.add(filter[1]); if (ignore) submodules.add(ignore[1]);
  }
  for (const line of [indexed, committed, working].join('\n').split('\n').map((item) => item.replace(/\r$/, ''))) { const ignore = /^submodule\.(.+)\.ignore$/.exec(line); if (ignore) submodules.add(ignore[1]); }
  options.push('-c', 'diff.ignoreSubmodules=dirty');
  for (const name of submodules) options.push(...setting(`submodule.${name}.ignore`, 'dirty'));
  for (const name of drivers) options.push(...setting(`filter.${name}.clean`, ''), ...setting(`filter.${name}.smudge`, ''), ...setting(`filter.${name}.process`, ''), ...setting(`filter.${name}.required`, 'false'));
  return options;
}
