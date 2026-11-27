import type { ScheduledRunRequest } from '../../shared/remote';
import type { Task, TaskSent } from '../../shared/workbench';
import { isChatEngineConfig, type Session } from '../../shared/types';
import { arrangeTiles, channelsFullNote, createSession, useWorkspaceStore } from '../state/workspace-store';
import { loadTasks, saveTask, sendTask, setTaskStatus, useTaskStore } from '../state/task-store';
import { closeChannel, startSession } from './use-native-host';
import { sendWhenReady } from './start-order';
import { sendToChannel } from './send-to-channel';
import { workbench } from './workbench';
import { dropPreparedTask, peekCoachingPrompt, showPreparedReason, takeCoachingPrompt } from './coaching';
import { useAgentStore } from '../state/agent-store';

const sessionOf = (id: string) => useWorkspaceStore.getState().sessions.find((item) => item.id === id);

/**
 * A scheduled job's run (1.39.0, electron/services/workbench/scheduled-jobs.ts): closes the job's previous channel when
 * the host says it is done with, adds a channel with the run's id for the agent in the job's folder, and starts it.
 * Claude Code and Codex get a chat channel, which takes the task at once (as Start in worktree does); Gemini and a custom
 * agent a terminal.
 * A custom agent whose definition takes its first request as arguments (`firstRequest`) is started with the task.
 * Returns why it could not, for the run's line and its task. Otherwise the task is sent afterwards, once the agent is ready.
 */
export async function scheduledRun(request: ScheduledRunRequest): Promise<string | undefined> {
  if (!useWorkspaceStore.getState().persistenceReady) return 'Trace was still opening its workspace.';
  if (sessionOf(request.sessionId)) return 'That channel is already open.';
  if (request.replace && sessionOf(request.replace)) await closeChannel(request.replace).catch(() => false);
  const state = useWorkspaceStore.getState();
  const full = channelsFullNote(state.sessions); if (full) return full;
  const session = createSession(request.engine, { mode: 'independent', cwd: request.directory }, request.engine === 'custom' && request.agent ? { id: request.agent, name: request.title } : undefined);
  if (request.engine === 'custom' && !request.agent) return 'The job names no agent.';
  session.id = request.sessionId; session.title = request.title;
  if (isChatEngineConfig(session.config)) session.config = { ...session.config, chat: true };
  // In the layout the desktop already uses: the person may be elsewhere.
  const sessions = [...state.sessions, session];
  useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, state.layoutMode) });
  // The task is marked sent (task-send) before the start, so its prompt can go in with it.
  const takesPrompt = request.engine === 'custom' && Boolean(useAgentStore.getState().agents.find((agent) => agent.id === request.agent)?.definition?.firstRequest);
  const sent = takesPrompt ? await workbench<TaskSent>({ action: 'task-send', id: request.taskId }).catch(() => null) : null;
  const prompted = await startSession(session.id, sent ? { firstRequest: sent.prompt } : {});
  const started = sessionOf(session.id);
  if (started?.status !== 'running') { if (sent) await setTaskStatus(request.taskId, 'queued').catch(() => {}); return started?.error ?? 'The channel could not start.'; }
  if (prompted) void loadTasks().catch(() => {});
  else void deliver(request.taskId, session.id, sent?.prompt).catch(() => {});
  return undefined;
}

/** Sends a run's task to its channel, as Send on the Tasks board does; `prompt` when task-send already gave it. False when it was not sent (back in To do). */
async function sendTaskTo(taskId: string, session: Session, prompt?: string) {
  if (isChatEngineConfig(session.config)) return sendTask(taskId).then(() => true, () => false);
  // Already marked sent when it was to go in at the start (a long one, or one the host did not take as arguments).
  const typed = prompt ?? (await workbench<TaskSent>({ action: 'task-send', id: taskId })).prompt;
  if (await sendToChannel(session, typed)) { await loadTasks(); return true; }
  await setTaskStatus(taskId, 'queued'); return false;
}
/**
 * Send first request on a run's channel, after it could not be sent by itself (deliver): the task, marked sent and tracked.
 * Null once sent, else why not, which the tile shows. An offer that no longer applies (the task removed, finished, or given
 * to another channel) goes.
 */
export async function sendPreparedTask(taskId: string, sessionId: string): Promise<string | null> {
  const why = await preparedSend(taskId, sessionId); return showPreparedReason(sessionId, why, why !== null && !peekCoachingPrompt(sessionId));
}
async function preparedSend(taskId: string, sessionId: string): Promise<string | null> {
  // Unread, the board is not taken as empty: the offer stays for another try.
  await loadTasks(); if (useTaskStore.getState().error) return 'Trace could not read the Tasks board. Try again.';
  const session = sessionOf(sessionId); const task = useTaskStore.getState().tasks.find((item) => item.id === taskId);
  if (!task || task.status === 'review' || task.status === 'done' || task.sessionId !== sessionId) { takeCoachingPrompt(sessionId); return !task ? 'That task is no longer on the Tasks board.' : task.sessionId !== sessionId ? 'That task was given to another channel.' : 'That task was already done.'; }
  if (!session || session.status !== 'running') return 'Start this channel first, then send the task.';
  if (isChatEngineConfig(session.config)) return sendTask(taskId).then(() => null, (error: unknown) => error instanceof Error ? error.message : 'The task could not be sent.');
  // A terminal waiting on a question would take the prompt's Enter as its answer (sendTask refuses the same).
  if (session.attention) return 'That channel is waiting for you. Answer what it asks first, then send the task.';
  return sendTaskTo(taskId, session).then((sent) => sent ? null : 'The task could not be typed into that channel. It is back in To do.', (error: unknown) => error instanceof Error ? error.message : 'The task could not be sent.');
}

/** Adds a line to a task's notes from the window. */
async function noteTask(id: string, note: string) {
  const task = useTaskStore.getState().tasks.find((item) => item.id === id); if (!task) return;
  await saveTask({ ...task, notes: [task.notes, note].filter(Boolean).join('\n').slice(-2000) });
}

/**
 * Sends the run's task once the agent is ready (sendWhenReady); `prompt` when task-send already gave it. Claude Code and Codex: as Send on the Tasks board does.
 * A Gemini or added agent's terminal: its marked prompt is typed here, and Tasks reads TASK COMPLETE from its screen
 * (screenSignal), as for one sent from the board. Not sent: the task stays in To do and says why.
 */
export async function deliver(taskId: string, sessionId: string, prompt?: string) {
  await loadTasks(); if (useTaskStore.getState().error) await loadTasks(); const unread = Boolean(useTaskStore.getState().error);
  const task = (): Task | undefined => useTaskStore.getState().tasks.find((item) => item.id === taskId); const sendId = task()?.sendId;
  // Still as the start left it: marked sent then (its prompt went in with the start, or is to be typed here) and not since.
  // With the board unread at first, any Working task counts as that, as before.
  const untyped = () => { const now = task(); return Boolean(prompt) && now?.status === 'active' && (unread ? sendId === undefined || now.sendId === sendId : sendId !== undefined && now.sendId === sendId); };
  // Read again each time, as the person may have acted meanwhile: sent here while still in To do or untyped; otherwise it
  // was sent from the board (Working with another mark), finished, removed, or given to another channel.
  const mine = () => { const now = task(); return Boolean(now) && now!.sessionId === sessionId && (now!.status === 'queued' || untyped()); };
  // To do again: sent as the task anew (task-send marks it), not with the start's prompt.
  const send = async (session: Session) => { await loadTasks(); return mine() && sendTaskTo(taskId, session, untyped() ? prompt : undefined).catch(() => false); };
  // Offered with the task's id (Send first request): pressed, it goes as this task, marked sent, not as its bare details.
  if (await sendWhenReady(sessionId, task()?.details || task()?.title || 'Send the task', send, taskId)) return;
  await loadTasks();
  // Marked sent at the start but never typed: back in To do, so nothing reads it as being worked on.
  if (untyped()) { await setTaskStatus(taskId, 'queued').catch(() => {}); await loadTasks(); }
  if (!mine()) { dropPreparedTask(sessionId, taskId); return; }
  // Offered only on the run it was started for: a channel restarted meanwhile has no button, so the board is named.
  await noteTask(taskId, sessionOf(sessionId)?.status !== 'running' ? 'The channel stopped before the request was sent.' : peekCoachingPrompt(sessionId)?.taskId === taskId ? 'The request could not be sent by itself (the agent was not ready within 2 minutes, or did not take it), so it waits on its channel: press Send first request there.' : 'The request could not be sent by itself (its channel was restarted meanwhile): send it from the Tasks board.');
}
