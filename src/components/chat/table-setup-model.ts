import { BUILT_IN_PRESETS, checkSeats, isBuiltInPreset, seatNames, type SeatDuty, type TableKind, type TablePreset, type TablePresetSeat } from '../../../shared/table-seats';
import type { SeatEngine, Session } from '../../../shared/types';
import { modelValue } from '../../../shared/schemas';
import type { EditableSeat, SeatPlan } from '../../runtime/round-table';
import { leadIndex } from '../../state/table-presets';
import { modelProblem } from './seat-model';

/**
 * The setup panel's logic (TableSetup.tsx draws it): a draft of a table that the person edits, and what becomes of it.
 * new: + Channel, a table with a channel of its own; chat: a table on a running chat, which leads it with its own agent
 * and model; edit: the seats of a table that is open or saved.
 */
export type SetupMode = { type: 'new'; table?: TableKind } | { type: 'chat'; leadId: string } | { type: 'edit'; leadId: string };
export interface DraftSeat {
  key: string; engine: SeatEngine; /** As typed; blank is the CLI's default. */ model: string; name: string; instructions: string; duties: SeatDuty[];
  /** A custom agent's id, for a seat of engine custom (phase 2). */ agent?: string;
  /** The channel's session, for a seat that exists already. */
  session?: string; lead: boolean;
  /** Its agent cannot change: a seat that exists, or the channel a table is started on. */ keepsAgent: boolean;
  /** Its model cannot change here: the channel a table is started on (change it in the channel's settings). */ keepsModel: boolean;
  status?: Session['status'];
}
export interface Draft { presetId: string; name: string; kind: TableKind; rounds: number; driver: number; seats: DraftSeat[] }

let counter = 0; const newKey = () => `seat-${++counter}`;
const builtIn = (kind: TableKind) => BUILT_IN_PRESETS.find((preset) => preset.kind === kind)!;
export const DEFAULT_TABLE_NAME = 'Round Table';

/** A copy of the preset to edit; `lead` fixes the lead seat to a running chat (its agent and model). */
export function draftFromPreset(preset: TablePreset, lead?: { engine: SeatEngine; model: string; agent?: string }): Draft {
  const at = Math.max(0, leadIndex(preset));
  const seats = preset.seats.map((seat, index): DraftSeat => {
    const isLead = index === at; const draft: DraftSeat = { key: newKey(), engine: seat.engine, model: seat.model, ...(seat.agent ? { agent: seat.agent } : {}), name: seat.name ?? '', instructions: seat.instructions ?? '', duties: [...(seat.duties ?? [])], lead: isLead, keepsAgent: false, keepsModel: false };
    if (!lead || !isLead) return draft;
    const { agent: _agent, ...rest } = draft; return { ...rest, engine: lead.engine, model: lead.model, ...(lead.agent ? { agent: lead.agent } : {}), keepsAgent: true, keepsModel: true };
  });
  // The tables Trace comes with are copied, never changed: the name is left for the person to give.
  return { presetId: preset.id, name: isBuiltInPreset(preset.id) ? '' : preset.name, kind: preset.kind, rounds: preset.rounds, driver: preset.driver ?? 0, seats };
}
/** The seats of an open or saved table (tableSeats), to edit. */
export function draftFromTable(seats: EditableSeat[], kind: TableKind, rounds: number): Draft {
  return { presetId: '', name: '', kind, rounds, driver: Math.max(0, seats.findIndex((seat) => seat.driver)),
    seats: seats.map((seat): DraftSeat => ({ key: newKey(), engine: seat.engine, model: seat.model, ...(seat.agent ? { agent: seat.agent } : {}), name: seat.name ?? '', instructions: seat.instructions ?? '', duties: [...(seat.duties ?? [])], session: seat.session, lead: seat.lead, keepsAgent: true, keepsModel: false, status: seat.status })) };
}

const LAST = (kind: TableKind) => `trace.tablePreset.${kind}`;
/** The preset last started for this kind of table, on this computer; null when none or when storage is not available. */
export function lastPreset(kind: TableKind): string | null { try { return localStorage.getItem(LAST(kind)); } catch { return null; } }
export function rememberPreset(kind: TableKind, id: string) { try { localStorage.setItem(LAST(kind), id); } catch { /* A convenience only. */ } }
/** The preset to start with for a kind: the person's last-used one if it still exists, else the built-in. */
export const pickPreset = (presets: TablePreset[], kind: TableKind, last: string | null = lastPreset(kind)): TablePreset => presets.find((preset) => preset.kind === kind && preset.id === last) ?? builtIn(kind);

const seatOf = (seat: DraftSeat, kind: TableKind): TablePresetSeat => ({ engine: seat.engine, model: modelValue(seat.model) ?? '', ...(seat.engine === 'custom' && seat.agent ? { agent: seat.agent } : {}), ...(seat.name.trim() ? { name: seat.name.trim() } : {}), ...(seat.instructions.trim() ? { instructions: seat.instructions.trim() } : {}), ...(kind === 'hierarchy' ? { duties: [...seat.duties] } : {}) });
export const toPreset = (draft: Draft, id = draft.presetId): TablePreset => ({ id, name: draft.name.trim() || DEFAULT_TABLE_NAME, kind: draft.kind, rounds: draft.rounds, ...(draft.kind === 'discussion' ? { driver: draft.driver } : {}), seats: draft.seats.map((seat) => seatOf(seat, draft.kind)) });
export const toPlan = (draft: Draft): SeatPlan => ({ seats: draft.seats.map((seat) => ({ ...seatOf(seat, draft.kind), ...(seat.session ? { session: seat.session } : {}) })), ...(draft.kind === 'discussion' ? { driver: draft.driver } : {}), rounds: draft.rounds });

/** Why this draft cannot be started or applied, in words for the person, or null. */
export function draftProblem(draft: Draft): string | null {
  for (const seat of draft.seats) { const why = modelProblem(seat.model); if (why) return why; }
  if (draft.seats.some((seat) => seat.engine === 'custom' && !seat.agent)) return 'Choose which of your agents sits in each seat.';
  const why = checkSeats(draft.kind, draft.seats.map((seat) => seatOf(seat, draft.kind)), Math.max(0, draft.seats.findIndex((seat) => seat.lead)), draft.kind === 'discussion' ? draft.driver : undefined);
  if (why) return why;
  if (draft.kind === 'discussion' && !draft.seats[draft.driver]) return 'Choose the agent that edits files.';
  const [low, high] = roundsRange(draft.kind);
  return Number.isInteger(draft.rounds) && draft.rounds >= low && draft.rounds <= high ? null : `Rounds are between ${low} and ${high}.`;
}
export const roundsRange = (kind: TableKind): [number, number] => kind === 'hierarchy' ? [1, 5] : [0, 5];

/** The default name of each seat as it would be called with no name of its own: the field's placeholder. `agentName`: a custom agent's name by id. */
export const placeholders = (draft: Draft, agentName: (id: string) => string = (id) => id): string[] => seatNames(draft.seats.map((seat) => ({ engine: seat.engine, duties: seat.duties, ...(seat.agent ? { agentName: agentName(seat.agent) } : {}) })), draft.kind);

/** How many more seats fit, and why none does when none does. `room` is seatRoom(): what the eight CLIs and the channels leave. */
export function roomNote(draft: Draft, room: number, max: number): { left: number; text: string } {
  const left = Math.max(0, room - draft.seats.length);
  if (left > 0) return { left, text: `${left} more ${left === 1 ? 'seat fits' : 'seats fit'}.` };
  return { left, text: room < max ? `This table has all the ${room} seats that fit: Trace runs at most 8 agents and terminals at once, and every seat is one. Close a channel to make room.` : `A Round Table seats at most ${max} agents.` };
}

const patch = (draft: Draft, index: number, change: Partial<DraftSeat>): Draft => ({ ...draft, seats: draft.seats.map((seat, at) => at === index ? { ...seat, ...change } : seat) });
export const patchSeat = patch;
/** A new seat: at a discussion the other agent than the last seat's; at a hierarchy a Codex reviewer. */
export function addSeat(draft: Draft, room: number): Draft {
  if (draft.seats.length >= room) return draft;
  const last = draft.seats[draft.seats.length - 1]; const seat: DraftSeat = { key: newKey(), engine: draft.kind === 'hierarchy' ? 'codex' : last?.engine === 'claude' ? 'codex' : 'claude', model: '', name: '', instructions: '', duties: draft.kind === 'hierarchy' ? ['review'] : [], lead: false, keepsAgent: false, keepsModel: false };
  return { ...draft, seats: [...draft.seats, seat] };
}
/** The lead cannot be taken away. The editing seat of a discussion stays the same agent, or the lead when it was the one removed. */
export function removeSeat(draft: Draft, index: number): Draft {
  if (draft.seats[index]?.lead) return draft;
  const seats = draft.seats.filter((_, at) => at !== index);
  return { ...draft, seats, driver: draft.driver === index ? Math.max(0, seats.findIndex((seat) => seat.lead)) : draft.driver > index ? draft.driver - 1 : draft.driver };
}
/** Build is the lead's alone, and the lead does only that (checkSeats). */
export function setDuty(draft: Draft, index: number, duty: SeatDuty, on: boolean): Draft {
  const seat = draft.seats[index]; if (!seat || seat.lead || duty === 'build') return draft;
  return patch(draft, index, { duties: on ? [...seat.duties.filter((item) => item !== duty), duty] : seat.duties.filter((item) => item !== duty) });
}
export const setDriver = (draft: Draft, index: number): Draft => ({ ...draft, driver: index });
/** Another kind of table: the built-in (or last-used) preset of that kind, on the same fixed lead. */
export const withKind = (draft: Draft, presets: TablePreset[], kind: TableKind, lead?: { engine: SeatEngine; model: string; agent?: string }): Draft => draft.kind === kind ? draft : draftFromPreset(pickPreset(presets, kind), lead);

export interface SetupDeps {
  startTable: (preset: TablePreset) => Promise<string | null>;
  openTable: (leadId: string, preset: TablePreset) => Promise<string | null>;
  changeSeats: (leadId: string, plan: SeatPlan) => Promise<string | null>;
}
/** Starts, opens or applies the draft: the error message, or null. */
export async function runSetup(mode: SetupMode, draft: Draft, deps: SetupDeps): Promise<string | null> {
  const why = draftProblem(draft); if (why) return why;
  const failure = mode.type === 'new' ? await deps.startTable(toPreset(draft)) : mode.type === 'chat' ? await deps.openTable(mode.leadId, toPreset(draft)) : await deps.changeSeats(mode.leadId, toPlan(draft));
  if (!failure && mode.type !== 'edit' && draft.presetId) rememberPreset(draft.kind, draft.presetId);
  return failure;
}

export interface PresetDeps { savePreset: (preset: TablePreset) => Promise<string | null>; deletePreset: (id: string) => Promise<string | null> }
const NEEDS_NAME = 'Give the table a name to keep it.';
/** Keeps the draft as a new preset of the person's, under `id`. */
export async function saveAsPreset(draft: Draft, id: string, deps: PresetDeps): Promise<string | null> {
  if (!draft.name.trim()) return NEEDS_NAME;
  const why = draftProblem(draft); return why ?? deps.savePreset(toPreset(draft, id));
}
/** Replaces one of the person's own presets with the draft. The built-in ones are never changed. */
export async function updatePreset(draft: Draft, deps: PresetDeps): Promise<string | null> {
  if (isBuiltInPreset(draft.presetId)) return 'The tables Trace comes with cannot be changed. Save a copy under a new name.';
  if (!draft.name.trim()) return NEEDS_NAME;
  const why = draftProblem(draft); return why ?? deps.savePreset(toPreset(draft));
}
export const removePreset = (id: string, deps: PresetDeps): Promise<string | null> => deps.deletePreset(id);
