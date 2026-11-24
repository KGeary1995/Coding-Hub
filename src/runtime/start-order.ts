import { create } from 'zustand';
import { channelNumber, channelsOf, useWorkspaceStore } from '../state/workspace-store';
import { startSession } from './use-native-host';
import { watchOutput, writeTerminal } from './terminals';
import { DEFAULT_WAIT_SECONDS, outputMatcher, startOrder } from '../../shared/start-order';
import { isAgentConfig, isChatRun } from '../../shared/types';

/** Where Start in order is: shown on its button while it runs, and why it stopped when it did not finish. */
export interface StartProgress { step: number; steps: number; channel: number; waiting: string | null }
export const useStartOrder = create<{ progress: StartProgress | null; notice: string | null }>(() => ({ progress: null, notice: null }));

let cancel: (() => void) | null = null;
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
        if (!wasRunning) await startSession(planned.id);
        const session = sessionOf(planned.id);
        if (session?.status !== 'running') return report(`CH${number} did not start${session?.error ? `: ${session.error}` : '.'} The rest were not started.`);
        // An already running channel is not typed into again: its command or request was for its start.
        if (!wasRunning && step.command && !isAgentConfig(session.config)) await writeTerminal(planned.id, step.command + '\r');
        if (!wasRunning && step.prompt && isAgentConfig(session.config)) useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === planned.id ? { ...item, preparedRequest: { prompt: step.prompt!, label: 'Send first request' } } : item) }));
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
