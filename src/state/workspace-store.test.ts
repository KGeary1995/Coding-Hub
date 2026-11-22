import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arrangeTiles, channelNumber, channelsFullNote, channelsOf, createSession, fitTiles, hiddenSeats, leadOf, savedWorkspace, seatsOf, tableDirectory, useWorkspaceStore } from './workspace-store';
import { MAX_CHANNELS, savedWorkspaceSchema } from '../../shared/schemas';
import type { CLIEngineConfig, CodexCLIEngineConfig } from '../../shared/types';
import { workspace120 } from '../../shared/workspace-120.fixture';

beforeEach(() => {
  const sessions = [createSession('claude'), createSession('codex')];
  useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'columns'), rootDirectory: null, focusedSessionId: null, layoutMode: 'columns', activeView: 'workspace' });
});

describe('multi-session workspace transitions', () => {
  it('restores settings as idle and excludes live process state from persistence', () => {
    const state = useWorkspaceStore.getState();
    const session = state.sessions[0];
    state.markStarting(session.id);
    state.applyEvent({ type: 'started', sessionId: session.id, runId: 'old-run', engine: 'claude', pid: 999, cwd: '/running' });
    const snapshot = savedWorkspace();
    expect(snapshot.sessions[0]).not.toHaveProperty('pid');
    expect(snapshot.sessions[0]).not.toHaveProperty('runId');
    useWorkspaceStore.getState().hydrate(snapshot, { databasePath: '/local/storage.db', logsDirectory: '/local/logs', maxLogBytes: 5242880, maxCompletedRuns: 100, retentionDays: 30 });
    expect(useWorkspaceStore.getState().sessions[0]).toMatchObject({ status: 'idle', pid: null, runId: null, config: session.config });
    expect(savedWorkspace()).toEqual(snapshot);
  });

  it('does not change the saved settings when terminal lifecycle or navigation changes', () => {
    const snapshot = savedWorkspace();
    const state = useWorkspaceStore.getState(); const session = state.sessions[0];
    state.setView('history'); state.markStarting(session.id);
    state.applyEvent({ type: 'started', sessionId: session.id, runId: 'new-run', engine: 'claude', pid: 111, cwd: '/running' });
    state.applyEvent({ type: 'exit', sessionId: session.id, runId: 'new-run', exitCode: 0 });
    expect(savedWorkspace()).toEqual(snapshot);
  });
  it('locks launch settings and ignores an old run’s exit after a new launch', () => {
    const session = useWorkspaceStore.getState().sessions[0];
    useWorkspaceStore.getState().markStarting(session.id);
    useWorkspaceStore.getState().applyEvent({ type: 'started', sessionId: session.id, runId: 'run-two', engine: 'claude', pid: 123, cwd: '/running/repo' });
    useWorkspaceStore.getState().updateBinding(session.id, { mode: 'independent', cwd: '/other/repo' });
    useWorkspaceStore.getState().updateConfig(session.id, { ...session.config as CLIEngineConfig, model: 'changed' });
    useWorkspaceStore.getState().applyEvent({ type: 'exit', sessionId: session.id, runId: 'run-one', exitCode: 1 });
    const current = useWorkspaceStore.getState().sessions[0];
    expect(current.status).toBe('running');
    expect(current.config).toEqual(session.config);
    expect(current.binding).toEqual(session.binding);
    expect(current.runningCwd).toBe('/running/repo');
  });
  it('keeps an active tile until its process exits', () => {
    useWorkspaceStore.getState().addSession('codex');
    const session = useWorkspaceStore.getState().sessions[2];
    useWorkspaceStore.getState().markStarting(session.id);
    useWorkspaceStore.getState().removeSession(session.id);
    expect(useWorkspaceStore.getState().sessions).toHaveLength(3);
    useWorkspaceStore.getState().applyEvent({ type: 'started', sessionId: session.id, runId: 'active-run', engine: 'codex', pid: 123, cwd: '/repo' });
    useWorkspaceStore.getState().removeSession(session.id);
    expect(useWorkspaceStore.getState().sessions).toHaveLength(3);
    useWorkspaceStore.getState().applyEvent({ type: 'exit', sessionId: session.id, runId: 'active-run', exitCode: 0 });
    useWorkspaceStore.getState().removeSession(session.id);
    expect(useWorkspaceStore.getState().sessions).toHaveLength(2);
  });
  it('caps sessions at the channel limit and keeps every tile bound to a unique session', () => {
    for (let index = 0; index < MAX_CHANNELS + 3; index++) useWorkspaceStore.getState().addSession('codex');
    const { sessions, tiles } = useWorkspaceStore.getState();
    expect(sessions).toHaveLength(MAX_CHANNELS);
    expect(tiles.map((tile) => tile.sessionId)).toEqual(sessions.map((session) => session.id));
    expect(new Set(sessions.map((session) => session.id)).size).toBe(MAX_CHANNELS);
  });

  it('lays out up to eight channels in two grid rows, and wraps columns after four', () => {
    for (let index = 0; index < 4; index++) useWorkspaceStore.getState().addSession('codex');
    const sessions = useWorkspaceStore.getState().sessions;
    const grid = arrangeTiles(sessions, 'grid');
    expect(grid.map(({ x, y, w }) => [x, y, w])).toEqual([[0, 0, 4], [4, 0, 4], [8, 0, 4], [0, 12, 4], [4, 12, 4], [8, 12, 4]]);
    expect(arrangeTiles(sessions.slice(0, 2), 'grid').map(({ w, y }) => [w, y])).toEqual([[6, 0], [6, 0]]);
    expect(arrangeTiles([...sessions, ...sessions.slice(0, 2)], 'grid').every(({ w, y }) => w === 3 && y <= 12)).toBe(true);
    expect(arrangeTiles(sessions, 'columns').map(({ y, w }) => [y, w])).toEqual([[0, 3], [0, 3], [0, 3], [0, 3], [12, 3], [12, 3]]);
    // Every arrangement is a workspace the host accepts.
    const workspace = { version: 1, rootDirectory: null, sessions: sessions.map(({ id, title, config, binding, createdAt }) => ({ id, title, config, binding, createdAt })), layoutMode: 'grid', focusedSessionId: null };
    for (const mode of ['grid', 'columns', 'rows'] as const) expect(savedWorkspaceSchema.safeParse({ ...workspace, layoutMode: mode, tiles: arrangeTiles(sessions, mode) }).success).toBe(true);
  });

  describe('the grid arrangement as channels come and go', () => {
    const places = () => useWorkspaceStore.getState().tiles.map(({ x, y, w }) => [x, y, w]);
    const WIDE_THIRD = [[0, 0, 6], [6, 0, 6], [0, 12, 12]]; const TWO_BY_TWO = [[0, 0, 6], [6, 0, 6], [0, 12, 6], [6, 12, 6]];
    it('gives the third channel the whole second row, two by two with a fourth, and the wide third again when one closes', () => {
      useWorkspaceStore.getState().addSession('shell');
      expect(useWorkspaceStore.getState().layoutMode).toBe('grid'); expect(places()).toEqual(WIDE_THIRD);
      useWorkspaceStore.getState().addSession('shell'); expect(places()).toEqual(TWO_BY_TWO);
      // Whichever of the four closes, the three left are two above and one wide below, in channel order.
      for (const index of [3, 0]) {
        const sessions = useWorkspaceStore.getState().sessions;
        useWorkspaceStore.getState().removeSession(sessions[index].id); expect(places()).toEqual(WIDE_THIRD);
        expect(useWorkspaceStore.getState().tiles.map((tile) => tile.sessionId)).toEqual(sessions.filter((_, at) => at !== index).map((session) => session.id));
        useWorkspaceStore.getState().addSession('codex'); expect(places()).toEqual(TWO_BY_TWO);
      }
    });
    it('does the same for a duplicate, a restored run and the grid button', () => {
      const [first] = useWorkspaceStore.getState().sessions;
      useWorkspaceStore.getState().addSession('claude', first.id); expect(places()).toEqual(WIDE_THIRD);
      useWorkspaceStore.getState().arrange('columns'); expect(places()).toEqual([[0, 0, 4], [4, 0, 4], [8, 0, 4]]);
      useWorkspaceStore.getState().arrange('grid'); expect(places()).toEqual(WIDE_THIRD);
      const run = { runId: 'history', sessionId: first.id, engine: 'codex' as const, config: { engine: 'codex' as const, model: '', reasoningEffort: null }, cwd: '/recorded', startedAt: first.createdAt, endedAt: null, status: 'interrupted' as const, exitCode: null, logFile: '', recordedBytes: 0, logTruncated: false };
      useWorkspaceStore.getState().removeSession(useWorkspaceStore.getState().sessions[2].id); expect(places()).toEqual([[0, 0, 6], [6, 0, 6]]);
      expect(useWorkspaceStore.getState().restoreRun(run)).toBe(true); expect(places()).toEqual(WIDE_THIRD);
    });
    it('leaves a layout the person dragged or resized alone when it is saved and opened again', () => {
      useWorkspaceStore.getState().addSession('shell');
      const [a, b, c] = useWorkspaceStore.getState().sessions.map((session) => session.id);
      // The person narrowed the third tile and moved the second under the first: what the grid reports after a drag.
      const dragged = [{ sessionId: a, x: 0, y: 0, w: 7, h: 10, minW: 3, minH: 10 }, { sessionId: b, x: 0, y: 10, w: 7, h: 14, minW: 3, minH: 10 }, { sessionId: c, x: 7, y: 0, w: 5, h: 24, minW: 3, minH: 10 }];
      useWorkspaceStore.getState().setTiles(dragged);
      const saved = savedWorkspace(); expect(saved.tiles).toEqual(dragged); expect(saved.layoutMode).toBe('grid');
      useWorkspaceStore.getState().hydrate(saved, { databasePath: '/local/storage.db', logsDirectory: '/local/logs', maxLogBytes: 5242880, maxCompletedRuns: 100, retentionDays: 30 });
      expect(useWorkspaceStore.getState().tiles).toEqual(dragged);
    });
    describe('a three-channel grid saved by an older version, its third tile at half width', () => {
      const info = { databasePath: '/local/storage.db', logsDirectory: '/local/logs', maxLogBytes: 5242880, maxCompletedRuns: 100, retentionDays: 30 };
      const OLDER = [[0, 0, 6], [6, 0, 6], [0, 12, 6]];
      const older = () => { useWorkspaceStore.getState().addSession('shell'); return { ...savedWorkspace(), tiles: useWorkspaceStore.getState().tiles.map((tile, index) => index === 2 ? { ...tile, w: 6 } : tile) }; };
      // The window's storage, where it remembers that it has opened a workspace under today's rule.
      beforeEach(() => { const kept = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); } }); });
      afterEach(() => { vi.unstubAllGlobals(); });
      it('is laid out by today’s rule the first time a workspace is opened, so the empty quarter is gone without a click', () => {
        useWorkspaceStore.getState().hydrate(older(), info); expect(places()).toEqual(WIDE_THIRD);
      });
      it('is opened as saved after that: a third tile at half width is then the person’s own', () => {
        const saved = older(); useWorkspaceStore.getState().hydrate(null, info);
        useWorkspaceStore.getState().hydrate(saved, info); expect(places()).toEqual(OLDER);
      });
      it('is opened as saved the first time too when the person had moved or resized a tile', () => {
        const saved = older(); const dragged = saved.tiles.map((tile, index) => index === 2 ? { ...tile, w: 8 } : tile);
        useWorkspaceStore.getState().hydrate({ ...saved, tiles: dragged }, info); expect(useWorkspaceStore.getState().tiles).toEqual(dragged);
      });
    });
    it('opens a three-channel grid saved by an older version as it was saved where the window cannot remember having done so', () => {
      useWorkspaceStore.getState().addSession('shell');
      const older = useWorkspaceStore.getState().tiles.map((tile, index) => index === 2 ? { ...tile, w: 6 } : tile);
      useWorkspaceStore.getState().hydrate({ ...savedWorkspace(), tiles: older }, { databasePath: '/local/storage.db', logsDirectory: '/local/logs', maxLogBytes: 5242880, maxCompletedRuns: 100, retentionDays: 30 });
      expect(places()).toEqual([[0, 0, 6], [6, 0, 6], [0, 12, 6]]);
      // The grid button, or a channel added or closed, lays it out by the rule.
      useWorkspaceStore.getState().arrange('grid'); expect(places()).toEqual(WIDE_THIRD);
    });
  });

  describe('a tile that goes without its channel closing (a seat taken at a Round Table)', () => {
    const tile = (sessionId: string, x: number, y: number, w: number, h = 12) => ({ sessionId, x, y, w, h, minW: 3, minH: 10 });
    const four = () => { const sessions = [createSession('claude'), createSession('codex'), createSession('shell'), createSession('codex')]; return { sessions, lead: { ...sessions[0], roundTable: { partner: sessions[3].id, driver: 'claude' as const, rounds: 2 } } }; };
    it('lays the rest out again while the tiles stand as Trace arranged them, so the third takes the spare width', () => {
      const { sessions, lead } = four(); const seated = [lead, ...sessions.slice(1)];
      expect(fitTiles(seated, arrangeTiles(sessions, 'grid'), 'grid').map(({ sessionId, x, y, w }) => [sessionId, x, y, w])).toEqual([[sessions[0].id, 0, 0, 6], [sessions[1].id, 6, 0, 6], [sessions[2].id, 0, 12, 12]]);
      // In columns too: three columns, not three quarters and a gap.
      expect(fitTiles(seated, arrangeTiles(sessions, 'columns'), 'columns').map(({ x, w }) => [x, w])).toEqual([[0, 4], [4, 4], [8, 4]]);
    });
    it('drops only that tile from a layout the person dragged or resized, and keeps tiles that already match', () => {
      const { sessions, lead } = four(); const seated = [lead, ...sessions.slice(1)]; const [a, b, c, d] = sessions.map((session) => session.id);
      const dragged = [tile(a, 0, 0, 8), tile(b, 8, 0, 4, 24), tile(c, 0, 12, 4), tile(d, 4, 12, 4)];
      expect(fitTiles(seated, dragged, 'grid')).toEqual(dragged.slice(0, 3));
      // Two tiles swapped by dragging are the person's too, though every size is Trace's.
      const swapped = [tile(a, 6, 0, 6), tile(b, 0, 0, 6), tile(c, 0, 12, 6), tile(d, 6, 12, 6)];
      expect(fitTiles(seated, swapped, 'grid')).toEqual(swapped.slice(0, 3));
      const kept = dragged.slice(0, 3); expect(fitTiles(seated, kept, 'grid')).toBe(kept);
    });
  });

  it('duplicates independent repository bindings and configs without sharing mutable state', () => {
    const source = useWorkspaceStore.getState().sessions[0];
    useWorkspaceStore.getState().updateBinding(source.id, { mode: 'independent', cwd: '/repos/agent-one' });
    useWorkspaceStore.getState().addSession('claude', source.id);
    const duplicate = useWorkspaceStore.getState().sessions[2];
    expect(duplicate.binding).toEqual({ mode: 'independent', cwd: '/repos/agent-one' });
    expect(duplicate.config).toEqual(source.config);
    expect(duplicate.config).not.toBe(source.config);
    useWorkspaceStore.getState().updateConfig(duplicate.id, { engine: 'claude', model: 'custom-model', thinking: { budget_tokens: 4096 }, tokenLimits: { maxOutputTokens: 8192, maxSessionTokens: null } });
    expect(useWorkspaceStore.getState().sessions[0].config).toEqual(source.config);
  });

  it('rejects another engine’s configuration for an existing session', () => {
    const claude = useWorkspaceStore.getState().sessions[0];
    useWorkspaceStore.getState().updateConfig(claude.id, { engine: 'codex', model: 'gpt-5.3-codex', reasoningEffort: 'xhigh' });
    expect(useWorkspaceStore.getState().sessions[0].config.engine).toBe('claude');
  });

  it('restores the grid after closing an isolated tile, and keeps the last channel', () => {
    useWorkspaceStore.getState().addSession('codex');
    const third = useWorkspaceStore.getState().sessions[2];
    useWorkspaceStore.getState().toggleFocus(third.id);
    useWorkspaceStore.getState().removeSession(third.id);
    expect(useWorkspaceStore.getState().focusedSessionId).toBeNull();
    expect(useWorkspaceStore.getState().tiles).toHaveLength(2);
    useWorkspaceStore.getState().removeSession(useWorkspaceStore.getState().sessions[0].id);
    expect(useWorkspaceStore.getState().sessions).toHaveLength(1);
    useWorkspaceStore.getState().removeSession(useWorkspaceStore.getState().sessions[0].id);
    expect(useWorkspaceStore.getState().sessions).toHaveLength(1);
    /** A one-channel workspace must still save, or every save (and the update that waits on it) fails. */
    expect(savedWorkspaceSchema.safeParse(savedWorkspace()).success).toBe(true);
  });

  it('rearranges horizontally and vertically without changing working directories or config', () => {
    const sessions = useWorkspaceStore.getState().sessions;
    useWorkspaceStore.getState().arrange('rows');
    expect(useWorkspaceStore.getState().tiles.map((tile) => [tile.x, tile.y, tile.w])).toEqual([[0, 0, 12], [0, 12, 12]]);
    useWorkspaceStore.getState().arrange('columns');
    expect(useWorkspaceStore.getState().tiles.map((tile) => [tile.x, tile.y, tile.w])).toEqual([[0, 0, 6], [6, 0, 6]]);
    expect(useWorkspaceStore.getState().sessions).toEqual(sessions);
  });
});

it('restores history into an idle session without reviving a PID or replacing active sessions', () => {
  const original = createSession('codex');
  const run = { runId: 'history', sessionId: original.id, engine: 'codex' as const, config: original.config as CodexCLIEngineConfig, cwd: '/recorded/repository', startedAt: original.createdAt, endedAt: null, status: 'interrupted' as const, exitCode: null, logFile: '', recordedBytes: 0, logTruncated: false };
  expect(useWorkspaceStore.getState().restoreRun(run)).toBe(true);
  expect(useWorkspaceStore.getState().sessions.at(-1)).toMatchObject({ status: 'idle', pid: null, runId: null, binding: { mode: 'independent', cwd: run.cwd } });
  while (useWorkspaceStore.getState().sessions.length < MAX_CHANNELS) useWorkspaceStore.getState().addSession('claude');
  useWorkspaceStore.setState({ sessions: useWorkspaceStore.getState().sessions.map((session) => ({ ...session, status: 'running' })) });
  const before = savedWorkspace(); expect(useWorkspaceStore.getState().restoreRun(run)).toBe(false); expect(savedWorkspace()).toEqual(before);
});

it('clears old resume metadata along with Codex overrides for a fresh-default recovery, and preserves active launches',()=>{
 const session=useWorkspaceStore.getState().sessions[1];useWorkspaceStore.getState().updateConfig(session.id,{engine:'codex',model:'old-model',reasoningEffort:'high',resumeId:crypto.randomUUID()});
 useWorkspaceStore.getState().resetCodexConfig(session.id);expect(useWorkspaceStore.getState().sessions[1].config).toEqual({engine:'codex',model:'',reasoningEffort:null});
 useWorkspaceStore.getState().updateConfig(session.id,{engine:'codex',model:'chosen-model',reasoningEffort:'minimal'});useWorkspaceStore.getState().markStarting(session.id);useWorkspaceStore.getState().resetCodexConfig(session.id);expect((useWorkspaceStore.getState().sessions[1].config as CodexCLIEngineConfig).model).toBe('chosen-model');
});

describe('directory changes after a run', () => {
  it('forgets the previous run directory when the binding or project root changes', () => {
    const state = useWorkspaceStore.getState(); const session = state.sessions[0];
    state.markStarting(session.id);
    state.applyEvent({ type: 'started', sessionId: session.id, runId: 'run', engine: 'claude', pid: 1, cwd: '/old-root' });
    state.applyEvent({ type: 'exit', sessionId: session.id, runId: 'run', exitCode: 0 });
    useWorkspaceStore.getState().updateBinding(session.id, { mode: 'independent', cwd: '/new/repo' });
    expect(useWorkspaceStore.getState().sessions[0].runningCwd).toBeNull();
  });
  it('clears a failed launch, status included, once the folder is fixed', () => {
    const failed = () => { const state = useWorkspaceStore.getState(); state.markStarting(state.sessions[0].id); useWorkspaceStore.getState().setSessionError(state.sessions[0].id, 'Folder missing', true); expect(useWorkspaceStore.getState().sessions[0]).toMatchObject({ status: 'error', error: 'Folder missing' }); };
    failed(); useWorkspaceStore.getState().updateBinding(useWorkspaceStore.getState().sessions[0].id, { mode: 'independent', cwd: '/fixed' });
    expect(useWorkspaceStore.getState().sessions[0]).toMatchObject({ status: 'idle', error: null });
    useWorkspaceStore.getState().updateBinding(useWorkspaceStore.getState().sessions[0].id, { mode: 'workspace' }); failed();
    useWorkspaceStore.getState().setRootDirectory('/root');
    expect(useWorkspaceStore.getState().sessions[0]).toMatchObject({ status: 'idle', error: null });
  });
});

it('adds a Terminal channel that saves and restores like the agents', () => {
  useWorkspaceStore.getState().addSession('shell');
  const shell = useWorkspaceStore.getState().sessions.at(-1)!;
  expect(shell).toMatchObject({ title: 'Terminal', config: { engine: 'shell' }, status: 'idle' });
  const saved = savedWorkspace();
  expect(savedWorkspaceSchema.parse(saved).sessions.at(-1)?.config).toEqual({ engine: 'shell' });
  useWorkspaceStore.getState().addSession('shell', shell.id);
  expect(useWorkspaceStore.getState().sessions.at(-1)?.config).toEqual({ engine: 'shell' });
});

it('closes a Round Table lead with its stopped partner, but never drops a partner still running', () => {
  const [lead, partner] = useWorkspaceStore.getState().sessions; const shell = createSession('shell');
  const seat = (status: 'exited' | 'running') => useWorkspaceStore.setState({ sessions: [{ ...lead, roundTable: { partner: partner.id, driver: 'claude', rounds: 2 } }, { ...partner, status }, shell] });
  seat('exited'); useWorkspaceStore.getState().removeSession(lead.id);
  expect(useWorkspaceStore.getState().sessions.map((session) => session.id)).toEqual([shell.id]);
  // Still running: kept, with no lead to hide it, so it shows as its own tile again.
  seat('running'); useWorkspaceStore.getState().removeSession(lead.id);
  expect(useWorkspaceStore.getState().sessions.map((session) => session.id)).toEqual([partner.id, shell.id]);
  expect(useWorkspaceStore.getState().tiles.map((tile) => tile.sessionId)).toEqual([partner.id, shell.id]);
});

describe('a workspace saved with Gemini (1.19, 1.20)', () => {
  const info = { databasePath: '/local/storage.db', logsDirectory: '/local/logs', maxLogBytes: 5242880, maxCompletedRuns: 100, retentionDays: 30 };
  it('loads with its Gemini channel, without the seat, the table at reviewing, and no notice (nothing the person saw is gone)', () => {
    useWorkspaceStore.setState({ loadNotice: null });
    useWorkspaceStore.getState().hydrate(workspace120() as never, info);
    const state = useWorkspaceStore.getState();
    expect(state.sessions.map((session) => session.id)).toEqual(['lead', 'rev', 'plan', 'gem']);
    expect(state.sessions[3].config).toEqual({ engine: 'gemini', model: 'gemini-4-argon-high' });
    expect(state.tiles.map((tile) => tile.sessionId)).toEqual(['lead', 'gem']); expect(state.focusedSessionId).toBe('gem');
    expect(state.sessions[0].roundTable).not.toHaveProperty('challenger'); expect(state.sessions[0].roundTable!.chain).toMatchObject({ step: 'stopped', stoppedAt: 'reviewing' });
    expect(state.loadNotice).toBeNull();
    expect(savedWorkspaceSchema.safeParse(savedWorkspace()).success).toBe(true);
  });
  it('says so for Gemini chats dropped with a tile, here or by the host, and says nothing for a workspace without them', () => {
    const plain = savedWorkspace();
    useWorkspaceStore.getState().hydrate(plain, info, 2); expect(useWorkspaceStore.getState().loadNotice).toBe('2 Gemini chats were removed from this workspace: Gemini runs only in a terminal now.');
    useWorkspaceStore.getState().hydrate(plain, info); expect(useWorkspaceStore.getState().loadNotice).toBeNull();
    const seen = workspace120(); (seen.sessions[4].config as Record<string, unknown>).chat = true;
    useWorkspaceStore.getState().hydrate(seen as never, info); expect(useWorkspaceStore.getState().loadNotice).toBe('A Gemini chat was removed from this workspace: Gemini runs only in a terminal now.');
  });
  it('keeps the folder when only Gemini chats were saved', () => {
    const only = { ...workspace120(), rootDirectory: '/only', sessions: [{ ...workspace120().sessions[4], config: { engine: 'gemini', model: '', chat: true } }], tiles: [{ ...workspace120().tiles[1], x: 0 }], focusedSessionId: null };
    const before = useWorkspaceStore.getState().sessions;
    useWorkspaceStore.getState().hydrate(only as never, info);
    expect(useWorkspaceStore.getState()).toMatchObject({ rootDirectory: '/only', sessions: before, persistenceReady: true }); expect(useWorkspaceStore.getState().loadNotice).toContain('A Gemini chat was removed');
  });
  it('keeps the folder the host sends when the host already dropped every channel', () => {
    useWorkspaceStore.setState({ rootDirectory: null });
    const before = useWorkspaceStore.getState().sessions;
    useWorkspaceStore.getState().hydrate(null, info, 1, '/kept');
    expect(useWorkspaceStore.getState()).toMatchObject({ rootDirectory: '/kept', sessions: before, persistenceReady: true, loadNotice: 'A Gemini chat was removed from this workspace: Gemini runs only in a terminal now.' });
    useWorkspaceStore.getState().hydrate(null, info); expect(useWorkspaceStore.getState().loadNotice).toBeNull();
  });
});

describe('a Round Table\'s folder', () => {
  it('is its partner\'s own folder, for its lead only', () => {
    const lead = createSession('claude'); const partner = createSession('codex', { mode: 'independent', cwd: '/table' }); const workspaceSeat = createSession('codex');
    const withTable = { ...lead, roundTable: { partner: partner.id, driver: 'claude' as const, rounds: 2 } };
    expect(tableDirectory([withTable, partner], withTable)).toBe('/table');
    expect(tableDirectory([withTable, partner], partner)).toBeNull(); expect(tableDirectory([lead, partner], lead)).toBeNull();
    const following = { ...lead, roundTable: { partner: workspaceSeat.id, driver: 'claude' as const, rounds: 2 } };
    expect(tableDirectory([following, workspaceSeat], following)).toBeNull();
  });
});

describe('events that change nothing', () => {
  it('leave the state as it was, so nothing redraws or is saved for them', () => {
    const session = useWorkspaceStore.getState().sessions[0];
    useWorkspaceStore.getState().markStarting(session.id);
    useWorkspaceStore.getState().applyEvent({ type: 'started', sessionId: session.id, runId: 'run', engine: 'claude', pid: 1, cwd: '/p' });
    const before = useWorkspaceStore.getState(); let notified = 0; const stop = useWorkspaceStore.subscribe(() => { notified++; });
    useWorkspaceStore.getState().applyEvent({ type: 'answered', sessionId: session.id, runId: 'run', at: new Date().toISOString() });
    useWorkspaceStore.getState().applyEvent({ type: 'answered', sessionId: 'elsewhere', runId: 'run', at: new Date().toISOString() });
    useWorkspaceStore.getState().applyEvent({ type: 'exit', sessionId: session.id, runId: 'older', exitCode: 0 });
    expect(notified).toBe(0); expect(useWorkspaceStore.getState()).toBe(before);
    useWorkspaceStore.getState().applyEvent({ type: 'attention', sessionId: session.id, runId: 'run', message: 'Allow?', at: new Date().toISOString() });
    stop(); expect(notified).toBe(1); expect(useWorkspaceStore.getState().sessions[0].attention?.message).toBe('Allow?');
  });
});

describe('adding a chat with every slot taken', () => {
  it('turns no existing channel into a chat', () => {
    while (useWorkspaceStore.getState().sessions.length < MAX_CHANNELS) useWorkspaceStore.getState().addSession('claude');
    const before = useWorkspaceStore.getState().sessions;
    useWorkspaceStore.getState().addChatSession('claude');
    expect(useWorkspaceStore.getState().sessions).toEqual(before);
    expect(useWorkspaceStore.getState().sessions.some((session) => (session.config as { chat?: boolean }).chat)).toBe(false);
  });
});

describe('restoring a run into a full workspace', () => {
  it('replaces a visible idle channel, never a Round Table’s lead or its hidden seat', () => {
    const lead = { ...createSession('claude'), status: 'idle' as const }; const seat = createSession('codex');
    const withTable = { ...lead, roundTable: { partner: seat.id, driver: 'claude' as const, rounds: 2, findings: [] } };
    const running = Array.from({ length: MAX_CHANNELS - 3 }, () => ({ ...createSession('codex'), status: 'running' as const, runId: 'r' }));
    const idle = createSession('claude');
    useWorkspaceStore.setState({ sessions: [withTable, seat, ...running, idle] });
    const run = { runId: 'h', sessionId: 'x', engine: 'codex', cwd: '/restored', config: { engine: 'codex', model: '', reasoningEffort: null } } as never;
    expect(useWorkspaceStore.getState().restoreRun(run)).toBe(true);
    const ids = useWorkspaceStore.getState().sessions.map((session) => session.id);
    expect(ids).toContain(withTable.id); expect(ids).toContain(seat.id); expect(ids).not.toContain(idle.id);
    useWorkspaceStore.setState({ sessions: [withTable, seat, ...running, { ...idle, status: 'running' as const }] });
    expect(useWorkspaceStore.getState().restoreRun(run)).toBe(false);
  });
});

describe('removing a Round Table\'s partner', () => {
  const finding = { id: 'F1', severity: 'high' as const, evidence: '', text: 'problem', status: 'open' as const, response: '', check: '', reviewedAt: null, changedAt: null, round: 1, at: '2026-11-10T00:00:00.000Z' };
  it('keeps the lead\'s record while it holds findings not yet saved, and drops it otherwise', () => {
    for (const findings of [[finding], []]) {
      const lead = createSession('claude'); const seat = createSession('codex'); const other = createSession('claude');
      useWorkspaceStore.setState({ sessions: [{ ...lead, roundTable: { partner: seat.id, driver: 'codex', rounds: 3, findings } }, seat, other] });
      useWorkspaceStore.getState().removeSession(seat.id);
      const kept = useWorkspaceStore.getState().sessions.find((session) => session.id === lead.id)!;
      expect(useWorkspaceStore.getState().sessions.some((session) => session.id === seat.id)).toBe(false);
      if (findings.length) expect(kept.roundTable?.findings).toHaveLength(1); else expect(kept.roundTable).toBeUndefined();
    }
  });
});

describe('a Round Table of four seats', () => {
  /** A lead with three hidden seats, as a table saved from 1.26 names them (partner is the first other seat). */
  function four() {
    const [lead, a, b, c] = [createSession('claude'), createSession('codex'), createSession('claude'), createSession('codex')];
    const led = { ...lead, roundTable: { partner: a.id, driver: 'claude' as const, rounds: 2, seats: [{ session: b.id, name: 'Middle' }, { session: lead.id }, { session: a.id }, { session: c.id }] } };
    const shell = createSession('shell'); const sessions = [led, a, b, c, shell];
    useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'columns') });
    return { lead: led, a, b, c, shell, sessions };
  }
  it('hides every seat but the lead, finds the lead from any seat, and lists the seats lead first', () => {
    const { lead, a, b, c, shell, sessions } = four();
    expect(hiddenSeats(sessions, lead.id).map((seat) => seat.id)).toEqual([b.id, a.id, c.id]);
    expect([a, b, c].map((seat) => leadOf(sessions, seat.id)?.id)).toEqual([lead.id, lead.id, lead.id]); expect(leadOf(sessions, lead.id)).toBeNull(); expect(leadOf(sessions, shell.id)).toBeNull();
    expect(channelsOf(sessions).map((session) => session.id)).toEqual([lead.id, shell.id]);
    expect(channelNumber(sessions, c.id)).toBe(1);
    expect(seatsOf(sessions, lead.id).map(({ seat, session }) => [seat.session, session?.id])).toEqual([[lead.id, lead.id], [b.id, b.id], [a.id, a.id], [c.id, c.id]]);
    expect(seatsOf(sessions, lead.id)[1].seat.name).toBe('Middle'); expect(seatsOf(sessions, shell.id)).toEqual([]);
    expect(tableDirectory(sessions, lead)).toBeNull(); expect(channelsFullNote(sessions)).toBeNull();
  });
  it('fits tiles to the channels the person sees, and saves the table while any hidden seat remains', () => {
    const { lead, a, b, c, sessions } = four();
    expect(fitTiles(sessions, arrangeTiles([lead, a, b, c], 'columns'), 'columns').map((tile) => tile.sessionId)).toEqual([lead.id, sessions[4].id]);
    expect(savedWorkspaceSchema.safeParse(savedWorkspace()).success).toBe(true); expect(savedWorkspace().sessions[0].roundTable?.seats).toHaveLength(4);
    useWorkspaceStore.setState({ sessions: sessions.filter((session) => session.id !== a.id && session.id !== b.id) }); expect(savedWorkspace().sessions[0].roundTable).toBeDefined();
    useWorkspaceStore.setState({ sessions: sessions.filter((session) => ![a, b, c].some((seat) => seat.id === session.id)) }); expect(savedWorkspace().sessions[0].roundTable).toBeUndefined();
  });
  it('takes a stopped lead’s seats along when it is removed, and forgets the table', () => {
    const { lead, sessions } = four();
    useWorkspaceStore.getState().removeSession(lead.id); expect(useWorkspaceStore.getState().sessions.map((session) => session.id)).toEqual([sessions[4].id]);
  });
  it('keeps a seat that still runs as a channel of its own when its lead is removed', () => {
    const { lead, c, sessions } = four();
    useWorkspaceStore.setState({ sessions: sessions.map((session) => session.id === c.id ? { ...session, status: 'running' as const } : session) });
    useWorkspaceStore.getState().removeSession(lead.id); expect(useWorkspaceStore.getState().sessions.map((session) => session.id)).toEqual([c.id, sessions[4].id]);
  });
  it('removing one seat’s channel closes the table that listed it', () => {
    const { lead, b } = four();
    useWorkspaceStore.getState().removeSession(b.id); expect(useWorkspaceStore.getState().sessions.find((session) => session.id === lead.id)?.roundTable).toBeUndefined();
  });
  it('loads a four-seat table saved by 1.26 with its seats hidden', () => {
    four(); const saved = savedWorkspace();
    expect(savedWorkspaceSchema.safeParse(saved).success).toBe(true);
    useWorkspaceStore.getState().hydrate(saved, { directory: '/data' } as never); expect(channelsOf(useWorkspaceStore.getState().sessions)).toHaveLength(2);
  });
});
