/**
 * Start in order (1.38.0): channels given a step start one after another when the person presses Start in order (never
 * on their own, so a template synced from another computer runs nothing until it is looked at). A shell can have a
 * command typed once it starts, an agent a first request offered with one press, and a step can hold the next one back
 * until a text appears in its output (a dev server's "ready").
 */
export interface StartStep {
  /** 1 starts first; channels with the same number start in their tile order. */
  order: number;
  /** A shell's command, typed once it has started. */
  command?: string;
  /** An agent's first request: offered on its tile once it has started, sent with one press (after any trust prompt). */
  prompt?: string;
  /** The next step waits until this text appears in this channel's output (not case-sensitive). */
  waitFor?: string;
  /** How long to wait for it before stopping the sequence. */
  waitSeconds?: number;
}
export const MAX_STEP = 8; export const MAX_COMMAND = 1000; export const MAX_WAIT_TEXT = 200; export const DEFAULT_WAIT_SECONDS = 120; export const MAX_WAIT_SECONDS = 1800;

/** The channels with a step, in the order they start: by step, then as their tiles are laid out. */
export function startOrder<T extends { id: string; startup?: StartStep }>(sessions: T[], tileOrder: string[]): T[] {
  const place = (id: string) => { const at = tileOrder.indexOf(id); return at < 0 ? Number.MAX_SAFE_INTEGER : at; };
  return sessions.filter((session) => session.startup).sort((a, b) => a.startup!.order - b.startup!.order || place(a.id) - place(b.id));
}

/** Terminal output without its colour, cursor and title codes, so a text can be found in it. */
export const plainOutput = (data: string) => data.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b[\\])/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '').replace(/\r/g, '');

/** Finds a text in output that arrives in pieces: a match split across two pieces is still found. */
export function outputMatcher(text: string) {
  const wanted = text.toLowerCase(); let tail = '';
  return (data: string) => { const seen = tail + plainOutput(data).toLowerCase(); if (seen.includes(wanted)) return true; tail = seen.slice(-Math.max(wanted.length * 2, 256)); return false; };
}
