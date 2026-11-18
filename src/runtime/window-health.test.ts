import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WindowHealthReport } from '../../shared/ipc';
import { reportWindowHealth, watchWindowHealth, type WindowHealthEnvironment } from './window-health';

/** A page whose clock, visibility and long tasks the test sets; the timers are vitest's fake ones. */
function page() {
  let clock = 0; let visible = true; let task: ((start: number, duration: number, name: string) => void) | null = null; let visibility: (() => void) | null = null;
  const sent: WindowHealthReport[] = [];
  const env: WindowHealthEnvironment = { now: () => clock, visible: () => visible, longTasks: (listener) => { task = listener; return () => { task = null; }; }, onVisibility: (listener) => { visibility = listener; return () => { visibility = null; }; }, send: (report) => sent.push(report) };
  return {
    env, sent,
    /** The page is blocked for `ms` (the clock moves, no timer runs), then timers catch up. */
    block(ms: number) { clock += ms; },
    tick(ms: number) { for (let left = ms; left > 0; left -= 100) { clock += Math.min(100, left); vi.advanceTimersByTime(Math.min(100, left)); } },
    longTask: (start: number, duration: number) => task?.(start, duration, 'self'),
    hide() { visible = false; visibility?.(); }, show() { visible = true; visibility?.(); },
    get watching() { return Boolean(task || visibility); },
    get now() { return clock; },
  };
}

describe('the window stall record', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('records long tasks of 250 ms or more, and nothing shorter', () => {
    vi.useFakeTimers(); const view = page(); const stop = watchWindowHealth(view.env);
    view.longTask(0, 249); view.longTask(10, 250); view.longTask(20, 1834.6);
    expect(view.sent).toEqual([{ kind: 'long-task', ms: 250, detail: 'self' }, { kind: 'long-task', ms: 1835, detail: 'self' }]); stop();
  });
  it('records a visible window whose timers ran a second or more late, once', () => {
    vi.useFakeTimers(); const view = page(); const stop = watchWindowHealth(view.env);
    view.tick(1000); view.block(1500); view.tick(500); view.tick(2000);
    expect(view.sent).toEqual([{ kind: 'stall', ms: expect.any(Number), detail: 'visible' }]);
    expect(view.sent[0].ms).toBeGreaterThanOrEqual(1000); expect(view.sent[0].ms).toBeLessThanOrEqual(1500);
    // 900 ms late is not a stall.
    view.block(900); view.tick(3000); expect(view.sent).toHaveLength(1); stop();
  });
  it('does not count a hidden window, whose timers are slowed on purpose', () => {
    vi.useFakeTimers(); const view = page(); const stop = watchWindowHealth(view.env);
    view.tick(1000); view.hide(); view.block(5000); view.tick(2000); view.show(); view.tick(2000);
    expect(view.sent).toEqual([]); stop();
  });
  it('does not count a computer that slept as a stall, and watches on afterwards', () => {
    vi.useFakeTimers(); const view = page(); const stop = watchWindowHealth(view.env);
    view.tick(1000); view.block(10 * 60000); view.tick(3000); expect(view.sent).toEqual([]);
    view.block(1500); view.tick(3000); expect(view.sent.map((report) => report.kind)).toEqual(['stall']); stop();
  });
  it('does not record a stall twice when a long task already covers it', () => {
    vi.useFakeTimers(); const view = page(); const stop = watchWindowHealth(view.env);
    view.tick(1000); const start = view.now; view.block(2000); view.longTask(start, 1900); view.tick(3000);
    expect(view.sent.map((report) => report.kind)).toEqual(['long-task']); stop();
  });
  it('stops watching when told to', () => {
    vi.useFakeTimers(); const view = page(); const stop = watchWindowHealth(view.env); view.tick(1000); view.block(1500); stop();
    view.tick(3000); expect(view.sent).toEqual([]); expect(view.watching).toBe(false);
  });
  it('sends only a kind, a bounded length and a short plain label, at most ten a minute', () => {
    const reportHealth = vi.fn(async () => ({ ok: true as const, value: null })); vi.stubGlobal('window', { codingHub: { reportWindowHealth: reportHealth } });
    reportWindowHealth('context-lost', undefined, undefined, 0);
    reportWindowHealth('stall', 1234.6, 'terminal <b>write</b>', 1);
    reportWindowHealth('long-task', 99_999_999, 'x'.repeat(100), 2);
    reportWindowHealth('long-task', Number.NaN, '', 3);
    expect(reportHealth.mock.calls.map((call) => (call as unknown[])[0])).toEqual([{ kind: 'context-lost' }, { kind: 'stall', ms: 1235, detail: 'terminal bwrite/b' }, { kind: 'long-task', ms: 3_600_000, detail: 'x'.repeat(60) }, { kind: 'long-task' }]);
    for (let index = 0; index < 20; index++) reportWindowHealth('context-restored', undefined, undefined, 10 + index);
    expect(reportHealth).toHaveBeenCalledTimes(10);
    reportWindowHealth('context-restored', undefined, undefined, 70_000); expect(reportHealth).toHaveBeenCalledTimes(11);
  });
  it('does nothing outside Trace\'s window', () => {
    vi.stubGlobal('window', {}); expect(() => reportWindowHealth('stall', 1000, undefined, 0)).not.toThrow();
  });
});
