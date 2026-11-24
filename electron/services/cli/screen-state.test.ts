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
  it('reports a change only once it is read twice in a row, and a stale ask once the agent works again', () => {
    const watch = new ScreenWatch();
    expect(watch.push({ state: 'blocked' })).toBeNull(); expect(watch.push({ state: 'blocked' })).toBe('blocked'); expect(watch.push({ state: 'blocked' })).toBeNull();
    expect(watch.push({ state: 'working' })).toBeNull(); expect(watch.push({ state: 'working' })).toBe('resolved');
    // Told by the CLI that it asks (its hook), the next working screen clears that too.
    watch.asked(); watch.push({ state: 'working' }); expect(watch.push({ state: 'working' })).toBe('resolved');
    // A flicker of one reading changes nothing.
    expect(watch.push({ state: 'blocked' })).toBeNull(); expect(watch.push({ state: 'working' })).toBeNull();
  });
});
