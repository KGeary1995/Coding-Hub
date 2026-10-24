import { useEffect } from 'react';
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

/** Reloads settings and the other computers' usage after a device sync; this computer's own usage arrives live. */
export async function refreshSynced() {
  const [preferences, usage] = await Promise.all([hubCall<HubPreferences>({ action: 'preferences' }), hubCall<UsageRecord[]>({ action: 'usage' })]);
  const store = useHubStore.getState(); store.setPreferences(preferences);
  store.setUsage([...store.usage.filter((record) => !record.machine), ...usage.filter((record) => record.machine)]);
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
    return () => { cancelled = true; clearInterval(syncTimer); unsubscribeSave(); unsubscribe(); unsubscribeErrors(); unsubscribeFlush(); unsubscribeUsage(); };
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
