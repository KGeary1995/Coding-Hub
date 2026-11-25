import { beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types';
import type { UsageRecord } from '../../shared/hub';
import { HANDOFF_LABEL, handoffPhase, handoffShown, setHandoffPhase, useHandoffStore } from './handoff-store';
import { needsYou } from './needs-you';
import { useWorkspaceStore } from './workspace-store';

const session = (patch: Partial<Session> = {}): Session => ({ id: 's1', title: 'Claude', config: { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }, binding: { mode: 'workspace' },
  status: 'running', pid: 1, runId: 'r1', runningCwd: '/p', error: null, createdAt: new Date().toISOString(), endedAt: null, exitCode: null, logFile: null, ...patch });
const usage = (used: number, limit: number, sessionId = 's1', runId = 'r1'): UsageRecord => ({ runId, sessionId, engine: 'claude', model: 'm', cwd: '/p', timestamp: new Date().toISOString(), input: 1, output: 1, cached: 0, cacheWrite: 0, reasoning: null, context: { used, limit }, cost: 0 } as UsageRecord);

describe('what a channel near its limit shows about its handoff', () => {
  beforeEach(() => useHandoffStore.setState({ bySession: {} }));
  it('says what Trace is doing for a Claude Code or Codex channel near the end of its context', () => {
    const one = session(); const full = usage(850_000, 1_000_000);
    expect(handoffShown(one, [one], full, {})).toBe('at-turn-end');
    expect(handoffShown(one, [one], full, {}, 'asked')).toBe('asked');
    expect(handoffShown(one, [one], full, {}, 'saved')).toBe('saved'); expect(handoffShown(one, [one], full, {}, 'compacted')).toBe('saved');
    // The agent ended three turns without saving it: the person's to write.
    expect(handoffShown(one, [one], full, {}, 'not-saved')).toBe('manual');
    expect(HANDOFF_LABEL['at-turn-end']).toBe('Handoff at turn end'); expect(HANDOFF_LABEL.manual).toBe('Write handoff');
  });
  it('leaves it to the person where Trace does not ask: automatic memory off, Gemini, a Round Table, a budget', () => {
    const full = usage(850_000, 1_000_000);
    const one = session(); expect(handoffShown(one, [one], full, { automaticMemory: false })).toBe('manual');
    const gemini = session({ config: { engine: 'gemini', model: '' } }); expect(handoffShown(gemini, [gemini], full, {})).toBe('manual');
    const lead = session({ roundTable: { partner: 's2', driver: 'claude', rounds: 2 } }); expect(handoffShown(lead, [lead], full, {})).toBe('manual');
    // Near a token budget, with the context well under its limit: a handoff does nothing for a budget.
    const budgeted = session({ budget: { tokens: 10, costUSD: null, contextPercent: 0 } }); expect(handoffShown(budgeted, [budgeted], usage(100_000, 1_000_000), {})).toBe('manual');
  });
  it('keeps a phase for the run it belongs to: a restarted channel starts again', () => {
    setHandoffPhase('s1', 'r1', 'compacted');
    expect(handoffPhase(useHandoffStore.getState().bySession, { id: 's1', runId: 'r1' })).toBe('compacted');
    expect(handoffPhase(useHandoffStore.getState().bySession, { id: 's1', runId: 'r2' })).toBeUndefined();
    setHandoffPhase('s1', 'r1', null); expect(useHandoffStore.getState().bySession).toEqual({});
  });
  it('in Needs you, opens the channel and says Trace is saving it, or asks the person to write it', () => {
    const one = session(); useWorkspaceStore.setState({ sessions: [one], tiles: [{ sessionId: 's1', x: 0, y: 0, w: 1, h: 1 }] } as never);
    const records = [usage(850_000, 1_000_000)];
    const auto = needsYou([one], records, [], {}, [], { phases: { s1: { runId: 'r1', phase: 'asked' } } }).find((item) => item.kind === 'limit');
    expect(auto).toMatchObject({ action: 'open' }); expect(auto?.detail).toContain('Trace asked it to save a handoff');
    const manual = needsYou([one], records, [], {}, [], { phases: {}, automaticMemory: false }).find((item) => item.kind === 'limit');
    expect(manual).toMatchObject({ action: 'handoff' }); expect(manual?.detail).toContain('write a handoff');
  });
});
