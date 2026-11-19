import { describe, expect, it } from 'vitest';
import { AUTH_TIMED_OUT, classifyAuthentication } from './auth-status';
import { advertisesFlag } from './discovery';
const result = (stdout = '', stderr = '', exitCode: number | null = 0, timedOut = false) => ({ stdout, stderr, exitCode, timedOut });
describe('local authentication diagnostics', () => {
  it('extracts Claude login state without exposing email, tokens, or account metadata', () => {
    const status = classifyAuthentication('claude', result(JSON.stringify({ loggedIn: true, email: 'private@example.invalid', token: 'private' })));
    expect(status.state).toBe('authenticated'); expect(JSON.stringify(status)).not.toContain('private');
    expect(classifyAuthentication('claude', result('{"loggedIn":false}', '', 1)).state).toBe('not-authenticated');
    expect(classifyAuthentication('claude', result('{"loggedIn":"false"}')).state).toBe('unknown');
  });
  it('handles Codex stderr status and nonzero logged-out status without confusing negation', () => {
    expect(classifyAuthentication('codex', result('', 'Logged in using ChatGPT')).state).toBe('authenticated');
    expect(classifyAuthentication('codex', result('', 'Not logged in', 1)).state).toBe('not-authenticated');
    expect(classifyAuthentication('codex', result('Logged in', '', 1)).state).toBe('unknown');
    expect(classifyAuthentication('codex', result('Logged in', '', 0, true)).state).toBe('unknown');
  });
  it('says a login check that timed out did so, instead of calling it unsupported', () => {
    expect(classifyAuthentication('claude', result('', '', null, true))).toMatchObject({ state: 'unknown', message: AUTH_TIMED_OUT });
    expect(classifyAuthentication('claude', result('bad-json')).message).not.toBe(AUTH_TIMED_OUT);
  });
  it('does not infer access from malformed output or unrelated flags', () => {
    expect(classifyAuthentication('claude', result('bad-json')).state).toBe('unknown');
    expect(classifyAuthentication('codex', result('network failure', '', 1)).state).toBe('unknown');
    expect(advertisesFlag('  -m, --model <MODEL>', '--model')).toBe(true);
    expect(advertisesFlag('--model-name <MODEL>', '--model')).toBe(false);
    expect(advertisesFlag('--config=value', '--config')).toBe(true);
  });
});

describe('Gemini CLI sign-in', () => {
  const usage = JSON.stringify({ conversation_id: '', status: 'SUCCESS', response: 'Gemini Models\tWeekly Limit Remaining\t98%\n', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [] }] } } });
  it('is signed in when agy reports its plan limits, and unknown otherwise (what it says signed out has not been seen)', () => {
    expect(classifyAuthentication('gemini', { stdout: usage, stderr: '', exitCode: 0, timedOut: false }).state).toBe('authenticated');
    for (const result of [{ stdout: usage, stderr: '', exitCode: 2, timedOut: false }, { stdout: 'not json', stderr: '', exitCode: 0, timedOut: false }, { stdout: JSON.stringify({ command: { name: 'usage', data: { groups: [] } } }), stderr: '', exitCode: 0, timedOut: false }, { stdout: '', stderr: '', exitCode: null, timedOut: true }])
      expect(classifyAuthentication('gemini', result).state).toBe('unknown');
  });
  it('never repeats what agy printed', () => {
    const status = classifyAuthentication('gemini', { stdout: usage.replace('Gemini Models', 'person@example.com'), stderr: 'person@example.com', exitCode: 0, timedOut: false });
    expect(JSON.stringify(status)).not.toContain('example.com');
  });
});
