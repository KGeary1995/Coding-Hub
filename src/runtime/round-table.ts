import { MAX_CHANNELS } from '../../shared/schemas';
import type { ChatImage, RoundTableState } from '../../shared/chat';
import type { ChatEngine, Session } from '../../shared/types';
import { BUILT_IN_PRESETS, checkSeats, MAX_SEATS, savedSeats, type SavedSeat, type SeatReference, type SeatSettings, type TablePreset, type TablePresetSeat } from '../../shared/table-seats';
import { createSession, fitTiles, hiddenSeats, seatsOf, useWorkspaceStore } from '../state/workspace-store';
import { tableOpenFailed } from '../state/hierarchy-state';
export { hierarchyDetached, tableDetached } from '../state/hierarchy-state';
import { checkPreset, leadIndex } from '../state/table-presets';
import { useChatStore } from '../state/chat-store';
import { hubCall } from '../state/hub-store';
import { itemTitle } from '../../shared/memory-items';
import type { Finding } from '../../shared/findings';
import { settled, startSession, stopSession } from './use-native-host';
import { isChatEngineConfig } from '../../shared/types';

const NAME = { claude: 'Claude Code', codex: 'Codex' } as const;
/** Rounds a new table discusses after each message: both answer, then each replies to the other twice at most. */
export const DEFAULT_ROUNDS = 2;
/** The person sees one channel for a Round Table, but each seat is a CLI process of its own, so each counts toward the eight. */
export const TABLE_FULL = `Close a channel first: a Round Table runs several agents in one channel, and Trace runs at most ${MAX_CHANNELS} agents and terminals at once.`;
const tableFull = (seats: number) => seats <= 2 ? TABLE_FULL : `A Round Table of ${seats} agents runs ${seats} CLIs, and Trace runs at most ${MAX_CHANNELS} agents and terminals at once. Close a channel first, or take a seat away.`;
/** One of the two tables Trace comes with (shared/table-seats.ts). */
const builtIn = (id: string) => BUILT_IN_PRESETS.find((preset) => preset.id === id)!;

/** The Round Table a chat channel leads, if any. */
export const tableOf = (sessionId: string): RoundTableState | null => useChatStore.getState().threads[sessionId]?.table ?? null;

/** Leads whose seats are being added and started here, so restoreTables does not seat it a second time meanwhile. */
const opening = new Set<string>();
const live = (session: Session | null | undefined) => session?.status === 'running' || session?.status === 'starting';

/** What the person set for a seat, as saved with the table: nothing is written for an empty field (the schema refuses an empty string). */
const seatRecord = (session: string, seat: SeatSettings, hierarchy: boolean): SavedSeat => ({ session, ...(seat.name?.trim() ? { name: seat.name.trim() } : {}), ...(seat.instructions?.trim() ? { instructions: seat.instructions.trim() } : {}), ...(hierarchy && seat.duties?.length ? { duties: [...seat.duties] } : {}) });
/** A seat as a request names it: its saved settings and its run. */
const seatReference = (seat: SavedSeat, session: Session): SeatReference => ({ sessionId: seat.session, runId: session.runId!, ...(seat.name ? { name: seat.name } : {}), ...(seat.instructions ? { instructions: seat.instructions } : {}), ...(seat.duties ? { duties: seat.duties } : {}) });
/** A hidden seat's chat: this agent and model, in the lead's folder, with the lead's permissions and memory project (one table, one setting). */
function seatSession(lead: Session, seat: TablePresetSeat, cwd: string): Session {
  const added = createSession(seat.engine, { mode: 'independent', cwd }); const from = lead.config;
  if (added.config.engine === 'gemini' || !('model' in added.config)) return added;
  const shared = { chat: true, ...(seat.model ? { model: seat.model } : {}), ...('permissions' in from && from.permissions ? { permissions: from.permissions } : {}), ...('memoryKey' in from && from.memoryKey ? { memoryKey: from.memoryKey } : {}) };
  // A Claude seat uses the lead's account when the lead is Claude, as the hierarchy's always did.
  added.config = { ...added.config, ...shared, ...(added.config.engine === 'claude' && from.engine === 'claude' && from.accountProfileId ? { accountProfileId: from.accountProfileId } : {}) };
  return added;
}
/** Whether a seat's session is up: running, with a run to name in a request. */
const up = (session: Session | undefined): session is Session & { runId: string } => session?.status === 'running' && Boolean(session.runId);
const engineOf = (session: Session | undefined): ChatEngine => session?.config.engine === 'codex' ? 'codex' : 'claude';

/** How many seats a table led by this channel (or, with no channel, a new table) can have now, from the eight CLIs Trace runs and the channels that exist. */
export function seatRoom(leadId?: string): number {
  const sessions = useWorkspaceStore.getState().sessions; const free = Math.max(0, MAX_CHANNELS - sessions.length);
  return Math.min(MAX_SEATS, (leadId ? 1 + hiddenSeats(sessions, leadId).length : 0) + free);
}

/**
 * Seats a table at a running chat channel: one hidden chat per other seat of the preset (its agent and model, in the folder
 * the lead runs in, no tile of its own: the lead saves them as its `roundTable` at once, which hides them), all started,
 * then joined to the lead's table. The channel it was opened from leads, with its own agent and model (the preset's lead
 * seat gives only its name, instructions and duties). If any seat cannot be seated, every one is stopped and removed.
 */
export async function openTable(leadId: string, preset: TablePreset): Promise<string | null> {
  const lead = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId);
  if (!lead || !isChatEngineConfig(lead.config) || !lead.config.chat || lead.status !== 'running' || !lead.runId || !lead.runningCwd) return 'Start this chat first.';
  if (tableOf(leadId) || opening.has(leadId)) return null;
  const refused = checkPreset(preset); if (refused) return refused;
  // A table saved earlier whose seats did not come back: replaced by a new one.
  if (lead.roundTable) { const why = await retire(leadId); if (why) return why; }
  const hierarchy = preset.kind === 'hierarchy'; const at = Math.max(0, leadIndex(preset)); const others = preset.seats.filter((_, index) => index !== at);
  if (useWorkspaceStore.getState().sessions.length + others.length > MAX_CHANNELS) return tableFull(preset.seats.length);
  // The same folder the leading chat runs in, whatever the workspace root is now.
  const added = others.map((seat) => seatSession(lead, seat, lead.runningCwd!));
  // Each seat of the preset by its session, in the preset's order; the saved seats and the request list the lead first.
  let next = 0; const ids = preset.seats.map((_, index) => index === at ? leadId : added[next++].id);
  const records = [seatRecord(leadId, preset.seats[at], hierarchy), ...others.map((seat, index) => seatRecord(added[index].id, seat, hierarchy))];
  const planner = hierarchy ? records.find((seat) => seat.duties?.includes('plan'))?.session : undefined;
  // At a discussion table the seat that edits: the preset's, the first when it names none.
  const driverId = hierarchy ? undefined : ids[preset.driver ?? 0];
  const driver = driverId === leadId || !driverId ? lead.config.engine : engineOf(added.find((session) => session.id === driverId));
  useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions, ...added].map((session) => session.id === leadId ? { ...session, roundTable: { partner: added[0].id, driver, rounds: preset.rounds, ...(hierarchy ? { kind: 'hierarchy' as const, ...(planner ? { planner } : {}) } : {}), seats: records, ...(driverId ? { driverSeat: driverId } : {}) } } : session) }));
  opening.add(leadId);
  try {
    await Promise.all(added.map((seat) => startSession(seat.id)));
    const now = useWorkspaceStore.getState().sessions; const seat = (id: string) => now.find((session) => session.id === id);
    for (const [index, item] of added.entries()) { const started = seat(item.id); if (!up(started)) { const why = started?.error ?? `${others[index].name?.trim() || NAME[others[index].engine]} could not be started.`; await retire(leadId); return why; } }
    const l = seat(leadId); if (!up(l)) { await retire(leadId); return 'This chat stopped before the Round Table opened.'; }
    const references = records.map((record) => seatReference(record, seat(record.session)!));
    const partner = references[1]; const plan = references.find((reference) => reference.sessionId === planner);
    const result = await window.codingHub?.chat({ action: 'table-open', sessionId: leadId, runId: l.runId, partner: { sessionId: partner.sessionId, runId: partner.runId }, driver, rounds: preset.rounds, ...(hierarchy ? { kind: 'hierarchy' as const, ...(plan ? { planner: { sessionId: plan.sessionId, runId: plan.runId } } : {}) } : {}), seats: references, ...(driverId ? { driverSeat: driverId } : {}) }).catch(() => null);
    if (result?.ok) return null;
    await retire(leadId); return result?.error.message ?? 'The Round Table could not be opened.';
  } finally { opening.delete(leadId); }
}
/** The discussion table with Claude Code and Codex at a running chat channel: the other agent seats at it, this channel's own agent driving first. */
export const openRoundTable = (leadId: string): Promise<string | null> => {
  const engine = engineOf(useWorkspaceStore.getState().sessions.find((session) => session.id === leadId));
  return openTable(leadId, { ...builtIn('discussion'), seats: [{ engine, model: '' }, { engine: engine === 'claude' ? 'codex' : 'claude', model: '' }] });
};

/**
 * The lead forgets its table, and its hidden partner is stopped and removed. A partner that would not stop is kept,
 * and as the table is forgotten it gets a tile of its own, so a running agent is never left out of sight.
 */
/** One line of the review record for a finding: what, where, and what became of it. */
const findingLine = (finding: Finding) => [`${finding.id} (${finding.severity}), ${finding.status}${finding.evidence ? `, at ${finding.evidence}` : ''}: ${finding.text}`, finding.response && `Driver: ${finding.response}`, finding.check && `Reviewer: ${finding.check}`, finding.reviewedAt && `Reviewed on files ${finding.reviewedAt}${finding.filesChanged ? ' (files changed while it was reviewed)' : ''}${finding.changedAt ? `, answered on ${finding.changedAt}` : ''}.`].filter(Boolean).join(' · ');

/**
 * A table's findings outlive it, in the project's shared memory (the channel's chosen memory project, or its folder's):
 * the whole review record as one note, verified findings included, and each finding not yet verified as an open item, so
 * later sessions see it until someone resolves it. Throws when memory cannot be written; nothing is dropped then.
 */
export async function keepFindings(lead: Session): Promise<number> {
  const findings = lead.roundTable?.findings ?? []; const open = findings.filter((finding) => finding.status !== 'verified');
  const directory = lead.runningCwd ?? (lead.binding.mode === 'independent' ? lead.binding.cwd : useWorkspaceStore.getState().rootDirectory);
  if (!findings.length || !isChatEngineConfig(lead.config)) return 0;
  if (!lead.config.memoryKey && !directory) throw new Error('This channel has no folder to find its memory project from.');
  const project = lead.config.memoryKey ?? await hubCall<string>({ action: 'memory-key', directory: directory! });
  const notes = [{ title: `Round Table review record: ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}, ${findings.length - open.length} verified`, content: ['Saved by Trace when the Round Table closed.', ...findings.map((finding) => `- ${findingLine(finding)}`)].join('\n') },
    ...open.map((finding) => ({ title: itemTitle(`Round Table ${finding.id} (${finding.severity}, ${finding.status}): ${finding.text}`), content: [`Round Table finding ${finding.id} (${finding.severity}), ${finding.status}${finding.evidence ? `, at ${finding.evidence}` : ''}: ${finding.text}`, finding.response && `Driver: ${finding.response}`, finding.check && `Reviewer: ${finding.check}`, finding.reviewedAt && `Reviewed on files ${finding.reviewedAt}${finding.filesChanged ? ' (files changed while it was reviewed)' : ''}.`, 'Saved by Trace when the Round Table closed, because it was not verified.'].filter(Boolean).join('\n') }))]
    .map((note) => ({ ...note, project, author: 'human' as const, key: `${project}\n${note.title}\n${note.content}` }));
  const missing = notes.filter((note) => !written.has(note.key));
  // One call, so the project's Drive copy syncs once rather than once a note.
  if (missing.length) try { await hubCall({ action: 'memory-write-many', notes: missing.map(({ key: _key, ...note }) => note) }); }
  catch (error) {
    const { code, message } = error as Error & { code?: string };
    // Notes are saved in order: the first N of them are, and a retry must not write them again.
    if (code === 'MEMORY_PARTIAL') { const saved = Number(/^(\d+) of /.exec(message)?.[1]); if (Number.isInteger(saved)) for (const note of missing.slice(0, saved)) written.add(note.key); throw error; }
    // A host that refuses the request (an older one has no memory-write-many): one note at a time, as before.
    if (code !== 'INVALID_HUB_REQUEST') throw error;
    for (const { key, ...note } of missing) { await hubCall({ action: 'memory-write', ...note }); written.add(key); }
  }
  for (const note of notes) written.delete(note.key);
  return findings.length;
}
/** Notes written by a save that failed part way. Memory notes cannot be changed or removed, so a retry writes only the rest. */
const written = new Set<string>();

/**
 * Saves a table's findings to shared memory and takes them off its saved record, so they are saved once. The error
 * message when memory cannot be written (the findings stay on the record then), or null.
 */
export async function archiveFindings(leadId: string): Promise<string | null> {
  const lead = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId); if (!lead?.roundTable?.findings?.length) return null;
  try { await keepFindings(lead); } catch (error) { return `The Round Table's findings could not be saved to shared memory (${(error as Error).message}). They are kept with the channel; Needs you can try again.`; }
  useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === leadId && session.roundTable ? { ...session, roundTable: { ...session.roundTable, findings: undefined } } : session) }));
  return null;
}

/** Returns an error message when the findings could not be saved: the table's record then stays with the lead, findings and all. */
async function retire(leadId: string): Promise<string | null> {
  if (retiring.has(leadId)) return null; retiring.add(leadId);
  try {
    const failure = await archiveFindings(leadId);
    // Tasks from Tasks still waiting at the table go back to To do before it is forgotten (also a table closed while not
    // open, which the host never hears of).
    const saved = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId)?.roundTable?.chain;
    // Loaded here, not at the top: the task store pulls in the terminals, which this module does not otherwise need.
    if (!failure && saved?.nextTasks?.length) { const { nextTasks, task } = saved; void import('../state/task-store').then(({ returnTasks }) => returnTasks(leadId, nextTasks, task)); }
    const seats = hiddenSeats(useWorkspaceStore.getState().sessions, leadId); const ids = new Set(seats.map((seat) => seat.id));
    for (const seat of seats) if (live(seat)) { await settled([seat.id], 'starting'); await stopSession(seat.id); await settled([seat.id]); }
    useWorkspaceStore.setState((state) => {
      const sessions = state.sessions
        .filter((session) => !ids.has(session.id) || live(session))
        .map((session) => session.id === leadId && session.roundTable && !failure ? { ...session, roundTable: undefined } : session);
      // A seat removed, or one that would not stop (now a channel of its own, so it stays in sight): tiles to match.
      return { sessions, tiles: fitTiles(sessions, state.tiles, state.layoutMode) };
    });
    return failure;
  } finally { retiring.delete(leadId); }
}
/** Leads whose table is being closed, so a close from the window and the host's `closed` event stop the partner once. */
const retiring = new Set<string>();

type TableRequest = { action: 'table-plan'; approve: boolean; note: string } | { action: 'table-continue'; skipChallenge?: boolean } | { action: 'table-waiting'; send: boolean } | { action: 'table-send'; text: string; images: ChatImage[] } | { action: 'table-driver'; driver: 'claude' | 'codex'; seat?: string } | { action: 'table-rounds'; rounds: number } | { action: 'table-stop' } | { action: 'table-close' } | { action: 'table-next-drop'; index: number; head: string };
/** A request to the table a running chat channel leads; the error message, or null. */
export async function tableRequest(leadId: string, request: TableRequest): Promise<string | null> {
  const lead = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId);
  if (!lead?.runId || !window.codingHub) return 'This chat is not running.';
  const result = await window.codingHub.chat({ ...request, sessionId: lead.id, runId: lead.runId }).catch(() => null);
  return result?.ok ? null : result?.error.message ?? 'Trace could not reach the Round Table.';
}

type TableRecord = NonNullable<Session['roundTable']>;
/** Whether two saved tables are the same; waiting images (up to 6 MB of base64) are compared as they are, not serialized. */
type Images = readonly { mediaType: string; data: string }[];
const sameImages = (left: Images = [], right: Images = []) => left.length === right.length && left.every((image, index) => image.mediaType === right[index].mediaType && image.data === right[index].data);
/** Images (a waiting message's, and a hierarchy task's once the host keeps them) are compared field by field, not serialized twice on every table event. */
function sameRecord(a: TableRecord, b: TableRecord) {
  const { waitingImages: left, chain: chainA, ...restA } = a; const { waitingImages: right, chain: chainB, ...restB } = b;
  const { images: imagesA, ...stepsA } = (chainA ?? {}) as { images?: Images }; const { images: imagesB, ...stepsB } = (chainB ?? {}) as { images?: Images };
  return sameImages(left, right) && sameImages(imagesA, imagesB) && !chainA === !chainB && JSON.stringify(stepsA) === JSON.stringify(stepsB) && JSON.stringify(restA) === JSON.stringify(restB);
}
/** The leading channel remembers its table (seats, driver, rounds) whenever the table changes. */
export function rememberTable(leadId: string, table: RoundTableState) {
  // The review record and a waiting message are kept with it, so a restart loses neither.
  const seats = table.seats?.map(({ sessionId, name, instructions, duties }) => ({ session: sessionId, ...(name ? { name } : {}), ...(instructions ? { instructions } : {}), ...(duties?.length ? { duties } : {}) }));
  const saved = { partner: table.partner.sessionId, driver: table.driver, rounds: table.rounds, ...(seats?.length ? { seats } : {}), ...(table.driverSeat ? { driverSeat: table.driverSeat } : {}), ...(table.kind === 'hierarchy' ? { kind: 'hierarchy' as const, ...(table.planner ? { planner: table.planner.sessionId } : {}), ...(table.chain ? { chain: table.chain } : {}) } : {}), ...(table.findings?.length ? { findings: table.findings } : {}), ...(table.waiting !== undefined ? { waiting: table.waiting } : {}), ...(table.waitingImages?.length ? { waitingImages: table.waitingImages } : {}) };
  useWorkspaceStore.setState((state) => {
    const lead = state.sessions.find((session) => session.id === leadId);
    if (!lead || (lead.roundTable && sameRecord(lead.roundTable, saved))) return state;
    const sessions = state.sessions.map((session) => session.id === leadId ? { ...session, roundTable: saved } : session);
    // A seat added as a channel (a table opened from a phone) is hidden now: its tile goes.
    return { sessions, tiles: fitTiles(sessions, state.tiles, state.layoutMode) };
  });
}
/** Closing the table (the person's choice, not Trace quitting) forgets it, so it is not opened again, and stops its seats. */
export function forgetTable(leadId: string) { return retire(leadId); }
/** Pairs of runs already seated again, so a table that fails to open is not tried over and over. */
const reopened = new Set<string>();
/**
 * After a restart (or after the chats were stopped and started again), a leading chat whose saved seats all run again is
 * seated at the table again, with the same seats, driver and rounds. The conversations resumed, so no seat is briefed
 * again. A table with a seat missing or stopped waits: it opens once every seat runs.
 */
export function restoreTables() {
  const { sessions } = useWorkspaceStore.getState();
  for (const lead of sessions) {
    const record = lead.roundTable;
    if (!record || lead.status !== 'running' || !lead.runId || tableOf(lead.id) || opening.has(lead.id)) continue;
    const hierarchy = record.kind === 'hierarchy';
    // A table saved before 1.26 has no seats: its partner (and at a hierarchy, its planner) are the others, as then.
    const others = savedSeats(record, lead.id).filter((seat) => seat.session !== lead.id).map((seat) => ({ seat, session: sessions.find((session) => session.id === seat.session) }));
    const partner = sessions.find((session) => session.id === record.partner);
    if (!partner || !up(partner) || others.some(({ session }) => !up(session))) continue;
    // A hierarchy table opens again once its planner runs too, picking up where its work stood.
    const planner = hierarchy ? sessions.find((session) => session.id === record.planner) : null;
    if (hierarchy && !up(planner ?? undefined)) continue;
    const pair = [lead.runId, ...others.map(({ session }) => session!.runId)].join(':'); if (reopened.has(pair)) continue; reopened.add(pair);
    // A table that will not open (seats in different folders, say) is tried once per set of runs: the thread and the
    // channel say why, instead of the table silently staying closed.
    const leadId = lead.id; const runId = lead.runId;
    const failed = (why: string) => tableOpenFailed(leadId, runId, why);
    const seats = record.seats?.length ? savedSeats(record, lead.id).map((seat) => seatReference(seat, seat.session === lead.id ? lead : sessions.find((session) => session.id === seat.session)!)) : null;
    void window.codingHub?.chat({ action: 'table-open', rejoin: true, sessionId: lead.id, runId: lead.runId, partner: { sessionId: partner.id, runId: partner.runId! }, driver: record.driver, rounds: record.rounds, ...(hierarchy && planner?.runId ? { kind: 'hierarchy' as const, planner: { sessionId: planner.id, runId: planner.runId }, ...(record.chain ? { chain: record.chain } : {}) } : {}), ...(seats ? { seats, ...(record.driverSeat ? { driverSeat: record.driverSeat } : {}) } : {}), ...(record.findings?.length ? { findings: record.findings } : {}), ...(record.waiting !== undefined ? { waiting: record.waiting } : {}), ...(record.waitingImages?.length ? { waitingImages: record.waitingImages } : {}) })
      .then((result) => { if (result && !result.ok) failed(result.error.message); }, (error: unknown) => failed(error instanceof Error ? error.message : 'Trace could not reach the Round Table.'));
  }
}

/**
 * + Channel → Round Table: a chat channel of the lead seat's agent and model in the project, started, with the preset's
 * other seats seated at it in the background (openTable), all in one tile. The error message, or null.
 */
export async function startTable(preset: TablePreset): Promise<string | null> {
  const before = new Set(useWorkspaceStore.getState().sessions.map((session) => session.id));
  const refused = checkPreset(preset); if (refused) return refused;
  if (before.size + preset.seats.length > MAX_CHANNELS) return tableFull(preset.seats.length);
  const seat = preset.seats[Math.max(0, leadIndex(preset))];
  useWorkspaceStore.getState().addChatSession(seat.engine);
  const lead = useWorkspaceStore.getState().sessions.find((session) => !before.has(session.id));
  if (!lead || lead.config.engine !== seat.engine) return 'The Round Table could not be added.';
  if (seat.model) useWorkspaceStore.getState().updateConfig(lead.id, { ...lead.config, model: seat.model });
  await startSession(lead.id);
  const started = useWorkspaceStore.getState().sessions.find((session) => session.id === lead.id);
  if (started?.status !== 'running') return started?.error ?? `${NAME[seat.engine]} could not be started.`;
  return openTable(lead.id, preset);
}
/** + Channel → Round Table: Claude Code with Codex (the built-in discussion table). Claude drives first; the person can swap. */
export const startRoundTable = (): Promise<string | null> => startTable(builtIn('discussion'));
/**
 * + Channel → Round Table (hierarchy): the built-in table, a Claude chat that builds (Opus 5.5 by default), with a hidden
 * Claude planner and final reviewer (Fable 5.2 by default) and a hidden Codex reviewer, who also challenges the plan.
 */
export const startHierarchyTable = (): Promise<string | null> => startTable(builtIn('hierarchy'));
/** Seats the planner and the reviewer of the built-in hierarchy table at a running chat channel (the builder). */
export const openHierarchy = (leadId: string): Promise<string | null> => openTable(leadId, builtIn('hierarchy'));

/** Starts a table's stopped seats; restoreTables then seats them again, and a hierarchy's work waits for Continue. */
export async function reopenTable(leadId: string): Promise<string | null> {
  const sessions = useWorkspaceStore.getState().sessions; const lead = sessions.find((session) => session.id === leadId);
  if (!lead || lead.status !== 'running') return 'Start this channel first.';
  const hidden = seatsOf(sessions, leadId).filter(({ seat }) => seat.session !== leadId);
  if (hidden.some(({ session }) => !session)) return lead.roundTable?.kind === 'hierarchy' ? 'This Round Table lost one of its seats. Close the table to chat with the builder alone.' : 'This Round Table lost one of its seats. Close the table to chat with this agent alone.';
  await Promise.all(hidden.map(({ session }) => live(session) ? undefined : startSession(session!.id)));
  const failed = hidden.map(({ seat }) => useWorkspaceStore.getState().sessions.find((session) => session.id === seat.session)).find((seat) => !live(seat));
  return failed ? failed.error ?? 'A seat of the Round Table could not be started.' : null;
}
/** The same as reopenTable, under the name a hierarchy's Reopen button already uses. */
export const reopenHierarchy = reopenTable;

/** A seat of an open or saved table as an editor shows it: what the person set, its agent and model, and who it is. */
export type EditableSeat = TablePresetSeat & { session: string; lead: boolean; driver: boolean; status: Session['status'] };
/** The seats of the table a channel leads, the lead first, as the person set them (the saved table) with each seat's agent and model from its channel. */
export function tableSeats(leadId: string): EditableSeat[] {
  const sessions = useWorkspaceStore.getState().sessions; const table = sessions.find((session) => session.id === leadId)?.roundTable; if (!table) return [];
  const seats = seatsOf(sessions, leadId).flatMap(({ seat, session }) => session && isChatEngineConfig(session.config) ? [{ seat, session, model: session.config.model }] : []);
  // A table saved before seats were named has no driverSeat: the seat of the driver's agent.
  const driverId = table.kind === 'hierarchy' ? undefined : table.driverSeat ?? seats.find(({ session }) => session.config.engine === table.driver)?.seat.session;
  return seats.map(({ seat, session, model }) => ({ engine: engineOf(session), model, ...(seat.name ? { name: seat.name } : {}), ...(seat.instructions ? { instructions: seat.instructions } : {}), ...(seat.duties ? { duties: [...seat.duties] } : {}), session: session.id, lead: session.id === leadId, driver: session.id === driverId, status: session.status }));
}

/** A plan for the seats of a table that is already open or saved: `session` names a seat that stays (with what the person now set), none a seat to add; seats not listed go. */
export interface SeatPlan { seats: (TablePresetSeat & { session?: string })[]; driver?: number; rounds?: number }
/**
 * Changes the seats of the table a channel leads. New seats are created and started first; the host is then told
 * (table-seats, with table-rounds and table-driver when those changed), and only once it accepted are the removed seats
 * stopped and removed and the new table saved: if it refuses, the seats just added are stopped and removed again and its
 * message is returned. A table that is saved but not open is changed on record only. A seat whose model changed is
 * stopped and started again last: its CLI cannot change model while it runs, and the table then closes for the moment
 * and is seated again by restoreTables once everyone runs, each conversation resumed. The error message, or null.
 */
export async function changeSeats(leadId: string, plan: SeatPlan): Promise<string | null> {
  const sessions = useWorkspaceStore.getState().sessions; const lead = sessions.find((session) => session.id === leadId); const table = lead?.roundTable;
  if (!lead || !table || !isChatEngineConfig(lead.config)) return 'This channel has no Round Table to change.';
  if (opening.has(leadId) || retiring.has(leadId)) return 'The Round Table is opening or closing. Try again in a moment.';
  const hierarchy = table.kind === 'hierarchy'; const kind = hierarchy ? 'hierarchy' as const : 'discussion' as const;
  const current = seatsOf(sessions, leadId); const known = new Map(current.map(({ seat, session }) => [seat.session, session]));
  // The lead first, then the others in the order given; each seat once, and only seats of this table.
  const at = plan.seats.findIndex((seat) => seat.session === leadId); if (at < 0) return 'The channel that leads the Round Table stays at it.';
  const order = [at, ...plan.seats.map((_, index) => index).filter((index) => index !== at)]; const seats = order.map((index) => plan.seats[index]);
  const named = seats.flatMap((seat) => seat.session ? [seat.session] : []);
  if (new Set(named).size !== named.length || named.some((id) => !known.get(id))) return 'A seat in this change is not at the Round Table.';
  for (const seat of seats) { const session = seat.session ? known.get(seat.session) : null; if (session && session.config.engine !== seat.engine) return 'A seat keeps its agent. Take it away and add another to change it.'; }
  const why = checkSeats(kind, seats, 0); if (why) return why;
  if (!hierarchy && plan.driver !== undefined && !plan.seats[plan.driver]) return 'The seat that edits is not at the table.';
  if (plan.rounds !== undefined && (!Number.isInteger(plan.rounds) || plan.rounds < (hierarchy ? 1 : 0) || plan.rounds > 5)) return hierarchy ? 'A hierarchy Round Table reviews between 1 and 5 rounds.' : 'A Round Table discusses between 0 and 5 rounds.';
  const fresh = seats.filter((seat) => !seat.session); const removed = current.filter(({ seat }) => seat.session !== leadId && !named.includes(seat.session)).map(({ seat }) => seat.session);
  if (sessions.length + fresh.length > MAX_CHANNELS) return tableFull(seats.length);
  const cwd = lead.runningCwd ?? (lead.binding.mode === 'independent' ? lead.binding.cwd : useWorkspaceStore.getState().rootDirectory);
  if (fresh.length && !cwd) return 'Choose a workspace root or an independent repository folder first.';
  const open = tableOf(leadId); const leadRun = lead.status === 'running' ? lead.runId : null; const previousDriver = tableSeats(leadId).find((seat) => seat.driver)?.session;
  if (open && !leadRun) return 'This chat is not running.';

  // New seats: created hidden (the lead's record lists them at once) and started.
  const added = fresh.map((seat) => seatSession(lead, seat, cwd!)); const addedFor = new Map(fresh.map((seat, index) => [seat, added[index].id]));
  const idOf = (seat: (typeof seats)[number]) => seat.session ?? addedFor.get(seat)!;
  const records = seats.map((seat) => seatRecord(idOf(seat), seat, hierarchy));
  const planner = hierarchy ? records.find((seat) => seat.duties?.includes('plan'))?.session : undefined;
  const driverId = hierarchy ? undefined : plan.driver !== undefined ? idOf(plan.seats[plan.driver]) : previousDriver && (previousDriver === leadId || named.includes(previousDriver)) ? previousDriver : leadId;
  const driverSession = driverId === leadId ? lead : added.find((session) => session.id === driverId) ?? sessions.find((session) => session.id === driverId);
  // Only what this change sets: the rest of the record (the work, the review record) is kept as it is when it is saved.
  const before = table; const next: Partial<NonNullable<Session['roundTable']>> = { partner: records[1].session, driver: driverSession && isChatEngineConfig(driverSession.config) ? engineOf(driverSession) : table.driver, rounds: plan.rounds ?? table.rounds, ...(planner ? { planner } : {}), seats: records, ...(driverId ? { driverSeat: driverId } : {}) };
  const undo = async () => {
    const gone = new Set(added.map((session) => session.id));
    for (const session of added) { const now = useWorkspaceStore.getState().sessions.find((item) => item.id === session.id); if (live(now)) { await settled([session.id], 'starting'); await stopSession(session.id); await settled([session.id]); } }
    useWorkspaceStore.setState((state) => { const rest = state.sessions.filter((session) => !gone.has(session.id) || live(session)).map((session) => session.id === leadId && session.roundTable ? { ...session, roundTable: { ...session.roundTable, seats: before.seats, driverSeat: before.driverSeat } } : session); return { sessions: rest, tiles: fitTiles(rest, state.tiles, state.layoutMode) }; });
  };
  if (added.length) {
    useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions, ...added].map((session) => session.id === leadId && session.roundTable ? { ...session, roundTable: { ...session.roundTable, seats: [...savedSeats(session.roundTable, leadId), ...added.map((seat) => ({ session: seat.id }))] } } : session) }));
    opening.add(leadId);
  }
  try {
    if (added.length) {
      await Promise.all(added.map((session) => startSession(session.id)));
      for (const session of added) { const started = useWorkspaceStore.getState().sessions.find((item) => item.id === session.id); if (!up(started)) { const message = started?.error ?? 'A new seat could not be started.'; await undo(); return message; } }
    }
    // The host first: it refuses a change while the table works, and nothing is stopped or removed before it accepts.
    if (open && leadRun) {
      const state = useWorkspaceStore.getState().sessions; const find = (id: string) => state.find((session) => session.id === id);
      const missing = records.find((record) => !up(find(record.session))); if (missing) { await undo(); return 'A seat of this table is not running. Press Reopen first.'; }
      const request = { sessionId: leadId, runId: leadRun };
      const seated = await window.codingHub?.chat({ action: 'table-seats', ...request, seats: records.map((record) => seatReference(record, find(record.session)!)), ...(driverId ? { driverSeat: driverId } : {}) }).catch(() => null);
      if (!seated?.ok) { await undo(); return seated?.error.message ?? 'Trace could not reach the Round Table.'; }
    }
    // Saved now, under the new seats; the removed seats are stopped while the old record still hides them.
    for (const id of removed) { const seat = useWorkspaceStore.getState().sessions.find((session) => session.id === id); if (live(seat)) { await settled([id], 'starting'); await stopSession(id); await settled([id]); } }
    const gone = new Set(removed);
    useWorkspaceStore.setState((state) => {
      const rest = state.sessions.filter((session) => !gone.has(session.id) || live(session)).map((session) => session.id === leadId && session.roundTable ? { ...session, roundTable: { ...session.roundTable, ...next } } : session);
      return { sessions: rest, tiles: fitTiles(rest, state.tiles, state.layoutMode) };
    });
    let problem: string | null = null;
    // Rounds and the editing seat go to the table as their own requests; the seats are already changed whatever they say.
    if (open && leadRun) {
      if (plan.rounds !== undefined && plan.rounds !== before.rounds) problem = await tableRequest(leadId, { action: 'table-rounds', rounds: plan.rounds });
      if (!problem && driverId && driverId !== previousDriver) problem = await tableRequest(leadId, { action: 'table-driver', driver: next.driver!, seat: driverId });
    }
    // A seat whose model changed starts again with it, last: the table closes for the moment, and restoreTables seats it again.
    const restart = seats.flatMap((seat) => { const session = seat.session ? known.get(seat.session) : null; return session && isChatEngineConfig(session.config) && session.config.model !== seat.model ? [{ session, model: seat.model }] : []; });
    if (!problem && restart.length) problem = await restartWithModels(leadId, restart);
    return problem;
  } finally { if (added.length) { opening.delete(leadId); restoreTables(); } }
}

/** Stops each of these seats, sets its model and starts it again (the lead's restart takes every hidden seat with it). The error message, or null. */
async function restartWithModels(leadId: string, changes: { session: Session; model: string }[]): Promise<string | null> {
  const ordered = [...changes.filter(({ session }) => session.id !== leadId), ...changes.filter(({ session }) => session.id === leadId)];
  for (const { session, model } of ordered) {
    const now = () => useWorkspaceStore.getState().sessions.find((item) => item.id === session.id);
    if (live(now())) { await settled([session.id], 'starting'); await stopSession(session.id); await settled([session.id]); }
    const stopped = now(); if (!stopped || live(stopped)) return 'A seat would not stop, so its model was not changed.';
    if (isChatEngineConfig(stopped.config)) useWorkspaceStore.getState().updateConfig(session.id, { ...stopped.config, model });
    await startSession(session.id);
  }
  const failed = useWorkspaceStore.getState().sessions.find((item) => changes.some(({ session }) => session.id === item.id) && !live(item));
  return failed ? failed.error ?? 'A seat could not be started again.' : null;
}
