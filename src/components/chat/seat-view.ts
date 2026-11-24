import type { RoundTableState } from '../../../shared/chat';
import type { SeatEngine } from '../../../shared/types';
import { defaultSeatName, seatNames, type SeatDuty } from '../../../shared/table-seats';

/**
 * How a Round Table's seats are drawn, shared by the desktop's chat, the phone and linked computers (so no zod, no
 * schemas). A table from a host before 1.26 has no `seats`: it is read as its lead and `partner` (and `planner`), named
 * as the code always did.
 */
export type SeatColour = SeatEngine | 'planner';
export interface SeatView {
  /** The seat's session id (at the host that runs it). */
  id: string; engine: SeatEngine; lead: boolean;
  /** What labels its messages, and what the working line and the bar call it. */
  name: string; working: string;
  duties: SeatDuty[];
  /** Discussion: whether it edits files. */
  driver: boolean;
  /** The avatar class: its engine's, or the planner's for the seat that plans. */
  colour: SeatColour;
  /** What its messages say beside its name: 'driver' or 'reviewer' (discussion), or what it does (hierarchy). */
  role?: string;
}
/** What a caller that knows models names a legacy hierarchy's builder and planner (a table before 1.26 has no seat names). */
export interface LegacyNames { builder?: string; planner?: string; builderWorking?: string; plannerWorking?: string; plannerColour?: SeatColour }

export const AGENT_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', custom: 'Agent' } as const;
const DUTY_SHORT: Record<SeatDuty, string> = { plan: 'plans', challenge: 'challenges', build: 'builds', review: 'reviews', final: 'final review' };
/** "Plans, final review": what a hierarchy seat does, in a few words. */
export const dutyText = (duties: readonly SeatDuty[]) => { const text = duties.map((duty) => DUTY_SHORT[duty]).join(', '); return text.charAt(0).toUpperCase() + text.slice(1); };
/** A hierarchy seat's role: its duties, left out when they only repeat its default name ("Builder" builds). */
function dutyRole(seat: { engine: SeatEngine; duties: SeatDuty[] }, name: string) {
  if (!seat.duties.length) return undefined;
  return seat.duties.length === 1 && defaultSeatName(seat, 'hierarchy') === name ? undefined : dutyText(seat.duties);
}

/** The seats of an open table, the lead first. */
export function seatViews(table: RoundTableState, leadEngine: SeatEngine, legacy: LegacyNames = {}, leadId = ''): SeatView[] {
  const hierarchy = table.kind === 'hierarchy';
  if (table.seats?.length) {
    const kind = hierarchy ? 'hierarchy' as const : 'discussion' as const; const names = seatNames(table.seats, kind);
    const driverId = hierarchy ? undefined : table.driverSeat ?? table.seats.find((seat) => seat.engine === table.driver)?.sessionId;
    return table.seats.map((seat, index) => {
      const duties = hierarchy ? seat.duties ?? [] : []; const driver = seat.sessionId === driverId; const name = names[index];
      return { id: seat.sessionId, engine: seat.engine, lead: index === 0, name, working: name, duties, driver, colour: hierarchy && duties.includes('plan') ? 'planner' as const : seat.engine, role: hierarchy ? dutyRole({ engine: seat.engine, duties }, name) : driver ? 'driver' : 'reviewer' };
    });
  }
  const partner = table.partner.engine;
  if (!hierarchy) return [
    { id: leadId, engine: leadEngine, lead: true, name: AGENT_NAME[leadEngine], working: AGENT_NAME[leadEngine], duties: [], driver: table.driver === leadEngine, colour: leadEngine, role: table.driver === leadEngine ? 'driver' : 'reviewer' },
    { id: table.partner.sessionId, engine: partner, lead: false, name: AGENT_NAME[partner], working: AGENT_NAME[partner], duties: [], driver: table.driver === partner, colour: partner, role: table.driver === partner ? 'driver' : 'reviewer' },
  ];
  return [
    { id: leadId, engine: leadEngine, lead: true, name: legacy.builder ?? AGENT_NAME[leadEngine], working: legacy.builderWorking ?? legacy.builder ?? AGENT_NAME[leadEngine], duties: ['build'], driver: false, colour: leadEngine, role: 'Builder' },
    { id: table.partner.sessionId, engine: partner, lead: false, name: AGENT_NAME[partner], working: AGENT_NAME[partner], duties: ['challenge', 'review'], driver: false, colour: partner, role: 'Reviewer' },
    // The planner is always listed, as the bar always showed it (its channel may be gone: its id is then empty).
    { id: table.planner?.sessionId ?? '', engine: 'claude' as const, lead: false, name: legacy.planner ?? 'Claude', working: legacy.plannerWorking ?? legacy.planner ?? 'Claude', duties: ['plan', 'final'] as SeatDuty[], driver: false, colour: legacy.plannerColour ?? 'planner' as const, role: 'Planner' },
  ];
}

/** "A and B", "A, B and C". */
export const joinNames = (names: readonly string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The session ids of every seat of an open table but the lead's, each once, in order. */
export function tableSeatIds(table: RoundTableState, leadId: string): string[] {
  const ids = table.seats?.length ? table.seats.map((seat) => seat.sessionId) : [table.partner.sessionId, table.planner?.sessionId];
  return [...new Set(ids.filter((id): id is string => Boolean(id) && id !== leadId))];
}
/** The run of a seat of an open table (the host's id for it), for an answer or a request that names it. */
export const seatRun = (table: RoundTableState, seatId: string): string | undefined => table.seats?.find((seat) => seat.sessionId === seatId)?.runId ?? (table.partner.sessionId === seatId ? table.partner.runId : table.planner?.sessionId === seatId ? table.planner.runId : undefined);
/**
 * Follows the events of every other seat of an open table (a phone, a linked computer: their events do not arrive with the
 * lead's); the function that stops following them all.
 */
export function followSeats(follow: (sessionId: string) => () => void, ids: readonly string[]): () => void {
  const stops = ids.map((id) => follow(id)); return () => { for (const stop of stops) stop(); };
}
