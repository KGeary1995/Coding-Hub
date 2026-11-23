import { describe, expect, it } from 'vitest';
import type { PlanLimits } from '../../../shared/plan-limits';
import { accountWarnings, planReading, scrollToTile } from './StatusBar';

const reading = (extra: Partial<PlanLimits> = {}): PlanLimits => ({ engine: 'claude', account: 'Default', windows: [], plan: null, checkedAt: '2026-11-18T10:00:00.000Z', error: null, ...extra });
const window = (label: string, usedPercent: number) => ({ label, usedPercent, resets: null });

describe('an engine’s plan cell in the status bar', () => {
  it('leaves whole when no account has a limit or an error', () => {
    expect(planReading([])).toBeNull();
    expect(planReading([reading(), reading({ account: 'Work' })])).toBeNull();
  });
  it('shows the default login’s 5-hour and weekly limits', () => {
    expect(planReading([reading({ account: 'Work', windows: [window('Session', 90)] }), reading({ windows: [window('Session', 12), window('Week', 40), window('Week (Fable)', 70)] })])).toEqual([window('Session', 12), window('Week', 40)]);
  });
  it('shows the fullest other limit when the login has neither of those', () => {
    expect(planReading([reading({ engine: 'codex', windows: [window('24 h', 20), window('Limit', 55)] })])).toEqual([window('Limit', 55)]);
  });
  it('keeps the cell, with nothing to count, for an error or when only another account has limits', () => {
    expect(planReading([reading({ error: 'Sign in to Claude Code to see its limits.' })])).toEqual([]);
    expect(planReading([reading(), reading({ account: 'Work', windows: [window('Week', 30)] })])).toEqual([]);
  });
});

describe('a named account in use that nears its cap', () => {
  const all = [reading({ windows: [window('Session', 12), window('Week', 40)] }), reading({ account: 'Work', windows: [window('Session', 30), window('Week', 92)] }), reading({ account: 'Side', windows: [window('Week', 80)] })];
  it('is named in the bar with its fullest limit, once a channel runs on it', () => {
    expect(accountWarnings(all, new Set(['Work']))).toEqual([{ account: 'Work', window: window('Week', 92) }]);
    expect(accountWarnings(all, new Set(['Work', 'Side']))).toEqual([{ account: 'Work', window: window('Week', 92) }, { account: 'Side', window: window('Week', 80) }]);
  });
  it('says nothing of an account no channel runs on, of one with room, or of the reading the cell already shows', () => {
    expect(accountWarnings(all, new Set())).toEqual([]);
    expect(accountWarnings([all[0], reading({ account: 'Work', windows: [window('Week', 74)] })], new Set(['Work']))).toEqual([]);
    expect(accountWarnings([reading({ windows: [window('Week', 95)] })], new Set(['Default']))).toEqual([]);
    expect(accountWarnings([reading(), reading({ account: 'Work', error: 'Sign in to Claude Code to see its limits.' })], new Set(['Work']))).toEqual([]);
  });
});

describe('how far a grid scrolls to show the channel a person jumps to', () => {
  // The grid shows 52 to 764 of the window.
  const view = { top: 52, bottom: 764 };
  it('does not move for a tile that shows whole', () => {
    expect(scrollToTile({ top: 52, bottom: 404 }, view)).toBe(0);
    expect(scrollToTile({ top: 412, bottom: 764 }, view)).toBe(0);
  });
  it('scrolls down until a tile below ends at the grid’s lower edge, and up until one above starts at its upper edge', () => {
    expect(scrollToTile({ top: 772, bottom: 1124 }, view)).toBe(360);
    expect(scrollToTile({ top: 600, bottom: 952 }, view)).toBe(188);
    expect(scrollToTile({ top: -308, bottom: 44 }, view)).toBe(-360);
    expect(scrollToTile({ top: 20, bottom: 372 }, view)).toBe(-32);
  });
  it('shows a tile taller than the grid from its top edge, where its header and request are', () => {
    expect(scrollToTile({ top: 772, bottom: 1672 }, view)).toBe(720);
    expect(scrollToTile({ top: 300, bottom: 1200 }, view)).toBe(248);
    expect(scrollToTile({ top: -100, bottom: 800 }, view)).toBe(-152);
  });
});
