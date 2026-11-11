import { create } from 'zustand';
import type { Task, TaskOutcome, TaskSent, TaskWatch } from '../../shared/workbench';
import type { ChannelTranscript } from '../../shared/remote';
import type { ChatBlock, RoundTableState } from '../../shared/chat';
import { replyToTask, taskSignal } from '../../shared/task-signal';
import { workbench } from '../runtime/workbench';
import { writeTerminal } from '../runtime/terminals';
import { useWorkspaceStore } from './workspace-store';
import { useActivityStore } from './activity-store';
import { chatFailed, chatSent, useChatStore } from './chat-store';
import { hierarchyDetached } from './hierarchy-state';
import { isAgentConfig } from '../../shared/types';

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
  const { sentAt: _sent, baseline: _baseline, designRef: _design, createdAt: _created, outcome: _outcome, outcomeNote: _note, pullRequest: _pr, sendId: _send, ...fields } = task as Task;
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
  if (!isAgentConfig(session.config)) throw new Error('Give tasks to Claude Code or Codex channels, not terminals or Gemini CLI.');
  // A hierarchy channel whose table is not open would give the task to the builder alone, unplanned and unreviewed.
  const detached = hierarchyDetached(session.id); if (detached) throw new Error(detached);
  const { prompt } = await workbench<TaskSent>({ action: 'task-send', id });
  let sent: boolean;
  if (session.config.chat && window.codingHub) {
    const hierarchy = useChatStore.getState().threads[session.id]?.table?.kind === 'hierarchy';
    chatSent(session.id, prompt, [], !hierarchy);
    // A chat leading a Round Table passes the task to both agents, as a message typed there would.
    const table = Boolean(useChatStore.getState().threads[session.id]?.table);
    const result = await window.codingHub.chat(table ? { action: 'table-send', sessionId: session.id, runId: session.runId, text: prompt, images: [] } : { action: 'send', sessionId: session.id, runId: session.runId, text: prompt, images: [] }).catch(() => null);
    if (!result?.ok) chatFailed(session.id, result && !result.ok ? result.error.message : 'The message could not be sent.');
    sent = Boolean(result?.ok);
  } else sent = await writeTerminal(session.id, prompt + '\r');
  if (!sent) { await setTaskStatus(id, 'queued'); throw new Error('The task could not be typed into that channel. It is back in To do.'); }
  await loadTasks(); void refreshTaskWatch();
}

type Said = { role: 'user' | 'assistant'; text: string };
const textOf = (blocks: ChatBlock[]) => blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
/** The newest reply to a task in a channel's conversation as the CLI recorded it (for terminals, whose screen Trace cannot read). */
async function lastReply(sessionId: string, task: Task): Promise<string | null> {
  try {
    const transcript = await workbench<ChannelTranscript>({ action: 'channel-transcript', sessionId });
    return replyToTask((transcript?.messages ?? []).map((message) => message.role === 'user' ? { role: 'user' as const, text: message.text } : { role: 'assistant' as const, text: textOf(message.blocks) }), task);
  } catch { return null; }
}
/** The newest reply to a task that a chat channel drew (at a Round Table, the seat's own conversation, which has the task as Trace passed it). */
export function chatReply(sessionId: string, task: Task): string | null {
  const items = useChatStore.getState().threads[sessionId]?.items ?? [];
  return replyToTask(items.flatMap((item): Said[] => item.kind === 'user' ? [{ role: 'user', text: item.text }] : item.kind === 'assistant' ? [{ role: 'assistant', text: textOf(item.blocks) }] : []), task);
}

/**
 * The agent ended a turn in a channel (Claude Code's Stop hook, or a chat reply ending). Its task is done only when the
 * reply ends with TASK COMPLETE (task-signal.ts); TASK BLOCKED: … leaves it in Working, waiting for the person, and any
 * other ending (a question, a stop part way) leaves it in Working, marked unconfirmed. An error or interruption: failed.
 * Only the reply after the task's own prompt counts. `from` is where to read it: a chat's own conversation (at a Round
 * Table, the driver seat's), or by default the CLI's transcript of `sessionId`.
 */
export async function taskTurnDone(sessionId: string, failed = false, from?: { chat: string } | { text: string | null }) {
  const task = useTaskStore.getState().tasks.find((item) => item.sessionId === sessionId && item.status === 'active' && item.sentAt);
  // A turn that ends within seconds of the send is the CLI taking the message, not the work.
  if (!task || Date.now() - Date.parse(task.sentAt!) <= 5000) return;
  if (failed) { if (task.outcome !== 'failed') await setTaskStatus(task.id, 'active', 'failed').catch(() => {}); return; }
  const reply = !from ? await lastReply(sessionId, task) : 'chat' in from ? chatReply(from.chat, task) : from.text;
  const signal = taskSignal(reply ?? '');
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
/** When each quiet terminal task's reply was last read, and what it said: read again only when it may have changed. */
const rechecked = new Map<string, { at: number; reply: string }>();
/**
 * A hierarchy Round Table's verdict moves the task given to its channel: APPROVED by the planner sends it to Ready for
 * review; a table that needs the person, or was stopped, marks it so. The builder's own turn ends say nothing here.
 */
export function chainTasks(leadId: string, table: RoundTableState) {
  if (table.kind !== 'hierarchy' || !table.chain) return;
  const task = useTaskStore.getState().tasks.find((item) => item.sessionId === leadId && item.status === 'active' && item.sentAt); if (!task) return;
  const { step, verdict, note } = table.chain;
  if (step === 'done' && verdict === 'approved') void setTaskStatus(task.id, 'review', 'finished').catch(() => {});
  else if (step === 'needs-you' && (task.outcome !== 'blocked' || task.outcomeNote !== note)) void setTaskStatus(task.id, 'active', 'blocked', note.slice(0, 500) || 'The Round Table needs you.').catch(() => {});
  else if (step === 'plan-review' && task.outcome !== 'blocked') void setTaskStatus(task.id, 'active', 'blocked', 'The plan is waiting for your approval.').catch(() => {});
  else if (step === 'stopped' && task.outcome !== 'stopped') void setTaskStatus(task.id, 'active', 'stopped').catch(() => {});
  else if (!['done', 'needs-you', 'plan-review', 'stopped', 'idle'].includes(step) && task.outcome && task.outcome !== 'finished') void setTaskStatus(task.id, 'active').catch(() => {});
}
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
      // A quiet terminal (Codex, which reports no turn end here): its transcript may say TASK COMPLETE or BLOCKED. A task
      // already marked (blocked, not confirmed, quiet) is read again whenever its reply changed, at most every 30 s, so a
      // later TASK COMPLETE after the person answered is not missed.
      if (since > 60000 && !(isAgentConfig(session.config) && session.config.chat) && recent.length >= 45 && recent.every((value) => value === 0)) {
        const last = rechecked.get(task.id);
        if ((!task.outcome || task.outcome === 'blocked' || task.outcome === 'unconfirmed' || task.outcome === 'quiet') && (!last || Date.now() - last.at > 30000)) void lastReply(session.id, task).then((reply) => {
          const seen = rechecked.get(task.id); rechecked.set(task.id, { at: Date.now(), reply: reply ?? '' }); if (task.outcome && seen && seen.reply === (reply ?? '')) return;
          const signal = taskSignal(reply ?? '');
          return signal?.kind === 'complete' ? setTaskStatus(task.id, 'review', 'finished') : signal?.kind === 'blocked' ? (task.outcome === 'blocked' && task.outcomeNote === signal.reason ? undefined : setTaskStatus(task.id, 'active', 'blocked', signal.reason)) : task.outcome ? undefined : setTaskStatus(task.id, 'active', 'quiet');
        }).catch(() => {});
      }
      else if (task.outcome === 'quiet' && recent.some((value) => value > 0)) void setTaskStatus(task.id, 'active').catch(() => {});
    }
    // Every 30 s: the open tasks' changes, and the board itself, so a task moved from a phone shows here too.
    if (++ticks % 6 === 0) { void refreshTaskWatch(); void loadTasks(); }
  };
  void loadTasks().then(() => refreshTaskWatch());
  const timer = setInterval(tick, 5000); return () => clearInterval(timer);
}
