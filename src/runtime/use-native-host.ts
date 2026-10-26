import { useEffect } from 'react';
import type { ChannelControl } from '../../shared/remote';
import { refreshLinked, routeLinkedEvent } from './linked-terminals';
import { savedWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { focusTerminal, releaseRemovedTerminals, routeTerminalEvent, terminalDimensions } from './terminals';
import { hubCall, useHubStore } from '../state/hub-store';
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
    const unsubscribe = host.onSessionEvent((event) => {
      useWorkspaceStore.getState().applyEvent(event);
      try { routeTerminalEvent(event); }
      catch { useWorkspaceStore.getState().setSessionError(event.sessionId, 'The terminal display failed. Stop the session and restart the app with software terminal rendering in Settings. Recorded output remains available in Session history.'); }
    });
    const unsubscribeErrors = host.onStorageError((logError) => useWorkspaceStore.setState({ logError }));
    const unsubscribeLinked = host.onLinkedEvent(routeLinkedEvent); void refreshLinked();
    const unsubscribeControl = host.onRemoteControl(({ requestId, sessionId, control }) => {
      void remoteControl(sessionId, control).then((error) => host.finishRemoteControl({ requestId, ...(error ? { error } : {}) })).catch(() => {});
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
      let generation = 0; let timer: ReturnType<typeof setTimeout> | null = null;
      // Changes come in bursts (typing a name, dragging a tile); the latest is saved once they settle. Closing the
      // app does not wait for this: the host asks for the current workspace directly (onWorkspaceFlush).
      const save = () => {
        timer = null;
        const workspace = savedWorkspace(); const next = JSON.stringify(workspace);
        if (next === previous) { useWorkspaceStore.setState({ persistenceStatus: 'saved' }); return; }
        previous = next;
        const current = ++generation;
        void host.saveWorkspace(workspace).then((saved) => {
          if (cancelled || current !== generation) return;
          useWorkspaceStore.setState({ persistenceStatus: saved.ok ? 'saved' : 'error', persistenceError: saved.ok ? null : saved.error.message });
        }).catch(() => {
          if (!cancelled && current === generation) useWorkspaceStore.setState({ persistenceStatus: 'error', persistenceError: 'The native storage connection is unavailable.' });
        });
      };
      unsubscribeSave = useWorkspaceStore.subscribe((state) => {
        if (JSON.stringify(savedWorkspace(state)) === previous) return;
        if (state.persistenceStatus !== 'saving') useWorkspaceStore.setState({ persistenceStatus: 'saving' });
        if (timer) clearTimeout(timer); timer = setTimeout(save, 400);
      });
    }).catch(() => {
      if (!cancelled) useWorkspaceStore.setState({ persistenceReady: true, persistenceStatus: 'error', persistenceError: 'The saved workspace could not be loaded. Automatic saving is disabled.' });
    });
    void refreshEngines();
    return () => { cancelled = true; clearInterval(syncTimer); unsubscribeSave(); unsubscribe(); unsubscribeErrors(); unsubscribeFlush(); unsubscribeUsage(); unsubscribeLinked(); unsubscribeControl(); };
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
}

export async function stopSession(id: string): Promise<boolean> {
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
 * Carries out a linked computer's request to start, stop or restart one of this computer's channels, the same way the
 * buttons on its tile would. Returns why it could not, for the other computer to show.
 */
export async function remoteControl(id: string, control: ChannelControl): Promise<string | undefined> {
  const current = () => useWorkspaceStore.getState().sessions.find((item) => item.id === id);
  const session = current(); if (!session) return 'That channel is no longer on this computer.';
  if (control !== 'start' && session.status === 'running') {
    if (!(await stopSession(id))) return current()?.error ?? 'The channel could not be stopped.';
    // The exit event can arrive just after the stop request returns.
    for (let i = 0; i < 50 && current()?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (control === 'stop') return undefined;
  const ready = current(); if (!ready) return 'That channel is no longer on this computer.';
  if (ready.status === 'running' || ready.status === 'starting') return control === 'start' ? undefined : 'The channel is still running.';
  await startSession(id);
  const after = current();
  return after && (after.status === 'running' || after.status === 'starting') ? undefined : after?.error ?? 'The channel could not start.';
}
