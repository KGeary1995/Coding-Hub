import { execFile } from 'node:child_process';

/**
 * Git options for commands that only read a repository (status, diff, log). A repository's own `.git/config` can name
 * programs Git runs while reading it: `core.fsmonitor` on status, and filter drivers (`filter.<name>.clean`/`process`,
 * picked by `.gitattributes`) on status and diff. A folder from a zip, a shared drive or an agent's edit could use
 * them to run anything as soon as Trace looks at it. These options turn off fsmonitor and hooks, and blank out the
 * filter drivers the repository itself defines. Filters from the person's own global or system config (Git LFS) stay.
 */
/** fsmonitor and hooks off: enough for commands that never read file contents (`rev-parse`), without a lookup first. */
export const noHookGitOptions = () => ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`];
export async function readOnlyGitOptions(cwd: string): Promise<string[]> {
  const options = noHookGitOptions();
  const listed = await new Promise<string>((resolve) => execFile('git', ['-C', cwd, 'config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'], { timeout: 8000, maxBuffer: 256 * 1024, windowsHide: true }, (_error, stdout) => resolve(String(stdout ?? ''))));
  const drivers = new Set<string>();
  for (const line of listed.split(/\r?\n/)) {
    const match = /^(local|worktree)\s+filter\.(.+)\.[^.]+$/i.exec(line.trim()); if (match) drivers.add(match[2]);
  }
  for (const name of drivers) options.push('-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`);
  return options;
}
