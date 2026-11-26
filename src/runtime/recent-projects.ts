import { create } from 'zustand';
import type { SyncedProject } from '../../shared/hub';
import { hubCall, useHubStore } from '../state/hub-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { openProject } from '../state/projects';

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
  // The other computers' projects, looked at now and every two minutes (sync itself runs on its own schedule).
  const look = () => { void hubCall<SyncedProject[]>({ action: 'synced-projects' }).then((list) => useSyncedProjects.setState({ list: Array.isArray(list) ? list : [] }), () => {}); };
  look(); const timer = setInterval(look, 120_000);
  return () => { stopWorkspace(); stopHub(); clearInterval(timer); };
}

/** Projects opened on the person's other computers and not on this one (device sync): offered to clone here. */
export const useSyncedProjects = create<{ list: SyncedProject[]; error: string | null }>(() => ({ list: [], error: null }));
/** Clones another computer's project into a folder the person picks, and opens it. Whether it opened. */
export async function cloneSyncedProject(project: SyncedProject): Promise<boolean> {
  const host = window.codingHub; if (!host) return false;
  const parent = await host.pickDirectory(); if (!parent) return false;
  const result = await host.projects({ action: 'github-clone', repository: project.repository, parent });
  // Said in the project menu, where it was chosen.
  if (!result.ok) { useSyncedProjects.setState({ error: `${project.name} could not be cloned: ${result.error.message}` }); return false; }
  useSyncedProjects.setState({ error: null });
  openProject((result.value as { directory: string }).directory); return true;
}
