import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoundTableState } from '../../shared/chat';
import type { Session } from '../../shared/types';
import { savedWorkspaceSchema } from '../../shared/schemas';
import { arrangeTiles, channelNumber, channelsFullNote, channelsOf, createSession, savedWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { channelAlerts } from '../state/channel-state';
import { useChatStore } from '../state/chat-store';
import { forgetTable, hierarchyDetached, openRoundTable, rememberTable, restoreTables } from './round-table';
import { closeChannel, startSession, stopSession } from './use-native-host';

// Chat channels draw no terminal; the real module needs a DOM.
vi.mock('./terminals', () => ({ focusTerminal: () => {}, routeTerminalEvent: () => {}, terminalDimensions: () => ({ cols: 100, rows: 24 }), releaseRemovedTerminals: () => {} }));

const RUN_A ='11111111-1111-4111-8111-111111111111'; const RUN_B = '22222222-2222-4222-8222-222222222222';
afterEach(() => { vi.unstubAllGlobals(); useChatStore.setState({ threads: {} }); });

const claudeChat = () => ({ ...createSession('claude'), config: { engine: 'claude' as const, chat: true, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } });
function seated() {
  const lead = claudeChat();
  const partner = { ...createSession('codex'), config: { engine: 'codex' as const, chat: true, model: '', reasoningEffort: null } };
  useWorkspaceStore.setState({ sessions: [lead, partner], tiles: arrangeTiles([lead, partner], 'columns') });
  const table: RoundTableState = { partner: { sessionId: partner.id, runId: RUN_B, engine: 'codex' }, driver: 'codex', rounds: 3, round: 0, phase: 'idle', agreed: false };
  return { lead, partner, table };
}
const run = (id: string, runId: string) => useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, status: 'running' as const, runId } : session) }));
const find = (id: string) => useWorkspaceStore.getState().sessions.find((session) => session.id === id);

/**
 * A desktop host that starts and stops runs at once, as the window sees it: `started` before the start call returns,
 * `exit` right after a stop. Records the stops and the chat requests.
 */
function host(chatResult: { ok: boolean; error?: { message: string } } = { ok: true }) {
  const stops: string[] = []; const chats: { action: string }[] = []; let next = 0;
  const codingHub = {
    startSession: vi.fn(async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
      const runId = `0000000${next++}-1111-4111-8111-111111111111`; const engine = find(sessionId)!.config.engine;
      return { ok: true, value: { sessionId, runId, pid: 10 + next, cwd, engine } };
    }),
    stopSession: vi.fn(async ({ sessionId, runId }: { sessionId: string; runId: string }) => {
      stops.push(sessionId); setTimeout(() => useWorkspaceStore.getState().applyEvent({ type: 'exit', sessionId, runId, exitCode: 0 }), 5);
      return { ok: true, value: undefined };
    }),
    chat: vi.fn(async (request: { action: string }) => { chats.push(request); return chatResult; }),
  };
  vi.stubGlobal('window', { codingHub }); vi.stubGlobal('document', { querySelector: () => null }); vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
  useWorkspaceStore.setState({ persistenceReady: true, rootDirectory: '/project' });
  return { codingHub, stops, chats };
}
async function runningLead(others: Session[] = []) {
  const lead = claudeChat(); useWorkspaceStore.setState({ sessions: [lead, ...others], tiles: arrangeTiles([lead, ...others], 'grid'), layoutMode: 'grid' });
  await startSession(lead.id); return find(lead.id)!;
}

describe('Round Tables across restarts', () => {
  it('saves the table with the leading channel and opens it again once both chats run, once per pair of runs', () => {
    const { lead, partner, table } = seated();
    rememberTable(lead.id, table);
    const saved = savedWorkspace();
    expect(saved.sessions[0].roundTable).toEqual({ partner: partner.id, driver: 'codex', rounds: 3 });
    expect(savedWorkspaceSchema.safeParse(saved).success).toBe(true);
    // As the app holds it once seated: the partner has no tile of its own, and that still saves.
    useWorkspaceStore.getState().arrange('grid');
    expect(savedWorkspace().tiles.map((tile) => tile.sessionId)).toEqual([lead.id]);
    expect(savedWorkspaceSchema.safeParse(savedWorkspace()).success).toBe(true);
    // A visible channel without a tile is still refused.
    const unseated = savedWorkspace(); unseated.sessions = unseated.sessions.map(({ roundTable: _, ...session }) => session);
    expect(savedWorkspaceSchema.safeParse(unseated).success).toBe(false);
    const chat = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', { codingHub: { chat } });
    run(lead.id, RUN_A); restoreTables();
    expect(chat).not.toHaveBeenCalled();
    run(partner.id, RUN_B); restoreTables(); restoreTables();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith({ action: 'table-open', sessionId: lead.id, runId: RUN_A, partner: { sessionId: partner.id, runId: RUN_B }, driver: 'codex', rounds: 3 });
  });
  it('forgets a table the person closed and removes its stopped partner, and does not save one whose partner channel is gone', async () => {
    const { lead, partner, table } = seated();
    rememberTable(lead.id, table); await forgetTable(lead.id);
    expect(savedWorkspace().sessions.map((session) => [session.id, session.roundTable])).toEqual([[lead.id, undefined]]);
    useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions, partner] }));
    rememberTable(lead.id, table);
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.filter((session) => session.id !== partner.id) }));
    expect(savedWorkspace().sessions[0].roundTable).toBeUndefined();
  });
});

describe('A Round Table in one tile', () => {
  it('leaves the partner out of the tiles, channel numbers and Alt keys, and reports its approval under the lead', () => {
    const { lead, partner, table } = seated(); const shell = createSession('shell');
    useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions, shell] }));
    rememberTable(lead.id, table);
    const { sessions } = useWorkspaceStore.getState();
    expect(channelsOf(sessions).map((session) => session.id)).toEqual([lead.id, shell.id]);
    expect(arrangeTiles(sessions, 'columns').map((tile) => tile.sessionId)).toEqual([lead.id, shell.id]);
    expect([channelNumber(sessions, lead.id), channelNumber(sessions, partner.id), channelNumber(sessions, shell.id)]).toEqual([1, 1, 2]);
    const waiting = sessions.map((session) => session.id === partner.id ? { ...session, status: 'running' as const, runId: RUN_B, attention: { message: 'Approve Bash', at: new Date().toISOString() } } : session);
    expect(channelAlerts(waiting, [])).toEqual([{ sessionId: partner.id, channel: 1, state: 'waiting', text: 'CH1 Codex needs approval' }]);
  });
  it('hides the partner of a table saved by 1.16 on load, and lays the tiles out again without it', () => {
    const { lead, partner } = seated(); const tiles = arrangeTiles([lead, partner], 'columns');
    useWorkspaceStore.getState().hydrate({ version: 1, rootDirectory: '/project', sessions: [{ ...lead, roundTable: { partner: partner.id, driver: 'claude', rounds: 2 } }, partner], tiles, layoutMode: 'columns', focusedSessionId: partner.id }, { directory: '/data' } as never);
    const state = useWorkspaceStore.getState();
    expect(state.tiles.map((tile) => tile.sessionId)).toEqual([lead.id]); expect(state.focusedSessionId).toBeNull();
    expect(state.sessions.map((session) => session.id)).toEqual([lead.id, partner.id]);
  });
  it('seats the other agent with no tile, and stops and removes it again when the table cannot open', async () => {
    const shell = createSession('shell'); host();
    const lead = await runningLead([shell]);
    expect(await openRoundTable(lead.id)).toBeNull();
    const { sessions, tiles } = useWorkspaceStore.getState(); const partner = sessions.at(-1)!;
    expect(partner.config).toMatchObject({ engine: 'codex', chat: true }); expect(partner.status).toBe('running');
    expect(find(lead.id)!.roundTable).toEqual({ partner: partner.id, driver: 'claude', rounds: 2 });
    expect(tiles.map((tile) => tile.sessionId)).toEqual([lead.id, shell.id]);

    const failing = host({ ok: false, error: { message: 'One of these chats is already at a Round Table.' } });
    const other = await runningLead();
    expect(await openRoundTable(other.id)).toBe('One of these chats is already at a Round Table.');
    expect(failing.stops).toHaveLength(1); expect(useWorkspaceStore.getState().sessions.map((session) => session.id)).toEqual([other.id]);
    expect(find(other.id)!.roundTable).toBeUndefined();
  });
  it('stops, starts and closes the partner with its lead', async () => {
    const { stops, codingHub } = host();
    const lead = await runningLead(); await openRoundTable(lead.id);
    const partner = useWorkspaceStore.getState().sessions.at(-1)!;
    expect(await stopSession(lead.id)).toBe(true); expect(stops.sort()).toEqual([lead.id, partner.id].sort());
    await vi.waitFor(() => expect(find(partner.id)!.status).toBe('exited'));
    // Starting the lead again starts the partner; restoreTables seats them once both run.
    codingHub.startSession.mockClear(); await startSession(lead.id);
    expect(codingHub.startSession.mock.calls.map(([request]) => request.sessionId)).toEqual([lead.id, partner.id]);
    expect(find(partner.id)!.status).toBe('running');
    // Closing the lead's tile stops and removes both.
    const shell = createSession('shell'); useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions, shell] }));
    expect(await closeChannel(lead.id)).toBe(true);
    expect(useWorkspaceStore.getState().sessions.map((session) => session.id)).toEqual([shell.id]);
  });
  it('counts the hidden partner toward the eight, and says so', () => {
    const { lead, partner, table } = seated(); rememberTable(lead.id, table);
    const more = Array.from({ length: 6 }, () => createSession('shell'));
    const sessions = [...useWorkspaceStore.getState().sessions, ...more];
    expect(channelsOf(sessions)).toHaveLength(7); expect(sessions.find((session) => session.id === partner.id)).toBeDefined();
    expect(channelsFullNote(sessions)).toContain('a Round Table runs two agents in one channel');
    expect(channelsFullNote(more)).toBeNull();
  });
});

describe('Round Table tiles and seats that come and go', () => {
  it('drops the tile of a seat added as a channel (a table opened from a phone), and saves after the table closes', async () => {
    // The phone adds the partner as an ordinary chat channel, with a tile, before the table hides it.
    const { lead, partner, table } = seated(); expect(useWorkspaceStore.getState().tiles).toHaveLength(2);
    rememberTable(lead.id, table); expect(useWorkspaceStore.getState().tiles.map((tile) => tile.sessionId)).toEqual([lead.id]);
    await forgetTable(lead.id); expect(find(partner.id)).toBeUndefined();
    const saved = savedWorkspace(); expect(savedWorkspaceSchema.safeParse(saved).success).toBe(true); expect(saved.tiles.map((tile) => tile.sessionId)).toEqual([lead.id]);
  });
  it('saves matching tiles whatever left them behind: a removed seat’s tile goes, a channel without one gets one', () => {
    const { lead, partner } = seated(); const tiles = useWorkspaceStore.getState().tiles;
    useWorkspaceStore.setState({ sessions: [lead], tiles }); expect(savedWorkspaceSchema.safeParse(savedWorkspace()).success).toBe(true);
    useWorkspaceStore.setState({ sessions: [lead, partner], tiles: [tiles[0]], focusedSessionId: 'gone' });
    const saved = savedWorkspace(); expect(savedWorkspaceSchema.safeParse(saved).success).toBe(true); expect(saved.tiles).toHaveLength(2); expect(saved.focusedSessionId).toBeNull();
  });
  it('keeps a closed table’s findings that memory could not take, though its partner is gone', () => {
    const lead = { ...claudeChat(), roundTable: { partner: '44444444-4444-4444-8444-444444444444', driver: 'claude' as const, rounds: 2, findings: [{ id: 'F1', severity: 'high' as const, text: 'bug', evidence: 'a.ts:1', status: 'open' as const, response: '', check: '', reviewedAt: null, changedAt: null, round: 1, at: new Date().toISOString() }] } };
    useWorkspaceStore.setState({ sessions: [lead], tiles: arrangeTiles([lead], 'grid') });
    const saved = savedWorkspace(); expect(savedWorkspaceSchema.safeParse(saved).success).toBe(true); expect(saved.sessions[0].roundTable?.findings).toHaveLength(1);
  });
  it('refuses messages and tasks to a hierarchy channel whose table is not open, and says how to go on', () => {
    const lead = { ...claudeChat(), status: 'running' as const, runId: RUN_A }; const reviewer = { ...createSession('codex'), config: { engine: 'codex' as const, chat: true, model: '', reasoningEffort: null } }; const planner = claudeChat();
    const withTable = { ...lead, roundTable: { partner: reviewer.id, planner: planner.id, kind: 'hierarchy' as const, driver: 'claude' as const, rounds: 2 } };
    useWorkspaceStore.setState({ sessions: [withTable, reviewer, planner], tiles: arrangeTiles([withTable], 'grid') });
    expect(hierarchyDetached(lead.id)).toMatch(/stopped\. Press Reopen/);
    run(reviewer.id, RUN_B); run(planner.id, '33333333-3333-4333-8333-333333333333'); expect(hierarchyDetached(lead.id)).toMatch(/opening/);
    useChatStore.setState({ threads: { [lead.id]: { ...useChatStore.getState().threads[lead.id], table: { kind: 'hierarchy', partner: { sessionId: reviewer.id, runId: RUN_B, engine: 'codex' }, driver: 'claude', rounds: 2, round: 0, phase: 'idle', agreed: false } } as never } });
    expect(hierarchyDetached(lead.id)).toBeNull();
    useChatStore.setState({ threads: {} }); useWorkspaceStore.setState((state) => ({ sessions: state.sessions.filter((session) => session.id !== planner.id) }));
    expect(hierarchyDetached(lead.id)).toMatch(/lost its planner or reviewer/);
    expect(hierarchyDetached(reviewer.id)).toBeNull();
  });
});
