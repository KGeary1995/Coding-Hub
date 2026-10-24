import { create } from 'zustand';

/** Seconds of terminal activity kept per channel for its scope trace. */
export const ACTIVITY_WINDOW = 120;
const EMPTY = Object.freeze(Array<number>(ACTIVITY_WINDOW).fill(0)) as readonly number[];

/** Terminal output per second, oldest first. Only real output is recorded; silence stays at zero. */
export const useActivityStore = create<{ samples: Record<string, readonly number[]> }>(() => ({ samples: {} }));

const pending = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Advances every channel by one second. Exported for tests; the store ticks itself while there is activity. */
export function tickActivity() {
  const current = useActivityStore.getState().samples; let next: Record<string, readonly number[]> | null = null; let active = false;
  for (const id of new Set([...Object.keys(current), ...pending.keys()])) {
    const shifted = [...(current[id] ?? EMPTY).slice(1), pending.get(id) ?? 0];
    next ??= { ...current };
    // A channel silent for the whole window is dropped; reads fall back to the empty trace.
    if (shifted.every((sample) => sample === 0)) delete next[id];
    else { next[id] = shifted; active = true; }
  }
  pending.clear();
  if (next) useActivityStore.setState({ samples: next });
  if (!active && timer) { clearInterval(timer); timer = null; }
}

/** Counts terminal output for a channel in the current second. */
export function recordActivity(sessionId: string, amount: number) {
  if (amount <= 0) return;
  pending.set(sessionId, (pending.get(sessionId) ?? 0) + amount);
  timer ??= setInterval(tickActivity, 1000);
}

export function forgetActivity(sessionId: string) {
  pending.delete(sessionId);
  const { samples } = useActivityStore.getState();
  if (sessionId in samples) { const next = { ...samples }; delete next[sessionId]; useActivityStore.setState({ samples: next }); }
}

export const activitySamples = (sessionId: string) => useActivityStore.getState().samples[sessionId] ?? EMPTY;

export { isPersonInput } from '../../shared/terminal-input';
