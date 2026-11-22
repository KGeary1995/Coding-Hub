import type { Session } from '../../shared/types';
import { seatNames } from '../../shared/table-seats';
import { seatsOf, useWorkspaceStore } from './workspace-store';
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
 * The seats of the table a channel leads, lead first, by the name the person gave each (or what it does there), with
 * its session; a seat whose channel is gone has none.
 */
export function seatLabels(sessions: Session[], leadId: string) {
  const seats = seatsOf(sessions, leadId); const kind = sessions.find((session) => session.id === leadId)?.roundTable?.kind ?? 'discussion';
  const names = seatNames(seats.map(({ seat, session }) => ({ ...seat, engine: session?.config.engine === 'codex' ? 'codex' as const : 'claude' as const })), kind);
  return seats.map(({ seat, session }, index) => ({ id: seat.session, name: names[index], session, named: Boolean(seat.name?.trim() || (kind === 'hierarchy' && seat.duties?.length) || session) }));
}
/** "Planner", "Planner or Reviewer": seat names for a message (a seat with no channel and no name of its own is "a seat"). */
const listed = (seats: { name: string; named: boolean }[]) => seats.map((seat) => seat.named ? seat.name : 'a seat').join(' or ');

/**
 * Why a Round Table channel cannot take a message or task now, or null: it has a saved table that is not open (a seat
 * stopped or crashed, the table is still opening, or it would not open). Sent anyway, it would reach the lead alone.
 */
export function tableDetached(leadId: string): string | null {
  const sessions = useWorkspaceStore.getState().sessions; const lead = sessions.find((session) => session.id === leadId);
  if (!lead?.roundTable || useChatStore.getState().threads[leadId]?.table) return null;
  const hierarchy = lead.roundTable.kind === 'hierarchy'; const hidden = seatLabels(sessions, leadId).filter((seat) => seat.id !== leadId); const alone = hierarchy ? 'the builder' : 'the lead agent';
  const lost = hidden.filter((seat) => !seat.session); if (lost.length) return `This Round Table lost its ${listed(lost)}. Close the table to chat with ${alone} alone.`;
  const stopped = hidden.filter((seat) => !live(seat.session)); if (stopped.length) return `The Round Table's ${listed(stopped)} stopped. Press Reopen to start ${stopped.length === 1 ? 'it' : 'them'} again${hierarchy ? ' and pick up where the work stood' : ''}.`;
  const failure = failures.get(leadId);
  if (failure && lead.runId && failure.runId === lead.runId) return `The Round Table could not open again: ${failure.why} Stop this channel and start it again, or close the table.`;
  return 'The Round Table is opening. Try again in a moment.';
}
/** Why a hierarchy channel cannot take a message or task now (tableDetached), or null. A discussion table never blocks one. */
export const hierarchyDetached = (leadId: string): string | null => useWorkspaceStore.getState().sessions.find((session) => session.id === leadId)?.roundTable?.kind === 'hierarchy' ? tableDetached(leadId) : null;
