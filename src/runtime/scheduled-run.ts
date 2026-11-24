import type { ScheduledRunRequest } from '../../shared/remote';
import type { Task, TaskSent } from '../../shared/workbench';
import { isChatEngineConfig, type Session } from '../../shared/types';
import { arrangeTiles, channelsFullNote, createSession, useWorkspaceStore } from '../state/workspace-store';
import { loadTasks, saveTask, sendTask, setTaskStatus, useTaskStore } from '../state/task-store';
import { closeChannel, startSession } from './use-native-host';
import { sendWhenReady } from './start-order';
import { sendToChannel } from './send-to-channel';
import { workbench } from './workbench';
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

/** Adds a line to a task's notes from the window. */
async function noteTask(id: string, note: string) {
  const task = useTaskStore.getState().tasks.find((item) => item.id === id); if (!task) return;
  await saveTask({ ...task, notes: [task.notes, note].filter(Boolean).join('\n').slice(-2000) });
}

/**
 * Sends the run's task once the agent is ready (sendWhenReady); `prompt` when task-send already gave it. Claude Code and Codex: as Send on the Tasks board does.
 * Gemini: Tasks refuses it there, since Trace cannot read Gemini's replies, so its marked prompt is typed here; the task
 * then waits in Working for the person to move it on. Not sent: the task stays in To do and says why.
 */
export async function deliver(taskId: string, sessionId: string, prompt?: string) {
  await loadTasks();
  const task = (): Task | undefined => useTaskStore.getState().tasks.find((item) => item.id === taskId);
  const send = async (session: Session) => {
    if (isChatEngineConfig(session.config)) return sendTask(taskId).then(() => true, () => false);
    // Already marked sent when it was to go in at the start (a long one, or one the host did not take as arguments).
    const typed = prompt ?? (await workbench<TaskSent>({ action: 'task-send', id: taskId })).prompt;
    if (await sendToChannel(session, typed)) { await loadTasks(); return true; }
    await setTaskStatus(taskId, 'queued'); return false;
  };
  if (await sendWhenReady(sessionId, task()?.details ?? '', (session) => send(session).catch(() => false))) return;
  await noteTask(taskId, sessionOf(sessionId)?.status === 'running' ? 'The request could not be sent by itself (the agent was not ready within 2 minutes, or did not take it), so it waits on its channel: press Send first request there.' : 'The channel stopped before the request was sent.');
}
