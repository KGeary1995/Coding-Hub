import type { ChatEnvelope, ChatEvent, ChatImage, RoundTableState } from '../../../shared/chat';
import { HubError } from '../cli/engine-adapter';

type Engine = 'claude' | 'codex';
/** What the coordinator needs from the run manager: chat runs it can read about and write to on the person's behalf. */
export interface TableHost {
  run(runId: string): { sessionId: string; engine: Engine; cwd: string; owner: number } | null;
  send(runId: string, text: string, images: ChatImage[]): void;
  setReadOnly(runId: string, readOnly: boolean): void;
  answer(runId: string, requestId: string, allow: boolean): void;
  interrupt(runId: string): void;
  emit(owner: number, envelope: ChatEnvelope): void;
}

const NAME: Record<Engine, string> = { claude: 'Claude Code', codex: 'Codex' };
/** The longest answer passed to the other agent; more is cut, and the agent is told so. */
const RELAY_LIMIT = 12_000;
/** Messages kept per chat run, so a newcomer gets the recent ones word for word. */
const RECENT = 8;
/** Tools a reviewer never gets to use: file edits, and leaving Claude's plan mode. */
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode', 'File changes']);
/** An answer saying the agent agrees and has nothing to add. */
const AGREES = /^\s*\**AGREE\**\s*[.!]?\s*$/i;

interface Seat { runId: string; sessionId: string; engine: Engine; busy: boolean; text: string; answer: string | null; briefed: boolean }
interface Table {
  owner: number; lead: Seat; partner: Seat; driver: Engine; rounds: number; round: number;
  phase: RoundTableState['phase']; agreed: boolean;
  /** A message the person sent while the agents were still busy: sent once both have stopped. */
  queued: { text: string; images: ChatImage[] } | null;
  /** The newest messages of the leading conversation, for the newcomer's brief. */
  recent: string[];
}

/**
 * Round Tables: the person, Claude Code and Codex in one conversation. Each table is led by the chat run it was opened
 * on and seats a partner chat run of the other engine in the same folder. Trace passes messages between them: the
 * person's go to both; when both have answered, each gets the other's answer, for up to `rounds` rounds or until both
 * say AGREE. The driver may edit files; the reviewer is read-only, and Trace declines any edit it still asks for.
 */
export class RoundTables {
  private tables = new Map<string, Table>();
  /** Recent messages of every chat run, by run id; a table's newcomer is briefed from them. */
  private recent = new Map<string, string[]>();
  constructor(private host: TableHost) {}

  /** The table a run sits at, as its leading run id. */
  private tableOf(runId: string): Table | null {
    const own = this.tables.get(runId); if (own) return own;
    for (const table of this.tables.values()) if (table.partner.runId === runId) return table;
    return null;
  }
  private leading(runId: string): Table {
    const table = this.tables.get(runId);
    if (!table) throw new HubError('TABLE_NONE', 'This channel has no Round Table open.');
    return table;
  }
  private seat(runId: string): Seat {
    const run = this.host.run(runId); if (!run) throw new HubError('TABLE_RUN', 'That chat is not running.');
    return { runId, sessionId: run.sessionId, engine: run.engine, busy: false, text: '', answer: null, briefed: false };
  }
  private state(table: Table): RoundTableState {
    return { partner: { sessionId: table.partner.sessionId, runId: table.partner.runId, engine: table.partner.engine }, driver: table.driver, rounds: table.rounds, round: table.round, phase: table.phase, agreed: table.agreed };
  }
  private publish(table: Table) { this.host.emit(table.owner, { sessionId: table.lead.sessionId, runId: table.lead.runId, event: { type: 'table', table: this.state(table) } }); }
  private roles(table: Table) {
    for (const seat of [table.lead, table.partner]) this.host.setReadOnly(seat.runId, seat.engine !== table.driver);
  }
  private other(table: Table, seat: Seat) { return seat === table.lead ? table.partner : table.lead; }

  /** What an agent is told about the table, once, before its first message here. */
  private brief(table: Table, seat: Seat) {
    const other = NAME[this.other(table, seat).engine];
    const role = seat.engine === table.driver
      ? `You are the driver: you make the file changes.`
      : `You are the reviewer: read files and check the driver's work, but do not edit files (Trace keeps you read-only).`;
    return `[Trace Round Table] You are in one conversation with the person and ${other}. Trace passes each of you what the other says. ${role} When Trace shows you ${other}'s answer, reply to it briefly: agree, disagree or add what is missing. If you fully agree and have nothing to add, reply with exactly AGREE.`;
  }

  open(owner: number, leadRunId: string, partnerRunId: string, driver: Engine, rounds: number): RoundTableState {
    if (this.tableOf(leadRunId) || this.tableOf(partnerRunId)) throw new HubError('TABLE_TAKEN', 'One of these chats is already at a Round Table.');
    const lead = this.seat(leadRunId); const partner = this.seat(partnerRunId);
    const leadRun = this.host.run(leadRunId)!; const partnerRun = this.host.run(partnerRunId)!;
    if (lead.engine === partner.engine) throw new HubError('TABLE_ENGINES', 'A Round Table seats Claude Code and Codex: add the other agent.');
    if (leadRun.cwd !== partnerRun.cwd) throw new HubError('TABLE_FOLDER', 'Both agents must work in the same folder.');
    if (leadRun.owner !== owner || partnerRun.owner !== owner) throw new HubError('TABLE_OWNER', 'Both chats must be open in this window.');
    const table: Table = { owner, lead, partner, driver, rounds: Math.max(0, Math.min(5, rounds)), round: 0, phase: 'idle', agreed: false, queued: null, recent: [...(this.recent.get(leadRunId) ?? [])] };
    this.tables.set(leadRunId, table); this.roles(table);
    // A conversation already under way: the leading agent sums it up, and the newcomer gets that plus the latest messages.
    if (table.recent.length) {
      table.phase = 'joining'; lead.busy = true; lead.text = '';
      this.host.send(lead.runId, `${this.brief(table, lead)}\n\n${NAME[partner.engine]} is joining now. Write a short summary of this conversation for it: the goal, what was decided, the current state and open questions. Reply with only the summary.`, []);
      lead.briefed = true;
    }
    this.publish(table);
    return this.state(table);
  }

  /** The person's message: to both agents. If they are still busy, both stop first and it follows. */
  send(leadRunId: string, text: string, images: ChatImage[]) {
    const table = this.leading(leadRunId);
    if (table.lead.busy || table.partner.busy) { table.queued = { text, images }; for (const seat of [table.lead, table.partner]) if (seat.busy) this.host.interrupt(seat.runId); return; }
    this.ask(table, text, images);
  }
  private ask(table: Table, text: string, images: ChatImage[]) {
    table.round = 0; table.agreed = false; table.phase = 'answering';
    // The person's messages reach the agents from here, not from the window, so they are remembered here.
    for (const seat of [table.lead, table.partner]) this.remember(seat.runId, { type: 'user', text, images: images.length });
    for (const seat of [table.lead, table.partner]) {
      seat.busy = true; seat.text = ''; seat.answer = null;
      const intro = seat.briefed ? '' : `${this.brief(table, seat)}\n\n`; seat.briefed = true;
      this.host.send(seat.runId, `${intro}${text}`, images);
    }
    this.publish(table);
  }

  setDriver(leadRunId: string, driver: Engine) {
    const table = this.leading(leadRunId); if (table.driver === driver) return this.state(table);
    table.driver = driver; this.roles(table);
    // Each agent hears about the change with its next message.
    for (const seat of [table.lead, table.partner]) seat.briefed = false;
    this.publish(table); return this.state(table);
  }
  setRounds(leadRunId: string, rounds: number) { const table = this.leading(leadRunId); table.rounds = Math.max(0, Math.min(5, rounds)); this.publish(table); return this.state(table); }

  /** Stops both agents and ends the discussion; the table stays. */
  stop(leadRunId: string) {
    const table = this.leading(leadRunId); table.queued = null; table.round = table.rounds;
    for (const seat of [table.lead, table.partner]) if (seat.busy) this.host.interrupt(seat.runId);
    table.phase = table.lead.busy || table.partner.busy ? table.phase : 'idle'; this.publish(table);
  }

  /** `byPerson`: closed on request (not because a run ended), which the window takes as forgetting the table. */
  close(leadRunId: string, byPerson = true) {
    const table = this.tables.get(leadRunId); if (!table) return;
    this.tables.delete(leadRunId);
    // Both may edit again, as ordinary chats.
    for (const seat of [table.lead, table.partner]) { try { this.host.setReadOnly(seat.runId, false); } catch { /* Ended. */ } }
    this.host.emit(table.owner, { sessionId: table.lead.sessionId, runId: table.lead.runId, event: { type: 'table', table: null, ...(byPerson ? { closed: true as const } : {}) } });
  }
  /** A chat run ended: its table closes for now (the window seats both again once both run). */
  ended(runId: string) {
    this.recent.delete(runId);
    const table = this.tableOf(runId); if (table) this.close(table.lead.runId, false);
  }

  /**
   * Every chat event passes here before it reaches the window. Returns a notice to show in place of an approval the
   * reviewer asked for and Trace declined (an edit, or leaving plan mode), so no approval card or alert appears for it.
   */
  observe(envelope: ChatEnvelope): string | null {
    const { runId, event } = envelope;
    this.remember(runId, event);
    const table = this.tableOf(runId); if (!table) return null;
    const seat = table.lead.runId === runId ? table.lead : table.partner;
    if (event.type === 'assistant') { const words = event.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n'); if (words) seat.text = seat.text ? `${seat.text}\n${words}` : words; return null; }
    if (event.type === 'permission' && seat.engine !== table.driver && EDITS.has(event.toolName)) {
      this.host.answer(runId, event.requestId, false);
      return `Trace declined ${event.toolName} for ${NAME[seat.engine]}: the reviewer does not edit files. Swap the driver to let it.`;
    }
    if (event.type !== 'done' || !seat.busy) return null;
    seat.busy = false; seat.answer = seat.text.trim(); seat.text = '';
    this.settle(table, seat);
    return null;
  }

  private settle(table: Table, seat: Seat) {
    if (table.lead.busy || table.partner.busy) { this.publish(table); return; }
    if (table.queued) { const { text, images } = table.queued; table.queued = null; this.ask(table, text, images); return; }
    if (table.phase === 'joining') {
      const summary = seat.answer || '(no summary)';
      const recent = table.recent.slice(-RECENT).join('\n\n');
      table.partner.briefed = true; table.partner.busy = true; table.phase = 'answering'; table.round = table.rounds;
      this.host.send(table.partner.runId, `${this.brief(table, table.partner)}\n\nYou are joining a conversation already under way. ${NAME[table.lead.engine]}'s summary:\n\n${summary}\n\nThe latest messages:\n\n${recent}\n\nSay briefly that you are caught up and anything you would add. Wait for the person's next message before changing anything.`, []);
      this.publish(table); return;
    }
    const answers = [table.lead.answer ?? '', table.partner.answer ?? ''];
    table.agreed = table.round > 0 && answers.every((answer) => AGREES.test(answer));
    if (table.agreed || table.round >= table.rounds || answers.every((answer) => !answer)) { table.phase = 'idle'; this.publish(table); return; }
    table.round++; table.phase = 'discussing';
    // Both answers are read before either seat starts its next turn (which clears its answer).
    const given = new Map([[table.lead, table.lead.answer], [table.partner, table.partner.answer]]);
    for (const each of [table.lead, table.partner]) {
      const other = this.other(table, each); let answer = given.get(other) || '(no answer)';
      if (answer.length > RELAY_LIMIT) answer = `${answer.slice(0, RELAY_LIMIT)}\n[… shortened by Trace]`;
      if (AGREES.test(answer)) answer = 'AGREE (nothing to add)';
      const intro = each.briefed ? '' : `${this.brief(table, each)}\n\n`; each.briefed = true;
      each.busy = true; each.answer = null; each.text = '';
      this.host.send(each.runId, `${intro}[Trace Round Table · round ${table.round} of ${table.rounds}] ${NAME[other.engine]} answered:\n\n${answer}\n\nReply briefly: agree, disagree or add what is missing. If you fully agree and have nothing to add, reply with exactly AGREE.`, []);
    }
    this.publish(table);
  }

  private remember(runId: string, event: ChatEvent) {
    const line = event.type === 'user' ? `The person: ${event.text}` : event.type === 'assistant' ? event.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n') : '';
    if (!line.trim()) return;
    const run = this.host.run(runId); const who = event.type === 'user' ? '' : `${run ? NAME[run.engine] : 'Agent'}: `;
    const list = this.recent.get(runId) ?? []; list.push(`${who}${line.slice(0, 2000)}`); if (list.length > RECENT * 2) list.splice(0, list.length - RECENT * 2);
    this.recent.set(runId, list);
  }
}
