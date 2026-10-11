import type { CLIEngine } from '../../../shared/types';
export interface ProbeResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }
export interface AuthenticationStatus { state: 'authenticated' | 'not-authenticated' | 'unknown'; checkedAt: string; message: string }

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
  const text = `${result.stdout}\n${result.stderr}`;
  if (!result.timedOut && engine === 'codex') {
    if (/\b(?:not logged in|not authenticated|no stored credentials)\b/i.test(text)) return { ...base, state: 'not-authenticated', message: 'The CLI reports no login. Run codex login in your system terminal.' };
    if (result.exitCode === 0 && /\b(?:logged in|authenticated)\b/i.test(text)) return { ...base, state: 'authenticated', message: 'The CLI reports a configured login.' };
  }
  return { ...base, state: 'unknown', message: 'Authentication status could not be verified locally. The CLI manages login, provider settings, and model access when it starts.' };
}
