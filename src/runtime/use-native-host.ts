import { useEffect } from 'react';
import type { ChannelControl, RemoteResumeRequest } from '../../shared/remote';
import type { ChannelEngine } from '../../shared/types';
import { refreshLinked, routeLinkedEvent } from './linked-terminals';
import { linkedChatKey, receiveChat, receiveReplay } from '../components/chat/RemoteChat';
import { forgetTable, rememberTable, restoreTables } from './round-table';
import { applyChatEvent, chatEnded, chatStarted } from '../state/chat-store';
import { arrangeTiles, channelsFullNote, channelsOf, createSession, leadOf, partnerOf, savedWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { focusTerminal, releaseRemovedTerminals, routeTerminalEvent, terminalDimensions } from './terminals';
import { hubCall, useHubStore } from '../state/hub-store';
import { loadLiveCoaching, receiveTip } from '../state/coaching-store';
import { jumpToChannel } from '../components/shell/StatusBar';
import { chainTasks, startTaskAutomation, taskTurnDone } from '../state/task-store';
import { useChatStore } from '../state/chat-store';

/**
 * A chat turn ended. The task sits with the channel that leads a Round Table; there, only the driver's reply says whether it
 * is done (the reviewer's turn ending says nothing about the work).
 */
function chatTurnDone(sessionId: string, failed: boolean) {
  const sessions = useWorkspaceStore.getState().sessions; const lead = leadOf(sessions, sessionId) ?? sessions.find((session) => session.id === sessionId);
  const table = lead ? useChatStore.getState().threads[lead.id]?.table : null; const seat = sessions.find((session) => session.id === sessionId);
  // A hierarchy's task is done on the planner's APPROVED (chainTasks), never when a seat's turn ends.
  if (table?.kind === 'hierarchy') return;
  if (lead && table && seat && seat.config.engine !== table.driver) return;
  void taskTurnDone(lead?.id ?? sessionId, failed, { chat: sessionId });
}
import { permissionsRefused } from './permissions';
import type { UsageRecord, HubPreferences } from '../../shared/hub';

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
    let unsubscribeSave = () => {};
    const unsubscribeUsage = host.onUsage((usage) => {
      useHubStore.getState().upsert(usage);
      if (usage.conversationId) useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.runId === usage.runId && session.config.engine === usage.engine && session.config.resumeId !== usage.conversationId ? { ...session, config: { ...session.config, resumeId: usage.conversationId } } : session) }));
    });
    void hubCall<UsageRecord[]>({ action: 'usage' }).then((usage) => { if (!cancelled) { const live = useHubStore.getState().usage; useHubStore.getState().setUsage([...live, ...usage.filter((u) => !live.some((l) => l.runId === u.runId))]); } }).catch(() => {});
    void hubCall<HubPreferences>({ action: 'preferences' }).then((preferences) => { if (!cancelled) useHubStore.getState().setPreferences(preferences); }).catch(() => {});
    // Settings and usage from other computers arrive through the background sync; pick them up once a minute.
    const syncTimer = setInterval(() => { if (useHubStore.getState().preferences.syncDevices) void refreshSynced(); }, 60000);
    const unsubscribeChat = host.onChatEvent((envelope) => {
      // The agent refused a permission change: the control shows the level still in effect.
      if (envelope.event.type === 'permissions') { void permissionsRefused(envelope.sessionId, envelope.runId, envelope.event.level); return; }
      applyChatEvent(envelope); if (envelope.event.type === 'done') chatTurnDone(envelope.sessionId, envelope.event.isError); if (envelope.event.type === 'table' && envelope.event.table) { rememberTable(envelope.sessionId, envelope.event.table); chainTasks(envelope.sessionId, envelope.event.table); }
      // Closed by the person, here or from a phone or linked computer: forgotten, and its hidden partner stopped and removed.
      if (envelope.event.type === 'table' && envelope.event.closed) void forgetTable(envelope.sessionId); });
    // A saved Round Table is opened again once both of its chats run (after a restart).
    const unsubscribeTables = useWorkspaceStore.subscribe(restoreTables);
    const stopTasks = startTaskAutomation();
    const unsubscribe = host.onSessionEvent((event) => {
      if (event.type === 'answered' && event.finished) taskTurnDone(event.sessionId);
      // A chat channel's thread starts (or continues, when resuming) with each run and closes its approvals at exit.
      const before = useWorkspaceStore.getState().sessions.find((item) => item.id === event.sessionId);
      if (event.type === 'started' && before && before.config.engine !== 'shell' && before.config.chat) chatStarted(event.sessionId, event.runId, Boolean(before.config.resumeId));
      if (event.type === 'exit' && before && before.config.engine !== 'shell' && before.config.chat) chatEnded(event.sessionId);
      useWorkspaceStore.getState().applyEvent(event);
      try { routeTerminalEvent(event); }
      catch { useWorkspaceStore.getState().setSessionError(event.sessionId, 'The terminal display failed. Stop the session and restart the app with software terminal rendering in Settings. Recorded output remains available in Session history.'); }
    });
    const unsubscribeErrors = host.onStorageError((logError) => useWorkspaceStore.setState({ logError }));
    const unsubscribeLinked = host.onLinkedEvent(routeLinkedEvent); void refreshLinked();
    // Another computer's chat channels: their events, into this window's chat store, kept apart by computer.
    const unsubscribeLinkedChat = host.onLinkedChatEvent((event) => { const keyOf = linkedChatKey(event.id); if (event.type === 'chat') receiveChat(event.envelope, keyOf); else receiveReplay(event.replay, keyOf); });
    const unsubscribeCoaching = host.onCoachingEvent(receiveTip); void loadLiveCoaching();
    // A clicked desktop notification opens what it is about.
    const unsubscribeAlerts = host.onAlertClick((target) => { if ('sessionId' in target) jumpToChannel(target.sessionId); else if ('computerId' in target) useWorkspaceStore.setState({ computerId: target.computerId, activeView: 'computer' }); else useWorkspaceStore.getState().setView('usage'); });
    // A phone resumed a conversation from its History: a channel for it here, as Session history's Resume makes.
    const unsubscribeResume = host.onRemoteResume((request) => { const error = remoteResume(request); host.finishRemoteControl({ requestId: request.requestId, ...(error ? { error } : {}) }); });
    const unsubscribeControl = host.onRemoteControl((request) => {
      void ('add' in request ? Promise.resolve(remoteAdd(request.add, request.chat === true, request.like)) : remoteControl(request.sessionId, request.control))
        .then((error) => host.finishRemoteControl({ requestId: request.requestId, ...(error ? { error } : {}) })).catch(() => {});
    });
    const unsubscribeFlush = host.onWorkspaceFlush((requestId) => {
      void host.finishWorkspaceFlush({ requestId, ...(loaded ? { workspace: savedWorkspace() } : {}) }).catch(() => {});
    });
    void host.loadWorkspace().then((result) => {
      if (cancelled) return;
      if (!result.ok) { useWorkspaceStore.setState({ persistenceReady: true, persistenceStatus: 'error', persistenceError: result.error.message }); return; }
      useWorkspaceStore.getState().hydrate(result.value.workspace, result.value.info);
      loaded = true;
      let previous = JSON.stringify(savedWorkspace());
      let generation = 0;
      unsubscribeSave = useWorkspaceStore.subscribe((state) => {
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
    return () => { cancelled = true; clearInterval(syncTimer); unsubscribeSave(); unsubscribe(); unsubscribeErrors(); unsubscribeFlush(); unsubscribeUsage(); unsubscribeLinked(); unsubscribeLinkedChat(); unsubscribeTables(); unsubscribeResume(); unsubscribeCoaching(); unsubscribeAlerts(); stopTasks(); unsubscribeControl(); unsubscribeChat(); };
  }, []);
  useEffect(() => { releaseRemovedTerminals(sessions.map((session) => session.id)); }, [sessions]);
}

export async function startSession(id: string) {
  const state = useWorkspaceStore.getState();
  if (!state.persistenceReady) return;
  const session = state.sessions.find((item) => item.id === id);
  if (!session || session.status === 'running' || session.status === 'starting') return;
  if (!window.codingHub) { state.setSessionError(id, 'Live sessions require the Electron desktop app. Run npm.cmd run dev on Windows, or npm run dev on macOS/Linux.', true); return; }
  const cwd = session.binding.mode === 'independent' ? session.binding.cwd : state.rootDirectory;
  if (!cwd) { state.setSessionError(id, 'Choose a workspace root or an independent repository directory first.', true); return; }
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
  } catch { useWorkspaceStore.getState().setSessionError(id, 'The native session could not be started.', true); }
  // A Round Table's partner has no tile to start it from: it starts with its lead, and restoreTables seats it again.
  const partner = partnerOf(useWorkspaceStore.getState().sessions, id); const lead = useWorkspaceStore.getState().sessions.find((item) => item.id === id);
  if (partner && lead?.status === 'running' && partner.status !== 'running' && partner.status !== 'starting') await startSession(partner.id);
}

/** Waits (up to `ms`) until none of these sessions is running, or only until they are past starting. */
export async function settled(ids: (string | undefined)[], past: 'running' | 'starting' = 'running', ms = 5000) {
  const busy = () => useWorkspaceStore.getState().sessions.some((session) => ids.includes(session.id) && (session.status === 'starting' || (past === 'running' && session.status === 'running')));
  for (const end = Date.now() + ms; busy() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Stops a channel, and the hidden partner of a Round Table it leads with it (that has no Stop of its own). */
export async function stopSession(id: string): Promise<boolean> {
  const partner = partnerOf(useWorkspaceStore.getState().sessions, id);
  const [own, seat] = await Promise.all([stopRun(id), partner ? stopRun(partner.id) : true]);
  return own && seat;
}
/** Stops a channel and closes it, with a Round Table's partner; false when it could not be stopped. */
export async function closeChannel(id: string): Promise<boolean> {
  const partner = partnerOf(useWorkspaceStore.getState().sessions, id);
  if (!(await stopSession(id))) return false;
  // The exit events can arrive just after the stop requests return; a session still running is never removed.
  await settled([id, partner?.id]);
  useWorkspaceStore.getState().removeSession(id);
  return !useWorkspaceStore.getState().sessions.some((session) => session.id === id);
}
async function stopRun(id: string): Promise<boolean> {
  const session = useWorkspaceStore.getState().sessions.find((item) => item.id === id);
  if (!session?.runId || session.status !== 'running') return session?.status !== 'starting';
  if (!window.codingHub) return false;
  try {
    const result = await window.codingHub.stopSession({ sessionId: id, runId: session.runId });
    if (!result.ok) useWorkspaceStore.getState().setSessionError(id, result.error.message);
    return result.ok;
  } catch { useWorkspaceStore.getState().setSessionError(id, 'The session could not be stopped.'); return false; }
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
  session.config = request.engine === 'claude'
    ? { engine: 'claude', resumeId: request.id, ...(request.profileId ? { accountProfileId: request.profileId } : {}), model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }
    : { engine: 'codex', resumeId: request.id, model: '', reasoningEffort: null };
  session.title = request.title || (request.engine === 'claude' ? 'Claude · resumed' : 'Codex · resumed');
  const sessions = [...state.sessions, session];
  useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'grid'), layoutMode: 'grid' });
  return undefined;
}
/** A linked computer's + Channel: adds the channel here, as this window's own + Channel does. */
export function remoteAdd(engine: ChannelEngine, chat = false, like?: string): string | undefined {
  const before = useWorkspaceStore.getState().sessions.length;
  const full = channelsFullNote(useWorkspaceStore.getState().sessions); if (full) return full;
  // A chat channel (Claude chat or Codex chat) when the phone or other computer asked for one.
  if (chat && engine !== 'shell') useWorkspaceStore.getState().addChatSession(engine); else useWorkspaceStore.getState().addSession(engine);
  // In the folder another channel works in (a Round Table's partner), whatever the workspace root is now.
  const source = like ? useWorkspaceStore.getState().sessions.find((session) => session.id === like) : undefined;
  if (source) { const cwd = source.runningCwd ?? (source.binding.mode === 'independent' ? source.binding.cwd : null); const added = useWorkspaceStore.getState().sessions.at(-1);
    if (added && added.id !== source.id) useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === added.id ? { ...session, binding: cwd ? { mode: 'independent', cwd } : { ...source.binding } } : session) })); }
  return useWorkspaceStore.getState().sessions.length > before ? undefined : 'The channel could not be added.';
}
export async function remoteControl(id: string, control: ChannelControl): Promise<string | undefined> {
  const current = () => useWorkspaceStore.getState().sessions.find((item) => item.id === id);
  const session = current(); if (!session) return 'That channel is no longer on this computer.';
  const partner = partnerOf(useWorkspaceStore.getState().sessions, id);
  if (control !== 'start' && (session.status === 'running' || partner?.status === 'running')) {
    if (!(await stopSession(id))) return current()?.error ?? 'The channel could not be stopped.';
    // The exit events (a Round Table's partner's too) can arrive just after the stop requests return.
    await settled([id, partner?.id]);
  }
  if (control === 'stop') return undefined;
  if (control === 'close') {
    // The same rule as the X on its tile: a computer keeps at least one channel.
    if (channelsOf(useWorkspaceStore.getState().sessions).length <= 1) return 'This is the only channel on this computer, so it was stopped but not closed.';
    useWorkspaceStore.getState().removeSession(id);
    return current() ? 'The channel could not be closed.' : undefined;
  }
  const ready = current(); if (!ready) return 'That channel is no longer on this computer.';
  if (ready.status === 'running' || ready.status === 'starting') return control === 'start' ? undefined : 'The channel is still running.';
  await startSession(id);
  const after = current();
  return after && (after.status === 'running' || after.status === 'starting') ? undefined : after?.error ?? 'The channel could not start.';
}
