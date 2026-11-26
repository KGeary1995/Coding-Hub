import { MAX_CHANNELS } from '../../shared/schemas';
import type { ManagedWorktree } from '../../shared/project-tools';
import { movedTask } from '../state/task-move';
import { useWorkspaceStore } from '../state/workspace-store';
import { refreshWorktrees } from '../state/projects';
import { saveTask, sendTask, useTaskStore } from '../state/task-store';
import { startSession } from './use-native-host';
import { hubCall } from '../state/hub-store';
import type { SharedRules } from '../../shared/hub';

/**
 * Project setup for a new worktree: the shared rules, applied to its CLAUDE.md and AGENTS.md as Save and apply would (a
 * launch there is refused without them). Dependencies are not installed: that runs project code, which the person does
 * themselves. Returns whether rules were applied.
 */
export async function setUpWorktree(directory: string): Promise<boolean> {
  const rules = await hubCall<SharedRules>({ action: 'rules-read', directories: [directory] });
  // One folder was asked for, so its target is the only one. The host names it in the folder's native spelling, which
  // can differ from `directory` by more than letter case (8.3 names, subst or mapped drives).
  const target = rules.targets[0];
  if (!rules.content.trim() || !target || target.applied) return false;
  if (target.error) throw new Error(`The worktree is ready, but the shared rules could not be applied there: ${target.error}`);
  await hubCall<SharedRules>({ action: 'rules-save', content: rules.content, revision: rules.revision, targets: [{ directory: target.directory, claudeHash: target.claudeHash, codexHash: target.codexHash }] });
  return true;
}

/**
 * Starts a task in a worktree of its own, in one step: a new `coding-hub/<id>` branch from the folder's committed HEAD
 * (uncommitted changes are not copied), a new chat channel there, the task moved to it, then sent. Parallel tasks then
 * never edit the same files; combine the branches through normal Git review. Each step that fails says where it stopped.
 */
export async function startTaskInWorktree(id: string, engine: 'claude' | 'codex' | 'gemini') {
  const task = useTaskStore.getState().tasks.find((item) => item.id === id); if (!task) throw new Error('This task is no longer here.');
  if (!window.codingHub) throw new Error('Worktrees need the desktop app.');
  if (useWorkspaceStore.getState().sessions.length >= MAX_CHANNELS) throw new Error(`Trace runs at most ${MAX_CHANNELS} channels. Close one first.`);
  const created = await window.codingHub.projectTools({ action: 'worktree-create', directory: task.directory });
  if (!created.ok) throw new Error(`The worktree could not be created: ${created.error.message}`);
  const tree = created.value as ManagedWorktree;
  const ruled = await setUpWorktree(tree.directory);
  // A chat channel takes the task at once; a terminal would first show the CLI's folder-trust question.
  const before = new Set(useWorkspaceStore.getState().sessions.map((session) => session.id));
  useWorkspaceStore.getState().addChatSession(engine);
  const channel = useWorkspaceStore.getState().sessions.find((session) => !before.has(session.id));
  if (!channel) throw new Error(`The worktree ${tree.branch} is ready, but no channel could be added. Add one there by hand.`);
  // The worktree known first, so the channel counts in its repository's project (projects.ts), not as one of its own.
  await refreshWorktrees(); useWorkspaceStore.getState().updateBinding(channel.id, { mode: 'independent', cwd: tree.directory });
  await saveTask(movedTask(task, channel.id, tree.directory));
  await startSession(channel.id);
  const started = useWorkspaceStore.getState().sessions.find((session) => session.id === channel.id);
  if (!started || started.status !== 'running') throw new Error(`The worktree ${tree.branch} and its channel are ready, but the channel did not start${started?.error ? `: ${started.error}` : ''}. The task waits in To do.`);
  await sendTask(id);
  return { ...tree, rulesApplied: ruled };
}
