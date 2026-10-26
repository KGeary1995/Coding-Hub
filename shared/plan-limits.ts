/**
 * How much of a subscription's usage limits is used: Claude's 5-hour session and weekly limits, Codex's limits (a
 * weekly one, and a 5-hour one on plans that have it). Read from each CLI without a model request.
 */
export interface LimitWindow {
  /** "Session" (the rolling 5-hour window), "Week", or a named weekly limit such as "Week (Fable)". */
  label: string;
  usedPercent: number;
  /** When it resets, as an ISO time when the CLI gives one, else as the CLI words it ("Oct 31 at 7:59am"). */
  resets: string | null;
}
export interface PlanLimits {
  engine: 'claude' | 'codex';
  /** "Default" for the CLI's own login, or a Claude account profile's name. */
  account: string;
  windows: LimitWindow[];
  /** The plan the CLI reports, when it does (Codex). */
  plan: string | null;
  checkedAt: string;
  error: string | null;
}

/** Parses Claude Code's `/usage` text ("Current session: 5% used · resets Oct 25 at 11:59pm (America/Los_Angeles)"). */
export function parseClaudeUsage(text: string): LimitWindow[] {
  const windows: LimitWindow[] = [];
  for (const match of text.matchAll(/^Current (session|week)( \(([^)]+)\))?:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets ([^\n(]+?)(?:\s*\([^)]*\))?)?\s*$/gm)) {
    const scope = match[3]; const label = match[1] === 'session' ? 'Session' : !scope || /^all models$/i.test(scope) ? 'Week' : `Week (${scope})`;
    windows.push({ label, usedPercent: Number(match[4]), resets: match[5]?.trim() || null });
  }
  return windows;
}

/** A Codex rate-limit window, named by its length. */
export function codexWindow(window: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }): LimitWindow {
  const minutes = window.windowDurationMins ?? 0;
  const label = minutes > 0 && minutes <= 360 ? 'Session' : minutes >= 10000 && minutes <= 10200 ? 'Week' : minutes ? `${Math.round(minutes / 60)} h` : 'Limit';
  return { label, usedPercent: window.usedPercent, resets: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null };
}
