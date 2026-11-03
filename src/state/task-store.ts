import { create } from 'zustand';
import type { Task, TaskSent, TaskWatch } from '../../shared/workbench';
import { workbench } from '../runtime/workbench';
import { writeTerminal } from '../runtime/terminals';
import { useWorkspaceStore } from './workspace-store';
import { useActivityStore } from './activity-store';
import { chatFailed, chatSent } from './chat-store';

/** The columns, in the person's words. */
export const TASK_COLUMNS: { status: Task['status']; label: string; hint: string }[] = [
  { status: 'queued', label: 'To do', hint: 'Not sent yet' },
  { status: 'active', label: 'Working', hint: 'The agent has it' },
  { status: 'review', label: 'Ready for review', hint: 'The agent finished or stopped' },
  { status: 'done', label: 'Done', hint: 'You checked it' },
];
/**
 * Task coordination as the window shows it: the tasks, each open task's changes and warnings (read every 30 s), and a
 * channel a new task was started from.
 */
export const useTaskStore = create<{ tasks: Task[]; watch: TaskWatch; draftFor: string | null; error: string }>(() => ({ tasks: [], watch: { changed: {}, warnings: [] }, draftFor: null, error: '' }));

export async function loadTasks() { try { useTaskStore.setState({ tasks: await workbench<Task[]>({ action: 'task-list' }), error: '' }); } catch (error) { useTaskStore.setState({ error: (error as Error).message }); } }
export async function saveTask(task: Omit<Task, 'id' | 'createdAt'> & { id?: string }) {
  const { sentAt: _sent, baseline: _baseline, designRef: _design, ...fields } = task as Task;
  const saved = await workbench<Task>({ action: 'task-save', ...fields }); await loadTasks(); return saved;
}
export async function removeTask(id: string) { await workbench({ action: 'task-remove', id }); await loadTasks(); }
export async function setTaskStatus(id: string, status: Task['status']) { await workbench({ action: 'task-status', id, status }); await loadTasks(); }
export async function refreshTaskWatch() {
  if (!useTaskStore.getState().tasks.some((task) => task.sentAt && (task.status === 'active' || task.status === 'review'))) { useTaskStore.setState({ watch: { changed: {}, warnings: [] } }); return; }
  try { useTaskStore.setState({ watch: await workbench<TaskWatch>({ action: 'task-watch' }) }); } catch { /* Kept as it was. */ }
}
/** Starts a task in the Tasks screen from a channel: its form opens with that channel and its folder. */
export function newTaskFor(sessionId: string) { useTaskStore.setState({ draftFor: sessionId }); useWorkspaceStore.getState().setView('tasks'); }

/**
 * Sends a task to its channel: Trace notes what was already changed in the project, then types the task into the agent
 * (as one message: the goal, its files, and to report what it changed). The channel must be running.
 */
export async function sendTask(id: string) {
  const task = useTaskStore.getState().tasks.find((item) => item.id === id); if (!task?.sessionId) throw new Error('Choose the channel to give this task to first.');
  const session = useWorkspaceStore.getState().sessions.find((item) => item.id === task.sessionId);
  if (!session || session.status !== 'running' || !session.runId) throw new Error('Start that channel first, then send the task.');
  if (session.config.engine === 'shell') throw new Error('Give tasks to Claude Code or Codex channels, not terminals.');
  const { prompt } = await workbench<TaskSent>({ action: 'task-send', id });
  let sent: boolean;
  if (session.config.chat && window.codingHub) {
    chatSent(session.id, prompt, []);
    const result = await window.codingHub.chat({ action: 'send', sessionId: session.id, runId: session.runId, text: prompt, images: [] }).catch(() => null);
    if (!result?.ok) chatFailed(session.id, result && !result.ok ? result.error.message : 'The message could not be sent.');
    sent = Boolean(result?.ok);
  } else sent = await writeTerminal(session.id, prompt + '\r');
  if (!sent) { await setTaskStatus(id, 'queued'); throw new Error('The task could not be typed into that channel. It is back in To do.'); }
  await loadTasks(); void refreshTaskWatch();
}

/** The agent finished a turn in a channel (Claude Code's Stop hook, or a chat reply ending): its working task is ready. */
export function taskTurnDone(sessionId: string) {
  const task = useTaskStore.getState().tasks.find((item) => item.sessionId === sessionId && item.status === 'active' && item.sentAt);
  // A turn that ends within seconds of the send is the CLI taking the message, not the work.
  if (task && Date.now() - Date.parse(task.sentAt!) > 5000) void setTaskStatus(task.id, 'review').catch(() => {});
}
/**
 * Moves working tasks along by themselves: to Ready for review when their channel stops, or (for CLIs that do not say
 * when a turn ends, such as Codex in a terminal) when the channel has drawn nothing for 45 s, a minute or more after the
 * task was sent; and reads the open tasks' changes every 30 s.
 */
export function startTaskAutomation() {
  let ticks = 0;
  const tick = () => {
    const sessions = useWorkspaceStore.getState().sessions; const samples = useActivityStore.getState().samples;
    for (const task of useTaskStore.getState().tasks) {
      if (task.status !== 'active' || !task.sentAt || !task.sessionId) continue;
      const session = sessions.find((item) => item.id === task.sessionId); const since = Date.now() - Date.parse(task.sentAt);
      if (!session || session.status === 'exited' || session.status === 'error' || session.status === 'idle') { if (since > 5000) void setTaskStatus(task.id, 'review').catch(() => {}); continue; }
      const recent = samples[session.id]?.slice(-45) ?? [];
      if (since > 60000 && !(session.config.engine !== 'shell' && session.config.chat) && recent.length >= 45 && recent.every((value) => value === 0)) void setTaskStatus(task.id, 'review').catch(() => {});
    }
    if (++ticks % 6 === 0) void refreshTaskWatch();
  };
  void loadTasks().then(() => refreshTaskWatch());
  const timer = setInterval(tick, 5000); return () => clearInterval(timer);
}
