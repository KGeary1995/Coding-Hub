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
    expect(handoffShown(one, [one], full, {}, 'saved')).toBe('saved'); // Compacted was the last climb's: at the limit again, it is asked at turn end.
    expect(handoffShown(one, [one], full, {}, 'compacted')).toBe('at-turn-end');
    // The agent ended three turns without saving it: the person's to write.
    expect(handoffShown(one, [one], full, {}, 'not-saved')).toBe('manual');
    expect(HANDOFF_LABEL['at-turn-end']).toBe('Handoff at turn end'); expect(HANDOFF_LABEL.manual).toBe('Write handoff');
  });
  it('leaves it to the person where Trace does not ask: automatic memory off, Gemini on its own, a hierarchy table, a budget', () => {
    const full = usage(850_000, 1_000_000);
    const one = session(); expect(handoffShown(one, [one], full, { automaticMemory: false })).toBe('manual');
    const gemini = session({ config: { engine: 'gemini', model: '' } }); expect(handoffShown(gemini, [gemini], full, {})).toBe('manual');
    const geminiChat = session({ config: { engine: 'gemini', chat: true, model: '' } }); expect(handoffShown(geminiChat, [geminiChat], full, {})).toBe('manual');
    const chain = session({ roundTable: { partner: 's2', driver: 'claude', rounds: 2, kind: 'hierarchy', planner: 's3' } }); const builder = session({ id: 's2' });
    expect(handoffShown(chain, [chain, builder], full, {})).toBe('manual'); expect(handoffShown(builder, [chain, builder], full, {})).toBe('manual');
    // Near a token budget, with the context well under its limit: a handoff does nothing for a budget.
    const budgeted = session({ budget: { tokens: 10, costUSD: null, contextPercent: 0 } }); expect(handoffShown(budgeted, [budgeted], usage(100_000, 1_000_000), {})).toBe('manual');
  });
  it('says what Trace is doing for a discussion Round Table’s seats (1.47), Gemini’s too', () => {
    const full = usage(850_000, 1_000_000);
    const lead = session({ roundTable: { partner: 's2', driver: 'claude', rounds: 2 } }); const codex = session({ id: 's2', config: { engine: 'codex', chat: true, model: '', reasoningEffort: null } });
    const gemini = session({ id: 's3', config: { engine: 'gemini', chat: true, model: '' } }); const all = [lead, codex, gemini];
    const seated = { ...lead, roundTable: { ...lead.roundTable!, seats: [{ session: 's1' }, { session: 's2' }, { session: 's3' }] } }; const table = [seated, codex, gemini];
    expect(handoffShown(lead, all, full, {})).toBe('at-turn-end'); expect(handoffShown(codex, table, full, {}, 'asked')).toBe('asked'); expect(handoffShown(gemini, table, full, {}, 'saved')).toBe('saved');
    expect(handoffShown(gemini, table, full, {})).toBe('at-turn-end'); expect(handoffShown(gemini, table, full, {}, 'compacted')).toBe('at-turn-end');
    // The table is not open (a seat stopped, or it closed with findings kept): Trace cannot ask, so the person writes it.
    expect(handoffShown(lead, all, full, {}, undefined, false)).toBe('manual'); expect(handoffShown(codex, table, full, {}, 'saved', false)).toBe('manual');
    const plain = session(); expect(handoffShown(plain, [plain], full, {}, undefined, false)).toBe('at-turn-end');
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
  it('in Needs you, lists a hidden seat near its limit under its lead’s channel, with what Trace is doing for it (1.47)', () => {
    const lead = session({ roundTable: { partner: 's2', driver: 'claude', rounds: 2 } }); const gemini = session({ id: 's2', runId: 'r2', config: { engine: 'gemini', chat: true, model: '' } });
    useWorkspaceStore.setState({ sessions: [lead, gemini], tiles: [{ sessionId: 's1', x: 0, y: 0, w: 1, h: 1 }] } as never);
    const records = [usage(10_000, 1_000_000), usage(950_000, 1_048_576, 's2', 'r2')]; const phases = { s2: { runId: 'r2' as const, phase: 'saved' as const } };
    const item = needsYou([lead, gemini], records, [], { s1: { phase: 'idle' } as never }, [], { phases }).find((each) => each.kind === 'limit');
    expect(item).toMatchObject({ sessionId: 's2', action: 'open', title: expect.stringContaining('CH1') }); expect(item?.detail).toContain('Trace compacts it');
    // Its table not open: Trace cannot ask or compact it, so the person writes the handoff.
    expect(needsYou([lead, gemini], records, [], {}, [], { phases }).find((each) => each.kind === 'limit')).toMatchObject({ action: 'handoff' });
  });
});
