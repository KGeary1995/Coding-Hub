import type { Session } from '../../shared/types';
import type { UsageRecord } from '../../shared/hub';

/** What a session is doing, as the Trace design shows it (docs/design/trace/README.md). */
export type ChannelState = 'idle' | 'starting' | 'working' | 'waiting' | 'finished' | 'failed' | 'limit';

/** Each state is shown four ways (glyph, word, trace, colour) so colour is never the only signal. */
export const CHANNEL_STATES: Record<ChannelState, { glyph: string; word: string; color: string; solid: boolean }> = {
  idle: { glyph: '○', word: 'IDLE', color: 'var(--tr-st-idle)', solid: false },
  starting: { glyph: '◌', word: 'ARMING', color: 'var(--tr-st-starting)', solid: false },
  working: { glyph: '●', word: 'RUN', color: 'engine', solid: false },
  waiting: { glyph: '◆', word: 'HOLD', color: 'var(--tr-st-waiting)', solid: true },
  finished: { glyph: '✓', word: 'STOP', color: 'var(--tr-st-finished)', solid: false },
  failed: { glyph: '✕', word: 'FAULT', color: 'var(--tr-st-failed)', solid: true },
  limit: { glyph: '▲', word: 'CLIP', color: 'var(--tr-st-limit)', solid: false },
};

/** Share of the context window or session budget in use (0–1+). Claude does not report its window size. */
export function limitRatio(session: Session, usage: UsageRecord | undefined) {
  if (!usage) return 0;
  const context = usage.context && usage.context.limit > 0 ? usage.context.used / usage.context.limit : 0;
  const budget = session.budget;
  if (!budget) return context;
  const tokens = usage.input + usage.output + (usage.engine === 'claude' ? usage.cached + usage.cacheWrite : 0);
  return Math.max(
    context,
    budget.tokens ? tokens / budget.tokens : 0,
    budget.costUSD && usage.cost !== null ? usage.cost / budget.costUSD : 0,
    budget.contextPercent ? context * 100 / budget.contextPercent : 0,
  );
}

/** At this share of the context window or budget a working channel shows as near its limit. */
export const LIMIT_THRESHOLD = 0.8;

export function channelState(session: Session, usage?: UsageRecord): ChannelState {
  if (session.status === 'error') return 'failed';
  // A stopped run exits without a diagnostic; only a failed one carries an error.
  if (session.status === 'exited') return session.exitCode !== 0 && session.error ? 'failed' : 'finished';
  if (session.status === 'idle') return 'idle';
  if (session.status === 'starting') return 'starting';
  if (session.attention) return 'waiting';
  return limitRatio(session, usage) >= LIMIT_THRESHOLD ? 'limit' : 'working';
}

/** The run's own usage record, so an earlier run in the same tile never colours this one. */
export function usageFor(session: Session, records: UsageRecord[]) {
  return session.runId ? records.find((record) => record.runId === session.runId) : undefined;
}

export interface ChannelAlert { sessionId: string; channel: number; state: 'waiting' | 'failed' | 'limit'; text: string }

/** Channels that need the person: waiting first, then failed, then near a limit. Channel numbers follow tile order. */
export function channelAlerts(sessions: Session[], records: UsageRecord[]): ChannelAlert[] {
  const order = { waiting: 0, failed: 1, limit: 2 } as const;
  const alerts: ChannelAlert[] = [];
  sessions.forEach((session, index) => {
    const usage = usageFor(session, records); const state = channelState(session, usage);
    if (state !== 'waiting' && state !== 'failed' && state !== 'limit') return;
    const channel = index + 1;
    const text = state === 'waiting' ? `CH${channel} needs approval` : state === 'failed' ? `CH${channel} failed` : `CH${channel} ${usage?.context && usage.context.limit > 0 ? `ctx ${Math.round(usage.context.used / usage.context.limit * 100)}%` : 'near budget'}`;
    alerts.push({ sessionId: session.id, channel, state, text });
  });
  return alerts.sort((a, b) => order[a.state] - order[b.state] || a.channel - b.channel);
}

/**
 * Input that was not read from cache. Codex counts cached input inside its input total; Claude reports cache reads
 * separately. Same normalisation as the cost estimate (electron/services/hub/telemetry.ts, usageCost).
 */
export const freshInput = (record: UsageRecord) => record.engine === 'codex' ? Math.max(0, record.input - record.cached) : record.input;

/** This computer's reported input + output tokens today (cache excluded) and cost, by local date. Cost is null when nothing is priced. */
export function todayTotals(records: UsageRecord[], now = new Date()) {
  const day = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const today = day(now); let tokens = 0; let cost: number | null = null;
  for (const record of records) {
    const started = new Date(record.timestamp);
    if (record.machine || Number.isNaN(started.getTime()) || day(started) !== today) continue;
    tokens += freshInput(record) + record.output;
    if (record.cost !== null) cost = (cost ?? 0) + record.cost;
  }
  return { tokens, cost };
}
