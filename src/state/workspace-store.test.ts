import { beforeEach, describe, expect, it } from 'vitest';
import { arrangeTiles, createSession, savedWorkspace, useWorkspaceStore } from './workspace-store';

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
    useWorkspaceStore.getState().updateConfig(session.id, { ...session.config, model: 'changed' });
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
  it('caps sessions at four and keeps every tile bound to a unique session', () => {
    for (let index = 0; index < 8; index++) useWorkspaceStore.getState().addSession('codex');
    const { sessions, tiles } = useWorkspaceStore.getState();
    expect(sessions).toHaveLength(4);
    expect(tiles.map((tile) => tile.sessionId)).toEqual(sessions.map((session) => session.id));
    expect(new Set(sessions.map((session) => session.id)).size).toBe(4);
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
  const run = { runId: 'history', sessionId: original.id, engine: 'codex' as const, config: original.config, cwd: '/recorded/repository', startedAt: original.createdAt, endedAt: null, status: 'interrupted' as const, exitCode: null, logFile: '', recordedBytes: 0, logTruncated: false };
  expect(useWorkspaceStore.getState().restoreRun(run)).toBe(true);
  expect(useWorkspaceStore.getState().sessions.at(-1)).toMatchObject({ status: 'idle', pid: null, runId: null, binding: { mode: 'independent', cwd: run.cwd } });
  useWorkspaceStore.getState().addSession('claude');
  useWorkspaceStore.setState({ sessions: useWorkspaceStore.getState().sessions.map((session) => ({ ...session, status: 'running' })) });
  const before = savedWorkspace(); expect(useWorkspaceStore.getState().restoreRun(run)).toBe(false); expect(savedWorkspace()).toEqual(before);
});

it('clears old resume metadata along with Codex overrides for a fresh-default recovery, and preserves active launches',()=>{
 const session=useWorkspaceStore.getState().sessions[1];useWorkspaceStore.getState().updateConfig(session.id,{engine:'codex',model:'old-model',reasoningEffort:'high',resumeId:crypto.randomUUID()});
 useWorkspaceStore.getState().resetCodexConfig(session.id);expect(useWorkspaceStore.getState().sessions[1].config).toEqual({engine:'codex',model:'',reasoningEffort:null});
 useWorkspaceStore.getState().updateConfig(session.id,{engine:'codex',model:'chosen-model',reasoningEffort:'minimal'});useWorkspaceStore.getState().markStarting(session.id);useWorkspaceStore.getState().resetCodexConfig(session.id);expect(useWorkspaceStore.getState().sessions[1].config.model).toBe('chosen-model');
});
