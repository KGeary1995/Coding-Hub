import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIERARCHY_MODELS, type RoundTableState } from '../../shared/chat';
import type { Session } from '../../shared/types';
import { savedWorkspaceSchema } from '../../shared/schemas';
import { arrangeTiles, channelNumber, channelsFullNote, channelsOf, createSession, savedWorkspace, tableDirectory, useWorkspaceStore } from '../state/workspace-store';
import { channelAlerts } from '../state/channel-state';
import { useChatStore } from '../state/chat-store';
import { changeSeats, forgetTable, hierarchyDetached, openHierarchy, openRoundTable, openTable, rememberTable, restoreTables, seatRoom, tableDetached, tableSeats } from './round-table';
import type { TablePreset } from '../../shared/table-seats';
import { closeChannel, remoteControl, startSession, stopSession } from './use-native-host';
import { useTaskStore } from '../state/task-store';
import type { Task } from '../../shared/workbench';

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
/** The model a session was last started with, as the host was asked. */
const startedModel = (codingHub: ReturnType<typeof host>['codingHub'], id: string) => { const calls = codingHub.startSession.mock.calls.map(([request]) => request as unknown as { sessionId: string; config: { model: string } }).filter((request) => request.sessionId === id); return calls[calls.length - 1]!.config.model; };
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
    // Seated again: both conversations resumed, so the host skips the joining summary.
    expect(chat).toHaveBeenCalledWith({ action: 'table-open', rejoin: true, sessionId: lead.id, runId: RUN_A, partner: { sessionId: partner.id, runId: RUN_B }, driver: 'codex', rounds: 3 });
  });
  it('does not serialize a hierarchy task\'s images to tell whether the saved table changed', () => {
    const { lead, table } = seated(); const image = { mediaType: 'image/png', data: 'A'.repeat(4096) };
    const chain = (images: unknown[]) => ({ step: 'planning' as const, task: 'T', plan: '', report: '', reviewRound: 0, finalRound: 0, verdict: null, note: '', images });
    const hierarchy = (images: unknown[]) => ({ ...table, kind: 'hierarchy' as const, chain: chain(images) } as RoundTableState);
    rememberTable(lead.id, hierarchy([image])); const before = useWorkspaceStore.getState().sessions;
    const stringify = vi.spyOn(JSON, 'stringify');
    rememberTable(lead.id, hierarchy([{ ...image }]));
    expect(useWorkspaceStore.getState().sessions).toBe(before);
    expect(stringify.mock.results.some((result) => String(result.value).includes(image.data))).toBe(false); stringify.mockRestore();
    rememberTable(lead.id, hierarchy([{ ...image, data: 'B' }]));
    expect(useWorkspaceStore.getState().sessions).not.toBe(before);
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
  it('closing a saved hierarchy table that is not open puts its waiting tasks from Tasks back in To do', async () => {
    const { lead, table } = seated(); const { codingHub } = host();
    const writes: unknown[] = []; Object.assign(codingHub, { workbench: vi.fn(async (request: { action: string }) => { if (request.action === 'task-status') writes.push(request); return { ok: true, value: request.action === 'task-list' ? useTaskStore.getState().tasks : null }; }) });
    const waiting: Task = { id: crypto.randomUUID(), title: 'Add a header', directory: '/project', sessionId: lead.id, scope: ['**'], status: 'active', notes: '', verificationId: null, createdAt: new Date().toISOString(), sentAt: new Date().toISOString() };
    useTaskStore.setState({ tasks: [waiting] });
    rememberTable(lead.id, { ...table, kind: 'hierarchy', chain: { step: 'final', task: 'Task: Add a footer.', plan: 'P', report: '', reviewRound: 0, finalRound: 0, verdict: null, note: '', nextTasks: ['Task: Add a header. End with TASK COMPLETE.'] } });
    await forgetTable(lead.id); await vi.waitFor(() => expect(writes).toEqual([{ action: 'task-status', id: waiting.id, status: 'queued' }]));
    expect(savedWorkspace().sessions.find((session) => session.id === lead.id)?.roundTable).toBeUndefined();
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
    expect(find(lead.id)!.roundTable).toEqual({ partner: partner.id, driver: 'claude', rounds: 2, seats: [{ session: lead.id }, { session: partner.id }], driverSeat: lead.id });
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
  it('starts a hierarchy table\'s reviewer on its own model, not Codex\'s default, and keeps one chosen under Models', async () => {
    const { codingHub } = host(); const modelOf = (id: string) => startedModel(codingHub, id);
    const lead = await runningLead(); await openHierarchy(lead.id);
    const reviewer = useWorkspaceStore.getState().sessions.find((session) => session.config.engine === 'codex')!;
    expect(modelOf(reviewer.id)).toBe(HIERARCHY_MODELS.reviewer); expect(HIERARCHY_MODELS.reviewer).toBe('gpt-6.1-sol');
    // A table saved before the reviewer had a model of its own (and before seats were saved): it gets the table's when it starts again.
    await stopSession(lead.id); await vi.waitFor(() => expect(find(reviewer.id)!.status).toBe('exited'));
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === reviewer.id ? { ...session, config: { engine: 'codex' as const, chat: true, model: '', reasoningEffort: null } } : session.id === lead.id ? { ...session, roundTable: { ...session.roundTable!, partner: reviewer.id, seats: undefined } } : session) }));
    await startSession(lead.id); expect(modelOf(reviewer.id)).toBe('gpt-6.1-sol');
    // One saved on the retired gpt-6-astra: it starts on the table's model too.
    await stopSession(lead.id); await vi.waitFor(() => expect(find(reviewer.id)!.status).toBe('exited'));
    useWorkspaceStore.getState().updateConfig(reviewer.id, { engine: 'codex', chat: true, model: 'gpt-6-astra', reasoningEffort: null });
    await startSession(lead.id); expect(modelOf(reviewer.id)).toBe('gpt-6.1-sol'); expect(find(reviewer.id)!.config).toMatchObject({ model: 'gpt-6.1-sol' });
    // One chosen under Models stays.
    await stopSession(lead.id); await vi.waitFor(() => expect(find(reviewer.id)!.status).toBe('exited'));
    useWorkspaceStore.getState().updateConfig(reviewer.id, { engine: 'codex', chat: true, model: 'gpt-6.1-terra', reasoningEffort: null });
    await startSession(lead.id); expect(modelOf(reviewer.id)).toBe('gpt-6.1-terra');
  });
  it('leaves a discussion table\'s Codex partner on Codex\'s own settings', async () => {
    const { codingHub } = host(); const lead = await runningLead(); await openRoundTable(lead.id);
    const partner = useWorkspaceStore.getState().sessions.at(-1)!;
    expect(startedModel(codingHub, partner.id)).toBe('');
  });
  it('counts the hidden partner toward the eight, and says so', () => {
    const { lead, partner, table } = seated(); rememberTable(lead.id, table);
    const more = Array.from({ length: 6 }, () => createSession('shell'));
    const sessions = [...useWorkspaceStore.getState().sessions, ...more];
    expect(channelsOf(sessions)).toHaveLength(7); expect(sessions.find((session) => session.id === partner.id)).toBeDefined();
    expect(channelsFullNote(sessions)).toContain('a Round Table runs several agents in one channel');
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
    expect(hierarchyDetached(lead.id)).toMatch(/lost its Planner/);
    expect(hierarchyDetached(reviewer.id)).toBeNull();
  });
});

describe('A hierarchy table: three seats, and opening again after a restart', () => {
  const tableOpen = (chats: { action: string }[]) => chats.filter((request) => request.action === 'table-open').at(-1) as unknown as Record<string, unknown> | undefined;
  const notices = (id: string) => (useChatStore.getState().threads[id]?.items ?? []).filter((item) => item.kind === 'notice').map((item) => (item as { text: string }).text);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  /** A hierarchy table whose three seats run again, as after a restart, with its table not open yet. */
  let restarts = 10;
  async function restarted() {
    restarts++; const hosted = host(); const lead = await runningLead(); await openHierarchy(lead.id); const table = find(lead.id)!.roundTable!;
    useChatStore.setState({ threads: {} }); hosted.chats.length = 0;
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session, index) => session.id === lead.id || session.id === table.partner || session.id === table.planner ? { ...session, status: 'running' as const, runId: `0000${restarts}${index}-2222-4222-8222-222222222222`.padStart(36, '0') } : session) }));
    return { ...hosted, lead: find(lead.id)!, table };
  }
  it('seats the planner and the Codex reviewer only, and names no Gemini seat', async () => {
    const { chats } = host(); const lead = await runningLead(); await openHierarchy(lead.id);
    expect(useWorkspaceStore.getState().sessions.map((session) => session.config.engine).sort()).toEqual(['claude', 'claude', 'codex']);
    expect(find(lead.id)!.roundTable).not.toHaveProperty('challenger'); expect(tableOpen(chats)).not.toHaveProperty('challenger');
  });
  it('says in the thread and on the channel why a saved table would not open again', async () => {
    const { codingHub, chats, lead } = await restarted();
    codingHub.chat.mockImplementation(async (request: { action: string }) => { chats.push(request); return { ok: false, error: { message: 'All the agents must work in the same folder.' } }; });
    restoreTables(); await settle();
    expect(tableOpen(chats)).toBeDefined();
    expect(notices(lead.id).at(-1)).toBe('The Round Table could not open again: All the agents must work in the same folder.');
    expect(hierarchyDetached(lead.id)).toBe('The Round Table could not open again: All the agents must work in the same folder. Stop this channel and start it again, or close the table.');
    // Tried once per set of runs: not again for the same runs.
    chats.length = 0; restoreTables(); await settle(); expect(tableOpen(chats)).toBeUndefined();
    // A new run of the builder is still opening, until the host answers.
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === lead.id ? { ...session, runId: '0000000f-3333-4333-8333-333333333333' } : session) }));
    expect(hierarchyDetached(lead.id)).toMatch(/opening/);
  });
  it('says why when the request to open it fails outright', async () => {
    const { codingHub, lead } = await restarted();
    codingHub.chat.mockImplementation(async () => { throw new Error('The host closed.'); });
    restoreTables(); await settle();
    expect(notices(lead.id).at(-1)).toBe('The Round Table could not open again: The host closed.');
    expect(hierarchyDetached(lead.id)).toMatch(/^The Round Table could not open again: The host closed\./);
  });
  it('starts the builder in its table\'s folder when the workspace folder changed since', async () => {
    const { codingHub } = host(); const lead = await runningLead(); await openHierarchy(lead.id);
    const table = find(lead.id)!.roundTable!; const folder = (find(table.partner)!.binding as { cwd: string }).cwd;
    expect(folder).toBe('/project');
    expect(tableDirectory(useWorkspaceStore.getState().sessions, find(lead.id)!)).toBe('/project');
    expect(tableDirectory(useWorkspaceStore.getState().sessions, find(table.partner)!)).toBeNull();
    // Stopped, the workspace moved to another folder, then started again: the builder joins its seats, not the new root.
    await stopSession(lead.id); await new Promise((resolve) => setTimeout(resolve, 20));
    useWorkspaceStore.getState().setRootDirectory('/elsewhere');
    await startSession(lead.id);
    const starts = codingHub.startSession.mock.calls.map(([request]) => request as unknown as { sessionId: string; cwd: string });
    expect(starts.filter((request) => request.sessionId === lead.id).at(-1)!.cwd).toBe('/project');
    expect(starts.filter((request) => request.sessionId === table.partner).at(-1)!.cwd).toBe('/project');
  });
});


describe('closing a Round Table’s channel from its tile', () => {
  const finding = (id: string, status: 'open' | 'verified') => ({ id, severity: 'high' as const, evidence: '', text: `problem ${id}`, status, response: '', check: '', reviewedAt: null, changedAt: null, round: 1, at: '2026-11-10T00:00:00.000Z' });
  it('saves its findings to shared memory first, and keeps the channel when they cannot be saved', async () => {
    const { codingHub } = host(); const writes: string[] = []; let offline = true;
    Object.assign(codingHub, { hub: vi.fn(async (request: { action: string; title?: string; notes?: { title: string }[] }) => { if (request.action === 'memory-key') return { ok: true, value: 'project' }; if (offline) return { ok: false, error: { code: 'HOST_ERROR', message: 'Drive folder is offline' } }; writes.push(...request.notes?.map((note) => note.title) ?? [request.title!]); return { ok: true, value: null }; }) });
    const lead = await runningLead(); await openRoundTable(lead.id); const partner = useWorkspaceStore.getState().sessions.at(-1)!;
    useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions.map((session) => session.id === lead.id ? { ...session, roundTable: { ...session.roundTable!, findings: [finding('F1', 'open'), finding('F2', 'verified')] } } : session), createSession('shell')] }));
    expect(await closeChannel(lead.id)).toBe(false);
    expect(find(lead.id)).toMatchObject({ status: 'exited', error: expect.stringMatching(/could not be saved to shared memory \(Drive folder is offline\).*try Close again/) });
    expect(find(lead.id)!.roundTable?.findings).toHaveLength(2);
    offline = false; expect(await closeChannel(lead.id)).toBe(true);
    expect(writes).toEqual(['Round Table review record: 2 findings, 1 verified', 'Open item: Round Table F1 (high, open): problem F1']);
    expect(find(lead.id)).toBeUndefined(); expect(find(partner.id)).toBeUndefined();
  });
  it('from a phone saves nothing while the channel is still starting, so the table keeps its findings', async () => {
    const { codingHub } = host(); const writes: string[] = [];
    Object.assign(codingHub, { hub: vi.fn(async (request: { action: string; title?: string; notes?: { title: string }[] }) => { if (request.action === 'memory-key') return { ok: true, value: 'project' }; writes.push(...request.notes?.map((note) => note.title) ?? [request.title!]); return { ok: true, value: null }; }) });
    const { lead, partner } = seated(); const shell = createSession('shell');
    useWorkspaceStore.setState({ sessions: [{ ...lead, status: 'starting', roundTable: { partner: partner.id, driver: 'codex', rounds: 3, findings: [finding('F1', 'open')] } }, partner, shell] });
    expect(await remoteControl(lead.id, 'close')).toBe('This channel is still starting. Close it again once it runs.');
    expect(writes).toEqual([]); expect(find(lead.id)!.roundTable?.findings).toHaveLength(1);
  });
});

describe('Round Tables of any number of seats', () => {
  const discussion: TablePreset = { id: 'mine', name: 'Three', kind: 'discussion', rounds: 1, driver: 1, seats: [{ engine: 'claude', model: '', name: 'Lead' }, { engine: 'codex', model: 'gpt-x', name: 'Skeptic', instructions: 'Doubt everything.' }, { engine: 'claude', model: 'opus-y' }] };
  const hierarchy: TablePreset = { id: 'mine2', name: 'No final review', kind: 'hierarchy', rounds: 3, seats: [{ engine: 'claude', model: 'opus-y', duties: ['build'] }, { engine: 'claude', model: 'fable-z', duties: ['plan'] }, { engine: 'codex', model: '', duties: ['challenge'], name: 'Hard questions' }, { engine: 'codex', model: '', duties: ['review'] }] };
  type Open = { seats: { sessionId: string; runId: string; name?: string; instructions?: string; duties?: string[] }[]; driverSeat?: string; partner: { sessionId: string }; planner?: { sessionId: string }; kind?: string; rounds: number; driver: string; rejoin?: boolean };
  const lastOpen = (chats: { action: string }[]) => chats.filter((request) => request.action === 'table-open').at(-1) as unknown as Open;
  it('opens a three-seat discussion: a hidden chat per seat on its agent and model, the request naming every seat', async () => {
    const { codingHub, chats } = host(); const shell = createSession('shell');
    const lead = await runningLead([shell]); expect(await openTable(lead.id, discussion)).toBeNull();
    const sessions = useWorkspaceStore.getState().sessions; const hidden = sessions.filter((session) => ![lead.id, shell.id].includes(session.id));
    expect(hidden.map((session) => [session.config.engine, (session.config as { model: string }).model, (session.config as { chat?: boolean }).chat])).toEqual([['codex', 'gpt-x', true], ['claude', 'opus-y', true]]);
    expect(channelsOf(sessions).map((session) => session.id)).toEqual([lead.id, shell.id]);
    const request = lastOpen(chats);
    expect(request.seats.map((seat) => seat.sessionId)).toEqual([lead.id, hidden[0].id, hidden[1].id]);
    expect(request.seats.map((seat) => seat.name)).toEqual(['Lead', 'Skeptic', undefined]); expect(request.seats[1].instructions).toBe('Doubt everything.');
    expect(request).toMatchObject({ driverSeat: hidden[0].id, driver: 'codex', rounds: 1, partner: { sessionId: hidden[0].id } });
    expect(find(lead.id)!.roundTable).toMatchObject({ partner: hidden[0].id, driver: 'codex', driverSeat: hidden[0].id, rounds: 1, seats: [{ session: lead.id, name: 'Lead' }, { session: hidden[0].id, name: 'Skeptic', instructions: 'Doubt everything.' }, { session: hidden[1].id }] });
    expect(savedWorkspaceSchema.safeParse(savedWorkspace()).success).toBe(true);
    expect(codingHub.startSession).toHaveBeenCalledTimes(3);
    expect(tableSeats(lead.id).map((seat) => [seat.lead, seat.driver, seat.model])).toEqual([[true, false, ''], [false, true, 'gpt-x'], [false, false, 'opus-y']]);
  });
  it('opens a hierarchy without a final reviewer: the planner and the extra seats named, the builder the lead', async () => {
    const { chats } = host(); const lead = await runningLead(); expect(await openTable(lead.id, hierarchy)).toBeNull();
    const hidden = useWorkspaceStore.getState().sessions.filter((session) => session.id !== lead.id); const request = lastOpen(chats);
    expect(request).toMatchObject({ kind: 'hierarchy', rounds: 3, planner: { sessionId: hidden[0].id }, partner: { sessionId: hidden[0].id } }); expect(request).not.toHaveProperty('driverSeat');
    expect(request.seats.map((seat) => seat.duties)).toEqual([['build'], ['plan'], ['challenge'], ['review']]); expect(request.seats[2].name).toBe('Hard questions');
    expect((hidden[0].config as { model: string }).model).toBe('fable-z');
    expect(find(lead.id)!.roundTable).toMatchObject({ kind: 'hierarchy', planner: hidden[0].id, rounds: 3 });
  });
  it('refuses seats that make no table, with the reason, before adding anything', async () => {
    host(); const lead = await runningLead();
    expect(await openTable(lead.id, { ...hierarchy, seats: hierarchy.seats.map((seat) => ({ ...seat, duties: ['review' as const] })) })).toMatch(/exactly one builder/);
    expect(await openTable(lead.id, { ...discussion, driver: 0, seats: [discussion.seats[0]] })).toMatch(/at least two/);
    expect(useWorkspaceStore.getState().sessions).toHaveLength(1);
  });
  it('stops and removes every seat when one cannot start, or the host refuses', async () => {
    const { codingHub, stops } = host(); const lead = await runningLead();
    const start = codingHub.startSession.getMockImplementation()!;
    codingHub.startSession.mockImplementation(async (request: { sessionId: string; cwd: string }) => find(request.sessionId)!.config.engine === 'codex' ? { ok: false as const, error: { code: 'X', message: 'Codex is not installed.' } } as never : start(request));
    expect(await openTable(lead.id, discussion)).toBe('Codex is not installed.');
    expect(useWorkspaceStore.getState().sessions.map((session) => session.id)).toEqual([lead.id]); expect(find(lead.id)!.roundTable).toBeUndefined(); expect(stops).toHaveLength(1);
    codingHub.startSession.mockImplementation(start); codingHub.chat.mockImplementation(async () => ({ ok: false, error: { message: 'Not in the same folder.' } }));
    expect(await openTable(lead.id, discussion)).toBe('Not in the same folder.');
    expect(useWorkspaceStore.getState().sessions.map((session) => session.id)).toEqual([lead.id]);
  });
  it('refuses a table with more seats than there are places left', async () => {
    host(); const lead = await runningLead(Array.from({ length: 6 }, () => createSession('shell')));
    expect(seatRoom(lead.id)).toBe(2); expect(seatRoom()).toBe(1); expect(await openTable(lead.id, discussion)).toMatch(/Close a channel first/);
    expect(useWorkspaceStore.getState().sessions).toHaveLength(7);
  });
  it('seats a saved table again only once every one of its seats runs, with all of them named', async () => {
    const { chats } = host(); const lead = await runningLead(); await openTable(lead.id, discussion);
    const ids = useWorkspaceStore.getState().sessions.map((session) => session.id).filter((id) => id !== lead.id); chats.length = 0; useChatStore.setState({ threads: {} });
    // A new run of the first seat only: the other is still stopped.
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => ids.includes(session.id) ? { ...session, status: 'exited' as const } : session) }));
    run(ids[0], '55555555-5555-4555-8555-555555555555'); restoreTables(); expect(chats).toEqual([]);
    run(ids[1], '66666666-6666-4666-8666-666666666666'); restoreTables();
    const request = lastOpen(chats); expect(request).toMatchObject({ rejoin: true, driverSeat: ids[0], partner: { sessionId: ids[0] } });
    expect(request.seats.map((seat) => seat.sessionId)).toEqual([lead.id, ids[0], ids[1]]); expect(request.seats.every((seat) => seat.runId)).toBe(true); expect(request.seats[1].name).toBe('Skeptic');
  });
  describe('changing the seats of a table', () => {
    /** A two-seat discussion table, open on the host. */
    async function opened() {
      const hosted = host(); const lead = await runningLead(); await openTable(lead.id, { ...discussion, seats: discussion.seats.slice(0, 2), driver: 0 });
      const [first, second] = tableSeats(lead.id);
      useChatStore.setState({ threads: { [lead.id]: { table: { partner: { sessionId: second.session, runId: find(second.session)!.runId!, engine: 'codex' }, driver: 'claude', rounds: 1, round: 0, phase: 'idle', agreed: false } } } as never });
      hosted.chats.length = 0; hosted.stops.length = 0; return { ...hosted, lead, first, second };
    }
    const seatsRequest = (chats: { action: string }[]) => chats.find((item) => item.action === 'table-seats') as unknown as { seats: { sessionId: string; name?: string }[]; driverSeat?: string };
    it('adds a seat: started, announced to the host with every seat, then saved', async () => {
      const { chats, lead, first, second } = await opened();
      expect(await changeSeats(lead.id, { seats: [first, { ...second, name: 'Skeptic 2' }, { engine: 'claude', model: '', name: 'Third' }] })).toBeNull();
      const request = seatsRequest(chats);
      expect(request.seats.map((seat) => seat.name)).toEqual(['Lead', 'Skeptic 2', 'Third']); expect(request.driverSeat).toBe(lead.id); expect(request.seats[0].sessionId).toBe(lead.id);
      expect(find(lead.id)!.roundTable!.seats).toHaveLength(3); expect(find(lead.id)!.roundTable!.seats![2]).toMatchObject({ name: 'Third' });
      expect(channelsOf(useWorkspaceStore.getState().sessions)).toHaveLength(1); expect(find(request.seats[2].sessionId)!.status).toBe('running');
    });
    it('removes a seat only after the host accepted it, then stops and removes that seat', async () => {
      const { codingHub, chats, stops, lead, first, second } = await opened();
      await changeSeats(lead.id, { seats: [first, second, { engine: 'claude', model: '' }] }); const third = tableSeats(lead.id)[2]; chats.length = 0;
      const seen: number[] = []; codingHub.chat.mockImplementation(async (request: { action: string }) => { chats.push(request); seen.push(stops.length); return { ok: true }; });
      expect(await changeSeats(lead.id, { seats: [first, second] })).toBeNull();
      expect(seatsRequest(chats).seats.map((seat) => seat.sessionId)).toEqual([lead.id, second.session]); expect(seen).toEqual([0]);
      expect(stops).toEqual([third.session]); expect(find(third.session)).toBeUndefined(); expect(find(lead.id)!.roundTable!.seats).toHaveLength(2);
    });
    it('puts everything back when the host refuses: the seats just added are stopped and removed', async () => {
      const { codingHub, stops, lead, first, second } = await opened(); const before = find(lead.id)!.roundTable;
      codingHub.chat.mockImplementation(async () => ({ ok: false, error: { message: 'The table is working. Wait for it to finish.' } }));
      expect(await changeSeats(lead.id, { seats: [first, second, { engine: 'codex', model: '' }] })).toBe('The table is working. Wait for it to finish.');
      expect(stops).toHaveLength(1); expect(useWorkspaceStore.getState().sessions).toHaveLength(2); expect(find(lead.id)!.roundTable).toEqual(before);
    });
    it('refuses what cannot be a table, and a seat whose agent was changed', async () => {
      const { stops, lead, first, second } = await opened();
      expect(await changeSeats(lead.id, { seats: [first] })).toMatch(/at least two/);
      expect(await changeSeats(lead.id, { seats: [second, { engine: 'claude', model: '' }] })).toMatch(/leads the Round Table/);
      expect(await changeSeats(lead.id, { seats: [first, { ...second, engine: 'claude' }] })).toMatch(/keeps its agent/);
      expect(await changeSeats(lead.id, { seats: [first, { ...second, session: 'someone-else' }] })).toMatch(/not at the Round Table/);
      expect(stops).toEqual([]); expect(useWorkspaceStore.getState().sessions).toHaveLength(2);
    });
    it('changes a table that is saved but not open on record only, starting new seats and removing dropped ones', async () => {
      const { chats, stops, lead, first, second } = await opened(); useChatStore.setState({ threads: {} });
      expect(await changeSeats(lead.id, { seats: [first, { engine: 'claude', model: '', name: 'Extra' }] })).toBeNull();
      expect(chats.map((request) => request.action)).not.toContain('table-seats'); expect(stops).toEqual([second.session]); expect(find(second.session)).toBeUndefined();
      const seats = find(lead.id)!.roundTable!.seats!; expect(seats.map((seat) => seat.name)).toEqual(['Lead', 'Extra']); expect(find(seats[1].session)!.status).toBe('running');
    });
    it('starts a seat again on its new model, last, once the host has accepted the rest', async () => {
      const { codingHub, chats, lead, first, second } = await opened();
      expect(await changeSeats(lead.id, { seats: [first, { ...second, model: 'gpt-new', name: 'Skeptic' }] })).toBeNull();
      expect(startedModel(codingHub, second.session)).toBe('gpt-new'); expect(find(second.session)!.config).toMatchObject({ model: 'gpt-new' }); expect(find(second.session)!.status).toBe('running');
      expect(chats.map((request) => request.action)).toEqual(['table-seats']); expect(codingHub.stopSession).toHaveBeenCalledTimes(1);
    });
    it('sends the new rounds and the new editing seat as requests of their own', async () => {
      const { chats, lead, first, second } = await opened();
      expect(await changeSeats(lead.id, { seats: [first, second], driver: 1, rounds: 4 })).toBeNull();
      expect(chats).toContainEqual(expect.objectContaining({ action: 'table-rounds', rounds: 4 })); expect(chats).toContainEqual(expect.objectContaining({ action: 'table-driver', driver: 'codex', seat: second.session }));
      expect(find(lead.id)!.roundTable).toMatchObject({ driver: 'codex', driverSeat: second.session, rounds: 4 });
    });
  });
});

describe('seat names and saved seats', () => {
  it('saves the seats and the editing seat with the table, and names a hidden seat in its alert', () => {
    const { lead, partner, table } = seated();
    const seats = [{ sessionId: lead.id, runId: RUN_A, engine: 'claude' as const, name: 'Lead' }, { sessionId: partner.id, runId: RUN_B, engine: 'codex' as const, name: 'Skeptic', instructions: 'Doubt.' }];
    rememberTable(lead.id, { ...table, seats, driverSeat: lead.id });
    expect(savedWorkspace().sessions[0].roundTable).toEqual({ partner: partner.id, driver: 'codex', rounds: 3, seats: [{ session: lead.id, name: 'Lead' }, { session: partner.id, name: 'Skeptic', instructions: 'Doubt.' }], driverSeat: lead.id });
    expect(savedWorkspaceSchema.safeParse(savedWorkspace()).success).toBe(true);
    const waiting = useWorkspaceStore.getState().sessions.map((session) => session.id === partner.id ? { ...session, status: 'running' as const, runId: RUN_B, attention: { message: 'Approve Bash', at: new Date().toISOString() } } : session);
    expect(channelAlerts(waiting, [])[0].text).toBe('CH1 Skeptic needs approval');
  });
  it('lets a table of a discussion say it is not open, while a message to it is still allowed', () => {
    const { lead, partner } = seated(); useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === lead.id ? { ...session, status: 'running' as const, runId: RUN_A, roundTable: { partner: partner.id, driver: 'claude' as const, rounds: 2 } } : session) }));
    expect(tableDetached(lead.id)).toMatch(/stopped\. Press Reopen to start it again\./); expect(hierarchyDetached(lead.id)).toBeNull();
    run(partner.id, RUN_B); expect(tableDetached(lead.id)).toMatch(/opening/);
  });
});
