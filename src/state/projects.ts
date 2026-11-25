import { create } from 'zustand';
import type { Session } from '../../shared/types';
import type { ManagedWorktree } from '../../shared/project-tools';
import { channelDirectory } from './channel-names';

/**
 * Several projects (step 6, docs/plans/several-projects.md; the owner's choice of 2026-11-25: the grid shows the active
 * project's channels only). A channel's project is the folder it works in, or for a managed worktree the repository the
 * worktree came from; a folder inside the project counts as the project. Nothing new is saved with a channel (an older
 * Trace reading a synced template would refuse a field it does not know): it is worked out from its binding.
 */
export const useWorktrees = create<{ list: ManagedWorktree[] }>(() => ({ list: [] }));
export async function refreshWorktrees() { const result = await window.codingHub?.projectTools({ action: 'worktree-list' }).catch(() => null); if (result?.ok) useWorktrees.setState({ list: result.value as ManagedWorktree[] }); }

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
