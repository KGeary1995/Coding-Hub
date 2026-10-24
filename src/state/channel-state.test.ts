import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types';
import type { UsageRecord } from '../../shared/hub';
import { CHANNEL_STATES, channelAlerts, channelState, todayTotals } from './channel-state';
import { ACTIVITY_WINDOW, activitySamples, forgetActivity, isPersonInput, recordActivity, tickActivity, useActivityStore } from './activity-store';
import { arrangeTiles, createSession, savedWorkspace, useWorkspaceStore } from './workspace-store';

const session = (patch: Partial<Session> = {}): Session => ({ ...createSession('codex'), runId: 'run-1', status: 'running', ...patch });
const usage = (patch: Partial<UsageRecord> = {}): UsageRecord => ({ runId: 'run-1', sessionId: 's', engine: 'codex', model: 'm', cwd: '/p', timestamp: new Date().toISOString(), input: 100, output: 20, cached: 0, cacheWrite: 0, reasoning: null, context: null, cost: null, ...patch });

describe('channel state', () => {
  it('maps every session lifecycle to one of the seven states', () => {
    expect(channelState(session({ status: 'idle', runId: null }))).toBe('idle');
    expect(channelState(session({ status: 'starting' }))).toBe('starting');
    expect(channelState(session())).toBe('working');
    expect(channelState(session({ attention: { message: 'Approve edit?', at: '' } }))).toBe('waiting');
    expect(channelState(session({ status: 'exited', exitCode: 0 }))).toBe('finished');
    expect(channelState(session({ status: 'exited', exitCode: 1, error: 'CLI exited with code 1.' }))).toBe('failed');
    expect(channelState(session({ status: 'error', error: 'PTY failed' }))).toBe('failed');
    expect(channelState(session(), usage({ context: { used: 160, limit: 200 } }))).toBe('limit');
    expect(Object.keys(CHANNEL_STATES)).toHaveLength(7);
  });
  it('treats a stopped run as finished, and waits over a near limit', () => {
    expect(channelState(session({ status: 'exited', exitCode: 143, error: null }))).toBe('finished');
    expect(channelState(session({ attention: { message: '', at: '' } }), usage({ context: { used: 190, limit: 200 } }))).toBe('waiting');
  });
  it('uses 80% of the context window or the session budget as the limit threshold', () => {
    expect(channelState(session(), usage({ context: { used: 159, limit: 200 } }))).toBe('working');
    expect(channelState(session({ budget: { tokens: 1000, costUSD: null, contextPercent: 100 } }), usage({ input: 700, output: 100 }))).toBe('limit');
    expect(channelState(session({ budget: { tokens: 1000, costUSD: null, contextPercent: 100 } }), usage({ input: 600, output: 100 }))).toBe('working');
    expect(channelState(session({ budget: { tokens: null, costUSD: 1, contextPercent: 100 } }), usage({ cost: 0.85 }))).toBe('limit');
    expect(channelState(session({ budget: { tokens: null, costUSD: null, contextPercent: 50 } }), usage({ context: { used: 82, limit: 200 } }))).toBe('limit');
  });
});

describe('alerts and totals', () => {
  it('orders alerts waiting, failed, limit and numbers channels by tile order', () => {
    const sessions = [session({ id: 'a', runId: 'ra', status: 'exited', exitCode: 2, error: 'boom' }), session({ id: 'b', runId: 'rb' }), session({ id: 'c', runId: 'rc', attention: { message: 'x', at: '' } }), session({ id: 'd', runId: 'rd' })];
    const records = [usage({ runId: 'rb', context: { used: 184, limit: 200 } }), usage({ runId: 'rd' })];
    expect(channelAlerts(sessions, records).map((alert) => alert.text)).toEqual(['CH3 needs approval', 'CH1 failed', 'CH2 ctx 92%']);
  });
  it("sums today's input and output tokens, excluding cache, and leaves cost null when nothing is priced", () => {
    const now = new Date(2026, 9, 24, 15); const yesterday = new Date(2026, 9, 23, 23);
    // Claude reports cache reads apart from input; Codex counts them inside input, so they are taken out.
    expect(todayTotals([usage({ engine: 'claude', timestamp: now.toISOString(), cached: 9999 }), usage({ timestamp: yesterday.toISOString() })], now)).toEqual({ tokens: 120, cost: null });
    expect(todayTotals([usage({ timestamp: now.toISOString(), input: 100, cached: 40, output: 20 })], now)).toEqual({ tokens: 80, cost: null });
    expect(todayTotals([usage({ timestamp: now.toISOString(), cost: 0.25 }), usage({ timestamp: now.toISOString(), cost: 0.5 })], now)).toEqual({ tokens: 240, cost: 0.75 });
  });
});

describe('terminal activity', () => {
  afterEach(() => { forgetActivity('t'); useActivityStore.setState({ samples: {} }); });
  it('keeps a 120 s window of output per second, oldest first, and drops quiet channels', () => {
    recordActivity('t', 10); recordActivity('t', 5); tickActivity();
    expect(activitySamples('t')).toHaveLength(ACTIVITY_WINDOW); expect(activitySamples('t').at(-1)).toBe(15);
    recordActivity('t', 7); tickActivity(); expect(activitySamples('t').slice(-2)).toEqual([15, 7]);
    for (let second = 0; second < ACTIVITY_WINDOW; second++) tickActivity();
    expect(useActivityStore.getState().samples).not.toHaveProperty('t'); expect(activitySamples('t').every((value) => value === 0)).toBe(true);
  });
  it('ignores focus and mouse reports as answers', () => {
    expect(isPersonInput('\x1b[I')).toBe(false); expect(isPersonInput('\x1b[O\x1b[<0;10;5M\x1b[<0;10;5m')).toBe(false);
    expect(isPersonInput('y')).toBe(true); expect(isPersonInput('\r')).toBe(true); expect(isPersonInput('\x1b[I1')).toBe(true);
  });
});

describe('attention in the workspace store', () => {
  beforeEach(() => { const sessions = [createSession('claude'), createSession('codex')]; useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'columns') }); });
  it('marks the running run as waiting, clears it on input or exit, and never saves it', () => {
    const state = useWorkspaceStore.getState(); const id = state.sessions[0].id; const snapshot = savedWorkspace();
    state.markStarting(id); state.applyEvent({ type: 'started', sessionId: id, runId: 'r1', engine: 'claude', pid: 1, cwd: '/p' });
    state.applyEvent({ type: 'attention', sessionId: id, runId: 'other-run', message: 'stale' });
    expect(useWorkspaceStore.getState().sessions[0].attention).toBeNull();
    state.applyEvent({ type: 'attention', sessionId: id, runId: 'r1', message: 'Claude needs your permission to use Bash' });
    expect(useWorkspaceStore.getState().sessions[0].attention?.message).toBe('Claude needs your permission to use Bash');
    expect(savedWorkspace()).toEqual(snapshot);
    state.clearAttention(id, '2000-01-01T00:00:00.000Z'); expect(useWorkspaceStore.getState().sessions[0].attention?.message).toBe('Claude needs your permission to use Bash');
    state.clearAttention(id, new Date(Date.now() + 1000).toISOString()); expect(useWorkspaceStore.getState().sessions[0].attention).toBeNull();
    state.applyEvent({ type: 'attention', sessionId: id, runId: 'r1', message: 'again' });
    state.applyEvent({ type: 'exit', sessionId: id, runId: 'r1', exitCode: 0 });
    expect(useWorkspaceStore.getState().sessions[0].attention).toBeNull();
  });
});
