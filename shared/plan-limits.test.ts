import { describe, expect, it } from 'vitest';
import { codexWindow, parseClaudeUsage } from './plan-limits';

describe('plan limits', () => {
  it('reads Claude Code’s /usage text', () => {
    // As printed by Claude Code 2.1.310.
    const text = `You are currently using your subscription to power your Claude Code usage

Current session: 5% used · resets Oct 25 at 11:59pm (America/Los_Angeles)
Current week (all models): 11% used · resets Oct 31 at 7:59am (America/Los_Angeles)
Current week (Fable): 0% used · resets Oct 31 at 8am (America/Los_Angeles)

What's contributing to your limits usage?`;
    expect(parseClaudeUsage(text)).toEqual([
      { label: 'Session', usedPercent: 5, resets: 'Oct 25 at 11:59pm' },
      { label: 'Week', usedPercent: 11, resets: 'Oct 31 at 7:59am' },
      { label: 'Week (Fable)', usedPercent: 0, resets: 'Oct 31 at 8am' },
    ]);
    expect(parseClaudeUsage('Current session: 100% used')).toEqual([{ label: 'Session', usedPercent: 100, resets: null }]);
    expect(parseClaudeUsage('You are using an API key.')).toEqual([]);
  });
  it('names Codex windows by their length', () => {
    expect(codexWindow({ usedPercent: 3, windowDurationMins: 10080, resetsAt: 1793536297 })).toEqual({ label: 'Week', usedPercent: 3, resets: new Date(1793536297000).toISOString() });
    expect(codexWindow({ usedPercent: 40, windowDurationMins: 300, resetsAt: null })).toEqual({ label: 'Session', usedPercent: 40, resets: null });
  });
});
