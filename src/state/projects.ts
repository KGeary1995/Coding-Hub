import { create } from 'zustand';
import type { GridTile, Session } from '../../shared/types';
import type { ManagedWorktree } from '../../shared/project-tools';
import { channelDirectory } from './channel-names';
import { useWorkspaceStore } from './workspace-store';

/**
 * Several projects (step 6, docs/plans/several-projects.md; the owner's choice of 2026-11-25: the grid shows the active
 * project's channels only). A channel's project is the folder it works in, or for a managed worktree the repository the
 * worktree came from; a folder inside the project counts as the project. Nothing new is saved with a channel (an older
 * Trace reading a synced template would refuse a field it does not know): it is worked out from its binding.
 */
export const useWorktrees = create<{ list: ManagedWorktree[]; loaded: boolean }>(() => ({ list: [], loaded: false }));
/** All projects in the grid at once (the project menu's All projects; the owner's choice of 2026-11-25), until a project is picked. */
export const useAllProjects = create<{ on: boolean }>(() => ({ on: false }));
/** Turns All projects on or off; every tile is laid out again, so the grid fits however many channels it then shows. */
export function setAllProjects(on: boolean) { useAllProjects.setState({ on }); const state = useWorkspaceStore.getState(); state.arrange(state.layoutMode); }
/** A folder's last part: the name a project goes by in the project menu. */
export const folderName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;
/** What the project button says: All projects while every project's channels show (it named the open one, 1.48.0). */
export const projectLabel = (rootDirectory: string | null, all: boolean) => !rootDirectory ? null : all ? 'All projects' : folderName(rootDirectory);
export async function refreshWorktrees() { const result = await window.codingHub?.projectTools({ action: 'worktree-list' }).catch(() => null); useWorktrees.setState({ list: result?.ok ? result.value as ManagedWorktree[] : useWorktrees.getState().list, loaded: true }); }

const clean = (folder: string) => folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** Whether `folder` is `project` or inside it (paths compared as Windows does, without case). */
export const within = (folder: string, project: string) => { const a = clean(folder); const b = clean(project); return a === b || a.startsWith(b + '/'); };

export function channelProject(session: Session, rootDirectory: string | null, worktrees: readonly ManagedWorktree[]): string | null {
  const folder = channelDirectory(session, rootDirectory); if (!folder) return rootDirectory;
  return worktrees.find((tree) => clean(tree.directory) === clean(folder))?.repository ?? folder;
}
/** Shown in the grid: its project is the active one (with no project open, every channel is). */
export const inActiveProject = (session: Session, rootDirectory: string | null, worktrees: readonly ManagedWorktree[]) => { const project = channelProject(session, rootDirectory, worktrees); return !rootDirectory || !project || within(project, rootDirectory); };
/** The other projects that have channels, each once, with how many (for the project menu). */
export function otherProjects(channels: Session[], rootDirectory: string | null, worktrees: readonly ManagedWorktree[]): { folder: string; channels: number }[] {
  const counts = new Map<string, { folder: string; channels: number }>();
  for (const session of channels) { if (inActiveProject(session, rootDirectory, worktrees)) continue; const folder = channelProject(session, rootDirectory, worktrees); if (!folder) continue; const key = clean(folder); counts.set(key, { folder, channels: (counts.get(key)?.channels ?? 0) + 1 }); }
  return [...counts.values()];
}

/**
 * Which channels the grid shows, settled when a project opens: changing a channel's folder in its settings does not move
 * it out of sight while it is being typed, and a channel added later shows in the project it was added in. Opening
 * another project settles it again (`settled` null: worked out from the rule above).
 */
export const useShownChannels = create<{ settled: { known: string[]; shown: string[] } | null }>(() => ({ settled: null }));
// A project opened any way (the menu, Change project, Projects, a clone) also ends All projects.
useWorkspaceStore.subscribe((state, previous) => { if (state.rootDirectory !== previous.rootDirectory) { useShownChannels.setState({ settled: null }); useAllProjects.setState({ on: false }); } });
/** The channels shown: by the rule once, then as settled (new channels shown). Settles it when it is not. */
export function shownChannels(channels: Session[], rootDirectory: string | null, worktrees: readonly ManagedWorktree[]): Session[] {
  const settled = useShownChannels.getState().settled;
  // Settled once the worktrees are known (a worktree's channel belongs to its repository's project), not before.
  if (!settled) { const shown = channels.filter((session) => inActiveProject(session, rootDirectory, worktrees)); if (useWorktrees.getState().loaded) queueMicrotask(() => useShownChannels.setState({ settled: { known: channels.map((session) => session.id), shown: shown.map((session) => session.id) } })); return shown; }
  return channels.filter((session) => !settled.known.includes(session.id) || settled.shown.includes(session.id));
}
/**
 * The saved tiles after the shown ones moved (the grid lays out only the shown ones, afresh from the top): the hidden
 * channels' tiles keep their order among themselves, below the shown ones, since a saved workspace must not overlap.
 */
export function mergeTiles(saved: GridTile[], moved: GridTile[]): GridTile[] {
  const hidden = saved.filter((tile) => !moved.some((item) => item.sessionId === tile.sessionId)); if (!hidden.length) return moved;
  const shift = Math.max(0, Math.max(0, ...moved.map((tile) => tile.y + tile.h)) - Math.min(...hidden.map((tile) => tile.y)));
  return [...hidden.map((tile) => ({ ...tile, y: tile.y + shift })), ...moved];
}
