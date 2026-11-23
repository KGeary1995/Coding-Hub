import { useEffect } from 'react';
import type { ChannelControl, RemoteChannelChange, RemoteResumeRequest } from '../../shared/remote';
import { permissionLevel } from '../../shared/schemas';
import type { ChannelEngine, Session } from '../../shared/types';
import { HIERARCHY_MODELS, RETIRED_REVIEWER_MODELS } from '../../shared/chat';
import { refreshLinked, routeLinkedEvent } from './linked-terminals';
import { linkedChatKey, receiveChat, receiveReplay } from '../components/chat/RemoteChat';
import { archiveFindings, forgetTable, rememberTable, restoreTables } from './round-table';
import { applyChatEvent, chatEnded, chatStarted } from '../state/chat-store';
import { arrangeTiles, channelsFullNote, channelsOf, createSession, hiddenSeats, resumeConfig, RESUMED_TITLE, leadOf, savedWorkspace, tableDirectory, useWorkspaceStore } from '../state/workspace-store';
import { focusTerminal, onWebGLContextLost, releaseRemovedTerminals, routeTerminalEvent, terminalDimensions } from './terminals';
import { reportWindowHealth } from './window-health';
import { hubCall, useHubStore } from '../state/hub-store';
import { loadLiveCoaching, receiveTip } from '../state/coaching-store';
import { jumpToChannel } from '../components/shell/StatusBar';
import { chainTasks, returnTasks, startTaskAutomation, taskTurnDone } from '../state/task-store';
import { useChatStore } from '../state/chat-store';

/**
 * A chat turn ended. The task sits with the channel that leads a Round Table; there, only the driver's reply says whether it
 * is done (the reviewer's turn ending says nothing about the work).
 */
function chatTurnDone(sessionId: string, failed: boolean) {
  // Near its context limit, the agent is asked to save a handoff itself (a seat at a Round Table is not).
  if (!failed) void askForHandoff(sessionId).catch(() => {});
  const sessions = useWorkspaceStore.getState().sessions; const lead = leadOf(sessions, sessionId) ?? sessions.find((session) => session.id === sessionId);
  const table = lead ? useChatStore.getState().threads[lead.id]?.table : null; const seat = sessions.find((session) => session.id === sessionId);
  // A hierarchy's task is done on the planner's APPROVED (chainTasks), never when a seat's turn ends.
  if (table?.kind === 'hierarchy' || lead?.roundTable?.kind === 'hierarchy') return;
  // Only the driver's reply says whether the work is done: the seat that edits (by session from 1.26, else by its agent).
  if (lead && table && seat && (table.driverSeat ? sessionId !== table.driverSeat : seat.config.engine !== table.driver)) return;
  void taskTurnDone(lead?.id ?? sessionId, failed, { chat: sessionId });
}
import { permissionsRefused, setPermissions } from './permissions';
import { askForHandoff } from './auto-handoff';
import { hiddenSeatIds } from '../../shared/table-seats';
import type { UsageRecord, HubPreferences } from '../../shared/hub';
import { isAgentConfig, isChatRun } from '../../shared/types';

export async function refreshEngines() {
  if (!window.codingHub) return;
  useWorkspaceStore.getState().setDiscovering();
  try {
    const result = await window.codingHub.discoverEngines();
    useWorkspaceStore.getState().setDiscovery(result.ok ? result.value : [], result.ok ? null : result.error.message);
  } catch { useWorkspaceStore.getState().setDiscovery([], 'The native host connection is unavailable.'); }
}

/** Reloads settings and usage after a device sync: other computers' runs, and costs recalculated with synced price rates. */
export async function refreshSynced() {
  const before = new Map(useHubStore.getState().usage.map((record) => [record.runId, record]));
  const [preferences, usage] = await Promise.all([hubCall<HubPreferences>({ action: 'preferences' }), hubCall<UsageRecord[]>({ action: 'usage' })]);
  const store = useHubStore.getState(); if (JSON.stringify(preferences) !== JSON.stringify(store.preferences)) store.setPreferences(preferences);
  // Take the host's records (costs follow synced price rates), except ones a live update replaced during the request.
  const current = new Map(store.usage.map((record) => [record.runId, record])); const fetched = new Set(usage.map((record) => record.runId));
  const merged = usage.map((record) => { const live = current.get(record.runId); return live && live !== before.get(record.runId) ? live : record; });
  store.setUsage([...merged, ...store.usage.filter((record) => !record.machine && !fetched.has(record.runId))]);
}

export function useNativeHost() {
  const sessions = useWorkspaceStore((state) => state.sessions);
  useEffect(() => {
    const host = window.codingHub;
    if (!host) { useWorkspaceStore.setState({ persistenceReady: true, persistenceStatus: 'browser' }); return; }
    let cancelled = false;
    let loaded = false;
    // A terminal's lost WebGL context (once per incident) goes into the health record, which a GPU process death alone would miss.
    onWebGLContextLost(() => reportWindowHealth('context-lost', undefined, 'terminal WebGL'));
    let unsubscribeSave = () => {};
    const unsubscribeUsage = host.onUsage((usage) => {
      useHubStore.getState().upsert(usage);
      // Only when a channel's conversation really changed: every usage update would otherwise redraw the whole window.
      const resumed = (session: Session) => session.runId === usage.runId && session.config.engine === usage.engine && session.config.resumeId !== usage.conversationId;
      if (usage.conversationId && useWorkspaceStore.getState().sessions.some(resumed)) useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => resumed(session) ? { ...session, config: { ...session.config, resumeId: usage.conversationId } } : session) }));
    });
    void hubCall<UsageRecord[]>({ action: 'usage' }).then((usage) => { if (!cancelled) { const live = useHubStore.getState().usage; useHubStore.getState().setUsage([...live, ...usage.filter((u) => !live.some((l) => l.runId === u.runId))]); } }).catch(() => {});
    void hubCall<HubPreferences>({ action: 'preferences' }).then((preferences) => { if (!cancelled) useHubStore.getState().setPreferences(preferences); }).catch(() => {});
    void hubCall<{ asOf: string; claudeModels: string[] }>({ action: 'catalog' }).then((catalog) => { if (!cancelled) useHubStore.setState({ catalog }); }).catch(() => { /* The built-in list. */ });
    // Settings and usage from other computers arrive through the background sync; pick them up once a minute.
    const syncTimer = setInterval(() => { if (useHubStore.getState().preferences.syncDevices) void refreshSynced().catch(() => { /* Tried again next minute. */ }); }, 60000);
    const unsubscribeChat = host.onChatEvent((envelope) => {
      // The agent refused a permission change: the control shows the level still in effect.
      if (envelope.event.type === 'permissions') { void permissionsRefused(envelope.sessionId, envelope.runId, envelope.event.level); return; }
      applyChatEvent(envelope); if (envelope.event.type === 'done') chatTurnDone(envelope.sessionId, envelope.event.isError); if (envelope.event.type === 'table' && envelope.event.table) { rememberTable(envelope.sessionId, envelope.event.table); chainTasks(envelope.sessionId, envelope.event.table); }
      // Tasks from Tasks the host removed from a hierarchy table without starting them (dropped, or the table closed): back to To do.
      if (envelope.event.type === 'table' && envelope.event.discarded?.length) void returnTasks(envelope.sessionId, envelope.event.discarded, envelope.event.table?.chain?.task);
      // Closed by the person, here or from a phone or linked computer: forgotten, and its hidden seats stopped and removed.
      if (envelope.event.type === 'table' && envelope.event.closed) void forgetTable(envelope.sessionId); });
    // A saved Round Table is opened again once both of its chats run (after a restart).
    const unsubscribeTables = useWorkspaceStore.subscribe(restoreTables);
    const stopTasks = startTaskAutomation();
    // A closed Round Table's findings that could not be written to shared memory stay with its channel (Needs you lists
    // them, with Save to memory): they are tried again every few minutes, so a Drive folder that came back needs no click.
    const findingsTimer = setInterval(() => { const sessions = useWorkspaceStore.getState().sessions; for (const session of sessions) { const record = session.roundTable; if (record?.findings?.length && !hiddenSeatIds(record, session.id).some((seat) => sessions.some((other) => other.id === seat))) void forgetTable(session.id); } }, 5 * 60000);
    const unsubscribe = host.onSessionEvent((event) => {
      if (event.type === 'answered' && event.finished) { taskTurnDone(event.sessionId); void askForHandoff(event.sessionId).catch(() => {}); }
      // A chat channel's thread starts (or continues, when resuming) with each run and closes its approvals at exit.
      const before = useWorkspaceStore.getState().sessions.find((item) => item.id === event.sessionId);
      // A chat's thread: Claude Code's or Codex's, or a Round Table's Gemini seat.
      const chatRun = before && isChatRun(before.config);
      if (event.type === 'started' && before && chatRun) chatStarted(event.sessionId, event.runId, isAgentConfig(before.config) && Boolean(before.config.resumeId));
      if (event.type === 'exit' && chatRun) chatEnded(event.sessionId);
      useWorkspaceStore.getState().applyEvent(event);
      try { routeTerminalEvent(event); }
      catch { useWorkspaceStore.getState().setSessionError(event.sessionId, 'The terminal display failed. Stop the channel and restart the app with software terminal rendering in Settings. Recorded output remains available in Session history.'); }
    });
    const unsubscribeErrors = host.onStorageError((logError) => useWorkspaceStore.setState({ logError }));
    const unsubscribeLinked = host.onLinkedEvent(routeLinkedEvent); void refreshLinked();
    // Another computer's chat channels: their events, into this window's chat store, kept apart by computer.
    const unsubscribeLinkedChat = host.onLinkedChatEvent((event) => { const keyOf = linkedChatKey(event.id); if (event.type === 'chat') receiveChat(event.envelope, keyOf); else receiveReplay(event.replay, keyOf); });
    const unsubscribeCoaching = host.onCoachingEvent(receiveTip); void loadLiveCoaching();
    // A clicked desktop notification opens what it is about.
    const unsubscribeAlerts = host.onAlertClick((target) => { if ('sessionId' in target) jumpToChannel(target.sessionId); else if ('computerId' in target) useWorkspaceStore.setState({ computerId: target.computerId, activeView: 'computer' }); else useWorkspaceStore.getState().setView(target.view); });
    // A phone resumed a conversation from its History: a channel for it here, as Session history's Resume makes.
    const unsubscribeResume = host.onRemoteResume((request) => { const error = remoteResume(request); host.finishRemoteControl({ requestId: request.requestId, ...(error ? { error } : {}) }); });
    const unsubscribeControl = host.onRemoteControl((request) => {
      void ('settings' in request ? remoteSettings(request.settings) : 'add' in request ? Promise.resolve(remoteAdd(request.add, request.chat === true, request.like)) : remoteControl(request.sessionId, request.control))
        .then((error) => host.finishRemoteControl({ requestId: request.requestId, ...(error ? { error } : {}) })).catch(() => {});
    });
    const unsubscribeFlush = host.onWorkspaceFlush((requestId) => {
      void host.finishWorkspaceFlush({ requestId, ...(loaded ? { workspace: savedWorkspace() } : {}) }).catch(() => {});
    });
    void host.loadWorkspace().then((result) => {
      if (cancelled) return;
      if (!result.ok) { useWorkspaceStore.setState({ persistenceReady: true, persistenceStatus: 'error', persistenceError: result.error.message }); return; }
      useWorkspaceStore.getState().hydrate(result.value.workspace, result.value.info, result.value.removedChannels, result.value.rootDirectory);
      loaded = true;
      if (result.value.resume) void resumeChannels(result.value.resume);
      let previous = JSON.stringify(savedWorkspace());
      let generation = 0;
      // What the saved workspace is made of: when none of these changed (a status line, a view), nothing is serialized.
      const parts = (state: ReturnType<typeof useWorkspaceStore.getState>) => [state.sessions, state.tiles, state.layoutMode, state.rootDirectory, state.focusedSessionId] as const;
      let seen = parts(useWorkspaceStore.getState());
      unsubscribeSave = useWorkspaceStore.subscribe((state) => {
        const now = parts(state); if (now.every((part, index) => part === seen[index])) return; seen = now;
        const workspace = savedWorkspace(state);
        const next = JSON.stringify(workspace);
        if (next === previous) return;
        previous = next;
        const current = ++generation;
        useWorkspaceStore.setState({ persistenceStatus: 'saving' });
        void host.saveWorkspace(workspace).then((saved) => {
          if (cancelled || current !== generation) return;
          useWorkspaceStore.setState({ persistenceStatus: saved.ok ? 'saved' : 'error', persistenceError: saved.ok ? null : saved.error.message });
        }).catch(() => {
          if (!cancelled && current === generation) useWorkspaceStore.setState({ persistenceStatus: 'error', persistenceError: 'The native storage connection is unavailable.' });
        });
      });
    }).catch(() => {
      if (!cancelled) useWorkspaceStore.setState({ persistenceReady: true, persistenceStatus: 'error', persistenceError: 'The saved workspace could not be loaded. Automatic saving is disabled.' });
    });
    void refreshEngines();
    return () => { cancelled = true; onWebGLContextLost(null); clearInterval(syncTimer); clearInterval(findingsTimer); unsubscribeSave(); unsubscribe(); unsubscribeErrors(); unsubscribeFlush(); unsubscribeUsage(); unsubscribeLinked(); unsubscribeLinkedChat(); unsubscribeTables(); unsubscribeResume(); unsubscribeCoaching(); unsubscribeAlerts(); stopTasks(); unsubscribeControl(); unsubscribeChat(); };
  }, []);
  useEffect(() => { releaseRemovedTerminals(sessions.map((session) => session.id)); }, [sessions]);
}

/**
 * Starts again the channels that were running when Trace quit (1.32.0): an agent on the conversation it saved (one with
 * none would start a new one, so it is left stopped), a shell afresh. Round Table seats too, so the table opens again
 * (restoreTables). One at a time, after the tiles have drawn, so each starts at its own size.
 */
export async function resumeChannels(ids: string[]) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const chosen = useWorkspaceStore.getState().sessions.filter((session) => ids.includes(session.id) && session.status === 'idle' && (!isAgentConfig(session.config) || Boolean(session.config.resumeId)));
  for (const session of chosen) await startSession(session.id);
  const started = chosen.filter((session) => useWorkspaceStore.getState().sessions.find((item) => item.id === session.id)?.status === 'running').length;
  const shown = channelsOf(useWorkspaceStore.getState().sessions).filter((session) => chosen.some((item) => item.id === session.id)).length;
  if (!started) return;
  const line = `${shown === 1 ? 'A channel' : `${shown} channels`} running when Trace closed ${shown === 1 ? 'was' : 'were'} started again on ${shown === 1 ? 'its' : 'their'} conversations${started < chosen.length ? ', and some could not be' : ''}. Settings → Preferences can turn this off.`;
  useWorkspaceStore.setState((state) => ({ loadNotice: state.loadNotice ? `${state.loadNotice} ${line}` : line }));
}

export async function startSession(id: string) {
  const state = useWorkspaceStore.getState();
  if (!state.persistenceReady) return;
  const session = state.sessions.find((item) => item.id === id);
  if (!session || session.status === 'running' || session.status === 'starting') return;
  // A hierarchy table's reviewer saved before it had a model of its own would start on whatever Codex's settings
  // default to, and one saved on a retired reviewer model (gpt-6-astra) on that: both get the table's (Models on the bar
  // can change it while the channel is stopped).
  // A table saved from 1.26 has its seats' own models ('' is a choice there): only the retired reviewer model is replaced.
  const hierarchyLead = leadOf(state.sessions, id)?.roundTable;
  if (session.config.engine === 'codex' && hierarchyLead?.kind === 'hierarchy' && (RETIRED_REVIEWER_MODELS.includes(session.config.model) || (!session.config.model && !hierarchyLead.seats))) {
    state.updateConfig(id, { ...session.config, model: HIERARCHY_MODELS.reviewer });
    const updated = useWorkspaceStore.getState().sessions.find((item) => item.id === id);
    if (updated?.config.engine === 'codex' && updated.config.model) return startSession(id);
  }
  if (!window.codingHub) { state.setSessionError(id, 'Live channels require the Electron desktop app. Run npm.cmd run dev on Windows, or npm run dev on macOS/Linux.', true); return; }
  // A Round Table's lead starts in its table's folder (its hidden seats keep theirs), so the table can be seated again.
  const cwd = tableDirectory(state.sessions, session) ?? (session.binding.mode === 'independent' ? session.binding.cwd : state.rootDirectory);
  if (!cwd) { state.setSessionError(id, 'Choose a workspace root or an independent repository folder first.', true); return; }
  state.markStarting(id);
  try {
    const result = await window.codingHub.startSession({ sessionId: id, cwd, config: session.config, ...terminalDimensions(id) });
    if (!result.ok) useWorkspaceStore.getState().setSessionError(id, result.error.message, true);
    else {
      // The started event usually precedes the invoke reply; never overwrite a later exit.
      if (useWorkspaceStore.getState().sessions.find((item) => item.id === id)?.status === 'starting') {
        useWorkspaceStore.getState().applyEvent({ type: 'started', ...result.value });
        routeTerminalEvent({ type: 'started', ...result.value });
      }
      focusTerminal(id);
    }
  } catch { useWorkspaceStore.getState().setSessionError(id, 'The channel could not be started.', true); }
  // A Round Table's hidden seats have no tile to start them from: they start with their lead, and restoreTables seats them again.
  const lead = useWorkspaceStore.getState().sessions.find((item) => item.id === id);
  const seats = hiddenSeats(useWorkspaceStore.getState().sessions, id);
  await Promise.all(seats.map((seat) => lead?.status === 'running' && seat.status !== 'running' && seat.status !== 'starting' ? startSession(seat.id) : undefined));
}

/** Waits (up to `ms`) until none of these sessions is running, or only until they are past starting. */
export async function settled(ids: (string | undefined)[], past: 'running' | 'starting' = 'running', ms = 5000) {
  const busy = () => useWorkspaceStore.getState().sessions.some((session) => ids.includes(session.id) && (session.status === 'starting' || (past === 'running' && session.status === 'running')));
  for (const end = Date.now() + ms; busy() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Stops a channel, and the hidden seats of a Round Table it leads with it (they have no Stop of their own). */
export async function stopSession(id: string): Promise<boolean> {
  const seats = hiddenSeats(useWorkspaceStore.getState().sessions, id);
  const stopped = await Promise.all([stopRun(id), ...seats.map((seat) => stopRun(seat.id))]);
  return stopped.every(Boolean);
}
/**
 * Stops a channel and closes it, with a Round Table's hidden seats; false when it could not be stopped, or when the table's
 * findings could not be saved to shared memory (the channel stays then, with the reason on it).
 */
export async function closeChannel(id: string): Promise<boolean> {
  const seats = hiddenSeats(useWorkspaceStore.getState().sessions, id); const ids = [id, ...seats.map((seat) => seat.id)];
  if (!(await stopSession(id))) {
    // A run still starting cannot be stopped yet; without this the Close button seems to do nothing.
    if (useWorkspaceStore.getState().sessions.some((session) => ids.includes(session.id) && session.status === 'starting')) useWorkspaceStore.getState().setSessionError(id, 'This channel is still starting. Close it again once it runs.');
    return false;
  }
  // The exit events can arrive just after the stop requests return; a session still running is never removed.
  await settled(ids);
  const unsaved = await keepTableFindings(id); if (unsaved) { useWorkspaceStore.getState().setSessionError(id, unsaved); return false; }
  useWorkspaceStore.getState().removeSession(id);
  return !useWorkspaceStore.getState().sessions.some((session) => session.id === id);
}
/**
 * A Round Table's findings go to shared memory before its channel closes, as closing the table itself does
 * (ChatView's closeTable). Its runs have stopped by now, so no later table event brings them back. The reason, or null.
 */
async function keepTableFindings(id: string): Promise<string | null> {
  // removeSession keeps a live channel, so archiving now would save the findings with the table still open.
  const status = useWorkspaceStore.getState().sessions.find((session) => session.id === id)?.status;
  if (status === 'starting') return 'This channel is still starting. Close it again once it runs.';
  if (status === 'running') return 'This channel is still running. Close it again once it stops.';
  const unsaved = await archiveFindings(id); return unsaved ? `${unsaved} The channel stays open; try Close again.` : null;
}
async function stopRun(id: string): Promise<boolean> {
  const session = useWorkspaceStore.getState().sessions.find((item) => item.id === id);
  if (!session?.runId || session.status !== 'running') return session?.status !== 'starting';
  if (!window.codingHub) return false;
  try {
    const result = await window.codingHub.stopSession({ sessionId: id, runId: session.runId });
    if (!result.ok) useWorkspaceStore.getState().setSessionError(id, result.error.message);
    return result.ok;
  } catch { useWorkspaceStore.getState().setSessionError(id, 'The channel could not be stopped.'); return false; }
}

/**
 * Carries out a linked computer's request to start, stop, restart or close one of this computer's channels, the same
 * way the buttons on its tile would. Returns why it could not, for the other computer to show.
 */
/**
 * A phone's Resume: a channel that continues the conversation in its own folder, as Session history's Resume does (the
 * computer already checked the conversation exists). The desktop's view is left as it is: the person is elsewhere.
 */
export function remoteResume(request: RemoteResumeRequest): string | undefined {
  const state = useWorkspaceStore.getState();
  const full = channelsFullNote(state.sessions); if (full) return full;
  const session = createSession(request.engine, { mode: 'independent', cwd: request.directory });
  session.config = resumeConfig(request.engine, request.id, request.profileId);
  session.title = request.title || RESUMED_TITLE[request.engine];
  // In the layout the desktop already uses: the person is elsewhere.
  const sessions = [...state.sessions, session];
  useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, state.layoutMode) });
  return undefined;
}
/**
 * A phone's channel settings: the name, and for an agent what it may do without asking, its model and (Codex) its
 * reasoning effort, changed as the channel's own settings change them. Permissions also reach a running chat (and
 * every seat at its Round Table); the model and effort are saved only while the channel is stopped, like on its tile.
 * Returns why something could not be changed.
 */
export async function remoteSettings(change: RemoteChannelChange): Promise<string | undefined> {
  const find = () => useWorkspaceStore.getState().sessions.find((item) => item.id === change.sessionId);
  const session = find(); if (!session) return 'That channel is no longer on this computer.';
  if (change.title !== undefined && change.title !== session.title) useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === session.id ? { ...item, title: change.title! } : item) }));
  const agentChange = change.permissions !== undefined || change.model !== undefined || change.effort !== undefined;
  if (!isAgentConfig(session.config)) return agentChange ? 'A terminal channel has no agent settings.' : undefined;
  if (change.permissions !== undefined && change.permissions !== permissionLevel(session.config)) { const error = await setPermissions(session.id, change.permissions); if (error) return error; }
  const now = find(); if (!now || !isAgentConfig(now.config)) return 'That channel is no longer on this computer.';
  const config = now.config; const model = change.model ?? config.model;
  const effort = config.engine === 'codex' ? (change.effort !== undefined ? change.effort : config.reasoningEffort) : null;
  if (model === config.model && (config.engine !== 'codex' || effort === config.reasoningEffort)) return undefined;
  if (now.status === 'running' || now.status === 'starting') return `The ${config.engine === 'codex' ? 'model and reasoning effort change' : 'model changes'} only while the channel is stopped. Stop it, then choose again.`;
  useWorkspaceStore.getState().updateConfig(now.id, config.engine === 'codex' ? { ...config, model, reasoningEffort: effort } : { ...config, model });
  return undefined;
}
/** A linked computer's + Channel: adds the channel here, as this window's own + Channel does. */
export function remoteAdd(engine: ChannelEngine, chat = false, like?: string): string | undefined {
  const before = useWorkspaceStore.getState().sessions.length;
  const full = channelsFullNote(useWorkspaceStore.getState().sessions); if (full) return full;
  // A chat channel (Claude chat or Codex chat) when the phone or other computer asked for one.
  if (chat && (engine === 'claude' || engine === 'codex')) useWorkspaceStore.getState().addChatSession(engine); else useWorkspaceStore.getState().addSession(engine);
  // In the folder another channel works in (a Round Table's seat), whatever the workspace root is now.
  const source = like ? useWorkspaceStore.getState().sessions.find((session) => session.id === like) : undefined;
  if (source) { const cwd = source.runningCwd ?? (source.binding.mode === 'independent' ? source.binding.cwd : null); const added = useWorkspaceStore.getState().sessions.at(-1);
    if (added && added.id !== source.id) useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === added.id ? { ...session, binding: cwd ? { mode: 'independent', cwd } : { ...source.binding } } : session) })); }
  return useWorkspaceStore.getState().sessions.length > before ? undefined : 'The channel could not be added.';
}
export async function remoteControl(id: string, control: ChannelControl): Promise<string | undefined> {
  const current = () => useWorkspaceStore.getState().sessions.find((item) => item.id === id);
  const session = current(); if (!session) return 'That channel is no longer on this computer.';
  const seats = hiddenSeats(useWorkspaceStore.getState().sessions, id);
  if (control !== 'start' && [session, ...seats].some((seat) => seat.status === 'running')) {
    if (!(await stopSession(id))) return current()?.error ?? 'The channel could not be stopped.';
    // The exit events (a Round Table's hidden seats' too) can arrive just after the stop requests return.
    await settled([id, ...seats.map((seat) => seat.id)]);
  }
  if (control === 'stop') return undefined;
  if (control === 'close') {
    // The same rule as the X on its tile: a computer keeps at least one channel.
    if (channelsOf(useWorkspaceStore.getState().sessions).length <= 1) return 'This is the only channel on this computer, so it was stopped but not closed.';
    const unsaved = await keepTableFindings(id); if (unsaved) return unsaved;
    useWorkspaceStore.getState().removeSession(id);
    return current() ? 'The channel could not be closed.' : undefined;
  }
  const ready = current(); if (!ready) return 'That channel is no longer on this computer.';
  if (ready.status === 'running' || ready.status === 'starting') return control === 'start' ? undefined : 'The channel is still running.';
  await startSession(id);
  const after = current();
  return after && (after.status === 'running' || after.status === 'starting') ? undefined : after?.error ?? 'The channel could not start.';
}
