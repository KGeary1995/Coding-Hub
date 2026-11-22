import type { ChatEnvelope, ChatEvent, ChatImage, RoundTableState } from '../../../shared/chat';
import { HubError } from '../cli/engine-adapter';
import type { PermissionLevel } from '../../../shared/types';
import { apply, type Finding, findingsFor, makeRoomForFinding, MAX_FINDINGS, parseAnswers, parseFindings, unreadLines, unreadNotice } from '../../../shared/findings';
import { checkSeats, GEMINI_SEAT_RULE, seatNames, type SeatSettings, type TableKind } from '../../../shared/table-seats';

type Engine = 'claude' | 'codex' | 'gemini';
/** What the coordinator needs from the run manager: chat runs it can read about and write to on the person's behalf. */
export interface TableHost {
  /** `permissions`: the level the person set for the run; at Full a read-only seat runs its commands without asking. */
  /** `busy`: the run is still in a turn it was given before (by an earlier table, say): its `done` has not come yet. */
  run(runId: string): { sessionId: string; engine: Engine; cwd: string; owner: number; permissions?: PermissionLevel; busy?: boolean } | null;
  send(runId: string, text: string, images: ChatImage[]): void;
  setReadOnly(runId: string, readOnly: boolean): void;
  answer(runId: string, requestId: string, allow: boolean): void;
  interrupt(runId: string): void;
  emit(owner: number, envelope: ChatEnvelope): void;
  /** The files in a folder now, as a hash (repositoryState); null outside Git. Findings record it. */
  stateOf?(cwd: string): Promise<string | null>;
}
/** A seat named for a table (table-open, table-seats): a running chat, with what the person set for it. Its session is read from the run (pty-manager checks a request's pair). */
export interface SeatInput extends SeatSettings { runId: string; sessionId?: string }

export const NAME: Record<Engine, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };
/** Names in a sentence: "A", "A and B", "A, B and C". */
export const list = (names: readonly string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
/**
 * Checks the seats of a table before anything changes: each chat once, seats that make a table of this kind
 * (checkSeats), every chat running, in one folder and in this window. Returns their runs, in order.
 */
export function checkTable(host: TableHost, owner: number, kind: TableKind, seats: readonly SeatInput[], lead = 0) {
  if (new Set(seats.map((seat) => seat.runId)).size !== seats.length) throw new HubError('TABLE_SEATS', 'The same chat is seated twice. Seat each chat once.');
  const problem = checkSeats(kind, seats, lead); if (problem) throw new HubError('TABLE_SEATS', problem);
  const runs = seats.map((seat) => { const run = host.run(seat.runId); if (!run) throw new HubError('TABLE_RUN', 'That chat is not running.'); return run; });
  if (new Set(runs.map((run) => run.sessionId)).size !== runs.length) throw new HubError('TABLE_SEATS', 'The same chat is seated twice. Seat each chat once.');
  const both = runs.length === 2;
  if (runs.some((run) => run.cwd !== runs[0].cwd)) throw new HubError('TABLE_FOLDER', both ? 'Both agents must work in the same folder.' : 'All the agents must work in the same folder.');
  if (runs.some((run) => run.owner !== owner)) throw new HubError('TABLE_OWNER', both ? 'Both chats must be open in this window.' : 'All the chats must be open in this window.');
  return runs;
}
/** The lead's own entry first (from the list, or bare), then the other seats in the order given. */
export function leadFirst(leadRunId: string, seats: readonly SeatInput[], lead: Partial<SeatInput> = {}): SeatInput[] {
  return [{ ...lead, ...seats.find((seat) => seat.runId === leadRunId), runId: leadRunId }, ...seats.filter((seat) => seat.runId !== leadRunId)];
}
/** The longest answer passed to the other agent; more is cut, and the agent is told so. */
const RELAY_LIMIT = 12_000;
/** Keeps the END of a long answer (a seat's closing report: files changed, checks run, is what the next seat needs), with a marker where the start was left out. */
export const cut = (text: string) => text.length > RELAY_LIMIT ? `[… earlier part shortened by Trace]\n${text.slice(-RELAY_LIMIT)}` : text;
/** Messages kept per chat run, so a newcomer gets the recent ones word for word. */
const RECENT = 8;
/** Images in one message (chatRequestSchema). */
const MAX_IMAGES = 10;
/** The most image data (base64 characters) a waiting message keeps through a restart; the saved workspace carries it. */
export const KEEP_IMAGES = 6_000_000;
/** The longest waiting message a saved workspace holds (savedWorkspaceSchema `waiting`): messages joined past it are refused, not saved unsaveable. */
export const KEEP_WAITING = 200_000;
/** Refuses a message that would make the waiting ones longer than a workspace can save. */
export function checkWaiting(queued: { text: string } | null, text: string) {
  if (queued && queued.text.length + 2 + text.length > KEEP_WAITING) throw new HubError('TABLE_WAITING_LONG', `The messages waiting for the agents would be longer than ${KEEP_WAITING.toLocaleString('en-US')} characters. Send this one after they finish.`);
}
/** Tools a reviewer never gets to use: file edits, and leaving Claude's plan mode. */
export const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode', 'File changes']);
/** Whether a permission request is an edit, by the name shown or the tool's own name (Claude may show a display name). */
export const isEdit = (event: { toolName: string; tool?: string }) => EDITS.has(event.toolName) || (event.tool !== undefined && EDITS.has(event.tool));
/**
 * A read-only seat's request that is not an edit (a command, a web fetch) at Full access: allowed at once, as the
 * person's level says, instead of an approval card. Returns whether it was. Edits are declined before this.
 */
export function allowAtFull(host: TableHost, runId: string, requestId: string): boolean {
  if (host.run(runId)?.permissions !== 'full') return false;
  host.answer(runId, requestId, true); return true;
}
/** An answer saying the agent agrees and has nothing to add. */
const AGREES = /^\s*\**AGREE\**\s*[.!]?\s*$/i;

interface Seat { runId: string; sessionId: string; engine: Engine; name?: string; instructions?: string; busy: boolean; text: string; answer: string | null; briefed: boolean;
  /** Seated after the table opened (setSeats): its first brief carries the latest messages, word for word. */
  newcomer?: boolean;
  /** Still in a turn from before this table opened: its `done` ends that old turn and is never taken as an answer. */
  stale?: boolean }
interface Table {
  /** Every seat, the lead first; `driver` is the one that edits files. */
  owner: number; lead: Seat; seats: Seat[]; driver: Seat; rounds: number; round: number;
  phase: RoundTableState['phase']; agreed: boolean;
  /** A message the person sent while the agents were still busy: sent once all have stopped. */
  queued: { text: string; images: ChatImage[] } | null;
  /** The queued message came back from before a restart: it is not sent until the person says so. */
  kept: boolean;
  /** The newest messages of the leading conversation, for the newcomers' brief. */
  recent: string[];
  /** The folder the agents work in, and the review record. */
  cwd: string; findings: Finding[];
  /** The files when the current turns were sent; and whether the answers are being read into the record (the next round waits for it). */
  turnStart: Promise<string | null> | null; reviewing: boolean;
  /** Stop was pressed: the turns it ends are expected, not failures. Cleared with the person's next message. */
  halted: boolean;
}

/**
 * Round Tables: the person and two or more agents (Claude Code or Codex chats, in any mix) in one conversation. Each
 * table is led by the chat run it was opened on and seats the other chat runs in the same folder. Trace passes messages
 * between them: the person's go to every seat; when all have answered, each gets the others' answers, for up to
 * `rounds` rounds or until all say AGREE. The driver may edit files; every other seat reviews, read-only, and Trace
 * declines any edit it still asks for.
 */
export class RoundTables {
  private tables = new Map<string, Table>();
  /** Recent messages of every chat run, by run id; a table's newcomer is briefed from them. */
  private recent = new Map<string, string[]>();
  constructor(private host: TableHost) {}

  /** Whether a run sits at a discussion table (as its lead or another seat). */
  isSeated(runId: string) { return this.tableOf(runId) !== null; }
  /** The table a run sits at, as its leading run id. */
  private tableOf(runId: string): Table | null {
    const own = this.tables.get(runId); if (own) return own;
    for (const table of this.tables.values()) if (table.seats.some((seat) => seat.runId === runId)) return table;
    return null;
  }
  private leading(runId: string): Table {
    const table = this.tables.get(runId);
    if (!table) throw new HubError('TABLE_NONE', 'This channel has no Round Table open.');
    return table;
  }
  private seat(input: SeatInput): Seat {
    const run = this.host.run(input.runId); if (!run) throw new HubError('TABLE_RUN', 'That chat is not running.');
    return { runId: input.runId, sessionId: run.sessionId, engine: run.engine, ...settings(input), busy: run.busy === true, text: '', answer: null, briefed: false, ...(run.busy ? { stale: true } : {}) };
  }
  private busy(table: Table) { return table.seats.some((seat) => seat.busy); }
  /** Each seat's name (its own, or its agent's; numbered when two would share one). */
  private names(table: Table) { const names = seatNames(table.seats, 'discussion'); return new Map(table.seats.map((seat, index) => [seat, names[index]])); }
  private nameOf(table: Table, seat: Seat) { return this.names(table).get(seat)!; }
  /** The seat that edits: a seat's session id, or (as before 1.26) an engine, meaning the first seat of that agent. */
  private driverOf(seats: Seat[], driver: string): Seat {
    const seat = seats.find((each) => each.sessionId === driver) ?? seats.find((each) => each.engine === driver);
    // A Gemini CLI seat runs in plan mode and has its edits declined: it is never the seat that edits.
    if (seat?.engine === 'gemini') throw new HubError('TABLE_DRIVER', GEMINI_SEAT_RULE);
    if (seat) return seat;
    // An engine no seat has (a table of two Claudes asked for Codex): the lead drives, as the table's own channel.
    if (driver === 'claude' || driver === 'codex') return seats[0];
    throw new HubError('TABLE_DRIVER', 'The seat that edits files must sit at this Round Table. Choose one of its seats.');
  }
  private state(table: Table): RoundTableState {
    const partner = table.seats[1];
    return { seats: table.seats.map((seat) => ({ sessionId: seat.sessionId, runId: seat.runId, engine: seat.engine, ...settings(seat) })), driverSeat: table.driver.sessionId,
      partner: { sessionId: partner.sessionId, runId: partner.runId, engine: partner.engine }, driver: table.driver.engine as 'claude' | 'codex', rounds: table.rounds, round: table.round, phase: table.phase, agreed: table.agreed, findings: table.findings.map((finding) => ({ ...finding })), ...(table.queued ? { waiting: table.queued.text, ...this.keptImages(table.queued.images), ...(table.kept ? { waitingKept: true } : {}) } : {}) };
  }
  /** A waiting message's images go with the saved table up to KEEP_IMAGES of base64; beyond that they are counted as dropped. */
  private keptImages(images: ChatImage[]) {
    if (!images.length) return {};
    return images.reduce((sum, image) => sum + image.data.length, 0) <= KEEP_IMAGES ? { waitingImages: images } : { waitingImagesDropped: images.length };
  }
  private publish(table: Table) { this.host.emit(table.owner, { sessionId: table.lead.sessionId, runId: table.lead.runId, event: { type: 'table', table: this.state(table) } }); }
  private notice(table: Table, text: string) { this.host.emit(table.owner, { sessionId: table.lead.sessionId, runId: table.lead.runId, event: { type: 'notice', text } }); }
  private roles(table: Table) {
    for (const seat of table.seats) this.host.setReadOnly(seat.runId, seat !== table.driver);
  }

  /** What an agent is told about the table, once, before its first message here. With two seats it reads as before 1.26. */
  private brief(table: Table, seat: Seat) {
    const names = this.names(table); const name = names.get(seat)!; const two = table.seats.length === 2;
    const otherNames = table.seats.filter((other) => other !== seat).map((other) => names.get(other)!); const others = list(otherNames);
    // A seat whose name is not simply its agent's (two Claudes, a name the person gave) is told what the others call it.
    const self = !two || name !== NAME[seat.engine] ? ` The others call you ${name}.` : '';
    const role = seat === table.driver
      ? `You are the driver: you make the file changes. Carry out what the person asked without asking again whether to proceed; ask only about choices that are theirs to make, or before anything that publishes, deletes or cannot be undone.`
      : two ? `You are the reviewer: read files and check the driver's work, but do not edit files (Trace keeps you read-only).`
        : `You are a reviewer: read files and check the work of the driver, ${names.get(table.driver)}, but do not edit files (Trace keeps you read-only).`;
    // The fixed forms Trace reads into the review record (shared/findings.ts).
    const record = seat === table.driver
      ? `When Trace lists open findings, answer each on its own line as "FIXED F<n>: what you changed" or "DECLINED F<n>: why".`
      : `Report each problem on its own line as "FINDING high|medium|low path:line — the problem" (Trace numbers them F1, F2, …). When the driver answers one, check it, then write "VERIFIED F<n>" or "REOPENED F<n>: why".`;
    const shown = two ? `${others}'s answer, reply to it` : `the others' answers, reply to them`;
    return `[Trace Round Table] You are in one conversation with ${list(['the person', ...otherNames])}.${self} Trace passes each of you what the ${two ? 'other says' : 'others say'}. ${role} When Trace shows you ${shown} briefly: agree, disagree or add what is missing. If you fully agree and have nothing to add, reply with exactly AGREE. ${record}${instructionsFor(seat)}`;
  }
  /** The brief a seat gets with its next message, if it has not had it; a newcomer's carries the latest messages too. */
  private intro(table: Table, seat: Seat) {
    if (seat.briefed) return '';
    seat.briefed = true; const recent = seat.newcomer ? (this.recent.get(table.lead.runId) ?? []).slice(-RECENT).join('\n\n') : ''; seat.newcomer = false;
    return `${this.brief(table, seat)}\n\n${recent ? `You are joining a conversation already under way. The latest messages:\n\n${recent}\n\n` : ''}`;
  }

  /**
   * Seats the other chats at a table led by `leadRunId`: one run id (a partner, as before 1.26) or the seats with what
   * the person set for each (the lead's own entry may be among them). `driver`: the seat that edits, by session id, or
   * an engine for the first seat of that agent.
   */
  open(owner: number, leadRunId: string, seats: string | readonly SeatInput[], driver: string, rounds: number, saved: { findings?: Finding[]; waiting?: string; waitingImages?: ChatImage[]; rejoin?: boolean } = {}): RoundTableState {
    const inputs = leadFirst(leadRunId, typeof seats === 'string' ? [{ runId: seats }] : seats);
    if (inputs.some((input) => this.tableOf(input.runId))) throw new HubError('TABLE_TAKEN', 'One of these chats is already at a Round Table.');
    const runs = checkTable(this.host, owner, 'discussion', inputs);
    const made = inputs.map((input) => this.seat(input)); const lead = made[0];
    const table: Table = { owner, lead, seats: made, driver: this.driverOf(made, driver), rounds: Math.max(0, Math.min(5, rounds)), round: 0, phase: 'idle', agreed: false, queued: null, recent: [...(this.recent.get(leadRunId) ?? [])], cwd: runs[0].cwd, findings: (saved.findings ?? []).slice(0, MAX_FINDINGS).map((finding) => ({ ...finding })), turnStart: null, reviewing: false, kept: false, halted: false };
    if (saved.waiting !== undefined || saved.waitingImages?.length) table.queued = { text: saved.waiting ?? '', images: (saved.waitingImages ?? []).slice(0, MAX_IMAGES) };
    table.kept = Boolean(table.queued);
    this.tables.set(leadRunId, table); this.roles(table);
    // A seat still at work from before (a table closed while it worked) is stopped; nothing is sent to it until that
    // turn has ended.
    for (const seat of made) if (seat.stale) { try { this.host.interrupt(seat.runId); } catch { /* Ended. */ } }
    // Seated again (every conversation resumed): they know each other already, so no summary and no new brief.
    if (saved.rejoin) for (const seat of made) seat.briefed = true;
    // A conversation already under way: the leading agent sums it up, and the newcomers get that plus the latest messages.
    else if (table.recent.length && !lead.busy) {
      table.phase = 'joining'; lead.busy = true; lead.text = '';
      const joining = made.slice(1);
      this.host.send(lead.runId, `${this.brief(table, lead)}\n\n${list(joining.map((seat) => this.nameOf(table, seat)))} ${joining.length === 1 ? 'is' : 'are'} joining now. Write a short summary of this conversation for ${joining.length === 1 ? 'it' : 'them'}: the goal, what was decided, the current state and open questions. Reply with only the summary.`, []);
      lead.briefed = true;
    }
    this.publish(table);
    return this.state(table);
  }

  /**
   * The person's message: to every seat. If any is still busy, their work is not stopped (Stop does that): the message
   * waits until all finish their turn and goes next, in place of further discussion rounds. Several waiting messages go
   * together.
   */
  send(leadRunId: string, text: string, images: ChatImage[]) {
    const table = this.leading(leadRunId);
    // A message kept from before a restart is the person's to send or drop; a new one is not mixed into it.
    if (table.kept) throw new HubError('TABLE_KEPT', 'A message from before Trace restarted is waiting. Send it or drop it first (on the Round Table bar).');
    if (this.busy(table) || table.reviewing) {
      // Waiting messages go as one, and a message carries at most ten images: refused rather than dropped.
      if (table.queued && table.queued.images.length + images.length > MAX_IMAGES) throw new HubError('TABLE_IMAGES', `The waiting messages already have ${table.queued.images.length} images and a message carries at most ${MAX_IMAGES}. Send this one after the agents finish.`);
      checkWaiting(table.queued, text);
      table.queued = table.queued ? { text: [table.queued.text, text].filter(Boolean).join('\n\n'), images: [...table.queued.images, ...images] } : { text, images };
      // Published at once, so the window saves it: a restart before the agents finish keeps the message.
      this.publish(table); return;
    }
    this.ask(table, text, images);
  }
  private ask(table: Table, text: string, images: ChatImage[]) {
    table.round = 0; table.agreed = false; table.halted = false; table.phase = 'answering'; this.snapshot(table);
    // Before this message is remembered: a newcomer's latest messages are those before it.
    const intros = new Map(table.seats.map((seat) => [seat, this.intro(table, seat)]));
    // The person's messages reach the agents from here, not from the window, so they are remembered here.
    for (const seat of table.seats) this.remember(seat.runId, { type: 'user', text, images: images.length });
    for (const seat of table.seats) {
      seat.busy = true; seat.text = ''; seat.answer = null;
      this.host.send(seat.runId, `${intros.get(seat)}${text}`, images);
    }
    this.publish(table);
  }

  /** A message kept from before a restart: sent now (to every seat, once they are free), or dropped. */
  waiting(leadRunId: string, send: boolean) {
    const table = this.leading(leadRunId); if (!table.queued) return this.state(table);
    table.kept = false;
    if (!send) { table.queued = null; this.publish(table); return this.state(table); }
    if (!this.busy(table) && !table.reviewing) { const { text, images } = table.queued; table.queued = null; this.ask(table, text, images); }
    else this.publish(table);
    return this.state(table);
  }

  /** The seat that edits from now on: a seat's session id, or an engine (the first seat of that agent). */
  setDriver(leadRunId: string, driver: string) {
    const table = this.leading(leadRunId); const seat = this.driverOf(table.seats, driver); if (table.driver === seat) return this.state(table);
    table.driver = seat; this.roles(table);
    // Each agent hears about the change with its next message.
    for (const each of table.seats) each.briefed = false;
    this.publish(table); return this.state(table);
  }
  setRounds(leadRunId: string, rounds: number) { const table = this.leading(leadRunId); table.rounds = Math.max(0, Math.min(5, rounds)); this.publish(table); return this.state(table); }
  /**
   * The table's seats from now on, while it is idle: seats not listed leave (read-only lifted; their window stops them),
   * new ones are checked as at open, names and instructions change. The lead stays. `driverSeat`: the seat that edits
   * (by session id); without it the driver stays, or the lead drives if the driver left. Everyone is briefed again
   * with their next message; a newcomer's brief carries the latest messages.
   */
  setSeats(leadRunId: string, seats: readonly SeatInput[], driverSeat?: string) {
    const table = this.leading(leadRunId);
    if (this.busy(table) || table.reviewing || table.phase !== 'idle') throw new HubError('TABLE_BUSY', 'Change the seats once the agents have finished: wait for them, or press Stop.');
    if (!seats.some((seat) => seat.runId === leadRunId)) throw new HubError('TABLE_LEAD', 'The channel that shows the Round Table keeps its seat. Keep it in the list.');
    const inputs = leadFirst(leadRunId, seats);
    const current = new Map(table.seats.map((seat) => [seat.runId, seat]));
    if (inputs.some((input) => !current.has(input.runId) && this.tableOf(input.runId))) throw new HubError('TABLE_TAKEN', 'One of these chats is already at a Round Table.');
    // The lead's run is checked with the rest, so every seat works in the table's folder.
    checkTable(this.host, table.owner, 'discussion', inputs);
    const made = inputs.map((input) => current.get(input.runId) ?? { ...this.seat(input), newcomer: true });
    const driver = driverSeat !== undefined ? this.driverOf(made, driverSeat) : made.includes(table.driver) ? table.driver : made[0];
    // Every check is done: from here nothing throws.
    made.forEach((seat, index) => { delete seat.name; delete seat.instructions; Object.assign(seat, settings(inputs[index])); });
    const left = table.seats.filter((seat) => !made.includes(seat));
    for (const seat of left) { try { this.host.setReadOnly(seat.runId, false); } catch { /* Ended. */ } }
    table.seats = made; table.driver = driver; this.roles(table);
    for (const seat of made) { seat.briefed = false; if (seat.stale) { try { this.host.interrupt(seat.runId); } catch { /* Ended. */ } } }
    this.publish(table); return this.state(table);
  }

  /**
   * Stops every agent and ends the discussion; the table stays. A message the person already sent is kept: it goes to
   * all as soon as they have stopped (it was shown as sent, so it is not dropped).
   */
  stop(leadRunId: string) {
    const table = this.leading(leadRunId); table.round = table.rounds; table.halted = true;
    for (const seat of table.seats) if (seat.busy) this.host.interrupt(seat.runId);
    table.phase = this.busy(table) ? table.phase : 'idle'; this.publish(table);
  }

  /** `byPerson`: closed on request (not because a run ended), which the window takes as forgetting the table. */
  close(leadRunId: string, byPerson = true) {
    const table = this.tables.get(leadRunId); if (!table) return;
    this.tables.delete(leadRunId);
    // All may edit again, as ordinary chats.
    for (const seat of table.seats) { try { this.host.setReadOnly(seat.runId, false); } catch { /* Ended. */ } }
    this.host.emit(table.owner, { sessionId: table.lead.sessionId, runId: table.lead.runId, event: { type: 'table', table: null, ...(byPerson ? { closed: true as const } : {}) } });
  }
  /**
   * A chat run ended: its table closes for now (the window seats them again once all run). The other seats, if still at
   * work, are stopped first (as at a hierarchy table): none is left working, with its read-only lifted, for a table that
   * is gone.
   */
  ended(runId: string) {
    this.recent.delete(runId);
    const table = this.tableOf(runId); if (!table) return;
    // Stopped before its read-only is lifted: the interrupt reaches the CLI ahead of the change of mode.
    for (const seat of table.seats) if (seat.busy && seat.runId !== runId) { try { this.host.interrupt(seat.runId); } catch { /* Ended. */ } }
    this.close(table.lead.runId, false);
  }

  /**
   * Every chat event passes here before it reaches the window. Returns a notice to show in place of an approval a
   * reviewer asked for and Trace declined (an edit, or leaving plan mode), so no approval card or alert appears for it;
   * or '' for one Trace allowed (a command, at Full access), which shows nothing.
   */
  observe(envelope: ChatEnvelope): string | null {
    const { runId, event } = envelope;
    this.remember(runId, event);
    const table = this.tableOf(runId); if (!table) return null;
    const seat = table.seats.find((each) => each.runId === runId)!;
    if (event.type === 'assistant') { const words = event.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n'); if (words) seat.text = seat.text ? `${seat.text}\n${words}` : words; return null; }
    if (event.type === 'permission' && seat !== table.driver && isEdit(event)) {
      this.host.answer(runId, event.requestId, false);
      return `Trace declined ${event.toolName} for ${this.nameOf(table, seat)}: the reviewer does not edit files. Swap the driver to let it.`;
    }
    if (event.type === 'permission' && seat !== table.driver && allowAtFull(this.host, runId, event.requestId)) return '';
    if (event.type !== 'done' || !seat.busy) return null;
    // The end of a turn from before this table opened: the seat is free, and a message waiting for it goes now.
    if (seat.stale) {
      seat.busy = false; seat.stale = false; seat.text = '';
      if (!this.busy(table) && !table.reviewing && table.queued && !table.kept) { const { text, images } = table.queued; table.queued = null; this.ask(table, text, images); }
      // The newcomer's old turn ended after the lead's summary came in: the summary goes to it now.
      else if (!this.busy(table) && table.phase === 'joining') this.settle(table, table.lead);
      else { if (!this.busy(table) && table.phase !== 'joining') table.phase = 'idle'; this.publish(table); }
      return null;
    }
    seat.busy = false; seat.answer = seat.text.trim(); seat.text = '';
    // A turn that failed (a usage limit, an API error) or was interrupted from the tile, not one the table's Stop ended,
    // ends the discussion: the others are not sent "(no answer)" for every round left. Worded to fit either cause.
    if (event.isError && !table.halted) {
      table.round = table.rounds;
      this.notice(table, `${this.nameOf(table, seat)} ended its turn early, so the Round Table discussion ends here${event.error ? `: ${event.error}` : '.'}`);
    }
    this.settle(table, seat, event.isError);
    return null;
  }

  /** `failed`: the seat's turn ended in an error. */
  private settle(table: Table, seat: Seat, failed = false) {
    if (this.busy(table)) { this.publish(table); return; }
    if (table.phase === 'joining' && table.queued && !table.kept) { const { text, images } = table.queued; table.queued = null; this.ask(table, text, images); return; }
    if (table.phase === 'joining') {
      // Stop, or a failed summary, leaves the newcomers unbriefed (a later message briefs them) instead of starting them anyway.
      if (table.halted || failed) { table.phase = 'idle'; this.publish(table); return; }
      const summary = seat.answer || '(no summary)';
      const recent = table.recent.slice(-RECENT).join('\n\n');
      table.phase = 'answering'; table.round = table.rounds;
      for (const each of table.seats) {
        if (each === table.lead || each.briefed) continue;
        each.briefed = true; each.newcomer = false; each.busy = true;
        this.host.send(each.runId, `${this.brief(table, each)}\n\nYou are joining a conversation already under way. ${this.nameOf(table, table.lead)}'s summary:\n\n${summary}\n\nThe latest messages:\n\n${recent}\n\nSay briefly that you are caught up and anything you would add. Wait for the person's next message before changing anything.`, []);
      }
      this.publish(table); return;
    }
    // The record is read, and the files' state taken, before anyone starts another turn that could change them.
    if (this.host.stateOf) {
      table.reviewing = true;
      void this.review(table).catch(() => { /* Recorded without the files' state. */ }).finally(() => { table.reviewing = false; if (this.tables.get(table.lead.runId) === table) this.next(table); });
      return;
    }
    void this.review(table); this.next(table);
  }
  /** A message the person sent meanwhile goes next, in place of further rounds; otherwise the discussion goes on. */
  private next(table: Table) {
    if (table.queued && !table.kept) { const { text, images } = table.queued; table.queued = null; this.ask(table, text, images); return; }
    this.discuss(table);
  }

  /** After all answered: stop, or pass each the others' answers for the next round. */
  private discuss(table: Table) {
    const answers = table.seats.map((seat) => seat.answer ?? '');
    table.agreed = table.round > 0 && answers.every((answer) => AGREES.test(answer));
    if (table.agreed || table.round >= table.rounds || answers.every((answer) => !answer)) { table.phase = 'idle'; this.publish(table); return; }
    table.round++; table.phase = 'discussing'; this.snapshot(table);
    // Every answer is read before any seat starts its next turn (which clears its answer).
    const given = new Map(table.seats.map((seat) => [seat, seat.answer])); const names = this.names(table);
    for (const each of table.seats) {
      const relayed = table.seats.filter((other) => other !== each).map((other) => {
        let answer = cut(given.get(other) || '(no answer)'); if (AGREES.test(answer)) answer = 'AGREE (nothing to add)';
        return `${names.get(other)} answered:\n\n${answer}`;
      }).join('\n\n');
      const intro = this.intro(table, each);
      each.busy = true; each.answer = null; each.text = '';
      const waiting = findingsFor(table.findings, each === table.driver ? 'driver' : 'reviewer');
      this.host.send(each.runId, `${intro}[Trace Round Table · round ${table.round} of ${table.rounds}] ${relayed}\n\n${waiting ? `${waiting}\n\n` : ''}Reply briefly: agree, disagree or add what is missing. If you fully agree and have nothing to add, reply with exactly AGREE.`, []);
    }
    this.publish(table);
  }

  /** The files as the coming turns start, to compare with how they are when the answers are in. */
  private snapshot(table: Table) { table.turnStart = this.host.stateOf ? this.host.stateOf(table.cwd).catch(() => null) : null; }
  /**
   * Reads the answers into the review record: every reviewer's new findings and checks, and the driver's answers. Each
   * change notes the files as they are now, so a finding shows which version was reviewed and which was answered.
   */
  private async review(table: Table) {
    const driver = table.driver; const reviewers = table.seats.filter((seat) => seat !== driver);
    const changed: Finding[] = []; const at = new Date().toISOString();
    let full = 0;
    for (const reviewer of reviewers) for (const found of parseFindings(reviewer.answer ?? '')) {
      const id = makeRoomForFinding(table.findings); if (!id) { full++; continue; }
      const finding: Finding = { id, ...found, status: 'open', response: '', check: '', reviewedAt: null, changedAt: null, round: table.round, at };
      table.findings.push(finding); changed.push(finding);
    }
    for (const [seat, role] of [...reviewers.map((reviewer) => [reviewer, 'reviewer'] as const), [driver, 'driver'] as const]) for (const { id, verb, note } of parseAnswers(seat.answer ?? '', role)) {
      const finding = table.findings.find((item) => item.id === id); if (finding && apply(finding, verb, note) && !changed.includes(finding)) changed.push(finding);
    }
    // A full record (MAX_FINDINGS, none verified to make room) says so, rather than dropping findings without a word.
    if (full) this.notice(table, `The review record is full (${MAX_FINDINGS} findings, none verified), so ${full} new ${full === 1 ? 'finding was' : 'findings were'} not recorded. Close the table to save the record to shared memory, then open it again.`);
    // So is a line that looks like a review line but could not be read.
    const unread = unreadNotice([...reviewers.flatMap((reviewer) => unreadLines(reviewer.answer ?? '', 'reviewer')), ...unreadLines(driver.answer ?? '', 'driver')]); if (unread) this.notice(table, unread);
    if (!changed.length || !this.host.stateOf) { if (changed.length) this.publish(table); return; }
    const [before, after] = await Promise.all([table.turnStart ?? Promise.resolve(null), this.host.stateOf(table.cwd).catch(() => null)]);
    const short = after ? after.slice(0, 12) : null; const moved = before !== null && after !== null && before !== after;
    for (const finding of changed) {
      if (finding.status === 'open' && !finding.reviewedAt) { finding.reviewedAt = short; if (moved) finding.filesChanged = true; }
      else finding.changedAt = short;
    }
    if (this.tables.get(table.lead.runId) === table) this.publish(table);
  }

  private remember(runId: string, event: ChatEvent) {
    const line = event.type === 'user' ? `The person: ${event.text}` : event.type === 'assistant' ? event.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n') : '';
    if (!line.trim()) return;
    const run = this.host.run(runId); const who = event.type === 'user' ? '' : `${run ? NAME[run.engine] : 'Agent'}: `;
    const lines = this.recent.get(runId) ?? []; lines.push(`${who}${line.slice(0, 2000)}`); if (lines.length > RECENT * 2) lines.splice(0, lines.length - RECENT * 2);
    this.recent.set(runId, lines);
  }
}

/** The name and instructions the person set for a seat, only those given. */
export function settings(seat: SeatSettings): SeatSettings {
  const name = seat.name?.trim(); const instructions = seat.instructions?.trim();
  return { ...(name ? { name } : {}), ...(instructions ? { instructions } : {}) };
}
/** The person's own instructions for a seat, marked as theirs, for the end of its brief; '' when there are none. */
export function instructionsFor(seat: SeatSettings) { return seat.instructions ? `\n\n[The person's own instructions for you at this table]\n${seat.instructions}` : ''; }
