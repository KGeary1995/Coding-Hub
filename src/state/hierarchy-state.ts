import type { Session } from '../../shared/types';
import { partnerOf, plannerOf, useWorkspaceStore } from './workspace-store';
import { useChatStore } from './chat-store';

const live = (session: Session | null | undefined) => session?.status === 'running' || session?.status === 'starting';

/**
 * Why a hierarchy channel cannot take a message or task now, or null: its table is not open (a seat stopped or crashed,
 * or the table is still opening). Sent anyway, it would reach the builder alone, with no plan or review.
 */
export function hierarchyDetached(leadId: string): string | null {
  const sessions = useWorkspaceStore.getState().sessions; const lead = sessions.find((session) => session.id === leadId);
  if (lead?.roundTable?.kind !== 'hierarchy' || useChatStore.getState().threads[leadId]?.table) return null;
  const seats = [partnerOf(sessions, leadId), plannerOf(sessions, leadId)];
  if (seats.some((seat) => !seat)) return 'This Round Table lost its planner or reviewer. Close the table to chat with the builder alone.';
  return seats.every(live) ? 'The Round Table is opening. Try again in a moment.' : 'The Round Table\'s planner or reviewer stopped. Press Reopen to start it again and pick up where the work stood.';
}
