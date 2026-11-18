import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HubError } from '../cli/engine-adapter';

/** A hooks folder that holds nothing. An empty `core.hooksPath=` is not one: Git reads it as the drive root (`/post-checkout`). */
export const noHooksPath = () => process.platform === 'win32' ? 'NUL' : '/dev/null';
/** fsmonitor and hooks off: enough for commands that never read file contents (`rev-parse`), without a lookup first. */
export const noHookGitOptions = () => ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooksPath()}`];
/** What a Git command printed; nothing when it failed (no repository, no match, no such blob). */
const gitText = (args: string[]) => new Promise<string>((resolve) => execFile('git', args, { timeout: 8000, maxBuffer: 256 * 1024, windowsHide: true }, (_error, stdout) => resolve(String(stdout ?? ''))));
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
  const [listed, top, indexed, committed] = await Promise.all([gitText(['-C', cwd, 'config', '--show-scope', '--name-only', '--get-regexp', `^filter\\.|${IGNORE}`]), gitText(['-C', cwd, 'rev-parse', '--show-toplevel']), ...[':.gitmodules', 'HEAD:.gitmodules'].map((blob) => gitText([...options, '-C', cwd, 'config', '--blob', blob, '--name-only', '--get-regexp', IGNORE]))]);
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
