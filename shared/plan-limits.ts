/**
 * How much of a subscription's usage limits is used: Claude's 5-hour session and weekly limits, Codex's limits (a
 * weekly one, and a 5-hour one on plans that have it), Gemini CLI's per model group. Read from each CLI without a model
 * request.
 */
export interface LimitWindow {
  /** "Session" (the rolling 5-hour window), "Week", or a named weekly limit such as "Week (Fable)". */
  label: string;
  usedPercent: number;
  /** When it resets, as an ISO time when the CLI gives one, else as the CLI words it ("Oct 31 at 7:59am"). */
  resets: string | null;
}
export interface PlanLimits {
  engine: 'claude' | 'codex' | 'gemini';
  /** "Default" for the CLI's own login, or a Claude account profile's name. */
  account: string;
  /** Who the default login is (its email, or the profile signed in to the same account), so the wrong account shows. */
  signedInAs?: string | null;
  windows: LimitWindow[];
  /** The plan the CLI reports, when it does (Codex). */
  plan: string | null;
  checkedAt: string;
  /** Why there are no windows: a failed check ("Codex could not be started.") or a plain fact about the account. */
  error: string | null;
  /** True when `error` is a failed check rather than a fact, so it can read as a failure. Older readings lack it: a fact. */
  failed?: boolean;
}

/** Parses Claude Code's `/usage` text ("Current session: 5% used · resets Oct 25 at 11:59pm (America/Los_Angeles)"). */
export function parseClaudeUsage(text: string): LimitWindow[] {
  const windows: LimitWindow[] = [];
  // An indented line, and a share under one percent ("<1% used", read as 1), are read too.
  for (const match of text.matchAll(/^[ \t]*Current (session|week)( \(([^)]+)\))?:\s*<?\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets ([^\n(]+?)(?:\s*\([^)]*\))?)?\s*$/gm)) {
    const scope = match[3]; const label = match[1] === 'session' ? 'Session' : !scope || /^all models$/i.test(scope) ? 'Week' : `Week (${scope})`;
    windows.push({ label, usedPercent: Number(match[4]), resets: match[5]?.trim() || null });
  }
  return windows;
}

/**
 * A Codex rate-limit window, named by its length. The app server's reply is checked, not trusted: null when it is not the
 * shape Trace knows (a newer Codex), rather than a window with no share or a time that cannot be read.
 */
export function codexWindow(window: unknown): LimitWindow | null {
  const value = (window && typeof window === 'object' ? window : {}) as Record<string, unknown>; const number = (field: unknown) => typeof field === 'number' && Number.isFinite(field) ? field : null;
  const used = number(value.usedPercent); if (used === null || used < 0 || used > 1000) return null;
  const minutes = Math.max(0, number(value.windowDurationMins) ?? 0); const seconds = number(value.resetsAt);
  const at = seconds !== null && seconds > 0 && seconds < 1e11 ? seconds * 1000 : typeof value.resetsAt === 'string' ? Date.parse(value.resetsAt) : NaN;
  const label = minutes > 0 && minutes <= 360 ? 'Session' : minutes >= 10000 && minutes <= 10200 ? 'Week' : minutes ? `${Math.round(minutes / 60)} h` : 'Limit';
  return { label, usedPercent: used, resets: Number.isFinite(at) ? new Date(at).toISOString() : null };
}
/** The windows of one Codex reply, the session first; two with one name are told apart by their length. */
export function codexWindows(windows: unknown[]): LimitWindow[] {
  const read = windows.flatMap((window) => { const parsed = codexWindow(window); return parsed ? [{ parsed, minutes: Number((window as { windowDurationMins?: unknown }).windowDurationMins) || 0 }] : []; });
  const named = read.map(({ parsed, minutes }) => read.filter((other) => other.parsed.label === parsed.label).length > 1 && minutes ? { ...parsed, label: `${parsed.label} (${minutes % 60 ? `${minutes} min` : `${minutes / 60} h`})` } : parsed);
  return named.sort((a, b) => (a.label.startsWith('Session') ? -1 : 0) - (b.label.startsWith('Session') ? -1 : 0));
}

/** Each engine's name on a plan's limits (status bar, Usage, alerts, the phone). */
export const PLAN_NAME: Record<PlanLimits['engine'], string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

/**
 * Gemini CLI's `/usage` (agy -p "/usage" --output-format json, seen with agy 1.5.12): model groups, each with a weekly
 * and a 5-hour bucket giving the share remaining and when it refills. The first group (Gemini's own models) is the
 * plan's Session and Week; the others are named after their group ("Week (Gemini 4 Argon)"). Null when the reply is not
 * that shape (signed out, or another agy).
 */
export function parseGeminiUsage(stdout: string): LimitWindow[] | null {
  let groups: unknown;
  try { const value = JSON.parse(stdout) as { command?: { name?: unknown; data?: { groups?: unknown } } }; if (value.command?.name !== 'usage') return null; groups = value.command.data?.groups; } catch { return null; }
  if (!Array.isArray(groups)) return null;
  const windows: LimitWindow[] = [];
  groups.slice(0, 20).forEach((group, index) => {
    const { name, buckets } = (group && typeof group === 'object' ? group : {}) as { name?: unknown; buckets?: unknown };
    for (const bucket of Array.isArray(buckets) ? buckets.slice(0, 10) : []) {
      const { window, remaining_fraction: left, reset_time: reset } = (bucket && typeof bucket === 'object' ? bucket : {}) as Record<string, unknown>;
      if (typeof left !== 'number' || !Number.isFinite(left) || left < 0 || left > 1 || (window !== '5h' && window !== 'weekly')) continue;
      const base = window === '5h' ? 'Session' : 'Week'; const group = typeof name === 'string' ? name.trim().slice(0, 60) : '';
      const at = typeof reset === 'string' ? Date.parse(reset) : NaN;
      windows.push({ label: index === 0 || !group ? base : `${base} (${group})`, usedPercent: Math.round((1 - left) * 1000) / 10, resets: Number.isFinite(at) ? new Date(at).toISOString() : null });
    }
  });
  return windows.sort((a, b) => (a.label === 'Session' ? -1 : 0) - (b.label === 'Session' ? -1 : 0));
}
