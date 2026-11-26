import { create } from 'zustand';
import { channelNumber, channelsOf, useWorkspaceStore } from '../state/workspace-store';
import { startSession } from './use-native-host';
import { watchOutput, writeTerminal } from './terminals';
import { sendToChannel } from './send-to-channel';
import { DEFAULT_WAIT_SECONDS, outputMatcher, startOrder, STARTUP_QUESTIONS } from '../../shared/start-order';
import { isAgentConfig, isChatRun, type Session } from '../../shared/types';

/** Where Start in order is: shown on its button while it runs, and why it stopped when it did not finish. */
export interface StartProgress { step: number; steps: number; channel: number; waiting: string | null }
export const useStartOrder = create<{ progress: StartProgress | null; notice: string | null }>(() => ({ progress: null, notice: null }));

let cancel: (() => void) | null = null;
/** Agents' output goes quiet this long once they are ready for a message (after a trust or setup prompt is answered). */
export const READY_QUIET_MS = 3000; export const READY_LIMIT_MS = 120_000;
/**
 * After a question it showed (a trust prompt) is answered, longer: Codex opens its review of a new hook a few seconds
 * after the folder is trusted (codex-cli 0.172, the owner's AWS SessionStart hook, 2026-11-25), and a request typed in
 * that moment was lost.
 */
export const READY_AFTER_QUESTION_MS = 10_000;
/** A startup question that appears this soon after the request was typed means it was not taken: it is offered again. */
export const LOST_REQUEST_MS = 15_000;

/**
 * Sends an agent its first request once it is ready: a chat at once, a terminal once its output has gone quiet with
 * nothing waiting for the person (a trust prompt is answered first). Still not ready in time, or not taken: the request
 * is offered on its tile instead, sent with one press. `send` types it another way (a scheduled job sends its task). Whether it was sent.
 */
export async function sendWhenReady(id: string, prompt: string, send: (session: Session) => Promise<boolean> = (session) => sendToChannel(session, prompt)): Promise<boolean> {
  const runId = sessionOf(id)?.runId; let last = Date.now(); let asked = false;
  const offer = () => { if (sessionOf(id)?.runId === runId) useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === id ? { ...item, preparedRequest: { prompt, label: 'Send first request' } } : item) })); };
  const unwatch = watchOutput(id, () => { last = Date.now(); });
  try {
    for (const end = Date.now() + READY_LIMIT_MS; Date.now() < end;) {
      const session = sessionOf(id); if (session?.status !== 'running' || session.runId !== runId) return false;
      if (session.attention) asked = true;
      if (isChatRun(session.config) || (!session.attention && Date.now() - last >= (asked ? READY_AFTER_QUESTION_MS : READY_QUIET_MS))) {
        if (!await send(session)) break;
        if (!isChatRun(session.config)) void offerIfLost(id, runId, offer);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally { unwatch(); }
  offer();
  return false;
}
/** A startup question shown soon after the request was typed: the CLI was not reading requests yet, so it is offered again. */
async function offerIfLost(id: string, runId: string | null | undefined, offer: () => void) {
  for (const end = Date.now() + LOST_REQUEST_MS; Date.now() < end;) {
    const session = sessionOf(id); if (session?.status !== 'running' || session.runId !== runId) return;
    if (session.attention && STARTUP_QUESTIONS.includes(session.attention.message)) { offer(); return; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Start in order on its own when a workspace opens (or a template is applied): only when no channel is running yet. */
export async function autoStartInOrder() {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const sessions = useWorkspaceStore.getState().sessions;
  if (sessions.some((session) => session.status === 'running' || session.status === 'starting') || !sessions.some((session) => session.startup)) return;
  await startInOrder();
}
/** Stops the sequence: the channels already started keep running. */
export function cancelStartOrder() { cancel?.(); }

const sessionOf = (id: string) => useWorkspaceStore.getState().sessions.find((item) => item.id === id);
/** The tiles as laid out, row by row: channels on the same step start in this order. */
const tileOrder = () => [...useWorkspaceStore.getState().tiles].sort((a, b) => a.y - b.y || a.x - b.x).map((tile) => tile.sessionId);

/**
 * Starts the channels that have a step, one after another (shared/start-order.ts). Waits for each to start, types a
 * shell's command, offers an agent's first request on its tile, and holds the next step until a waited-for text appears.
 * Stops, saying why, when a channel does not start, stops while waited for, or the text does not appear in time.
 */
export async function startInOrder() {
  if (useStartOrder.getState().progress) return;
  const steps = startOrder(channelsOf(useWorkspaceStore.getState().sessions), tileOrder());
  if (!steps.length) return;
  let cancelled = false; let wake: (() => void) | null = null;
  cancel = () => { cancelled = true; wake?.(); };
  const report = (notice: string | null) => useStartOrder.setState({ progress: null, notice });
  try {
    for (const [index, planned] of steps.entries()) {
      if (cancelled) return report('Start in order was stopped. The channels already started keep running.');
      const number = channelNumber(useWorkspaceStore.getState().sessions, planned.id); const step = planned.startup!;
      useStartOrder.setState({ progress: { step: index + 1, steps: steps.length, channel: number, waiting: null }, notice: null });
      const before = sessionOf(planned.id); if (!before) continue;
      const wasRunning = before.status === 'running';
      // Watching starts before the channel does, so output written while it starts is not missed.
      let seen = false; const found = step.waitFor ? outputMatcher(step.waitFor) : null;
      const unwatch = found ? watchOutput(planned.id, (data) => { if (!seen && found(data)) { seen = true; wake?.(); } }) : () => {};
      try {
        // A custom agent whose definition takes its first request as arguments is given it at start (docs/custom-agents.md).
        const prompted = !wasRunning && await startSession(planned.id, step.prompt && before.config.engine === 'custom' ? { firstRequest: step.prompt } : {});
        const session = sessionOf(planned.id);
        if (session?.status !== 'running') return report(`CH${number} did not start${session?.error ? `: ${session.error}` : '.'} The rest were not started.`);
        // An already running channel is not typed into again: its command or request was for its start.
        if (!wasRunning && step.command && !isAgentConfig(session.config)) await writeTerminal(planned.id, step.command + '\r');
        if (!wasRunning && !prompted && step.prompt && isAgentConfig(session.config)) void sendWhenReady(planned.id, step.prompt);
        if (!found || isChatRun(session.config) || index === steps.length - 1) continue;
        useStartOrder.setState({ progress: { step: index + 1, steps: steps.length, channel: number, waiting: step.waitFor! } });
        const seconds = step.waitSeconds ?? DEFAULT_WAIT_SECONDS; const runId = session.runId;
        // Woken by the text, by Stop, or every second to see whether the channel stopped; ends at the time limit.
        for (const end = Date.now() + seconds * 1000; !seen && !cancelled;) {
          const now = sessionOf(planned.id);
          if (now?.status !== 'running' || now.runId !== runId) return report(`CH${number} stopped before “${step.waitFor}” appeared. The rest were not started.`);
          if (Date.now() >= end) return report(`“${step.waitFor}” did not appear in CH${number} within ${seconds} seconds. The rest were not started.`);
          await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 1000); }); wake = null;
        }
      } finally { unwatch(); }
    }
    report(cancelled ? 'Start in order was stopped. The channels already started keep running.' : null);
  } finally { cancel = null; if (useStartOrder.getState().progress) report(null); }
}
