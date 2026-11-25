import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { AccountConnection, AccountProvider } from '../../../shared/accounts';
import { freshHostEnvironment, findExecutable, probeCLI, checkAuthentication, type Executable } from './discovery';
import { HubError } from './engine-adapter';
/** Gemini (agy) has none here: Trace has no install page for it that was checked. */
export const INSTALL_GUIDES: Record<AccountProvider, string | null> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli/',
  gemini: null,
  github: 'https://cli.github.com/',
};
/** agy has no login command: started plainly, it asks to sign in when it is not. */
export const LOGIN_ARGUMENTS: Record<AccountProvider, string[]> = { claude: ['auth', 'login'], codex: ['login'], gemini: [], github: ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'] };
export function githubAuthentication(stdout: string, stderr: string, exitCode: number | null): AccountConnection['state'] {
  // gh lists every stored account; judge only the active one so a stale secondary token does not mask a working login.
  const all = stdout + '\n' + stderr; const blocks = all.split(/\n(?=\s*[✓X!]\s)/); const active = blocks.find((block) => /active account:\s*true/i.test(block));
  const text = active ?? all;
  if (/not logged (?:in|into)|token[^\n]*invalid|failed to log in|authentication failed/i.test(text)) return 'not-authenticated';
  // gh exits 1 when any stored account fails, even if the active one works.
  if ((exitCode === 0 || active) && /logged in to github\.com/i.test(text)) return 'authenticated';
  return 'unknown';
}
export async function findGitHub(environment?: Record<string, string>): Promise<Executable> {
  const env = environment ?? await freshHostEnvironment(); const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  for (const directory of env[pathKey].split(path.delimiter).filter(Boolean)) {
    const file = path.join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'gh.exe' : 'gh');
    try { await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); if (!(await stat(file)).isFile()) continue; return { file, prefixArgs: [], extraEnv: {}, displayPath: file }; } catch { /* Try next PATH entry. */ }
  }
  throw new HubError('GITHUB_CLI_NOT_FOUND', 'GitHub CLI (gh) is not installed or not on PATH. Open the installation guide, install it, and refresh.');
}
export async function inspectAccount(provider: AccountProvider, environment?: Record<string, string>): Promise<{ connection: AccountConnection; executable: Executable | null }> {
  const connection: AccountConnection = { provider, installed: false, executable: null, version: null, state: 'unknown', message: 'Checking local CLI…', canLogin: false, checkedAt: new Date().toISOString() };
  try {
    const env = environment ?? await freshHostEnvironment();
    const executable = provider === 'github' ? await findGitHub(env) : await findExecutable(provider, env);
    const [version, help] = await Promise.all([probeCLI(executable, ['--version'], env), probeCLI(executable, ['--help'], env)]);
    if (version.exitCode !== 0 || help.exitCode !== 0) throw new HubError('ACCOUNT_CLI_FAILED', 'CLI health check failed or timed out. Repair its installation and refresh.');
    connection.installed = true; connection.executable = executable.displayPath; connection.version = (version.stdout + '\n' + version.stderr).trim().split('\n')[0].slice(0, 120);
    const helpText = help.stdout + '\n' + help.stderr;
    if (provider === 'github') {
      const result = await probeCLI(executable, ['auth', 'status', '--hostname', 'github.com'], env);
      connection.state = result.timedOut ? 'unknown' : githubAuthentication(result.stdout, result.stderr, result.exitCode);
      connection.message = connection.state === 'authenticated' ? 'GitHub CLI reports a configured login for github.com.' : connection.state === 'not-authenticated' ? 'Sign in to GitHub using its browser login flow.' : 'GitHub authentication could not be verified. Check connectivity or sign in again.';
      connection.canLogin = /^\s*auth\b/m.test(helpText);
    } else {
      // The version decides whether agy can answer /usage itself (discovery's GEMINI_USAGE_COMMAND); without it Gemini stayed unknown.
      const authentication = await checkAuthentication(provider, executable, helpText, env, connection.version);
      connection.state = authentication.state; connection.message = authentication.message;
      // agy signs in when it starts (it has no login command); its setup asks which account and billing to use.
      connection.canLogin = provider === 'gemini' || new RegExp(`^\\s*${provider === 'claude' ? 'auth' : 'login'}\\b`, 'm').test(helpText);
      if (provider === 'gemini' && connection.state !== 'authenticated') connection.message = `${connection.state === 'not-authenticated' ? 'Gemini is not signed in.' : 'Gemini did not report a sign-in.'} Connect starts it to sign in: choose your Google account, then the free or individual option. Google Cloud and Pay As You Go ask for a Cloud project, and quitting at that step leaves Gemini signed out.`;
      else if (!connection.canLogin) connection.message += ' This version does not advertise the supported login command. Update the CLI or sign in from your system terminal.';
    }
    return { connection, executable };
  } catch (error) { connection.message = error instanceof HubError ? error.message : 'The CLI could not be inspected. Install it and refresh.'; return { connection, executable: null }; }
}
