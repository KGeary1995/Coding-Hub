import { hubCall, useHubStore } from '../state/hub-store';
import { useWorkspaceStore } from '../state/workspace-store';

/** Recent projects (several projects, step 4: docs/plans/several-projects.md): the folders opened last, newest first. */
export const MAX_RECENT = 10;
export const withRecent = (list: readonly string[], directory: string) => [directory, ...list.filter((item) => item !== directory)].slice(0, MAX_RECENT);

/**
 * Keeps the folder the workspace opens in the person's preferences, on this computer only (they are not among the
 * settings that sync between computers). Waits for the preferences to load, so the saved list is not replaced.
 */
export function rememberProjects(): () => void {
  const remember = () => {
    const directory = useWorkspaceStore.getState().rootDirectory; const hub = useHubStore.getState(); if (!directory || !hub.preferencesLoaded) return;
    const list = hub.preferences.recentProjects ?? []; if (list[0] === directory) return;
    const preferences = { ...hub.preferences, recentProjects: withRecent(list, directory) };
    void hubCall({ action: 'save-preferences', preferences }).then(() => useHubStore.getState().setPreferences(preferences), () => {});
  };
  const stopWorkspace = useWorkspaceStore.subscribe((state, previous) => { if (state.rootDirectory !== previous.rootDirectory) remember(); });
  const stopHub = useHubStore.subscribe((state, previous) => { if (state.preferencesLoaded && !previous.preferencesLoaded) remember(); });
  remember();
  return () => { stopWorkspace(); stopHub(); };
}
