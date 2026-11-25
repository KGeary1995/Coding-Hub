import { describe, expect, it } from 'vitest';
import { screenState, ScreenWatch } from './screen-state';

describe('reading an agent\'s state from its screen (herdr\'s rules, a subset)', () => {
  it('sees Claude Code\'s approval form after the last rule, its working spinner, and nothing in plain output', () => {
    const form = ['● Bash(rm -rf build)', '────────────────────', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Enter to confirm'];
    expect(screenState('claude', form, 'Claude Code')).toEqual({ state: 'blocked', message: 'Do you want to proceed?' });
    expect(screenState('claude', ['output'], '⠂ Fixing tests')).toEqual({ state: 'working' });
    expect(screenState('claude', ['Some reply', '✻ Thinking… (12s · esc to interrupt)'], 'Claude Code')).toEqual({ state: 'working' });
    expect(screenState('claude', ['I can cancel this: esc to cancel and enter to confirm are its keys.', '────', '> '], 'Claude Code')).toEqual({ state: 'unknown' });
  });
  it('sees Codex\'s approval after its last prompt marker, and its title', () => {
    expect(screenState('codex', ['› run the tests', 'Allow command?', '  npm test', 'y/n'], 'codex')).toEqual({ state: 'blocked', message: 'Allow command?' });
    expect(screenState('codex', ['› hi'], 'Action Required · codex')).toEqual({ state: 'blocked', message: 'Codex is waiting for your approval' });
    expect(screenState('codex', ['› hi'], '⠋ codex')).toEqual({ state: 'working' });
    expect(screenState('codex', ['Allow command? was the old wording', '› next question'], 'codex')).toEqual({ state: 'unknown' });
  });
  it('sees the startup questions that Enter or a letter would answer: Claude\'s and Codex\'s folder trust, Codex\'s hook review', () => {
    // As Claude Code 2.1.332 and codex-cli 0.172 drew them (2026-11-25).
    const claudeTrust = ['Accessing workspace:', '/tmp/project', 'Quick safety check: Is this a project you created or one you trust?', 'Security guide', '❯ No, exit', '  Yes, I trust this folder', 'Enter to confirm · Esc to cancel'];
    expect(screenState('claude', claudeTrust, 'Claude Code').state).toBe('blocked');
    const codexTrust = ['Folder access', '/tmp/project', 'Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.', '› 1. Trust and continue', '  2. Back to Agent Command Center', 'enter continue · esc back'];
    expect(screenState('codex', codexTrust, 'codex')).toEqual({ state: 'blocked', message: 'Codex asks whether to trust this folder' });
    const hooks = ['Hooks', 'Lifecycle hooks from config and enabled plugins.', '⚠ 1 hook needs review before it can run.', 'Event  Installed  Active  Review  Description', '› SessionStart  1  0  1  When a new session starts', '  SessionEnd  0  0  0  Right before a session ends', 't trust all · enter review · esc close'];
    expect(screenState('codex', hooks, 'codex')).toEqual({ state: 'blocked', message: 'Codex asks you to review a hook before it runs' });
    // The words alone, in a reply, are not a question.
    expect(screenState('codex', ['› explain', 'Press enter review then esc close to leave; trust this folder if you like.'], 'codex').state).toBe('unknown');
  });
  it('reports a change only once it is read twice in a row, and a stale ask once the agent works again', () => {
    const watch = new ScreenWatch();
    expect(watch.push({ state: 'blocked' })).toBeNull(); expect(watch.push({ state: 'blocked' })).toBe('blocked'); expect(watch.push({ state: 'blocked' })).toBeNull();
    expect(watch.push({ state: 'working' })).toBeNull(); expect(watch.push({ state: 'working' })).toBe('resolved');
    // Told by the CLI that it asks (its hook), the next working screen clears that too.
    watch.asked(); watch.push({ state: 'working' }); expect(watch.push({ state: 'working' })).toBe('resolved');
    // A flicker of one reading changes nothing.
    expect(watch.push({ state: 'blocked' })).toBeNull(); expect(watch.push({ state: 'working' })).toBeNull();
  });
  it('says when the agent starts working, and when a working screen settles, each once it is read twice (1.43.0)', () => {
    const watch = new ScreenWatch();
    expect(watch.push({ state: 'working' })).toBeNull(); expect(watch.push({ state: 'working' })).toBe('working');
    expect(watch.push({ state: 'unknown' })).toBeNull(); expect(watch.push({ state: 'unknown' })).toBe('settled');
    // Settled once: more quiet readings say nothing; a blocked one after work is a question, not an end.
    expect(watch.push({ state: 'unknown' })).toBeNull();
    watch.push({ state: 'working' }); watch.push({ state: 'working' }); watch.push({ state: 'blocked' }); expect(watch.push({ state: 'blocked' })).toBe('blocked');
  });
});
