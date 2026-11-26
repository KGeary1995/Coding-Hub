import { create } from 'zustand';
import type { Session } from '../../shared/types';
import { isChatEngineConfig } from '../../shared/types';
import type { HubPreferences, UsageRecord } from '../../shared/hub';
import { LIMIT_THRESHOLD } from './channel-state';
import { leadOf } from './workspace-store';

/**
 * How far the automatic handoff (runtime/auto-handoff.ts) has got for a channel's run, so its tile and Needs you say what
 * Trace is doing instead of asking the person to write one: asked, saved (in the project's memory), compacted, or
 * not saved (the agent ended three turns without saving it; then it is the person's to write).
 */
export type HandoffPhase = 'asked' | 'saved' | 'compacted' | 'not-saved';
/** By channel, with the run it belongs to: a restarted channel's new run starts with none. */
export const useHandoffStore = create<{ bySession: Record<string, { runId: string; phase: HandoffPhase }> }>(() => ({ bySession: {} }));
export function setHandoffPhase(sessionId: string, runId: string, phase: HandoffPhase | null) {
  useHandoffStore.setState((state) => { const { [sessionId]: _old, ...rest } = state.bySession; return { bySession: phase ? { ...rest, [sessionId]: { runId, phase } } : rest }; });
}
/** The phase of the channel's current run, if any. */
export const handoffPhase = (bySession: Record<string, { runId: string; phase: HandoffPhase }>, session: Pick<Session, 'id' | 'runId'>) => { const entry = bySession[session.id]; return entry && entry.runId === session.runId ? entry.phase : undefined; };

/** The share of the context window in use (0 when the CLI has not reported both numbers). */
export const contextShare = (usage: UsageRecord | undefined) => usage?.context && usage.context.limit > 0 ? usage.context.used / usage.context.limit : 0;

/** The channel that leads the Round Table this one sits at (itself, when it leads one), or null. */
export const tableLeadOf = (sessions: Session[], session: Session) => session.roundTable ? session : leadOf(sessions, session.id);
/**
 * Whether Trace handles this agent's handoff: a Claude Code or Codex channel, or from 1.47 a Claude Code, Codex or
 * Gemini seat (lead or hidden) of a discussion Round Table, which the table asks on its own while it rests. Not a
 * hierarchy's seat (its steps hand every turn to the next seat), a custom agent, or a Gemini terminal (no context window).
 */
export function handoffHandled(session: Session, sessions: Session[]): boolean {
  const lead = tableLeadOf(sessions, session); if (!lead) return isChatEngineConfig(session.config);
  return lead.roundTable?.kind !== 'hierarchy' && (isChatEngineConfig(session.config) || (session.config.engine === 'gemini' && session.config.chat === true));
}

/**
 * Whether Trace saves this channel's handoff itself: automatic memory on, an agent it handles (handoffHandled; a token
 * or cost budget is not asked), near the end of its context window.
 */
export function handoffAutomatic(session: Session, sessions: Session[], usage: UsageRecord | undefined, preferences: Pick<HubPreferences, 'automaticMemory'>): boolean {
  if (preferences.automaticMemory === false || !handoffHandled(session, sessions)) return false;
  return contextShare(usage) >= LIMIT_THRESHOLD;
}

/** What a channel near its limit shows: `manual` asks the person to write the handoff; the others say what Trace is doing. */
export type HandoffShown = 'manual' | 'at-turn-end' | 'asked' | 'saved';
export function handoffShown(session: Session, sessions: Session[], usage: UsageRecord | undefined, preferences: Pick<HubPreferences, 'automaticMemory'>, phase?: HandoffPhase): HandoffShown {
  if (phase === 'not-saved' || !handoffAutomatic(session, sessions, usage, preferences)) return 'manual';
  return phase === 'asked' ? 'asked' : phase === 'saved' || phase === 'compacted' ? 'saved' : 'at-turn-end';
}
export const HANDOFF_LABEL: Record<HandoffShown, string> = { manual: 'Write handoff', 'at-turn-end': 'Handoff at turn end', asked: 'Handoff asked', saved: 'Handoff saved' };
export const HANDOFF_DETAIL: Record<HandoffShown, string> = {
  manual: 'Near its context or budget limit: write a handoff before it runs out.',
  'at-turn-end': 'Near the end of its context: Trace asks it to save a handoff when its turn ends, then compacts it.',
  asked: 'Near the end of its context: Trace asked it to save a handoff, and compacts it once saved.',
  saved: 'Its handoff is saved in shared memory: Trace compacts it when its turn ends.',
};
