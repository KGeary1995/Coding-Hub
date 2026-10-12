import { create } from 'zustand';
import type { CLIEngine, CLIEngineConfig, GridTile, Session, WorkspaceBinding, SavedWorkspace, StorageInfo, SessionHistoryRun } from '../../shared/types';
import type { EngineInfo, SessionEvent } from '../../shared/ipc';

export type NavigationView = 'workspace' | 'design' | 'coaching' | 'tasks' | 'verification' | 'projects' | 'accounts' | 'history' | 'files' | 'diff' | 'usage' | 'connectors' | 'skills' | 'memory' | 'rules' | 'help' | 'settings' | 'workflow';
export type LayoutMode = 'columns' | 'rows' | 'grid';

export function createSession(engine: CLIEngine, binding: WorkspaceBinding = { mode: 'workspace' }): Session {
  return {
    id: crypto.randomUUID(),
    title: engine === 'claude' ? 'Claude Code' : 'Codex',
    config: engine === 'claude'
      ? { engine, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }
      : { engine, model: '', reasoningEffort: null },
    binding,
    status: 'idle',
    pid: null,
    runId: null,
    runningCwd: null,
    error: null,
    createdAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    logFile: null,
  };
}

export function arrangeTiles(sessions: Session[], mode: LayoutMode): GridTile[] {
  const columns = mode === 'rows' ? 1 : mode === 'columns' ? sessions.length : Math.min(2, sessions.length);
  const width = 12 / columns;
  return sessions.map((session, index) => ({
    sessionId: session.id,
    x: (index % columns) * width,
    y: Math.floor(index / columns) * 12,
    w: width,
    h: 12,
    minW: 3,
    minH: 10,
  }));
}

interface WorkspaceState {
  persistenceReady: boolean;
  persistenceStatus: 'loading' | 'saving' | 'saved' | 'error' | 'browser';
  persistenceError: string | null;
  logError: string | null;
  storageInfo: StorageInfo | null;
  hydrate: (workspace: SavedWorkspace | null, info: StorageInfo) => void;
  rootDirectory: string | null;
  sessions: Session[];
  tiles: GridTile[];
  layoutMode: LayoutMode;
  focusedSessionId: string | null;
  activeView: NavigationView;
  helpTopicId: string;
  workflowTab: 'recovery' | 'search' | 'templates' | 'support';
  designSnapshotId: string | null;
  recoverySessionId: string | null;
  engines: EngineInfo[];
  discovering: boolean;
  discoveryError: string | null;
  setDiscovery: (engines: EngineInfo[], error?: string | null) => void;
  setDiscovering: () => void;
  markStarting: (id: string) => void;
  setSessionError: (id: string, message: string, launchFailure?: boolean) => void;
  applyEvent: (event: SessionEvent) => void;
  setRootDirectory: (directory: string) => void;
  setView: (view: NavigationView) => void;
  restoreRun: (run: SessionHistoryRun) => boolean;
  addSession: (engine: CLIEngine, sourceSessionId?: string) => void;
  removeSession: (id: string) => void;
  updateConfig: (id: string, config: CLIEngineConfig) => void;
  updateBinding: (id: string, binding: WorkspaceBinding) => void;
  setTiles: (tiles: GridTile[]) => void;
  arrange: (mode: LayoutMode) => void;
  toggleFocus: (id: string) => void;
}

const initialSessions = [createSession('claude'), createSession('codex')];

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  persistenceReady: false,
  persistenceStatus: 'loading',
  persistenceError: null,
  logError: null,
  storageInfo: null,
  hydrate: (workspace, storageInfo) => set({
    ...(workspace ? { ...workspace, sessions: workspace.sessions.map((session) => ({ ...session, status: 'idle' as const, pid: null, runId: null, runningCwd: null, error: null, endedAt: null, exitCode: null, logFile: null })) } : {}),
    storageInfo, persistenceReady: true, persistenceStatus: 'saved', persistenceError: null,
  }),
  rootDirectory: null,
  sessions: initialSessions,
  tiles: arrangeTiles(initialSessions, 'columns'),
  layoutMode: 'columns',
  focusedSessionId: null,
  activeView: 'workspace',
  helpTopicId: 'overview',
  workflowTab: 'recovery', designSnapshotId: null, recoverySessionId: null,
  engines: [],
  discovering: false,
  discoveryError: null,
  setDiscovering: () => set({ discovering: true, discoveryError: null }),
  setDiscovery: (engines, discoveryError = null) => set({ engines, discovering: false, discoveryError }),
  markStarting: (id) => set((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, status: 'starting', runId: null, pid: null, runningCwd: null, error: null, exitCode: null, endedAt: null } : session) })),
  setSessionError: (id, error, launchFailure = false) => set((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, error, ...(launchFailure ? { status: 'error' as const, pid: null } : {}) } : session) })),
  applyEvent: (event) => set((state) => event.type === 'data' ? state : ({ sessions: state.sessions.map((session) => {
    if (session.id !== event.sessionId) return session;
    if (event.type === 'started') return session.status === 'starting' ? { ...session, status: 'running', runId: event.runId, pid: event.pid, runningCwd: event.cwd, error: null } : session;
    if (event.runId !== session.runId) return session;
    if (event.type === 'exit') return { ...session, status: 'exited', pid: null, error: event.diagnostic ?? session.error, exitCode: event.exitCode, endedAt: new Date().toISOString() };
    if (event.type === 'error') return { ...session, error: event.message };
    return session;
  }) })),
  setRootDirectory: (rootDirectory) => set((state) => ({ rootDirectory, sessions: state.sessions.map((session) => session.binding.mode === 'workspace' && session.status !== 'running' && session.status !== 'starting' ? { ...session, error: null } : session) })),
  setView: (activeView) => set({ activeView }),
  restoreRun: (run) => {
    const state = get();
    const slot = state.sessions.length >= 4 ? state.sessions.find((session) => session.status !== 'running' && session.status !== 'starting') : null;
    if (state.sessions.length >= 4 && !slot) return false;
    const session = createSession(run.engine, { mode: 'independent', cwd: run.cwd }); session.config = structuredClone(run.config);
    const sessions = slot ? state.sessions.map((item) => item.id === slot.id ? session : item) : [...state.sessions, session];
    set({ sessions, tiles: arrangeTiles(sessions, 'grid'), layoutMode: 'grid', focusedSessionId: null, activeView: 'workspace' });
    return true;
  },
  addSession: (engine, sourceSessionId) => set((state) => {
    if (state.sessions.length >= 4) return state;
    const source = state.sessions.find((session) => session.id === sourceSessionId);
    const session = createSession(engine, source ? { ...source.binding } : undefined);
    if (source?.config.engine === engine) { session.config = structuredClone(source.config); delete session.config.resumeId; }
    const sessions = [...state.sessions, session];
    return { sessions, tiles: arrangeTiles(sessions, 'grid'), layoutMode: 'grid', focusedSessionId: null };
  }),
  removeSession: (id) => set((state) => {
    if (state.sessions.length <= 2 || state.sessions.some((session) => session.id === id && (session.status === 'running' || session.status === 'starting'))) return state;
    const sessions = state.sessions.filter((session) => session.id !== id);
    return {
      sessions,
      tiles: arrangeTiles(sessions, state.layoutMode),
      focusedSessionId: state.focusedSessionId === id ? null : state.focusedSessionId,
    };
  }),
  updateConfig: (id, config) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === id && session.config.engine === config.engine && session.status !== 'running' && session.status !== 'starting'
      ? { ...session, config } : session),
  })),
  updateBinding: (id, binding) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === id && session.status !== 'running' && session.status !== 'starting' ? { ...session, binding, error: null } : session),
  })),
  setTiles: (tiles) => set({ tiles }),
  arrange: (layoutMode) => set((state) => ({ layoutMode, tiles: arrangeTiles(state.sessions, layoutMode) })),
  toggleFocus: (id) => set((state) => ({ focusedSessionId: state.focusedSessionId === id ? null : id })),
}));

export function savedWorkspace(state = useWorkspaceStore.getState()): SavedWorkspace {
  return {
    version: 1, rootDirectory: state.rootDirectory,
    sessions: state.sessions.map(({ id, title, config, binding, createdAt, budget, preparedRequest }) => ({ id, title, config, binding, createdAt, ...(budget ? { budget } : {}), ...(preparedRequest ? { preparedRequest } : {}) })),
    tiles: state.tiles, layoutMode: state.layoutMode, focusedSessionId: state.focusedSessionId,
  };
}
