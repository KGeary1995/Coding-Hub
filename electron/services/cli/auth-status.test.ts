import { describe, expect, it } from 'vitest';
import { classifyAuthentication } from './auth-status';
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
  it('does not infer access from malformed output or unrelated flags', () => {
    expect(classifyAuthentication('claude', result('bad-json')).state).toBe('unknown');
    expect(classifyAuthentication('codex', result('network failure', '', 1)).state).toBe('unknown');
    expect(advertisesFlag('  -m, --model <MODEL>', '--model')).toBe(true);
    expect(advertisesFlag('--model-name <MODEL>', '--model')).toBe(false);
    expect(advertisesFlag('--config=value', '--config')).toBe(true);
  });
});
