import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types';
import type { MemoryNote, UsageRecord } from '../../shared/hub';
import type { RoundTableState } from '../../shared/chat';
import { askForHandoff, handoffDue, handoffRequest, handoffSaved } from './auto-handoff';
import { useWorkspaceStore } from '../state/workspace-store';
import { useHubStore } from '../state/hub-store';
import { useChatStore } from '../state/chat-store';
import { useHandoffStore } from '../state/handoff-store';

// Chats draw no terminal; the real module needs a DOM.
vi.mock('./terminals', () => ({ submitTerminal: async () => true }));

const session = (patch: Partial<Session> = {}): Session => ({ id: 's1', title: 'Claude', config: { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }, binding: { mode: 'workspace' },
  status: 'running', pid: 1, runId: 'r1', runningCwd: '/p', error: null, createdAt: new Date().toISOString(), endedAt: null, exitCode: null, logFile: null, ...patch });
const usage = (used: number, limit: number): UsageRecord => ({ runId: 'r1', sessionId: 's1', engine: 'claude', model: 'm', cwd: '/p', timestamp: new Date().toISOString(), input: 1, output: 1, cached: 0, cacheWrite: 0, reasoning: null, context: { used, limit }, cost: null });

describe('asking an agent for a handoff near its context limit', () => {
  it('is due for a running agent at 80% of its context, with automatic memory on', () => {
    const one = session();
    expect(handoffDue(one, [one], usage(800_000, 1_000_000), {})).toBe(true);
    expect(handoffDue(one, [one], usage(790_000, 1_000_000), {})).toBe(false);
    // Just compacted: what was kept, not the old size.
    expect(handoffDue(one, [one], usage(34_597, 1_000_000), {})).toBe(false);
    // Claude has not reported its window yet: no share is guessed.
    expect(handoffDue(one, [one], usage(800_000, 0), {})).toBe(false); expect(handoffDue(one, [one], undefined, {})).toBe(false);
    expect(handoffDue(one, [one], usage(900_000, 1_000_000), { automaticMemory: false })).toBe(false);
  });
  it('is not due while the agent waits for an approval, is stopped, is a terminal or Gemini CLI, or sits at a Round Table', () => {
    const full = usage(900_000, 1_000_000);
    const waiting = session({ attention: { message: 'Approve npm test?', at: new Date().toISOString() } }); expect(handoffDue(waiting, [waiting], full, {})).toBe(false);
    const stopped = session({ status: 'exited', runId: null }); expect(handoffDue(stopped, [stopped], full, {})).toBe(false);
    const shell = session({ config: { engine: 'shell' } }); expect(handoffDue(shell, [shell], full, {})).toBe(false);
    const gemini = session({ config: { engine: 'gemini', model: '' } }); expect(handoffDue(gemini, [gemini], full, {})).toBe(false);
    const lead = session({ roundTable: { partner: 's2', driver: 'claude', rounds: 2 } }); const seat = session({ id: 's2' });
    expect(handoffDue(lead, [lead, seat], full, {})).toBe(false); expect(handoffDue(seat, [lead, seat], full, {})).toBe(false);
    const codex = session({ config: { engine: 'codex', model: '', reasoningEffort: null } }); expect(handoffDue(codex, [codex], full, {})).toBe(true);
  });
  it('counts a handoff as saved only when that agent wrote a note after it was asked', () => {
    const asked = Date.parse('2026-11-22T14:00:00Z'); const note = (author: 'claude' | 'codex' | 'human', at: string) => ({ author, createdAt: at });
    expect(handoffSaved([note('claude', '2026-11-22T14:01:10Z')], 'claude', asked)).toBe(true);
    expect(handoffSaved([note('claude', '2026-11-22T13:20:00Z'), note('codex', '2026-11-22T14:01:10Z'), note('human', '2026-11-22T14:02:00Z')], 'claude', asked)).toBe(false);
    expect(handoffSaved([], 'codex', asked)).toBe(false);
  });
  it('asks in one line, naming the tool and how full the context is', () => {
    const text = handoffRequest(84); expect(text).toContain('84%'); expect(text).toContain('write_handoff'); expect(text).not.toContain('\n');
    // A seat is asked while its table rests: told the server its tools come from, and to do nothing more.
    const seat = handoffRequest(90, 'trace_memory', true); expect(seat).toContain('(trace_memory)'); expect(seat).toContain('change nothing'); expect(seat).not.toContain('carry on');
  });
});

describe('a chat channel’s automatic handoff', () => {
  afterEach(() => { vi.unstubAllGlobals(); useHandoffStore.setState({ bySession: {} }); });
  it('tries a compaction refused as busy again at the next turn’s end, not counted as unsaved turns, keeps it as an earlier one back under the limit, and clears any other phase there', async () => {
    const chats: Record<string, unknown>[] = []; let compact = { ok: false, error: { code: 'CHAT_BUSY', message: 'busy' } } as { ok: boolean; error?: { code: string; message: string } };
    vi.stubGlobal('window', { codingHub: { chat: async (request: Record<string, unknown>) => { chats.push(request); return request.action === 'compact' ? compact : { ok: true, value: null }; }, hub: async (request: { action: string }) => ({ ok: true, value: request.action === 'memory-key' ? 'k' : [{ author: 'claude', createdAt: new Date(Date.now() + 1000).toISOString() }] }) } });
    const one = session({ id: 'c1', runId: 'rc1', config: { engine: 'claude', chat: true, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } });
    const at = (used: number) => useHubStore.setState({ usage: [{ ...usage(used, 1_000_000), sessionId: 'c1', runId: 'rc1' }], preferences: {} } as never);
    useWorkspaceStore.setState({ sessions: [one], rootDirectory: '/p' } as never); at(850_000);
    expect(await askForHandoff('c1', 0)).toBe(true); expect(useHandoffStore.getState().bySession.c1.phase).toBe('asked');
    // Saved, but the compaction is refused (a turn started first): still saved, and tried again.
    await askForHandoff('c1', 0); expect(useHandoffStore.getState().bySession.c1.phase).toBe('saved');
    // Busy over more turns than an unsaved handoff is given: still saved, not given up.
    for (let turn = 0; turn < 4; turn++) await askForHandoff('c1', 0); expect(useHandoffStore.getState().bySession.c1.phase).toBe('saved');
    compact = { ok: true }; await askForHandoff('c1', 0); expect(useHandoffStore.getState().bySession.c1.phase).toBe('compacted');
    expect(chats.filter((request) => request.action === 'compact')).toHaveLength(6);
    // Back under the limit: the compaction is kept as an earlier one (still told); another phase left from a climb is not.
    at(30_000); await askForHandoff('c1', 0); expect(useHandoffStore.getState().bySession.c1.phase).toBe('earlier');
    useHandoffStore.setState({ bySession: { c1: { runId: 'rc1', phase: 'saved' } } }); await askForHandoff('c1', 0); expect(useHandoffStore.getState().bySession.c1).toBeUndefined();
  });
  it('does not try a compaction again that is refused for another reason than busy', async () => {
    const chats: Record<string, unknown>[] = [];
    vi.stubGlobal('window', { codingHub: { chat: async (request: Record<string, unknown>) => { chats.push(request); return request.action === 'compact' ? { ok: false, error: { code: 'COMPACT_UNAVAILABLE', message: 'no' } } : { ok: true, value: null }; }, hub: async (request: { action: string }) => ({ ok: true, value: request.action === 'memory-key' ? 'k' : [{ author: 'claude', createdAt: new Date(Date.now() + 1000).toISOString() }] }) } });
    const one = session({ id: 'c2', runId: 'rc2', config: { engine: 'claude', chat: true, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } });
    useWorkspaceStore.setState({ sessions: [one], rootDirectory: '/p' } as never); useHubStore.setState({ usage: [{ ...usage(850_000, 1_000_000), sessionId: 'c2', runId: 'rc2' }], preferences: {} } as never);
    await askForHandoff('c2', 0); await askForHandoff('c2', 0); await askForHandoff('c2', 0);
    expect(chats.filter((request) => request.action === 'compact')).toHaveLength(1); expect(useHandoffStore.getState().bySession.c2.phase).toBe('saved');
  });
});

describe('a Round Table seat’s automatic handoff (1.47)', () => {
  const RUNS = { s1: '11111111-1111-4111-8111-111111111111', s2: '22222222-2222-4222-8222-222222222222', s3: '33333333-3333-4333-8333-333333333333' } as const;
  const idle: RoundTableState = { partner: { sessionId: 's2', runId: RUNS.s2, engine: 'codex' }, driver: 'claude', rounds: 2, round: 0, phase: 'idle', agreed: false };
  const table = { partner: 's2', driver: 'claude' as const, rounds: 2, seats: [{ session: 's1' }, { session: 's2' }, { session: 's3' }] };
  const lead = session({ runId: RUNS.s1, config: { engine: 'claude', chat: true, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }, roundTable: table });
  const codex = session({ id: 's2', runId: RUNS.s2, config: { engine: 'codex', chat: true, model: '', reasoningEffort: null } });
  const gemini = session({ id: 's3', runId: RUNS.s3, config: { engine: 'gemini', chat: true, model: '' } });
  const record = (id: keyof typeof RUNS, used: number, limit = 1_000_000): UsageRecord => ({ ...usage(used, limit), runId: RUNS[id], sessionId: id });
  afterEach(() => { vi.unstubAllGlobals(); useChatStore.setState({ threads: {} }); useHandoffStore.setState({ bySession: {} }); });

  it('is due for a Claude Code, Codex or Gemini seat at its limit only while the table rests', () => {
    const all = [lead, codex, gemini]; const full = usage(900_000, 1_000_000);
    for (const seat of all) expect(handoffDue(seat, all, full, {}, idle)).toBe(true);
    // A discussion under way, or a message of the person's waiting for the seats: not now.
    expect(handoffDue(codex, all, full, {}, { ...idle, phase: 'discussing' })).toBe(false); expect(handoffDue(codex, all, full, {}, { ...idle, waiting: 'Next' })).toBe(false);
    expect(handoffDue(codex, all, full, {}, null)).toBe(false);
    // Gemini reports no window (its terminal, or before agy says it): never due, as no share is guessed.
    expect(handoffDue(gemini, all, usage(900_000, 0), {}, idle)).toBe(false); expect(handoffDue(gemini, all, undefined, {}, idle)).toBe(false);
    // A hierarchy table's seats stay the person's.
    const chain = { ...lead, roundTable: { ...table, kind: 'hierarchy' as const } }; expect(handoffDue(codex, [chain, codex, gemini], full, {}, { ...idle, kind: 'hierarchy' })).toBe(false);
  });

  it('asks the seat at its limit through the table, then compacts it once its handoff is saved, a Gemini seat too', async () => {
    const chats: Record<string, unknown>[] = []; let notes: Pick<MemoryNote, 'author' | 'createdAt'>[] = [];
    const chat = vi.fn(async (request: Record<string, unknown>) => { chats.push(request); return { ok: true, value: null }; });
    vi.stubGlobal('window', { codingHub: { chat, hub: async (request: { action: string }) => ({ ok: true, value: request.action === 'memory-key' ? 'project-key' : notes }) } });
    useWorkspaceStore.setState({ sessions: [lead, codex, gemini], rootDirectory: '/p' } as never);
    useChatStore.setState({ threads: { s1: { table: idle } } } as never);
    useHubStore.setState({ usage: [record('s1', 100_000), record('s2', 850_000), record('s3', 100_000)], preferences: {} } as never);
    // The lead's turn ended: the Codex seat is at 85%, so it alone is asked, through the table.
    expect(await askForHandoff('s1', 0)).toBe(true);
    expect(chats).toEqual([{ action: 'table-handoff', sessionId: 's1', runId: RUNS.s1, seat: { sessionId: 's2', runId: RUNS.s2 }, percent: 85 }]);
    expect(useHandoffStore.getState().bySession.s2).toEqual({ runId: RUNS.s2, phase: 'asked' });
    // Asked once each climb: another turn's end does not ask it again.
    expect(await askForHandoff('s1', 0)).toBe(false); expect(chats).toHaveLength(1);
    // Its handoff turn ended with the note saved: compacted through the table.
    notes = [{ author: 'codex', createdAt: new Date().toISOString() }];
    await askForHandoff('s2', 0);
    expect(chats.at(-1)).toEqual({ action: 'table-compact', sessionId: 's1', runId: RUNS.s1, seat: { sessionId: 's2', runId: RUNS.s2 } });
    expect(useHandoffStore.getState().bySession.s2.phase).toBe('compacted');
    // The Gemini seat climbs: asked, and compacted once saved.
    useHubStore.setState({ usage: [record('s1', 100_000), record('s2', 30_000), record('s3', 950_000, 1_048_576)] } as never);
    expect(await askForHandoff('s2', 0)).toBe(true); expect(chats.at(-1)).toMatchObject({ action: 'table-handoff', seat: { sessionId: 's3' }, percent: 91 });
    notes = [{ author: 'gemini', createdAt: new Date().toISOString() }]; const count = chats.length;
    await askForHandoff('s3', 0);
    expect(chats.slice(count)).toEqual([{ action: 'table-compact', sessionId: 's1', runId: RUNS.s1, seat: { sessionId: 's3', runId: RUNS.s3 } }]); expect(useHandoffStore.getState().bySession.s3.phase).toBe('compacted');
  });
  it('leaves a seat saved when the host cannot compact it (agy has not listed its command yet), and does not try again', async () => {
    const chats: Record<string, unknown>[] = [];
    vi.stubGlobal('window', { codingHub: { chat: async (request: Record<string, unknown>) => { chats.push(request); return request.action === 'table-compact' ? { ok: false, error: { code: 'COMPACT_UNAVAILABLE', message: 'Gemini cannot compact its conversation from Trace.' } } : { ok: true, value: null }; }, hub: async (request: { action: string }) => ({ ok: true, value: request.action === 'memory-key' ? 'k' : [{ author: 'gemini', createdAt: new Date().toISOString() }] }) } });
    const fresh = { ...gemini, runId: '44444444-4444-4444-8444-444444444444' };
    useWorkspaceStore.setState({ sessions: [lead, codex, fresh], rootDirectory: '/p' } as never); useChatStore.setState({ threads: { s1: { table: idle } } } as never);
    useHubStore.setState({ usage: [record('s1', 10_000), record('s2', 10_000), { ...record('s3', 960_000), runId: fresh.runId }], preferences: {} } as never);
    expect(await askForHandoff('s1', 0)).toBe(true); await askForHandoff('s3', 0);
    expect(useHandoffStore.getState().bySession.s3.phase).toBe('saved'); const count = chats.length;
    await askForHandoff('s1', 0); expect(chats).toHaveLength(count);
  });

  it('asks nobody while the table works or a seat waits for an approval, and asks again later if the table refused', async () => {
    const chats: Record<string, unknown>[] = []; let answer: { ok: boolean; error?: { code: string; message: string } } = { ok: false, error: { code: 'TABLE_BUSY', message: 'busy' } };
    vi.stubGlobal('window', { codingHub: { chat: async (request: Record<string, unknown>) => { chats.push(request); return answer; }, hub: async () => ({ ok: true, value: [] }) } });
    const waiting = { ...codex, attention: { message: 'Approve npm test?', at: new Date().toISOString() } };
    useWorkspaceStore.setState({ sessions: [lead, waiting, gemini], rootDirectory: '/p' } as never);
    useHubStore.setState({ usage: [record('s1', 100_000), record('s2', 850_000), record('s3', 100_000)], preferences: {} } as never);
    useChatStore.setState({ threads: { s1: { table: { ...idle, phase: 'answering' } } } } as never);
    expect(await askForHandoff('s1', 0)).toBe(false); expect(chats).toEqual([]);
    useChatStore.setState({ threads: { s1: { table: idle } } } as never);
    expect(await askForHandoff('s1', 0)).toBe(false); expect(chats).toEqual([]);
    // Free again, but a seat still busy as the host sees it: refused, and asked at the next turn's end.
    useWorkspaceStore.setState({ sessions: [lead, codex, gemini] } as never);
    expect(await askForHandoff('s1', 0)).toBe(false); expect(chats).toHaveLength(1); expect(useHandoffStore.getState().bySession.s2).toBeUndefined();
    answer = { ok: true }; expect(await askForHandoff('s1', 0)).toBe(true); expect(chats).toHaveLength(2);
  });
});
