import { beforeEach, describe, expect, it } from 'vitest';
import { arrangeTiles, createSession, savedWorkspace, useWorkspaceStore } from './workspace-store';
import { MAX_CHANNELS, savedWorkspaceSchema } from '../../shared/schemas';
import type { CLIEngineConfig, CodexCLIEngineConfig } from '../../shared/types';

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

  it('restores the grid after closing an isolated tile, preserving the two-session minimum', () => {
    useWorkspaceStore.getState().addSession('codex');
    const third = useWorkspaceStore.getState().sessions[2];
    useWorkspaceStore.getState().toggleFocus(third.id);
    useWorkspaceStore.getState().removeSession(third.id);
    expect(useWorkspaceStore.getState().focusedSessionId).toBeNull();
    expect(useWorkspaceStore.getState().tiles).toHaveLength(2);
    useWorkspaceStore.getState().removeSession(useWorkspaceStore.getState().sessions[0].id);
    expect(useWorkspaceStore.getState().sessions).toHaveLength(2);
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
