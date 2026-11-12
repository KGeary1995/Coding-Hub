import { create } from 'zustand';
import type { ChannelEngine, CLIEngineConfig, GridTile, Session, WorkspaceBinding, SavedWorkspace, StorageInfo, SessionHistoryRun } from '../../shared/types';
import type { EngineInfo, SessionEvent } from '../../shared/ipc';
import { MAX_CHANNELS, type LegacySavedWorkspace } from '../../shared/schemas';
import { isAgentConfig } from '../../shared/types';
import { DEFAULT_TITLES } from '../../shared/channel-name';
import { migrateWorkspace } from '../../shared/workspace-migration';

export type NavigationView = 'computer' | 'workspace' | 'coaching' | 'tasks' | 'verification' | 'projects' | 'accounts' | 'history' | 'files' | 'diff' | 'usage' | 'connectors' | 'skills' | 'memory' | 'rules' | 'help' | 'settings' | 'workflow' | 'tools';
export type LayoutMode = 'columns' | 'rows' | 'grid';

export function createSession(engine: ChannelEngine, binding: WorkspaceBinding = { mode: 'workspace' }): Session {
  return {
    id: crypto.randomUUID(),
    title: DEFAULT_TITLES[engine],
    config: engine === 'claude'
      ? { engine, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }
      : engine === 'codex' ? { engine, model: '', reasoningEffort: null } : { engine },
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

/**
 * Chat channels seated at another channel's Round Table (the lead's saved `roundTable.partner`). They run in the
 * background with no tile, number or alert of their own: the lead's tile carries the table. Tables saved by 1.16
 * name their partner the same way, so those partners are hidden on load too.
 */
export function seatedIds(sessions: Session[]) {
  const ids = new Set<string>();
  for (const session of sessions) for (const seat of session.roundTable ? [session.roundTable.partner, session.roundTable.planner] : []) if (seat && seat !== session.id && sessions.some((item) => item.id === seat)) ids.add(seat);
  return ids;
}
/** The channels the person sees, in tile order: every session but seated partners (the same array when there are none). */
export function channelsOf(sessions: Session[]) { const seated = seatedIds(sessions); return seated.size ? sessions.filter((session) => !seated.has(session.id)) : sessions; }
/** The channel whose Round Table this session sits at, if it is a seated partner. */
export const leadOf = (sessions: Session[], id: string) => sessions.find((session) => session.id !== id && (session.roundTable?.partner === id || session.roundTable?.planner === id)) ?? null;
/** The hidden planner of a channel that leads a hierarchy Round Table. */
export const plannerOf = (sessions: Session[], id: string) => { const lead = sessions.find((session) => session.id === id); return lead?.roundTable?.planner ? sessions.find((session) => session.id === lead.roundTable!.planner && session.id !== id) ?? null : null; };
/** Every hidden seat at the Round Table a channel leads: its partner (reviewer) and planner, those it has. */
export const hiddenSeats = (sessions: Session[], id: string) => [partnerOf(sessions, id), plannerOf(sessions, id)].filter((seat): seat is Session => Boolean(seat));
/** A session's channel number as the person sees it (a Round Table's partner goes by its lead's), or 0 for none. */
export const channelNumber = (sessions: Session[], id: string | null) => id ? channelsOf(sessions).findIndex((session) => session.id === (leadOf(sessions, id)?.id ?? id)) + 1 : 0;
/** The hidden partner of a channel that leads a Round Table. */
export const partnerOf = (sessions: Session[], id: string) => { const lead = sessions.find((session) => session.id === id); return lead?.roundTable ? sessions.find((session) => session.id === lead.roundTable!.partner && session.id !== id) ?? null : null; };
/**
 * The folder a Round Table's lead must start in: its partner's, when the partner has a folder of its own. Hidden seats
 * keep the folder they were seated in; a lead that follows the workspace root would otherwise start elsewhere after the
 * root changed, and the host refuses to seat agents in different folders. Null for anything else.
 */
export function tableDirectory(sessions: Session[], session: Session): string | null {
  if (!session.roundTable) return null;
  const partner = partnerOf(sessions, session.id);
  return partner?.binding.mode === 'independent' ? partner.binding.cwd : null;
}
/**
 * Why no channel can be added: every session counts toward the eight, a hidden Round Table partner too (it is a running
 * CLI), so the message says so when one is why the person sees fewer than eight tiles.
 */
export function channelsFullNote(sessions: Session[]) {
  if (sessions.length < MAX_CHANNELS) return null;
  return seatedIds(sessions).size
    ? `This computer already runs ${MAX_CHANNELS} agents and terminals, the most Trace runs at once (a Round Table runs two agents in one channel). Close a channel first.`
    : `This computer already has ${MAX_CHANNELS} channels. Close one there first.`;
}

export function arrangeTiles(all: Session[], mode: LayoutMode): GridTile[] {
  const sessions = channelsOf(all);
  // Columns wrap after four; the grid keeps two rows, so five to eight channels sit three or four across.
  const columns = mode === 'rows' ? 1 : mode === 'columns' ? Math.min(4, sessions.length) : sessions.length <= 2 ? sessions.length : Math.ceil(sessions.length / 2);
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

/**
 * Tiles that match the channels the person sees: one each, none for a hidden Round Table seat or a removed session.
 * The same tiles when they already match; extra tiles are dropped in place; a channel without a tile lays all out again.
 */
export function fitTiles(sessions: Session[], tiles: GridTile[], mode: LayoutMode): GridTile[] {
  const shown = new Set(channelsOf(sessions).map((session) => session.id));
  const kept = tiles.filter((tile, index) => shown.has(tile.sessionId) && tiles.findIndex((other) => other.sessionId === tile.sessionId) === index);
  if (kept.length !== shown.size || !kept.length) return arrangeTiles(sessions, mode);
  return kept.length === tiles.length ? tiles : kept;
}

interface WorkspaceState {
  persistenceReady: boolean;
  persistenceStatus: 'loading' | 'saving' | 'saved' | 'error' | 'browser';
  persistenceError: string | null;
  logError: string | null;
  storageInfo: StorageInfo | null;
  /**
   * Takes a saved workspace in. One saved by 1.19 or 1.20 can hold Gemini channels, which are dropped (migrateWorkspace)
   * before anything is stored; `removedChannels`: those the host already dropped. Either way `loadNotice` says so.
   */
  hydrate: (workspace: SavedWorkspace | LegacySavedWorkspace | null, info: StorageInfo, removedChannels?: number, rootDirectory?: string) => void;
  /** A line about what loading the workspace changed (Gemini channels removed), until the person dismisses it. */
  loadNotice: string | null;
  rootDirectory: string | null;
  sessions: Session[];
  tiles: GridTile[];
  layoutMode: LayoutMode;
  focusedSessionId: string | null;
  activeView: NavigationView;
  helpTopicId: string;
  workflowTab: 'recovery' | 'search' | 'templates' | 'support';
  recoverySessionId: string | null;
  /** The linked computer whose channels the 'computer' view shows. */
  computerId: string | null;
  /** The channel whose repository Changes should open on next; cleared once Changes reads it. */
  reviewSessionId: string | null;
  /** An absolute file path Files should select next (from the command menu); cleared once Files reads it. */
  openFilePath: string | null;
  /** A memory note Shared memory should show next (from the command menu); cleared once Shared memory reads it. */
  openMemoryNote: { project: string; id: string } | null;
  engines: EngineInfo[];
  discovering: boolean;
  discoveryError: string | null;
  setDiscovery: (engines: EngineInfo[], error?: string | null) => void;
  setDiscovering: () => void;
  markStarting: (id: string) => void;
  setSessionError: (id: string, message: string, launchFailure?: boolean) => void;
  applyEvent: (event: SessionEvent) => void;
  /** The person answered: input sent at `sentAt` reached the CLI. A request that arrived after it stays. */
  clearAttention: (id: string, sentAt?: string) => void;
  setRootDirectory: (directory: string) => void;
  setView: (view: NavigationView) => void;
  restoreRun: (run: SessionHistoryRun) => boolean;
  addSession: (engine: ChannelEngine, sourceSessionId?: string) => void;
  /** A Claude channel shown as a conversation (chat) rather than a terminal. */
  addChatSession: (engine: 'claude' | 'codex') => void;
  removeSession: (id: string) => void;
  updateConfig: (id: string, config: CLIEngineConfig) => void;
  resetCodexConfig: (id: string) => void;
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
  loadNotice: null,
  hydrate: (saved, storageInfo, removedByHost = 0, keptRoot) => {
    const migrated = saved ? migrateWorkspace(saved) : { workspace: null, removedChannels: 0, rootDirectory: keptRoot ?? null };
    const removed = removedByHost + migrated.removedChannels;
    const loadNotice = removed ? `${removed === 1 ? 'A Gemini channel was' : `${removed} Gemini channels were`} removed from this workspace: Trace no longer runs Gemini.` : null;
    // Nothing but Gemini channels was saved (here, or already dropped by the host): the default channels, in the saved folder.
    const workspace = migrated.workspace;
    if (!workspace && migrated.rootDirectory) { set({ rootDirectory: migrated.rootDirectory, loadNotice, storageInfo, persistenceReady: true, persistenceStatus: 'saved', persistenceError: null }); return; }
    const sessions = workspace?.sessions.map((session): Session => ({ ...session, status: 'idle' as const, pid: null, runId: null, runningCwd: null, error: null, endedAt: null, exitCode: null, logFile: null }));
    // A workspace from 1.16 gave a Round Table's partner its own tile: laid out again without it.
    const seated = sessions ? seatedIds(sessions) : new Set<string>();
    const tiles = workspace && sessions && workspace.tiles.some((tile) => seated.has(tile.sessionId)) ? arrangeTiles(sessions, workspace.layoutMode) : workspace?.tiles;
    const focused = workspace?.focusedSessionId && seated.has(workspace.focusedSessionId) ? null : workspace?.focusedSessionId ?? null;
    set({ ...(workspace && sessions && tiles ? { ...workspace, sessions, tiles, focusedSessionId: focused } : {}), loadNotice, storageInfo, persistenceReady: true, persistenceStatus: 'saved', persistenceError: null });
  },
  rootDirectory: null,
  sessions: initialSessions,
  tiles: arrangeTiles(initialSessions, 'columns'),
  layoutMode: 'columns',
  focusedSessionId: null,
  activeView: 'workspace',
  helpTopicId: 'overview',
  workflowTab: 'recovery', recoverySessionId: null, computerId: null, reviewSessionId: null, openFilePath: null, openMemoryNote: null,
  engines: [],
  discovering: false,
  discoveryError: null,
  setDiscovering: () => set({ discovering: true, discoveryError: null }),
  setDiscovery: (engines, discoveryError = null) => set({ engines, discovering: false, discoveryError }),
  markStarting: (id) => set((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, status: 'starting', runId: null, pid: null, runningCwd: null, error: null, exitCode: null, endedAt: null } : session) })),
  setSessionError: (id, error, launchFailure = false) => set((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, error, ...(launchFailure ? { status: 'error' as const, pid: null } : {}) } : session) })),
  clearAttention: (id, sentAt) => set((state) => {
    const answered = (session: Session) => session.id === id && session.attention && (!sentAt || session.attention.at <= sentAt);
    return state.sessions.some(answered) ? { sessions: state.sessions.map((session) => answered(session) ? { ...session, attention: null } : session) } : state;
  }),
  applyEvent: (event) => set((state) => event.type === 'data' ? state : ({ sessions: state.sessions.map((session) => {
    if (session.id !== event.sessionId) return session;
    if (event.type === 'started') return session.status === 'starting' ? { ...session, status: 'running', runId: event.runId, pid: event.pid, runningCwd: event.cwd, error: null, attention: null } : session;
    if (event.runId !== session.runId) return session;
    if (event.type === 'answered') return session.attention && session.attention.at <= event.at ? { ...session, attention: null } : session;
    if (event.type === 'attention') return session.status === 'running' ? { ...session, attention: { message: event.message, at: event.at } } : session;
    if (event.type === 'exit') return { ...session, status: 'exited', pid: null, /* An input error from while it ran (a write that failed) does not make a stopped channel a failed one. */ error: event.diagnostic ?? null, exitCode: event.exitCode, endedAt: new Date().toISOString(), attention: null };
    if (event.type === 'error') return { ...session, error: event.message };
    if (event.type === 'conversation') return session.config.engine === 'claude' && !session.config.chat && session.config.resumeId !== event.conversationId ? { ...session, config: { ...session.config, resumeId: event.conversationId } } : session;
    return session;
  }) })),
  setRootDirectory: (rootDirectory) => set((state) => ({ rootDirectory, sessions: state.sessions.map((session) => session.binding.mode === 'workspace' && session.status !== 'running' && session.status !== 'starting' ? { ...session, error: null, runningCwd: null } : session) })),
  setView: (activeView) => set({ activeView }),
  restoreRun: (run) => {
    const state = get();
    const slot = state.sessions.length >= MAX_CHANNELS ? state.sessions.find((session) => session.status !== 'running' && session.status !== 'starting') : null;
    if (state.sessions.length >= MAX_CHANNELS && !slot) return false;
    const session = createSession(run.engine, { mode: 'independent', cwd: run.cwd }); session.config = structuredClone(run.config);
    const sessions = slot ? state.sessions.map((item) => item.id === slot.id ? session : item) : [...state.sessions, session];
    set({ sessions, tiles: arrangeTiles(sessions, 'grid'), layoutMode: 'grid', focusedSessionId: null, activeView: 'workspace' });
    return true;
  },
  addChatSession: (engine) => { useWorkspaceStore.getState().addSession(engine); useWorkspaceStore.setState((state) => { const last = state.sessions.at(-1); return last && last.config.engine === engine ? { sessions: state.sessions.map((session) => session.id === last.id && isAgentConfig(session.config) ? { ...session, config: { ...session.config, chat: true } } : session) } : {}; }); },
  addSession: (engine, sourceSessionId) => set((state) => {
    if (state.sessions.length >= MAX_CHANNELS) return state;
    const source = state.sessions.find((session) => session.id === sourceSessionId);
    const session = createSession(engine, source ? { ...source.binding } : undefined);
    if (source?.config.engine === engine) { session.config = structuredClone(source.config); if (isAgentConfig(session.config)) delete session.config.resumeId; }
    const sessions = [...state.sessions, session];
    return { sessions, tiles: arrangeTiles(sessions, 'grid'), layoutMode: 'grid', focusedSessionId: null };
  }),
  removeSession: (id) => set((state) => {
    const live = (session: Session) => session.status === 'running' || session.status === 'starting';
    if (channelsOf(state.sessions).length <= 1 && !leadOf(state.sessions, id) || state.sessions.some((session) => session.id === id && live(session))) return state;
    // A lead takes its hidden partner along once that has stopped; a partner still running is kept, and shows as its own tile.
    const seats = hiddenSeats(state.sessions, id); const gone = new Set([id, ...seats.flatMap((seat) => !live(seat) ? [seat.id] : [])]);
    const sessions = state.sessions.filter((session) => !gone.has(session.id)).map((session) => {
      if (!session.roundTable) return session;
      if (gone.has(session.roundTable.partner) || (session.roundTable.planner && gone.has(session.roundTable.planner))) return { ...session, roundTable: undefined };
      return session;
    });
    return {
      sessions,
      tiles: arrangeTiles(sessions, state.layoutMode),
      focusedSessionId: state.focusedSessionId && gone.has(state.focusedSessionId) ? null : state.focusedSessionId,
    };
  }),
  updateConfig: (id, config) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === id && session.config.engine === config.engine && session.status !== 'running' && session.status !== 'starting'
      ? { ...session, config } : session),
  })),
  resetCodexConfig: (id) => set((state) => ({ sessions: state.sessions.map((session) => session.id === id && session.config.engine === 'codex' && session.status !== 'running' && session.status !== 'starting' ? { ...session, config: { engine: 'codex' as const, model: '', reasoningEffort: null } } : session) })),
  updateBinding: (id, binding) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === id && session.status !== 'running' && session.status !== 'starting' ? { ...session, binding, error: null, runningCwd: null } : session),
  })),
  setTiles: (tiles) => set({ tiles }),
  arrange: (layoutMode) => set((state) => ({ layoutMode, tiles: arrangeTiles(state.sessions, layoutMode) })),
  toggleFocus: (id) => set((state) => ({ focusedSessionId: state.focusedSessionId === id ? null : id })),
}));

export function savedWorkspace(state = useWorkspaceStore.getState()): SavedWorkspace {
  return {
    version: 1, rootDirectory: state.rootDirectory,
    // A table whose partner is gone is not saved, unless it still holds findings that could not be saved to memory.
    sessions: state.sessions.map(({ id, title, config, binding, createdAt, budget, preparedRequest, roundTable }) => ({ id, title, config, binding, createdAt, ...(budget ? { budget } : {}), ...(preparedRequest ? { preparedRequest } : {}), ...(roundTable && (state.sessions.some((item) => item.id === roundTable.partner) || roundTable.findings?.length) ? { roundTable } : {}) })),
    // Saved tiles always match the channels, whichever path added or removed a hidden seat.
    tiles: fitTiles(state.sessions, state.tiles, state.layoutMode), layoutMode: state.layoutMode,
    focusedSessionId: state.focusedSessionId && channelsOf(state.sessions).some((session) => session.id === state.focusedSessionId) ? state.focusedSessionId : null,
  };
}
