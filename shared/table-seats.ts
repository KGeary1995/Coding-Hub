/**
 * Round Table seats (from 1.26): who sits at a table, under what name, with what instructions of the person's own and,
 * at a hierarchy table, which steps each seat does. Before 1.26 a discussion table was always Claude Code with Codex and
 * a hierarchy always planner, builder and reviewer; a table saved then has no `seats` and is read as those (legacySeats).
 * Pure logic, shared by the host (round-table.ts, review-chain.ts), the window and the phone.
 */
import { HIERARCHY_MODELS } from './chat';
import type { SeatEngine } from './types';

/**
 * What a hierarchy seat does. plan: writes the plan (and answers the challenges to it). challenge: challenges the plan
 * before the person sees it. build: the one seat that edits files. review: reviews the builder's changes, as findings.
 * final: the final review, ending in APPROVED or CHANGES NEEDED.
 */
export type SeatDuty = 'plan' | 'challenge' | 'build' | 'review' | 'final';
export const SEAT_DUTIES: readonly SeatDuty[] = ['plan', 'challenge', 'build', 'review', 'final'];
export const DUTY_LABEL: Record<SeatDuty, string> = { plan: 'Plans', challenge: 'Challenges the plan', build: 'Builds', review: 'Reviews', final: 'Final review' };
/** A seat's default name at a hierarchy table, from the first of its duties in this order. */
const DUTY_NAME: [SeatDuty, string][] = [['build', 'Builder'], ['plan', 'Planner'], ['review', 'Reviewer'], ['challenge', 'Challenger'], ['final', 'Final reviewer']];
const ENGINE_NAME: Record<SeatEngine, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };
/*
 * A Gemini seat takes any seat (from 1.39, the person's decision of 2026-11-24): before, 1.28 to 1.38 held it to reviewing
 * or planning (GEMINI_SEAT_RULE), as it ran only in plan mode and had no chat channel to lead from. GeminiStream now runs
 * it in plan mode only while it is read-only, and a Gemini chat channel can lead.
 */
export const MAX_SEAT_NAME = 40;
export const MAX_SEAT_INSTRUCTIONS = 4000;
export const MAX_TABLE_PRESETS = 20;
export const MAX_PRESET_NAME = 60;
/** A table is at least two agents; each seat is a CLI process of its own, so at most as many as Trace runs (MAX_CHANNELS). */
export const MIN_SEATS = 2;
export const MAX_SEATS = 8;

export type TableKind = 'discussion' | 'hierarchy';
/** What the person sets for a seat. `duties` only at a hierarchy table. Its engine and model are its chat channel's own. */
export interface SeatSettings { name?: string; instructions?: string; duties?: SeatDuty[] }
/** A seat as saved with its table (SavedRoundTable.seats): the lead's own entry too, by session id. */
export interface SavedSeat extends SeatSettings { session: string }
/** A seat of an open table (RoundTableState.seats), the lead first. */
export interface TableSeatState extends SeatSettings { sessionId: string; runId: string; engine: SeatEngine }
/** A seat named in a request (table-open, table-seats): a running chat, with what the person set for it. */
export interface SeatReference extends SeatSettings { sessionId: string; runId: string }
/** A seat of a preset: started as a chat channel of this engine and model ('' for the CLI's default). */
export interface TablePresetSeat extends SeatSettings { engine: SeatEngine; model: string }
/**
 * A table the person can start again and again (HubPreferences.tablePresets, and the two built in). The lead, whose
 * channel shows the table, is the first seat at a discussion table and the builder at a hierarchy. `driver`: the index
 * of the discussion seat that edits files (0 when absent). `rounds`: discussion rounds (0 to 5), or a hierarchy's
 * review rounds (1 to 5).
 */
export interface TablePreset { id: string; name: string; kind: TableKind; rounds: number; driver?: number; seats: TablePresetSeat[] }

export const BUILT_IN_PRESETS: readonly TablePreset[] = [
  { id: 'discussion', name: 'Claude Code and Codex', kind: 'discussion', rounds: 2, driver: 0, seats: [{ engine: 'claude', model: '' }, { engine: 'codex', model: '' }] },
  { id: 'hierarchy', name: 'Planner, builder, reviewer', kind: 'hierarchy', rounds: 2, seats: [
    { engine: 'claude', model: HIERARCHY_MODELS.builder, duties: ['build'] },
    { engine: 'claude', model: HIERARCHY_MODELS.planner, duties: ['plan', 'final'] },
    { engine: 'codex', model: HIERARCHY_MODELS.reviewer, duties: ['challenge', 'review'] }] },
];
export const isBuiltInPreset = (id: string) => BUILT_IN_PRESETS.some((preset) => preset.id === id);

/** The duties of a hierarchy table saved before 1.26: the lead builds, `partner` challenges and reviews, `planner` plans and gives the final review. */
export const LEGACY_DUTIES = { lead: ['build'], partner: ['challenge', 'review'], planner: ['plan', 'final'] } as const satisfies Record<string, readonly SeatDuty[]>;

type SeatedTable = { partner: string; planner?: string; challenger?: string; seats?: { session: string }[] };
/** Every hidden seat of the table a channel leads (all but the lead itself), each once, in order. */
export function hiddenSeatIds(table: SeatedTable, leadId: string): string[] {
  const ids = table.seats?.length ? table.seats.map((seat) => seat.session) : [table.partner, table.planner, table.challenger];
  return [...new Set(ids.filter((id): id is string => Boolean(id) && id !== leadId))];
}
/**
 * The seats of a saved table, the lead first: as saved, or for a table from before 1.26 its partner (and planner) with
 * the duties they had then.
 */
export function savedSeats(table: { partner: string; planner?: string; kind?: 'hierarchy'; seats?: SavedSeat[] }, leadId: string): SavedSeat[] {
  if (table.seats?.length) { const lead = table.seats.find((seat) => seat.session === leadId) ?? { session: leadId, ...(table.kind === 'hierarchy' ? { duties: [...LEGACY_DUTIES.lead] } : {}) }; return [lead, ...table.seats.filter((seat) => seat.session !== leadId)]; }
  if (table.kind !== 'hierarchy') return [{ session: leadId }, { session: table.partner }];
  return [{ session: leadId, duties: [...LEGACY_DUTIES.lead] }, ...(table.planner ? [{ session: table.planner, duties: [...LEGACY_DUTIES.planner] }] : []), { session: table.partner, duties: [...LEGACY_DUTIES.partner] }];
}

/**
 * Why these seats cannot make a table, in words for the person; or null. The lead is `seats[lead]`. A hierarchy needs
 * exactly one builder (the lead, who does nothing else: it is the only seat that edits) and exactly one planner; at most
 * one seat gives the final review; challengers and reviewers are as many as the person likes, or none.
 */
/** `driver`: the index of the discussion seat that edits, when the caller knows it (any agent may: from 1.39 Gemini too). */
export function checkSeats(kind: TableKind, seats: readonly (SeatSettings & { engine?: SeatEngine })[], lead = 0, driver?: number): string | null {
  if (seats.length < MIN_SEATS) return 'A Round Table needs at least two agents.';
  if (kind === 'discussion' && driver !== undefined && !seats[driver]) return 'Choose the agent that edits files.';
  if (seats.length > MAX_SEATS) return `A Round Table seats at most ${MAX_SEATS} agents.`;
  for (const seat of seats) {
    if ((seat.name?.length ?? 0) > MAX_SEAT_NAME) return `A seat's name is at most ${MAX_SEAT_NAME} characters.`;
    if ((seat.instructions?.length ?? 0) > MAX_SEAT_INSTRUCTIONS) return `A seat's instructions are at most ${MAX_SEAT_INSTRUCTIONS.toLocaleString('en-US')} characters.`;
  }
  if (kind === 'discussion') return null;
  const having = (duty: SeatDuty) => seats.filter((seat) => seat.duties?.includes(duty));
  if (seats.some((seat) => !seat.duties?.length)) return 'Give every seat something to do: plan, challenge, build, review or the final review.';
  if (seats.some((seat) => seat.duties!.some((duty) => !SEAT_DUTIES.includes(duty)) || new Set(seat.duties).size !== seat.duties!.length)) return 'A seat has a step Trace does not know, or the same step twice.';
  if (having('build').length !== 1) return 'A hierarchy Round Table needs exactly one builder: the one seat that edits files.';
  if (having('build')[0] !== seats[lead]) return 'The builder leads a hierarchy Round Table: its channel is the one that shows the table.';
  if (seats[lead].duties!.length !== 1) return 'The builder only builds: give the plan, the reviews and the final review to other seats, which stay read-only.';
  if (having('plan').length !== 1) return 'A hierarchy Round Table needs exactly one planner.';
  if (having('final').length > 1) return 'Only one seat gives the final review.';
  return null;
}

/** A seat's name when the person gave none: what it does at a hierarchy table, its agent at a discussion table. */
export function defaultSeatName(seat: { engine: SeatEngine; duties?: readonly SeatDuty[] }, kind: TableKind): string {
  if (kind === 'hierarchy') for (const [duty, name] of DUTY_NAME) if (seat.duties?.includes(duty)) return name;
  return ENGINE_NAME[seat.engine];
}
/**
 * The name each seat goes by, in order: its own, or its default; two seats that would share a name are numbered
 * ("Reviewer", "Reviewer 2"), so a prompt or a label never leaves it open who is meant.
 */
export function seatNames(seats: readonly { name?: string; engine: SeatEngine; duties?: readonly SeatDuty[] }[], kind: TableKind): string[] {
  const seen = new Map<string, number>();
  return seats.map((seat) => {
    const base = seat.name?.trim() || defaultSeatName(seat, kind); const count = (seen.get(base.toLowerCase()) ?? 0) + 1; seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} ${count}`;
  });
}
