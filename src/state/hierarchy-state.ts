import type { Session } from '../../shared/types';
import { partnerOf, plannerOf, useWorkspaceStore } from './workspace-store';
import { chatNotice, useChatStore } from './chat-store';

const live = (session: Session | null | undefined) => session?.status === 'running' || session?.status === 'starting';

/** Why a lead's table would not open again (restoreTables), for the lead's run it was tried with. */
const failures = new Map<string, { runId: string; why: string }>();
/** A saved table could not be seated again for this run of its lead: kept so the channel can say why, and said in the thread. */
export function tableOpenFailed(leadId: string, runId: string, why: string) {
  failures.set(leadId, { runId, why });
  chatNotice(leadId, `The Round Table could not open again: ${why}`);
}

/**
 * Why a hierarchy channel cannot take a message or task now, or null: its table is not open (a seat stopped or crashed,
 * the table is still opening, or it would not open). Sent anyway, it would reach the builder alone, with no plan or review.
 */
export function hierarchyDetached(leadId: string): string | null {
  const sessions = useWorkspaceStore.getState().sessions; const lead = sessions.find((session) => session.id === leadId);
  if (lead?.roundTable?.kind !== 'hierarchy' || useChatStore.getState().threads[leadId]?.table) return null;
  const seats = [partnerOf(sessions, leadId), plannerOf(sessions, leadId)];
  if (seats.some((seat) => !seat)) return 'This Round Table lost its planner or reviewer. Close the table to chat with the builder alone.';
  if (!seats.every(live)) return 'The Round Table\'s planner or reviewer stopped. Press Reopen to start it again and pick up where the work stood.';
  const failure = failures.get(leadId);
  if (failure && lead.runId && failure.runId === lead.runId) return `The Round Table could not open again: ${failure.why} Stop this channel and start it again, or close the table.`;
  return 'The Round Table is opening. Try again in a moment.';
}
