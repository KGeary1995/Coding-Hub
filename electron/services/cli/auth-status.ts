import type { CLIEngine } from '../../../shared/types';
export interface ProbeResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }
export interface AuthenticationStatus { state: 'authenticated' | 'not-authenticated' | 'unknown'; checkedAt: string; message: string }
/** The message of a login check the CLI did not answer in time (a busy computer), told apart from an unsupported one. */
export const AUTH_TIMED_OUT = 'The CLI did not report its login in time. Try again once the computer is less busy.';

/** Never return CLI auth output: it can contain email addresses, account IDs, or credentials. */
export function classifyAuthentication(engine: CLIEngine, result: ProbeResult): AuthenticationStatus {
  const base = { checkedAt: new Date().toISOString() };
  if (!result.timedOut && engine === 'claude') {
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (value && typeof value === 'object' && 'loggedIn' in value && typeof value.loggedIn === 'boolean') {
        return { ...base, state: value.loggedIn ? 'authenticated' : 'not-authenticated', message: value.loggedIn ? 'The CLI reports a configured login.' : 'The CLI reports no login. Run claude auth login in your system terminal.' };
      }
    } catch { /* Unknown formats stay unknown. */ }
  }
  // agy answers `-p "/usage" --output-format json` with its plan limits only when signed in. What it prints signed out
  // has not been seen (its sign-in lives in the system's credential store), so anything else stays unknown.
  if (!result.timedOut && engine === 'gemini' && result.exitCode === 0) {
    try {
      const value = JSON.parse(result.stdout) as { command?: { name?: unknown; data?: { groups?: unknown } } };
      if (value.command?.name === 'usage' && Array.isArray(value.command.data?.groups) && value.command.data.groups.length) return { ...base, state: 'authenticated', message: 'Gemini CLI reports your plan limits, so it is signed in.' };
    } catch { /* Unknown formats stay unknown. */ }
  }
  const text = `${result.stdout}\n${result.stderr}`;
  if (!result.timedOut && engine === 'codex') {
    if (/\b(?:not logged in|not authenticated|no stored credentials)\b/i.test(text)) return { ...base, state: 'not-authenticated', message: 'The CLI reports no login. Run codex login in your system terminal.' };
    if (result.exitCode === 0 && /\b(?:logged in|authenticated)\b/i.test(text)) return { ...base, state: 'authenticated', message: 'The CLI reports a configured login.' };
  }
  if (result.timedOut) return { ...base, state: 'unknown', message: AUTH_TIMED_OUT };
  return { ...base, state: 'unknown', message: 'Authentication status could not be verified locally. The CLI manages login, provider settings, and model access when it starts.' };
}
