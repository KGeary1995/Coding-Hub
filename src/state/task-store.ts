import { create } from 'zustand';
import type { Task, TaskOutcome, TaskSent, TaskWatch } from '../../shared/workbench';
import type { ChannelTranscript } from '../../shared/remote';
import { taskSignal } from '../../shared/task-signal';
import { workbench } from '../runtime/workbench';
import { writeTerminal } from '../runtime/terminals';
import { useWorkspaceStore } from './workspace-store';
import { useActivityStore } from './activity-store';
import { chatFailed, chatSent, useChatStore } from './chat-store';

/** The columns, in the person's words. */
export const TASK_COLUMNS: { status: Task['status']; label: string; hint: string }[] = [
  { status: 'queued', label: 'To do', hint: 'Not sent yet' },
  { status: 'active', label: 'Working', hint: 'The agent has it' },
  { status: 'review', label: 'Ready for review', hint: 'The agent said TASK COMPLETE' },
  { status: 'done', label: 'Done', hint: 'You checked it' },
];
/**
 * Task coordination as the window shows it: the tasks, each open task's changes and warnings (read every 30 s), and a
 * channel a new task was started from.
 */
export const useTaskStore = create<{ tasks: Task[]; watch: TaskWatch; draftFor: string | null; error: string }>(() => ({ tasks: [], watch: { changed: {}, warnings: [] }, draftFor: null, error: '' }));

export async function loadTasks() { try { useTaskStore.setState({ tasks: await workbench<Task[]>({ action: 'task-list' }), error: '' }); } catch (error) { useTaskStore.setState({ error: (error as Error).message }); } }
export async function saveTask(task: Omit<Task, 'id' | 'createdAt'> & { id?: string }) {
  // Fields the host keeps itself are left out; task-save refuses them.
  const { sentAt: _sent, baseline: _baseline, designRef: _design, createdAt: _created, outcome: _outcome, pullRequest: _pr, ...fields } = task as Task;
  const saved = await workbench<Task>({ action: 'task-save', ...fields }); await loadTasks(); return saved;
}
export async function removeTask(id: string) { await workbench({ action: 'task-remove', id }); await loadTasks(); }
export async function setTaskStatus(id: string, status: Task['status'], outcome?: TaskOutcome, outcomeNote?: string) { await workbench({ action: 'task-status', id, status, ...(outcome ? { outcome, ...(outcomeNote ? { outcomeNote } : {}) } : {}) }); await loadTasks(); }
/** What a task card says about how Trace moved or flagged it; nothing when the agent simply finished. */
export const OUTCOME_TEXT: Record<TaskOutcome, string> = { finished: '', quiet: 'The channel has drawn nothing for 45 seconds. The agent may be finished, or waiting for you: look, then move it on by hand.', stopped: 'The channel stopped before the agent finished. Send it again, or move it on by hand.', failed: 'The channel failed before the agent finished. Send it again, or move it on by hand.', blocked: 'The agent is waiting for you (TASK BLOCKED). Answer it in its channel.', unconfirmed: 'The agent ended its turn without saying TASK COMPLETE: it may have asked you something, or stopped part way. Read its reply, then answer it or move the task on by hand.' };
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
    // A chat leading a Round Table passes the task to both agents, as a message typed there would.
    const table = Boolean(useChatStore.getState().threads[session.id]?.table);
    const result = await window.codingHub.chat(table ? { action: 'table-send', sessionId: session.id, runId: session.runId, text: prompt, images: [] } : { action: 'send', sessionId: session.id, runId: session.runId, text: prompt, images: [] }).catch(() => null);
    if (!result?.ok) chatFailed(session.id, result && !result.ok ? result.error.message : 'The message could not be sent.');
    sent = Boolean(result?.ok);
  } else sent = await writeTerminal(session.id, prompt + '\r');
  if (!sent) { await setTaskStatus(id, 'queued'); throw new Error('The task could not be typed into that channel. It is back in To do.'); }
  await loadTasks(); void refreshTaskWatch();
}

/** The newest reply in a channel's conversation as the CLI recorded it (for terminals, whose screen Trace cannot read). */
async function lastReply(sessionId: string): Promise<string | null> {
  try {
    const transcript = await workbench<ChannelTranscript>({ action: 'channel-transcript', sessionId });
    const last = transcript?.messages.filter((message) => message.role === 'assistant').at(-1);
    return last && last.role === 'assistant' ? last.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n') : null;
  } catch { return null; }
}
/** The newest reply a chat channel drew. */
export function chatReply(sessionId: string): string {
  const last = useChatStore.getState().threads[sessionId]?.items.filter((item) => item.kind === 'assistant').at(-1);
  return last && last.kind === 'assistant' ? last.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n') : '';
}

/**
 * The agent ended a turn in a channel (Claude Code's Stop hook, or a chat reply ending). Its task is done only when the
 * reply ends with TASK COMPLETE (task-signal.ts); TASK BLOCKED: … leaves it in Working, waiting for the person, and any
 * other ending (a question, a stop part way) leaves it in Working, marked unconfirmed. An error or interruption: failed.
 * `reply` is the reply's text when the caller has it (chats); otherwise it is read from the CLI's transcript.
 */
export async function taskTurnDone(sessionId: string, failed = false, reply?: string | null) {
  const task = useTaskStore.getState().tasks.find((item) => item.sessionId === sessionId && item.status === 'active' && item.sentAt);
  // A turn that ends within seconds of the send is the CLI taking the message, not the work.
  if (!task || Date.now() - Date.parse(task.sentAt!) <= 5000) return;
  if (failed) { if (task.outcome !== 'failed') await setTaskStatus(task.id, 'active', 'failed').catch(() => {}); return; }
  const signal = taskSignal((reply === undefined ? await lastReply(sessionId) : reply) ?? '');
  if (signal?.kind === 'complete') await setTaskStatus(task.id, 'review', 'finished').catch(() => {});
  else if (signal?.kind === 'blocked') await setTaskStatus(task.id, 'active', 'blocked', signal.reason).catch(() => {});
  else if (task.outcome !== 'unconfirmed') await setTaskStatus(task.id, 'active', 'unconfirmed').catch(() => {});
}
/**
 * Moves working tasks along by themselves, and reads the open tasks' changes every 30 s. A channel that stops or fails
 * leaves its task in Working, marked, since the work was cut short rather than finished. A CLI that does not say when a
 * turn ends (Codex in a terminal) only gets a mark on its task once the channel has drawn nothing for 45 s, a minute or
 * more after the task was sent: silence is not completion, so the person moves it on. The mark goes when output resumes.
 */
export function startTaskAutomation() {
  let ticks = 0;
  const tick = () => {
    const sessions = useWorkspaceStore.getState().sessions; const samples = useActivityStore.getState().samples;
    for (const task of useTaskStore.getState().tasks) {
      if (task.status !== 'active' || !task.sentAt || !task.sessionId) continue;
      const session = sessions.find((item) => item.id === task.sessionId); const since = Date.now() - Date.parse(task.sentAt);
      if (!session || session.status === 'exited' || session.status === 'error' || session.status === 'idle') { const outcome = session?.status === 'error' ? 'failed' : 'stopped'; if (since > 5000 && task.outcome !== outcome) void setTaskStatus(task.id, 'active', outcome).catch(() => {}); continue; }
      if (session.attention) continue;
      const recent = samples[session.id]?.slice(-45) ?? [];
      // A quiet terminal (Codex, which reports no turn end here): its transcript may already say TASK COMPLETE or BLOCKED.
      if (since > 60000 && !(session.config.engine !== 'shell' && session.config.chat) && recent.length >= 45 && recent.every((value) => value === 0)) { if (!task.outcome) void lastReply(session.id).then((reply) => { const signal = taskSignal(reply ?? ''); return signal?.kind === 'complete' ? setTaskStatus(task.id, 'review', 'finished') : signal?.kind === 'blocked' ? setTaskStatus(task.id, 'active', 'blocked', signal.reason) : setTaskStatus(task.id, 'active', 'quiet'); }).catch(() => {}); }
      else if (task.outcome === 'quiet' && recent.some((value) => value > 0)) void setTaskStatus(task.id, 'active').catch(() => {});
    }
    // Every 30 s: the open tasks' changes, and the board itself, so a task moved from a phone shows here too.
    if (++ticks % 6 === 0) { void refreshTaskWatch(); void loadTasks(); }
  };
  void loadTasks().then(() => refreshTaskWatch());
  const timer = setInterval(tick, 5000); return () => clearInterval(timer);
}
