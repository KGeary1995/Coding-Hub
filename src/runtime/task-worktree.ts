import { MAX_CHANNELS } from '../../shared/schemas';
import type { ManagedWorktree } from '../../shared/project-tools';
import { useWorkspaceStore } from '../state/workspace-store';
import { saveTask, sendTask, useTaskStore } from '../state/task-store';
import { startSession } from './use-native-host';

/**
 * Starts a task in a worktree of its own, in one step: a new `coding-hub/<id>` branch from the folder's committed HEAD
 * (uncommitted changes are not copied), a new chat channel there, the task moved to it, then sent. Parallel tasks then
 * never edit the same files; combine the branches through normal Git review. Each step that fails says where it stopped.
 */
export async function startTaskInWorktree(id: string, engine: 'claude' | 'codex') {
  const task = useTaskStore.getState().tasks.find((item) => item.id === id); if (!task) throw new Error('This task is no longer here.');
  if (!window.codingHub) throw new Error('Worktrees need the desktop app.');
  if (useWorkspaceStore.getState().sessions.length >= MAX_CHANNELS) throw new Error(`Trace runs at most ${MAX_CHANNELS} channels. Close one first.`);
  const created = await window.codingHub.projectTools({ action: 'worktree-create', directory: task.directory });
  if (!created.ok) throw new Error(`The worktree could not be created: ${created.error.message}`);
  const tree = created.value as ManagedWorktree;
  // A chat channel takes the task at once; a terminal would first show the CLI's folder-trust question.
  const before = new Set(useWorkspaceStore.getState().sessions.map((session) => session.id));
  useWorkspaceStore.getState().addChatSession(engine);
  const channel = useWorkspaceStore.getState().sessions.find((session) => !before.has(session.id));
  if (!channel) throw new Error(`The worktree ${tree.branch} is ready, but no channel could be added. Add one there by hand.`);
  useWorkspaceStore.getState().updateBinding(channel.id, { mode: 'independent', cwd: tree.directory });
  await saveTask({ ...task, sessionId: channel.id, directory: tree.directory, status: 'queued' });
  await startSession(channel.id);
  const started = useWorkspaceStore.getState().sessions.find((session) => session.id === channel.id);
  if (!started || started.status !== 'running') throw new Error(`The worktree ${tree.branch} and its channel are ready, but the channel did not start${started?.error ? `: ${started.error}` : ''}. The task waits in To do.`);
  await sendTask(id);
  return tree;
}
