import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { AccountConnection, AccountProvider } from '../../../shared/accounts';
import { hostEnvironment, findExecutable, probeCLI, checkAuthentication, type Executable } from './discovery';
import { HubError } from './engine-adapter';
export const INSTALL_GUIDES: Record<AccountProvider, string> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli/',
  github: 'https://cli.github.com/',
};
export const LOGIN_ARGUMENTS: Record<AccountProvider, string[]> = { claude: ['auth', 'login'], codex: ['login'], github: ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'] };
export function githubAuthentication(stdout: string, stderr: string, exitCode: number | null): AccountConnection['state'] {
  const text = stdout + '\n' + stderr;
  if (/not logged (?:in|into)|token[^\n]*invalid|failed to log in|authentication failed/i.test(text)) return 'not-authenticated';
  if (exitCode === 0 && /logged in to github\.com/i.test(text)) return 'authenticated';
  return 'unknown';
}
export async function findGitHub(): Promise<Executable> {
  const env = hostEnvironment(); const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  for (const directory of env[pathKey].split(path.delimiter).filter(Boolean)) {
    const file = path.join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'gh.exe' : 'gh');
    try { await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); if (!(await stat(file)).isFile()) continue; return { file, prefixArgs: [], extraEnv: {}, displayPath: file }; } catch { /* Try next PATH entry. */ }
  }
  throw new HubError('GITHUB_CLI_NOT_FOUND', 'GitHub CLI (gh) is not installed or not on PATH. Open the installation guide, install it, and refresh.');
}
export async function inspectAccount(provider: AccountProvider, environment = hostEnvironment()): Promise<{ connection: AccountConnection; executable: Executable | null }> {
  const connection: AccountConnection = { provider, installed: false, executable: null, version: null, state: 'unknown', message: 'Checking local CLI…', canLogin: false, checkedAt: new Date().toISOString() };
  try {
    const executable = provider === 'github' ? await findGitHub() : await findExecutable(provider);
    const env = environment; const [version, help] = await Promise.all([probeCLI(executable, ['--version'], env), probeCLI(executable, ['--help'], env)]);
    if (version.exitCode !== 0 || help.exitCode !== 0) throw new HubError('ACCOUNT_CLI_FAILED', 'CLI health check failed or timed out. Repair its installation and refresh.');
    connection.installed = true; connection.executable = executable.displayPath; connection.version = (version.stdout + '\n' + version.stderr).trim().split('\n')[0].slice(0, 120);
    const helpText = help.stdout + '\n' + help.stderr;
    if (provider === 'github') {
      const result = await probeCLI(executable, ['auth', 'status', '--hostname', 'github.com'], env);
      connection.state = result.timedOut ? 'unknown' : githubAuthentication(result.stdout, result.stderr, result.exitCode);
      connection.message = connection.state === 'authenticated' ? 'GitHub CLI reports a configured login for github.com.' : connection.state === 'not-authenticated' ? 'Sign in to GitHub using its browser login flow.' : 'GitHub authentication could not be verified. Check connectivity or sign in again.';
      connection.canLogin = /^\s*auth\b/m.test(helpText);
    } else {
      const authentication = await checkAuthentication(provider, executable, helpText, env);
      connection.state = authentication.state; connection.message = authentication.message;
      connection.canLogin = new RegExp(`^\\s*${provider === 'claude' ? 'auth' : 'login'}\\b`, 'm').test(helpText);
      if (!connection.canLogin) connection.message += ' This version does not advertise the supported login command. Update the CLI or sign in from your system terminal.';
    }
    return { connection, executable };
  } catch (error) { connection.message = error instanceof HubError ? error.message : 'The CLI could not be inspected. Install it and refresh.'; return { connection, executable: null }; }
}
