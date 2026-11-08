import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoundTableState } from '../../shared/chat';
import type { Session } from '../../shared/types';
import { savedWorkspaceSchema } from '../../shared/schemas';
import { arrangeTiles, channelNumber, channelsFullNote, channelsOf, createSession, savedWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { channelAlerts } from '../state/channel-state';
import { useChatStore } from '../state/chat-store';
import { forgetTable, openRoundTable, rememberTable, restoreTables } from './round-table';
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
