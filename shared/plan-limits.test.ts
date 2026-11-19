import { describe, expect, it } from 'vitest';
import { codexWindow, codexWindows, parseClaudeUsage, parseGeminiUsage, PLAN_NAME } from './plan-limits';

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
    expect(parseClaudeUsage('  Current session: <1% used · resets 11pm (Europe/London)')).toEqual([{ label: 'Session', usedPercent: 1, resets: '11pm' }]);
  });
  it('names Codex windows by their length', () => {
    expect(codexWindow({ usedPercent: 3, windowDurationMins: 10080, resetsAt: 1793536297 })).toEqual({ label: 'Week', usedPercent: 3, resets: new Date(1793536297000).toISOString() });
    expect(codexWindow({ usedPercent: 40, windowDurationMins: 300, resetsAt: null })).toEqual({ label: 'Session', usedPercent: 40, resets: null });
  });
  it('checks what Codex reports instead of trusting it, and tells two windows of one name apart', () => {
    // Before, a reset time that is not seconds threw inside the reader, and a missing share showed as NaN%.
    expect(codexWindow({ usedPercent: 3, windowDurationMins: 10080, resetsAt: '2026-11-18T18:26:48Z' })).toEqual({ label: 'Week', usedPercent: 3, resets: '2026-11-18T18:26:48.000Z' });
    expect(codexWindow({ usedPercent: 3, windowDurationMins: 10080, resetsAt: 'soon' })).toEqual({ label: 'Week', usedPercent: 3, resets: null });
    expect(codexWindow({ windowDurationMins: 300, resetsAt: null })).toBeNull(); expect(codexWindow({ usedPercent: '40' })).toBeNull(); expect(codexWindow(null)).toBeNull();
    expect(codexWindows([{ usedPercent: 10, windowDurationMins: 60, resetsAt: null }, { usedPercent: 20, windowDurationMins: 300, resetsAt: null }, { used: 1 }]).map((window) => window.label)).toEqual(['Session (1 h)', 'Session (5 h)']);
    expect(codexWindows([{ usedPercent: 3, windowDurationMins: 10080, resetsAt: null }, { usedPercent: 40, windowDurationMins: 300, resetsAt: null }]).map((window) => window.label)).toEqual(['Session', 'Week']);
  });
});

describe('Gemini CLI plan limits', () => {
  // agy 1.5.12's reply to -p "/usage" --output-format json, cut to its fields.
  const reply = (groups: unknown) => JSON.stringify({ conversation_id: '', status: 'SUCCESS', command: { name: 'usage', data: { groups } } });
  const groups = [
    { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9848442077636719, reset_time: '2026-11-26T04:49:19Z' }, { id: 'gemini-5h', window: '5h', remaining_fraction: 0.9719548225402832, reset_time: '2026-11-19T09:49:19Z' }] },
    { name: 'Claude and GPT models', buckets: [{ window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-26T04:53:50Z' }] },
    { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remaining_fraction: 0.5 }] },
  ];
  it('reads each group’s share used: Gemini’s own models as Session and Week, the others by name', () => {
    expect(parseGeminiUsage(reply(groups))).toEqual([
      { label: 'Session', usedPercent: 2.8, resets: '2026-11-19T09:49:19.000Z' }, { label: 'Week', usedPercent: 1.5, resets: '2026-11-26T04:49:19.000Z' },
      { label: 'Week (Claude and GPT models)', usedPercent: 0, resets: '2026-11-26T04:53:50.000Z' }, { label: 'Week (Gemini 4 Argon)', usedPercent: 50, resets: null },
    ]);
  });
  it('is null for another reply, and skips a bucket it cannot read', () => {
    expect(parseGeminiUsage('not json')).toBeNull(); expect(parseGeminiUsage(JSON.stringify({ command: { name: 'model' } }))).toBeNull();
    expect(parseGeminiUsage(reply([{ name: 'X', buckets: [{ window: 'weekly', remaining_fraction: 2 }, { window: 'daily', remaining_fraction: 0.5 }, { window: '5h', remaining_fraction: 0.25 }] }]))).toEqual([{ label: 'Session', usedPercent: 75, resets: null }]);
  });
  it('names each engine’s plan', () => { expect(PLAN_NAME).toEqual({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }); });
});
