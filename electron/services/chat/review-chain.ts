import { late, type ChainStep, type ChatEnvelope, type ChatImage, type PlanChallenge, type RoundTableState, type SavedChain } from '../../../shared/chat';
import { HubError } from '../cli/engine-adapter';
import { apply, type Finding, findingsFor, makeRoomForFinding, MAX_FINDINGS, parseAnswers, parseChallengeAnswers, parseChallenges, parseFindings, unreadLines, unreadNotice } from '../../../shared/findings';
import { allowAtFull, checkTable, checkWaiting, cut, instructionsFor, isEdit, KEEP_IMAGES, leadFirst, list, NAME, settings, type SeatInput, type TableHost } from './round-table';
import { BLOCKED_LINE, SIGNAL_INSTRUCTION, taskSignal } from '../../../shared/task-signal';
import { defaultSeatName, LEGACY_DUTIES, seatNames, type SeatDuty } from '../../../shared/table-seats';

/** Review rounds (the reviewers review, the builder fixes) before the final review, unless the table sets its own. */
export const REVIEW_ROUNDS = 2;
/** The most review rounds a table can be set to (table-rounds, table-open `rounds`). */
export const MAX_REVIEW_ROUNDS = 5;
/** Times the final reviewer can send work back to the fix step (CHANGES NEEDED) before the table stops and asks the person. */
export const FINAL_ROUNDS = 2;
const MAX_IMAGES = 10;
/**
 * The task's images go with the saved chain only within what a saved workspace accepts (savedChainSchema: MAX_IMAGES, and
 * KEEP_IMAGES of base64); beyond that they are kept only for as long as the table runs, so the workspace stays saveable.
 */
const savedImages = (images: ChatImage[]) => images.length && images.length <= MAX_IMAGES && images.reduce((sum, image) => sum + image.data.length, 0) <= KEEP_IMAGES ? { images } : {};
const MAX_CHALLENGES = 50;
/** Steps where the table waits for the person or has nothing to do. */
const RESTING: ChainStep[] = ['idle', 'plan-review', 'done', 'needs-you', 'stopped'];
/** Steps several seats take one after another (each challenger, each reviewer): the saved chain says whose turn it is. */
const TAKEN_IN_TURN: ChainStep[] = ['challenging', 'reviewing'];
/** Steps whose answers go into the review record, so the files' state is noted before them. */
const RECORDED: ChainStep[] = ['implementing', 'reviewing', 'fixing', 'final-fixing'];
const clampRounds = (rounds: number) => Math.max(1, Math.min(MAX_REVIEW_ROUNDS, Math.round(rounds)));
/** The seats of a hierarchy opened as before 1.26 (no `seats` in the request): the planner plans and gives the final review, the partner challenges and reviews. */
export const legacySeats = (partnerRunId: string, plannerRunId: string): SeatInput[] => [{ runId: plannerRunId, duties: [...LEGACY_DUTIES.planner] }, { runId: partnerRunId, duties: [...LEGACY_DUTIES.partner] }];
const sameDuties = (a: readonly SeatDuty[], b: readonly SeatDuty[]) => a.length === b.length && a.every((duty) => b.includes(duty));
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

interface Seat { runId: string; sessionId: string; engine: 'claude' | 'codex' | 'gemini'; duties: SeatDuty[]; name?: string; instructions?: string; busy: boolean; text: string; answer: string | null; briefed: boolean;
  /** Still in a turn from before this table opened (Reopen while it worked): its `done` ends that old turn, never a step. */
  stale?: boolean }
interface Chain {
  /** Every seat, the builder (the lead) first. */
  owner: number; cwd: string; builder: Seat; seats: Seat[]; rounds: number;
  step: ChainStep; stoppedAt: ChainStep | null; task: string; images: ChatImage[]; plan: string; report: string; reviewRound: number; finalRound: number;
  verdict: 'approved' | 'changes' | null; note: string; findings: Finding[];
  /** This task's challenges, and whether its plan was challenged yet (once per task). */
  challenges: PlanChallenge[]; challenged: boolean;
  queued: { text: string; images: ChatImage[] } | null; kept: boolean; turnStart: Promise<string | null> | null;
  /** The seat that said TASK BLOCKED: the person's next message is its answer, in the same step. */
  blocked: Seat | null;
  /** The seat given the latest turn: with several challengers or reviewers, whose turn the step is (Continue gives it to them again). */
  turn: Seat | null;
  /** New findings the last review reported that the full record could not take (the review then stops for the person). */
  unrecorded: number;
  /** Counts turns: a step's answer is acted on only if no newer turn began meanwhile (Stop and Continue start one). */
  attempt: number;
  /** Set while the planner writes the plan again after the final review: the final review's request ('' when none). */
  replan: string | null;
  /** Set while the planner revises a plan the person sent back: what they asked for. With replan, a plan is owed until one arrives. */
  revision: string | null;
  /** Why the message waiting could not be planned again with the task (too long, too many images): it stays until dropped. */
  held: string | null;
  /**
   * Tasks from Tasks that arrived while the table worked, in order. Each is a task of its own (tracked by its mark in the
   * chain's task), so it never joins a step or a typed message: it starts once the task before it is approved.
   */
  nextTasks: string[];
}
/** The most tasks from Tasks that wait for the table at once. */
const MAX_NEXT_TASKS = 10;
/** A message from Tasks: its prompt carries the TASK COMPLETE instruction, and Tasks sends no images. */
const fromTasks = (text: string, images: ChatImage[]) => text.includes(SIGNAL_INSTRUCTION) && !images.length;
/** The longest task a chain keeps (as saved: shared/schemas.ts chainFields): two of the longest messages, with room for the headings between them. */
const MAX_TASK = 410_000;
/** The longest message the person sends (shared/schemas.ts table-send). A task that long still has room for a follow-up as long. */
const MAX_MESSAGE = 200_000;
/** A plan or report as saved with the table (chainFields allows 200,000 characters): a seat's whole answer can be longer, which would leave the workspace unsaveable. */
const keep = (text: string) => text.length > 200_000 ? text.slice(0, 200_000) : text;
/** A reply's last non-empty line, without Markdown emphasis, quote marks or list dashes around it. */
function lastLine(answer: string) {
  const lines = answer.split(/\r?\n/).map((line) => line.trim().replace(/^[*_`>\s-]+|[*_`\s]+$/g, '')).filter(Boolean);
  // A TASK COMPLETE after the verdict (the habit a task's own instruction teaches) does not hide it.
  if (lines.length > 1 && /^TASK COMPLETE\.?$/i.test(lines.at(-1)!)) lines.pop();
  return lines.at(-1) ?? '';
}
/**
 * Whether a reviewer's reply is a review: findings, answers to earlier findings (VERIFIED, REOPENED), or NO FINDINGS on
 * the last line. Anything else (an empty reply, a question) would otherwise pass as a clean review.
 */
export function isReview(answer: string): boolean {
  return parseFindings(answer).length > 0 || parseAnswers(answer, 'reviewer').length > 0 || /^NO FINDINGS\.?$/i.test(lastLine(answer));
}
/** Whether the reviewer's reply challenges the plan: CHALLENGE lines, or NO CHALLENGES on the last line. */
export function isChallenge(answer: string): boolean { return parseChallenges(answer).length > 0 || /^NO CHALLENGES\.?$/i.test(lastLine(answer)); }
/** The planner's verdict on the last non-empty line: APPROVED, or CHANGES NEEDED: what to change. */
export function verdictOf(answer: string): { approved: true } | { approved: false; changes: string } | null {
  const last = lastLine(answer);
  if (/^APPROVED\.?$/i.test(last)) return { approved: true };
  const changes = /^CHANGES NEEDED:?\s*(.*)$/i.exec(last); return changes ? { approved: false, changes: changes[1].trim() || 'See my review above.' } : null;
}

/**
 * Hierarchy Round Tables: the person's task goes through fixed steps, each to one seat at a time. The planner (read-only)
 * writes a plan; once per task each challenger (read-only) challenges it in turn, and the planner answers each challenge
 * and writes the plan again, before the person sees it. The person approves the plan or sends it back; the builder (the
 * leading chat, the only seat that edits) implements it; each reviewer reviews in turn, as findings; the builder fixes
 * them, for up to `rounds` rounds; then the final reviewer reviews the whole and ends with APPROVED or CHANGES NEEDED.
 * Changes go back to the fix step: the builder makes them, the reviewers check them, and the final review comes again;
 * up to FINAL_ROUNDS times before the table asks the person. Challengers, reviewers and the final review are optional
 * (from 1.26): a step with nobody to take it is left out, and with no final reviewer the task is complete once built
 * and reviewed. Any seat may be Claude Code or Codex. What the person writes once the final review is reached goes back
 * to the planner, who plans again (replan); the challengers challenge that plan and the person approves it before the
 * builder starts. Trace passes each step's output to the next seat.
 */
export class ReviewChains {
  private chains = new Map<string, Chain>();
  constructor(private host: TableHost) {}

  has(leadRunId: string) { return this.chains.has(leadRunId); }
  /** Whether a run sits at a hierarchy table (as its builder or another seat). */
  isSeated(runId: string) { return this.chainOf(runId) !== null; }
  private chainOf(runId: string): Chain | null {
    const own = this.chains.get(runId); if (own) return own;
    for (const chain of this.chains.values()) if (chain.seats.some((seat) => seat.runId === runId)) return chain;
    return null;
  }
  private leading(runId: string): Chain { const chain = this.chains.get(runId); if (!chain) throw new HubError('TABLE_NONE', 'This channel has no Round Table open.'); return chain; }
  private seatOf(input: SeatInput): Seat {
    const run = this.host.run(input.runId); if (!run) throw new HubError('TABLE_RUN', 'That chat is not running.');
    // A seat still working on a turn from before (a table closed while it worked) counts as busy until that turn ends.
    return { runId: input.runId, sessionId: run.sessionId, engine: run.engine, duties: [...(input.duties ?? [])], ...settings(input), busy: run.busy === true, text: '', answer: null, briefed: false, ...(run.busy ? { stale: true } : {}) };
  }
  private busy(chain: Chain) { return chain.seats.some((seat) => seat.busy); }
  /** The seats with a duty, in seat order. checkSeats makes sure there is one planner and at most one final reviewer. */
  private having(chain: Chain, duty: SeatDuty) { return chain.seats.filter((seat) => seat.duties.includes(duty)); }
  private planner(chain: Chain) { return this.having(chain, 'plan')[0]; }
  private finalSeat(chain: Chain): Seat | null { return this.having(chain, 'final')[0] ?? null; }
  private names(chain: Chain) { const names = seatNames(chain.seats, 'hierarchy'); return new Map(chain.seats.map((seat, index) => [seat, names[index]])); }
  /**
   * How prompts and notices name a seat: "the planner" for a seat known only by what it does (no name of its own, none
   * other like it), so a table seated as before 1.26 reads as it did; its name otherwise ("Reviewer 2", "Ada").
   */
  private called(chain: Chain, seat: Seat) {
    const names = this.names(chain); const name = names.get(seat)!; const base = defaultSeatName(seat, 'hierarchy');
    return !seat.name && name === base && ![...names.values()].includes(`${base} 2`) ? `the ${base.toLowerCase()}` : name;
  }
  /** The legacy kind of a seat, for `blocked` (a Trace before 1.26 reads it). */
  private kind(chain: Chain, seat: Seat): 'planner' | 'builder' | 'reviewer' { return seat === chain.builder ? 'builder' : seat.duties.includes('plan') ? 'planner' : 'reviewer'; }
  private state(chain: Chain): RoundTableState {
    const working = !RESTING.includes(chain.step); const planner = this.planner(chain);
    // Older phones and linked computers know the reviewer as `partner` and read `planner` (typed as a Claude chat there; any engine now).
    const partner = this.having(chain, 'review')[0] ?? chain.seats.find((seat) => seat !== chain.builder)!;
    const turnStep = chain.step === 'stopped' ? chain.stoppedAt : chain.step;
    return {
      kind: 'hierarchy', seats: chain.seats.map((seat) => ({ sessionId: seat.sessionId, runId: seat.runId, engine: seat.engine, duties: [...seat.duties], ...settings(seat) })),
      partner: { sessionId: partner.sessionId, runId: partner.runId, engine: partner.engine }, planner: { sessionId: planner.sessionId, runId: planner.runId, engine: planner.engine as 'claude' },
      // The builder leads: any agent, Gemini too from 1.39.
      driver: chain.builder.engine, rounds: chain.rounds, round: chain.reviewRound, phase: working ? 'answering' : 'idle', agreed: chain.verdict === 'approved',
      findings: chain.findings.map((finding) => ({ ...finding })),
      ...(chain.step === 'stopped' && this.busy(chain) ? { stopping: true } : {}),
      chain: { step: chain.step, ...(chain.stoppedAt ? { stoppedAt: chain.stoppedAt } : {}), ...(chain.blocked ? { blocked: this.kind(chain, chain.blocked), blockedSeat: chain.blocked.sessionId } : {}), ...(chain.turn && turnStep && TAKEN_IN_TURN.includes(turnStep) ? { turnSeat: chain.turn.sessionId } : {}),
        reviewRound: chain.reviewRound, finalRound: chain.finalRound, plan: keep(chain.plan), verdict: chain.verdict, note: chain.note, task: chain.task, report: keep(chain.report),
        ...savedImages(chain.images),
        ...(chain.challenges.length ? { challenges: chain.challenges.map((challenge) => ({ ...challenge })) } : {}), ...(chain.challenged ? { challenged: true as const } : {}), ...(chain.replan !== null ? { replan: chain.replan } : {}), ...(chain.revision !== null ? { revision: chain.revision } : {}), ...(chain.held ? { held: chain.held } : {}), ...(chain.nextTasks.length ? { nextTasks: [...chain.nextTasks] } : {}) },
      ...(chain.queued ? { waiting: chain.queued.text, ...this.keptImages(chain.queued.images), ...(chain.kept ? { waitingKept: true } : {}) } : {}),
    };
  }
  /** A waiting message's images go with the saved table up to KEEP_IMAGES of base64 (as at a discussion table). */
  private keptImages(images: ChatImage[]) { if (!images.length) return {}; return images.reduce((sum, image) => sum + image.data.length, 0) <= KEEP_IMAGES ? { waitingImages: images } : { waitingImagesDropped: images.length }; }
  /** Sends the table's state to its window; `discarded`: tasks from Tasks just removed without starting (the window puts them back in To do). */
  private publish(chain: Chain, discarded?: string[]) { this.host.emit(chain.owner, { sessionId: chain.builder.sessionId, runId: chain.builder.runId, event: { type: 'table', table: this.state(chain), ...(discarded?.length ? { discarded } : {}) } }); }

  /** What a seat is told about the table, once, before its first message here. */
  private brief(chain: Chain, seat: Seat) {
    return `[Trace Round Table · hierarchy] ${this.steps(chain)} Trace passes each step's output to the next. ${this.role(chain, seat)} End each reply as your step asks. Only if you need the person first (a question, an approval, a choice that is theirs), end instead with the line ${BLOCKED_LINE} and what you need.${instructionsFor(seat)}`;
  }
  /** The steps of this table, from the seats it has; each seat's agent is named where the seat first comes up. */
  private steps(chain: Chain) {
    const named = new Set<Seat>(); const who = (seat: Seat) => { const called = this.called(chain, seat); if (named.has(seat)) return called; named.add(seat); return `${called} (${NAME[seat.engine]})`; };
    const planner = this.planner(chain); const challengers = this.having(chain, 'challenge'); const reviewers = this.having(chain, 'review'); const final = this.finalSeat(chain);
    const parts = [`${who(planner)} plans`];
    if (challengers.length) { const them = list(challengers.map(who)); parts.push(`${them} ${challengers.length === 1 ? 'challenges the plan' : 'challenge the plan one after another'} and ${who(planner)} answers`); }
    parts.push('the person approves the plan', `${who(chain.builder)} implements`);
    if (reviewers.length) { const them = list(reviewers.map(who)); parts.push(`${them} ${reviewers.length === 1 ? 'reviews' : 'review one after another'}`, `${who(chain.builder)} fixes`); }
    if (final) parts.push(`${who(final)} gives the final review`);
    return `Steps: ${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}.`;
  }
  /** What a seat does here. The builder, and seats seated as before 1.26, are told as they were then. */
  private role(chain: Chain, seat: Seat) {
    if (seat === chain.builder) return `You are ${this.identity(chain, seat, 'builder')}: the only seat that edits files. You implement the planner's plan, then fix what the reviewers find. Carry out the plan without asking again whether to proceed; ask only about choices that are the person's, or before anything that publishes, deletes or cannot be undone.`;
    const plans = seat.duties.includes('plan');
    const planNote = !plans ? '' : seat.engine === 'claude' ? ' Trace runs you in Claude\'s plan mode: write the whole plan in your reply, not in a plan file, and do not call ExitPlanMode; the person approves the plan in Trace.' : ' Write the whole plan in your reply, not in a file; the person approves the plan in Trace.';
    if (sameDuties(seat.duties, LEGACY_DUTIES.planner)) return `You are ${this.identity(chain, seat, 'planner and final reviewer')}. You do not edit files (Trace keeps you read-only). You write the plan the builder follows, and at the end you review the finished work against your plan and the review findings.${planNote}`;
    if (sameDuties(seat.duties, LEGACY_DUTIES.partner)) return `You are ${this.identity(chain, seat, 'reviewer')}. You challenge the planner's plan before the person sees it, and later review the builder's changes in the files. You do not edit files.`;
    const does = [
      ...(plans ? [`You write the plan the builder follows${this.having(chain, 'challenge').length ? ', and answer the challenges to it' : ''}.`] : []),
      ...(seat.duties.includes('challenge') ? ['You challenge the planner\'s plan before the person sees it.'] : []),
      ...(seat.duties.includes('review') ? ['You review the builder\'s changes in the files, as findings.'] : []),
      ...(seat.duties.includes('final') ? [`At the end you give the final review: the finished work against ${plans ? 'your' : 'the'} plan and the review findings.`] : []),
    ];
    return `You are ${this.called(chain, seat)}. ${does.join(' ')} You do not edit files (Trace keeps you read-only).${planNote}`;
  }
  /** "the planner", or "Ada, the planner" for a seat with a name of its own (or one of several alike). */
  private identity(chain: Chain, seat: Seat, what: string) { const called = this.called(chain, seat); return called.startsWith('the ') ? `the ${what}` : `${called}, the ${what}`; }
  /**
   * One step: a turn for one seat. A message the person sent meanwhile goes along with it; at or after the final review
   * it goes to the planner instead (replan). `hold`: the step runs without it (a blocked seat's answer), and the message
   * waits for the step after.
   */
  private turn(chain: Chain, seat: Seat, step: ChainStep, text: string, images: ChatImage[] = [], hold = false) {
    let waiting = hold ? null : this.followUp(chain);
    // A follow-up too long to join the task stops the table at this step, its request kept: once the person drops the
    // message, Continue runs the step as it would have run.
    if (waiting && late(chain, step)) { if (!this.replan(chain, null, false)) { chain.step = 'stopped'; chain.stoppedAt = step; chain.blocked = null; chain.turn = seat; this.publish(chain); } return; }
    // A plan still owed: the message joins what the planner is asked, saved (Stop, a restart or an empty answer keeps it).
    // The plain planning prompt is built again with it; a blocked planner's answer goes as it is, with the message added.
    if (waiting && step === 'planning' && this.owed(chain)) {
      const plain = text === this.planPrompt(chain); const problem = this.owe(chain, waiting.text);
      if (problem) { chain.held = `${problem} Drop the waiting message to go on.`; chain.step = 'stopped'; chain.stoppedAt = step; chain.blocked = null; chain.turn = seat; this.publish(chain); return; }
      if (plain) { text = this.planPrompt(chain); images = [...images, ...waiting.images].slice(0, MAX_IMAGES); chain.queued = null; waiting = null; }
    }
    chain.step = step; chain.stoppedAt = null; chain.attempt++; chain.held = null; chain.turn = seat;
    let extra = ''; let pictures = images;
    if (waiting) { extra = `\n\nThe person adds: ${waiting.text}`; pictures = [...images, ...waiting.images].slice(0, MAX_IMAGES); chain.queued = null; }
    seat.busy = true; seat.text = ''; seat.answer = null;
    const intro = seat.briefed ? '' : `${this.brief(chain, seat)}\n\n`; seat.briefed = true;
    // The files' state before a turn, for record(); the other steps' answers are never recorded there, so they skip the hash.
    chain.turnStart = this.host.stateOf && RECORDED.includes(step) ? this.host.stateOf(chain.cwd).catch(() => null) : null;
    this.host.send(seat.runId, `${intro}${text}${extra}`, pictures);
    this.publish(chain);
  }
  /**
   * The person wrote once the final review was reached: their message (with one still waiting, not kept) joins the task,
   * and the planner plans again from where the work stands; the challengers challenge that plan and the person approves it.
   * Checked before anything changes: `strict` (the person's own send) refuses a follow-up that is too long or has too many
   * images. Otherwise (Trace between steps) nothing changes but `held`, which says why, and it returns false: the caller
   * stops where the work was going, with its step and the final review's request kept.
   */
  private replan(chain: Chain, extra: { text: string; images: ChatImage[] } | null, strict: boolean): boolean {
    const waiting = this.followUp(chain);
    const parts = [waiting, extra].filter((part): part is { text: string; images: ChatImage[] } => part !== null);
    const text = parts.map((part) => part.text.trim()).filter(Boolean).join('\n\n'); const images = parts.flatMap((part) => part.images);
    const task = `${chain.task}\n\n[The person's follow-up after the final review]\n${text}`;
    const problem = task.length > MAX_TASK ? { code: 'TABLE_TASK_LONG', message: `The task with this follow-up would be longer than ${MAX_TASK.toLocaleString('en-US')} characters. Write a shorter follow-up, or give it as a new task once the table is done.` }
      : images.length > MAX_IMAGES ? { code: 'TABLE_IMAGES', message: `The follow-up and the message waiting would carry ${images.length} images; a message carries at most ${MAX_IMAGES}.` } : null;
    if (problem && strict) throw new HubError(problem.code, problem.message);
    if (problem) { chain.held = `${problem.message} Drop the waiting message to go on with the work as it was.`; return false; }
    // A follow-up after the final review takes the place of a revision still owed.
    chain.replan = chain.verdict === 'changes' ? chain.note : ''; chain.revision = null;
    chain.task = task; chain.images = images; chain.blocked = null; chain.held = null; if (waiting) chain.queued = null;
    chain.reviewRound = 0; chain.finalRound = 0; chain.verdict = null; chain.note = ''; chain.challenged = false; chain.challenges = [];
    // The plan, the builder's report and the findings stay: the planner plans from where the work stands.
    this.turn(chain, this.planner(chain), 'planning', this.planPrompt(chain), images);
    return true;
  }
  /** Whether the planner owes a plan: a revision the person asked for, or a re-plan after the final review. */
  private owed(chain: Chain) { return chain.revision !== null || chain.replan !== null; }
  /**
   * Adds the person's feedback to what the planner owes (the revision, or the task for a re-plan), saved with the chain.
   * Returns why not (too long), changing nothing; empty feedback changes nothing.
   */
  private owe(chain: Chain, text: string): string | null {
    if (!text.trim()) return null;
    const joined = `${chain.revision ?? chain.task}\n\n${text}`;
    if (joined.length > MAX_TASK) return `With this message, what the planner is asked would be longer than ${MAX_TASK.toLocaleString('en-US')} characters.`;
    if (chain.revision !== null) chain.revision = joined; else chain.task = joined;
    return null;
  }
  /**
   * The message the person wrote meanwhile that goes along with the next step (or into a re-plan). Not one kept from
   * before a restart (it waits for Send now), and not a task from Tasks: that is a task of its own, tracked by its mark
   * in the chain's task, so it waits and starts as the next task once this one is done (or on Send now).
   */
  private followUp(chain: Chain) { return chain.queued && !chain.kept && !fromTasks(chain.queued.text, chain.queued.images) ? chain.queued : null; }
  /** "The planner's final review", or "Your final review" when the planner gives it; null with no final reviewer. */
  private finalReview(chain: Chain, to: Seat) { const final = this.finalSeat(chain); return !final ? null : final === to ? 'Your final review' : `${capital(this.called(chain, final))}'s final review`; }
  // The prompts for each step.
  /** Built only from what the chain saves (revision, replan, task), so Continue and a restart at this step ask the same. */
  private planPrompt(chain: Chain) {
    if (chain.revision !== null) return `[Step: plan, revised] The person asks you to revise the plan:\n\n${chain.revision}\n\nWrite the whole plan again, as numbered steps, with the files to change and how to check the result. End with the line PLAN READY.`;
    if (chain.replan !== null) {
      const open = findingsFor(chain.findings, 'driver');
      return `[Step: plan again, after the final review] The person wrote after the final review; their follow-up is at the end of the task. The task:\n\n${chain.task}\n\nYour plan so far:\n\n${cut(chain.plan)}\n\nThe builder's latest report:\n\n${cut(chain.report)}\n\n${open ? `${open}\n\n` : ''}${chain.replan ? `${this.finalReview(chain, this.planner(chain)) ?? 'The final review'} asked for changes:\n\n${chain.replan}\n\n` : ''}Read what you need in the project, then write the whole plan again for what is still to do (the follow-up, and anything left from before): numbered steps, the files to change, and how to check the result. Do not change files. End with the line PLAN READY.`;
    }
    return `[Step: plan] The task:\n\n${chain.task}\n\nRead what you need in the project, then write a plan the builder can follow: numbered steps, the files to change, and how to check the result. Do not change files. End with the line PLAN READY.`;
  }
  /** A challenger after the first is shown the challenges already raised, so it does not raise them again. */
  private challengePrompt(chain: Chain, seat: Seat) {
    const earlier = this.having(chain, 'challenge').filter((other, index, all) => index < all.indexOf(seat));
    const raised = earlier.length && chain.challenges.length ? `Already raised by ${list(earlier.map((other) => this.called(chain, other)))} (do not raise these again):\n${chain.challenges.map((challenge) => `${challenge.id} (${challenge.severity}): ${challenge.text}`).join('\n')}\n\n` : '';
    return `[Step: challenge the plan] The task:\n\n${chain.task}\n\nThe planner's plan:\n\n${cut(chain.plan)}\n\n${raised}Read what you need in the project, but change nothing and write no plan of your own. Challenge the plan: requirements it misses, a simpler approach, and cases where it would fail. Report each on its own line as "CHALLENGE high|medium|low — the challenge" (Trace numbers them C1, C2, …). If you have none, end with the line NO CHALLENGES.`;
  }
  private answerPrompt(chain: Chain) {
    const challengers = this.having(chain, 'challenge'); const lines = chain.challenges.map((challenge) => `${challenge.id} (${challenge.severity}): ${challenge.text}`).join('\n');
    const who = challengers.length === 1 ? capital(this.called(chain, challengers[0])) : 'The challengers';
    return `[Step: answer the challenges] ${who} challenged your plan:\n${lines}\n\nAnswer each on its own line as "ACCEPTED C<n>" or "REJECTED C<n> — why". Then write the whole plan again, with what you accepted worked in, as numbered steps with the files to change and how to check the result. End with the line PLAN READY.`;
  }
  private buildPrompt(chain: Chain) { return `[Step: implement] The task:\n\n${chain.task}\n\nThe approved plan:\n\n${cut(chain.plan)}\n\nImplement it. When you are done, report the files you changed and how you checked the result.`; }
  /** A reviewer after the first in a round is shown the open findings, so it does not report them again. */
  private reviewPrompt(chain: Chain, seat: Seat) {
    const check = findingsFor(chain.findings, 'reviewer');
    const open = this.having(chain, 'review').indexOf(seat) > 0 ? chain.findings.filter((finding) => finding.status === 'open' && !finding.duplicateOf) : [];
    const reported = open.length ? `Open findings already in the record (do not report these again):\n${open.map((finding) => `${finding.id} (${finding.severity}${finding.evidence ? `, ${finding.evidence}` : ''}): ${finding.text}`).join('\n')}\n\n` : '';
    return `[Step: review, round ${chain.reviewRound} of ${Math.max(chain.rounds, chain.reviewRound)}] The task:\n\n${chain.task}\n\nThe plan:\n\n${cut(chain.plan)}\n\nThe builder's report:\n\n${cut(chain.report)}\n\n${check ? `${check}\n\n` : ''}${reported}Review the changes in the files. Report each problem on its own line as "FINDING high|medium|low path:line — the problem" (Trace numbers them). If you find nothing wrong, end with the line NO FINDINGS.`;
  }
  private fixPrompt(chain: Chain) {
    const open = findingsFor(chain.findings, 'driver');
    const final = chain.verdict === 'changes' && chain.note ? `${this.finalReview(chain, chain.builder) ?? 'The final review'} asks for changes:\n\n${chain.note}` : '';
    return `[Step: fix${final ? ', after the final review' : ''}] ${[final, open].filter(Boolean).join('\n\n')}\n\nThen report what you changed.`;
  }
  private finalPrompt(chain: Chain) {
    const final = this.finalSeat(chain)!; const own = final === this.planner(chain) ? 'your' : 'the'; const challengers = this.having(chain, 'challenge');
    const record = chain.findings.length ? chain.findings.map((finding) => `${finding.id} (${finding.severity}, ${finding.status}): ${finding.text}${finding.response ? ` · builder: ${finding.response}` : ''}${finding.check ? ` · reviewer: ${finding.check}` : ''}`).join('\n') : 'No findings.';
    const whose = challengers.length === 1 ? `${capital(this.called(chain, challengers[0]))}'s` : 'The';
    const challenges = chain.challenges.length ? `\n\n${whose} challenges to the plan:\n${chain.challenges.map((challenge) => `${challenge.id} (${challenge.severity}, ${challenge.answer ?? 'not answered'}): ${challenge.text}${challenge.reason ? ` · ${challenge.reason}` : ''}`).join('\n')}` : '';
    return `[Step: final review${chain.finalRound ? `, again after changes (${chain.finalRound} of ${FINAL_ROUNDS})` : ''}] The task:\n\n${chain.task}\n\n${capital(own)} plan:\n\n${cut(chain.plan)}\n\nThe builder's latest report:\n\n${cut(chain.report)}\n\nThe review record:\n${record}${challenges}\n\nCheck the finished work in the files against the task, ${own} plan and the findings. End with the line APPROVED, or CHANGES NEEDED: and what to change.`;
  }
  private finalFixPrompt(chain: Chain) { const final = this.finalSeat(chain); return `[Step: changes from the final review] ${final ? capital(this.called(chain, final)) : 'The final review'} asks for changes:\n\n${chain.note}\n\nMake them, then report what you changed.`; }

  /**
   * Seats the table led by the builder `leadRunId`: the other seats with their duties (legacySeats for a table as before
   * 1.26), and the lead's own entry if the list has it (it builds). `rounds`: review rounds, 1 to MAX_REVIEW_ROUNDS.
   */
  open(owner: number, leadRunId: string, seats: readonly SeatInput[], saved: { findings?: Finding[]; waiting?: string; waitingImages?: ChatImage[]; chain?: SavedChain; rounds?: number } = {}): RoundTableState {
    const inputs = leadFirst(leadRunId, seats, { duties: [...LEGACY_DUTIES.lead] });
    if (inputs.some((input) => this.chainOf(input.runId))) throw new HubError('TABLE_TAKEN', 'One of these chats is already at a Round Table.');
    const runs = checkTable(this.host, owner, 'hierarchy', inputs);
    const made = inputs.map((input) => this.seatOf(input)); const builder = made[0];
    const before = saved.chain;
    // A chain cut short by a restart comes back stopped at its step: Continue picks it up.
    const resumable = before && !RESTING.includes(before.step) ? before.step : null;
    const chain: Chain = { owner, cwd: runs[0].cwd, builder, seats: made, rounds: clampRounds(saved.rounds ?? REVIEW_ROUNDS), step: before ? (resumable ? 'stopped' : before.step) : 'idle', stoppedAt: resumable ?? (before?.step === 'stopped' ? before.stoppedAt ?? null : null),
      task: before?.task ?? '', images: (before?.images ?? []).slice(0, MAX_IMAGES), plan: before?.plan ?? '', report: before?.report ?? '', reviewRound: before?.reviewRound ?? 0, finalRound: before?.finalRound ?? 0, verdict: before?.verdict ?? null, note: before?.note ?? '',
      challenges: (before?.challenges ?? []).slice(0, MAX_CHALLENGES).map((challenge) => ({ ...challenge })), challenged: before?.challenged === true,
      findings: (saved.findings ?? []).slice(0, MAX_FINDINGS).map((finding) => ({ ...finding })), queued: null, kept: false, turnStart: null, blocked: null, turn: null, attempt: 0, unrecorded: 0, replan: before?.replan ?? null, revision: before?.revision ?? null, held: before?.held ?? null, nextTasks: (before?.nextTasks ?? []).slice(0, MAX_NEXT_TASKS) };
    // A seat that was waiting for the person before the restart still is: by its session (from 1.26), else by its kind.
    if (chain.step === 'stopped' && before?.blockedSeat) chain.blocked = made.find((seat) => seat.sessionId === before.blockedSeat) ?? null;
    else if (chain.step === 'stopped' && before?.blocked) chain.blocked = before.blocked === 'builder' ? builder : before.blocked === 'planner' ? this.planner(chain) : this.having(chain, 'review')[0] ?? this.having(chain, 'challenge')[0] ?? null;
    // Whose turn a challenge or review was, so Continue gives it to the same challenger or reviewer.
    if (before?.turnSeat) chain.turn = made.find((seat) => seat.sessionId === before.turnSeat) ?? null;
    if (saved.waiting !== undefined || saved.waitingImages?.length) { chain.queued = { text: saved.waiting ?? '', images: (saved.waitingImages ?? []).slice(0, MAX_IMAGES) }; chain.kept = true; }
    this.chains.set(leadRunId, chain);
    for (const seat of made) this.host.setReadOnly(seat.runId, seat !== builder);
    // A seat still at work from before is stopped; the table waits (Stopping…) until its old turn has ended.
    for (const seat of made) if (seat.stale) { try { this.host.interrupt(seat.runId); } catch { /* Ended. */ } }
    this.publish(chain); return this.state(chain);
  }

  /**
   * The table's seats from now on (each with its duties, name and instructions). Seats come and go, and duties change,
   * only between tasks (idle or done); names and instructions change at any resting step. Nobody may be at work. The
   * builder (the lead) stays. Seats that leave may edit again; every seat is told about the table again with its next turn.
   */
  setSeats(leadRunId: string, seats: readonly SeatInput[]) {
    const chain = this.leading(leadRunId);
    if (this.busy(chain)) throw new HubError('TABLE_BUSY', 'Change the seats once the agents have finished their turns: wait for them, or press Stop and wait until they have stopped.');
    if (!seats.some((seat) => seat.runId === leadRunId)) throw new HubError('TABLE_LEAD', 'The builder keeps its seat: it is the channel that shows the Round Table. Keep it in the list.');
    const inputs = leadFirst(leadRunId, seats);
    const current = new Map(chain.seats.map((seat) => [seat.runId, seat]));
    const reshaped = inputs.length !== chain.seats.length || inputs.some((input) => { const kept = current.get(input.runId); return !kept || !sameDuties(kept.duties, input.duties ?? []); });
    if (reshaped && chain.step !== 'idle' && chain.step !== 'done') throw new HubError('TABLE_STEP', 'Add or remove seats, or change what they do, between tasks: once this task is done, or before the first.');
    if (!RESTING.includes(chain.step)) throw new HubError('TABLE_STEP', 'Rename seats or change their instructions while the table waits: when it is stopped, or waits for you.');
    if (inputs.some((input) => !current.has(input.runId) && this.chainOf(input.runId))) throw new HubError('TABLE_TAKEN', 'One of these chats is already at a Round Table.');
    // The builder's run is checked with the rest, so every seat works in the table's folder.
    checkTable(this.host, chain.owner, 'hierarchy', inputs);
    const made = inputs.map((input) => current.get(input.runId) ?? this.seatOf(input));
    // Every check is done: from here nothing throws.
    made.forEach((seat, index) => { delete seat.name; delete seat.instructions; Object.assign(seat, settings(inputs[index]), { duties: [...(inputs[index].duties ?? [])] }); });
    for (const seat of chain.seats) if (!made.includes(seat)) { try { this.host.setReadOnly(seat.runId, false); } catch { /* Ended. */ } }
    chain.seats = made;
    if (chain.turn && !made.includes(chain.turn)) chain.turn = null;
    if (chain.blocked && !made.includes(chain.blocked)) chain.blocked = null;
    for (const seat of made) { this.host.setReadOnly(seat.runId, seat !== chain.builder); seat.briefed = false; if (seat.stale) { try { this.host.interrupt(seat.runId); } catch { /* Ended. */ } } }
    this.publish(chain); return this.state(chain);
  }
  /** Review rounds from now on (1 to MAX_REVIEW_ROUNDS), while the table is at rest. */
  setRounds(leadRunId: string, rounds: number) {
    const chain = this.leading(leadRunId);
    if (this.busy(chain) || !RESTING.includes(chain.step)) throw new HubError('TABLE_BUSY', 'Change the review rounds while the table waits: between tasks, while it waits for you, or once stopped.');
    chain.rounds = clampRounds(rounds); this.publish(chain); return this.state(chain);
  }

  /** The person's message: a new task when the table is free, a revision while the plan waits, otherwise it goes with the next step. */
  send(leadRunId: string, text: string, images: ChatImage[]) {
    const chain = this.leading(leadRunId);
    if (chain.kept) throw new HubError('TABLE_KEPT', 'A message from before Trace restarted is waiting. Send it or drop it first (on the Round Table bar).');
    if (chain.step === 'plan-review') { this.plan(leadRunId, false, text, images); return; }
    // A seat that asked the person (TASK BLOCKED) gets the answer and goes on with its step.
    if (chain.step === 'stopped' && chain.blocked && chain.stoppedAt && !this.busy(chain)) {
      const seat = chain.blocked; chain.blocked = null; chain.note = ''; const answer = `[The person answers] ${text}\n\nGo on with your step.`;
      // At or after the final review, a message still waiting is not this answer: it is planned again once the step ends.
      this.turn(chain, seat, chain.stoppedAt, answer, images, late(chain, chain.stoppedAt));
      return;
    }
    // A seat at work, or Trace between two steps of the same task (recording the files' state while no seat is busy): the
    // message waits for the next step. Taken as a new task, it would throw the current one away.
    if (this.busy(chain) || !RESTING.includes(chain.step)) {
      // A task from Tasks waits on its own, never merged with what the person types (that goes to the next step, or to
      // the planner after the final review): it starts once the current task is approved.
      if (fromTasks(text, images)) {
        if (chain.nextTasks.length >= MAX_NEXT_TASKS) throw new HubError('TABLE_TASKS_FULL', `${MAX_NEXT_TASKS} tasks from Tasks already wait for this Round Table. Send this one once it is done.`);
        chain.nextTasks.push(text); this.publish(chain); return;
      }
      if (chain.queued && chain.queued.images.length + images.length > MAX_IMAGES) throw new HubError('TABLE_IMAGES', `The waiting messages already have ${chain.queued.images.length} images and a message carries at most ${MAX_IMAGES}.`);
      checkWaiting(chain.queued, text);
      chain.queued = chain.queued ? { text: [chain.queued.text, text].filter(Boolean).join('\n\n'), images: [...chain.queued.images, ...images] } : { text, images };
      this.publish(chain); return;
    }
    // While the table waits for the person (stopped, or needs you), a typed reply goes on with the same task: a new task
    // starts only from idle or done, or when it comes from Tasks (its prompt carries the TASK COMPLETE instruction).
    if (chain.task && (chain.step === 'stopped' || chain.step === 'needs-you') && !text.includes(SIGNAL_INSTRUCTION)) { this.reply(chain, leadRunId, text, images); return; }
    // A new task: a fresh plan and a fresh count of rounds; the findings record goes on. A task from Tasks asks to end
    // with TASK COMPLETE, which would push each step's own last line (PLAN READY, APPROVED) aside: here the final
    // review's APPROVED completes the task, and each seat's brief says when to end with TASK BLOCKED.
    chain.task = text.replace(SIGNAL_INSTRUCTION, '').trim(); chain.images = images; chain.plan = ''; chain.report = ''; chain.reviewRound = 0; chain.finalRound = 0; chain.verdict = null; chain.note = '';
    chain.challenges = []; chain.challenged = false; chain.replan = null; chain.revision = null;
    this.turn(chain, this.planner(chain), 'planning', this.planPrompt(chain), images);
  }
  /**
   * The person's reply while the table waits for them: with no plan yet, to the planner with the task; a step stopped
   * before the final review takes it along when it continues; otherwise (the final review reached) the planner plans
   * again with it (replan), and the person approves that plan before the builder starts.
   */
  private reply(chain: Chain, leadRunId: string, text: string, images: ChatImage[]) {
    // replan runs before the note is cleared: it keeps the final review's request from it.
    const stopped = chain.step === 'stopped' && chain.stoppedAt;
    if (stopped && late(chain, chain.stoppedAt)) { this.replan(chain, { text, images }, true); return; }
    // A plan still owed (a revision or a re-plan the planner answered with nothing, or was stopped at): the reply, and a
    // message still waiting before it, join what the planner is asked, saved, before the planner is asked again.
    if (this.owed(chain) && (!stopped || chain.stoppedAt === 'planning')) {
      const waiting = this.followUp(chain); const pictures = [...(waiting?.images ?? []), ...images].slice(0, MAX_IMAGES);
      const problem = this.owe(chain, [waiting?.text ?? '', text].filter((part) => part.trim()).join('\n\n'));
      if (problem) throw new HubError('TABLE_TASK_LONG', `${problem} Write a shorter reply.`);
      chain.note = ''; if (waiting) chain.queued = null;
      if (stopped) { if (pictures.length) chain.queued = { text: '', images: pictures }; this.continue(leadRunId); }
      else this.turn(chain, this.planner(chain), 'planning', this.planPrompt(chain), pictures);
      return;
    }
    if (!stopped && chain.plan) { this.replan(chain, { text, images }, true); return; }
    chain.note = '';
    // Added to a message still waiting from before Stop, so neither is lost.
    if (stopped) {
      // A task from Tasks waiting keeps its place (it starts once this one is done); the reply goes with the step on its own.
      const task = chain.queued && !chain.kept && !this.followUp(chain) ? chain.queued : null; const waiting = this.followUp(chain);
      chain.queued = waiting ? { text: [waiting.text, text].filter(Boolean).join('\n\n'), images: [...waiting.images, ...images].slice(0, MAX_IMAGES) } : { text, images: images.slice(0, MAX_IMAGES) }; chain.kept = false;
      try { this.continue(leadRunId); } finally { if (task) { chain.queued = task; this.publish(chain); } }
      return;
    }
    this.turn(chain, this.planner(chain), 'planning', `${this.planPrompt(chain)}\n\nThe person adds: ${text}`, images);
  }
  /**
   * The person on the plan: approve it (the builder starts), or send it back with what to change. Pictures sent with the
   * change join the task's: the planner gets them now, and they go again on Continue and to the builder.
   */
  plan(leadRunId: string, approve: boolean, note = '', images: ChatImage[] = []) {
    const chain = this.leading(leadRunId);
    if (chain.step !== 'plan-review') throw new HubError('TABLE_STEP', 'There is no plan waiting for you.');
    if (this.busy(chain)) throw new HubError('TABLE_STOPPING', 'An agent is still stopping. Try again once it has stopped.');
    if (approve) this.turn(chain, chain.builder, 'implementing', this.buildPrompt(chain), chain.images);
    else {
      if (!note.trim()) throw new HubError('TABLE_NOTE', 'Say what to change in the plan.');
      if (note.length > MAX_MESSAGE) throw new HubError('TABLE_NOTE_LONG', `Say what to change in fewer than ${MAX_MESSAGE.toLocaleString('en-US')} characters.`);
      if (chain.images.length + images.length > MAX_IMAGES) throw new HubError('TABLE_IMAGES', `This task already has ${chain.images.length} images and a message carries at most ${MAX_IMAGES}. ${chain.images.length >= MAX_IMAGES ? 'Send the change without pictures.' : `Send at most ${MAX_IMAGES - chain.images.length} ${MAX_IMAGES - chain.images.length === 1 ? 'picture' : 'pictures'} with the change.`}`);
      // Saved with the chain until a plan arrives: Stop, a restart or an empty answer does not lose it.
      chain.revision = note; chain.images = [...chain.images, ...images]; this.turn(chain, this.planner(chain), 'planning', this.planPrompt(chain), images);
    }
    return this.state(chain);
  }
  /**
   * Picks a stopped chain up at its step (after Stop, or a restart), with the seat whose turn it was. `skipChallenge`:
   * the rest of a stopped challenge is left out (challenges already raised are still answered).
   */
  continue(leadRunId: string, skipChallenge = false) {
    const chain = this.leading(leadRunId); const step = chain.stoppedAt;
    if (chain.step !== 'stopped' || !step) throw new HubError('TABLE_STEP', 'Nothing was stopped part way.');
    // A stopped seat's turn ends with a late `done`; a new turn begun before it would take that `done` as its own end.
    if (this.busy(chain)) throw new HubError('TABLE_STOPPING', 'The agent is still stopping. Continue once it has stopped.');
    if (skipChallenge && step !== 'challenging') throw new HubError('TABLE_STEP', 'Only a stopped challenge can be left out.');
    chain.blocked = null;
    if (skipChallenge) {
      chain.challenged = true; chain.stoppedAt = null; chain.turn = null;
      if (chain.challenges.length) { this.turn(chain, this.planner(chain), 'plan-responding', this.answerPrompt(chain)); return this.state(chain); }
      chain.step = chain.plan ? 'plan-review' : 'needs-you'; chain.note = 'The challenge was left out at your request.'; this.publish(chain); return this.state(chain);
    }
    const inTurn = (duty: SeatDuty) => { const seats = this.having(chain, duty); return chain.turn && seats.includes(chain.turn) ? chain.turn : seats[0]; };
    if (step === 'planning') this.turn(chain, this.planner(chain), 'planning', this.planPrompt(chain), chain.images);
    else if (step === 'challenging') { const seat = inTurn('challenge'); if (seat) this.turn(chain, seat, 'challenging', this.challengePrompt(chain, seat)); else this.afterChallenges(chain); }
    else if (step === 'plan-responding') this.turn(chain, this.planner(chain), 'plan-responding', this.answerPrompt(chain));
    else if (step === 'implementing') this.turn(chain, chain.builder, 'implementing', this.buildPrompt(chain), chain.images);
    else if (step === 'reviewing') { const seat = inTurn('review'); if (seat) this.turn(chain, seat, 'reviewing', this.reviewPrompt(chain, seat)); else this.toFinal(chain); }
    else if (step === 'fixing') this.turn(chain, chain.builder, 'fixing', this.fixPrompt(chain));
    else if (step === 'final') this.toFinal(chain);
    else if (step === 'final-fixing') this.turn(chain, chain.builder, 'final-fixing', this.finalFixPrompt(chain));
    return this.state(chain);
  }
  waiting(leadRunId: string, send: boolean) {
    const chain = this.leading(leadRunId); if (!chain.queued) return this.state(chain);
    const { kept, held } = chain; chain.kept = false; chain.held = null;
    if (!send) {
      chain.queued = null;
      // Dropped once the work was approved: the tasks from Tasks it held back start, in order.
      if (!this.busy(chain) && chain.step === 'done' && chain.nextTasks.length) { this.send(leadRunId, chain.nextTasks.shift()!, []); return this.state(chain); }
    }
    else if (!this.busy(chain) && (chain.step === 'idle' || chain.step === 'done' || chain.step === 'needs-you')) {
      // Taken from the queue only for send() (which would otherwise add it twice); put back as it was if send refuses it.
      const queued = chain.queued; chain.queued = null;
      try { this.send(leadRunId, queued.text, queued.images); } catch (error) { chain.queued = queued; chain.kept = kept; chain.held = held; this.publish(chain); throw error; }
      return this.state(chain);
    }
    // The table is at work: a task from Tasks kept from before a restart joins the tasks waiting their turn.
    else if (fromTasks(chain.queued.text, chain.queued.images) && chain.nextTasks.length < MAX_NEXT_TASKS) { chain.nextTasks.push(chain.queued.text); chain.queued = null; }
    this.publish(chain); return this.state(chain);
  }
  /** Stops the seat at work; the chain waits at its step for Continue. */
  stop(leadRunId: string) {
    // A message the person already sent stays: it goes with the step when it continues (it was shown as sent).
    const chain = this.leading(leadRunId); chain.blocked = null;
    if (!RESTING.includes(chain.step)) { chain.stoppedAt = chain.step; chain.step = 'stopped'; }
    for (const seat of chain.seats) if (seat.busy) this.host.interrupt(seat.runId);
    this.publish(chain);
  }
  /**
   * Removes a task from Tasks waiting its turn: the one at `index`, only if it still starts with `head` (what the person
   * saw), so a task that started meanwhile is never taken for the next one. The window puts it back in To do.
   */
  dropNext(leadRunId: string, index: number, head: string) {
    const chain = this.leading(leadRunId); const task = chain.nextTasks[index];
    if (!head || task === undefined || !task.startsWith(head)) throw new HubError('TABLE_STEP', 'That task is no longer waiting: it has started, or was removed.');
    chain.nextTasks.splice(index, 1); this.publish(chain, [task]); return this.state(chain);
  }
  close(leadRunId: string, byPerson = true) {
    const chain = this.chains.get(leadRunId); if (!chain) return;
    this.chains.delete(leadRunId);
    for (const seat of chain.seats) { try { this.host.setReadOnly(seat.runId, false); } catch { /* Ended. */ } }
    // Closed by the person: the tasks from Tasks still waiting go back to To do. A seat that ended keeps them with the
    // saved table, for Reopen.
    const discarded = byPerson && chain.nextTasks.length ? [...chain.nextTasks] : null;
    this.host.emit(chain.owner, { sessionId: chain.builder.sessionId, runId: chain.builder.runId, event: { type: 'table', table: null, ...(byPerson ? { closed: true as const } : {}), ...(discarded ? { discarded } : {}) } });
  }
  /**
   * A seat's process ended: the table closes until the window seats it again. The seats still at work are stopped first:
   * nothing goes on working for a table that is no longer there.
   */
  ended(runId: string) {
    const chain = this.chainOf(runId); if (!chain) return;
    for (const seat of chain.seats) if (seat.busy && seat.runId !== runId) { try { this.host.interrupt(seat.runId); } catch { /* Ended. */ } }
    this.close(chain.builder.runId, false);
  }

  /** Every chat event passes here; returns a notice in place of an edit a read-only seat asked for (declined), or '' for a command allowed at Full. */
  observe(envelope: ChatEnvelope): string | null {
    const { runId, event } = envelope; const chain = this.chainOf(runId); if (!chain) return null;
    const seat = chain.seats.find((item) => item.runId === runId)!;
    if (event.type === 'assistant') { const words = event.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n'); if (words) seat.text = seat.text ? `${seat.text}\n${words}` : words; return null; }
    if (event.type === 'permission' && seat !== chain.builder && isEdit(event)) {
      this.host.answer(runId, event.requestId, false);
      return `Trace declined ${event.toolName} for ${this.called(chain, seat)}: only ${this.called(chain, chain.builder)} edits files.`;
    }
    // At Full access a read-only seat's commands run without an approval card, as the person's level says.
    if (event.type === 'permission' && seat !== chain.builder && allowAtFull(this.host, runId, event.requestId)) return '';
    if (event.type !== 'done' || !seat.busy) return null;
    // The end of a turn from before this table opened: the seat is free now, and no step moves on it.
    // What was queued while it was busy starts now if the table is free.
    if (seat.stale) { seat.busy = false; seat.stale = false; seat.text = ''; this.publish(chain); if (!this.busy(chain) && (chain.step === 'idle' || chain.step === 'done')) this.startWaiting(chain); return null; }
    seat.busy = false; seat.answer = seat.text.trim(); seat.text = '';
    this.finished(chain, seat, event);
    return null;
  }
  /** A seat's turn ended: an error or a stop leaves the chain stopped at its step; otherwise the next step. */
  private finished(chain: Chain, seat: Seat, event: { isError: boolean; error: string | null }) {
    if (event.isError || chain.step === 'stopped' || chain.step === 'needs-you') { if (chain.step !== 'stopped') { chain.stoppedAt = chain.step; chain.step = 'stopped'; chain.note = event.error ?? 'The agent stopped with an error.'; } this.publish(chain); return; }
    void this.advance(chain, seat).catch((error: unknown) => { chain.stoppedAt = chain.step; chain.step = 'stopped'; chain.note = `Trace could not finish this step (${error instanceof Error ? error.message : String(error)}). Continue tries it again.`; this.publish(chain); });
  }
  /** A seat finished its step: record what it said, then the next step. */
  private async advance(chain: Chain, seat: Seat) {
    const answer = seat.answer ?? ''; const who = capital(this.called(chain, seat));
    // A seat that needs the person stops the chain at its step; the person's answer goes back to it (send).
    const signal = taskSignal(answer);
    if (signal?.kind === 'blocked') { chain.stoppedAt = chain.step; chain.step = 'stopped'; chain.blocked = seat; chain.note = `${who} needs you: ${signal.reason}`; this.publish(chain); return; }
    const step = chain.step; const attempt = chain.attempt;
    // Reads into the record, then goes on only if this is still the same turn: Stop, or Stop then Continue (a new turn at
    // the same step), while the files' state was being taken leaves the old answer behind.
    const recorded = async () => { await this.record(chain, seat, step); return this.chains.get(chain.builder.runId) === chain && chain.step === step && chain.attempt === attempt; };
    if (chain.step === 'planning') {
      // An empty answer keeps everything as it was (the plan before, and the revision or re-plan still owed), for the person's reply.
      const plan = answer.replace(/\n?\s*PLAN READY\s*$/i, '').trim();
      if (!plan) { chain.step = 'needs-you'; chain.note = `${who} wrote no plan.`; this.publish(chain); return; }
      chain.plan = plan; chain.note = ''; chain.replan = null; chain.revision = null;
      // Once per task the challengers challenge the plan before the person sees it; a revised plan is not challenged again.
      const first = this.having(chain, 'challenge')[0];
      if (!chain.challenged && first) { this.turn(chain, first, 'challenging', this.challengePrompt(chain, first)); return; }
      chain.step = 'plan-review'; this.publish(chain); return;
    }
    if (chain.step === 'challenging') {
      if (!isChallenge(answer)) { chain.stoppedAt = 'challenging'; chain.step = 'stopped'; chain.note = `${who} ended without CHALLENGE lines or NO CHALLENGES. Continue runs the challenge again, or Continue without the challenge.`; this.publish(chain); return; }
      // Challenges are numbered on across the challengers (C1, C2, … then C3, …); the first starts the list afresh.
      const challengers = this.having(chain, 'challenge'); const index = challengers.indexOf(seat); if (index <= 0) chain.challenges = [];
      const start = chain.challenges.length;
      chain.challenges.push(...parseChallenges(answer).slice(0, MAX_CHALLENGES - start).map((challenge, at) => ({ id: `C${start + at + 1}`, ...challenge })));
      const next = index >= 0 ? challengers[index + 1] : undefined;
      if (next) { this.turn(chain, next, 'challenging', this.challengePrompt(chain, next)); return; }
      this.afterChallenges(chain); return;
    }
    if (chain.step === 'plan-responding') {
      for (const { id, answer: verdict, reason } of parseChallengeAnswers(answer)) { const challenge = chain.challenges.find((item) => item.id === id); if (challenge) { challenge.answer = verdict; challenge.reason = reason; } }
      // The plan is what is left once the answers to the challenges (shown with them) and PLAN READY are taken out.
      const plan = answer.split(/\r?\n/).filter((line) => !parseChallengeAnswers(line).length).join('\n').replace(/\n?\s*PLAN READY\s*$/i, '').trim();
      if (plan) chain.plan = plan; else chain.note = `${who} answered the challenges without writing the plan again; this is its plan from before them.`;
      chain.step = 'plan-review'; this.publish(chain); return;
    }
    if (chain.step === 'implementing' || chain.step === 'final-fixing') {
      chain.report = answer || chain.report; if (!await recorded()) return;
      if (chain.step === 'final-fixing') { this.toFinal(chain); return; }
      const first = this.having(chain, 'review')[0]; if (!first) { this.toFinal(chain); return; }
      chain.reviewRound = 1;
      this.turn(chain, first, 'reviewing', this.reviewPrompt(chain, first)); return;
    }
    if (chain.step === 'reviewing') {
      if (!isReview(answer)) { chain.stoppedAt = 'reviewing'; chain.step = 'stopped'; chain.note = `${who} ended without findings or NO FINDINGS. Continue runs the review again.`; this.publish(chain); return; }
      if (!await recorded()) return;
      if (chain.unrecorded) { const count = chain.unrecorded; chain.unrecorded = 0; chain.step = 'needs-you'; chain.note = `The review record is full (${MAX_FINDINGS} findings, none verified), so ${count} new ${count === 1 ? 'finding' : 'findings'} from this review could not be recorded. Close the table to save the record to shared memory, then open it again and give the task again.`; this.publish(chain); return; }
      // The reviewers of a round take it one after another; the round ends with the last of them.
      const reviewers = this.having(chain, 'review'); const index = reviewers.indexOf(seat); const next = index >= 0 ? reviewers[index + 1] : undefined;
      if (next) { this.turn(chain, next, 'reviewing', this.reviewPrompt(chain, next)); return; }
      this.afterReview(chain); return;
    }
    if (chain.step === 'fixing') {
      chain.report = answer || chain.report; if (!await recorded()) return;
      // The final review's changes are done once the builder has had its turn at them.
      if (chain.verdict === 'changes') { chain.verdict = null; chain.note = ''; }
      const first = this.having(chain, 'review')[0];
      if (first && chain.reviewRound < chain.rounds) { chain.reviewRound++; this.turn(chain, first, 'reviewing', this.reviewPrompt(chain, first)); return; }
      this.toFinal(chain); return;
    }
    if (chain.step === 'final') {
      const verdict = verdictOf(answer);
      // A message the person wrote during the final review (not one kept from before a restart, nor a task from Tasks).
      const followUp = this.followUp(chain) !== null;
      if (verdict?.approved) { this.complete(chain); return; }
      // A follow-up too long to plan again with the task (held says why) stops the table at the final review, its verdict
      // and note kept: once the person drops the message, Continue runs the final review again.
      const heldAtFinal = () => { chain.step = 'stopped'; chain.stoppedAt = 'final'; chain.blocked = null; this.publish(chain); };
      if (!verdict) { if (followUp) { if (!this.replan(chain, null, false)) heldAtFinal(); return; } chain.step = 'needs-you'; chain.note = `${who} ended its final review without APPROVED or CHANGES NEEDED.`; this.publish(chain); return; }
      chain.verdict = 'changes'; chain.note = verdict.changes;
      if (chain.finalRound >= FINAL_ROUNDS && followUp) { if (!this.replan(chain, null, false)) heldAtFinal(); return; }
      if (chain.finalRound >= FINAL_ROUNDS) { chain.step = 'needs-you'; chain.note = `${who} still asks for changes after ${FINAL_ROUNDS} rounds: ${verdict.changes}`; this.publish(chain); return; }
      // Back to the fix step: the builder makes the changes, the reviewers check them once more, then the final review again.
      // With a message from the person waiting, turn() sends it all to the planner instead (replan).
      chain.finalRound++; chain.reviewRound = chain.rounds - 1; this.turn(chain, chain.builder, 'fixing', this.fixPrompt(chain)); return;
    }
    this.publish(chain);
  }
  /** The challenges are in: the planner answers them, or with none the person sees the plan. */
  private afterChallenges(chain: Chain) {
    chain.challenged = true;
    if (chain.challenges.length) { this.turn(chain, this.planner(chain), 'plan-responding', this.answerPrompt(chain)); return; }
    chain.step = 'plan-review'; this.publish(chain);
  }
  /** The final review, or with no final reviewer at this table the task is complete as if it had been approved. */
  private toFinal(chain: Chain) {
    const final = this.finalSeat(chain);
    if (final) { this.turn(chain, final, 'final', this.finalPrompt(chain)); return; }
    this.complete(chain);
  }
  /** This task is done (Tasks moves it on). Next: a message the person wrote meanwhile, then the tasks from Tasks in order, one per approval. */
  private complete(chain: Chain) {
    chain.verdict = 'approved'; chain.step = 'done'; chain.note = ''; chain.held = null; chain.turn = null; this.publish(chain);
    this.startWaiting(chain);
  }
  /** What waits for a free table starts: the person's message, else the first task from Tasks. A message kept from before a restart still waits for Send now. */
  private startWaiting(chain: Chain) {
    if (chain.queued && !chain.kept) { const { text, images } = chain.queued; chain.queued = null; this.send(chain.builder.runId, text, images); }
    else if (!chain.queued && chain.nextTasks.length) this.send(chain.builder.runId, chain.nextTasks.shift()!, []);
  }
  /** After a review: the builder fixes what is open (a duplicate in a record from 1.20 is not), or the final review comes. */
  private afterReview(chain: Chain) {
    if (chain.findings.some((finding) => finding.status === 'open' && !finding.duplicateOf)) { this.turn(chain, chain.builder, 'fixing', this.fixPrompt(chain)); return; }
    this.toFinal(chain);
  }
  /**
   * Reads a seat's answer into the review record, by the step it answered: at a review, new findings and checks; the
   * builder's FIXED/DECLINED at implementing and fixing. Notes the files' state. Other steps' answers are not recorded.
   */
  private async record(chain: Chain, seat: Seat, step: ChainStep) {
    const role = step === 'reviewing' ? 'reviewer' : seat === chain.builder && (step === 'implementing' || step === 'fixing' || step === 'final-fixing') ? 'driver' : null;
    if (!role) return;
    const changed: Finding[] = []; const at = new Date().toISOString(); const answer = seat.answer ?? '';
    if (role === 'reviewer') for (const found of parseFindings(answer)) {
      const id = makeRoomForFinding(chain.findings); if (!id) { chain.unrecorded++; continue; }
      const finding: Finding = { id, ...found, status: 'open', response: '', check: '', reviewedAt: null, changedAt: null, round: Math.min(5, chain.reviewRound), at };
      chain.findings.push(finding); changed.push(finding);
    }
    for (const { id, verb, note } of parseAnswers(answer, role)) { const finding = chain.findings.find((item) => item.id === id); if (finding && !finding.duplicateOf && apply(finding, verb, note) && !changed.includes(finding)) changed.push(finding); }
    // A line that looks like a review line but could not be read is named, rather than left out of the record without a word.
    const unread = unreadNotice(unreadLines(answer, role)); if (unread) this.host.emit(chain.owner, { sessionId: chain.builder.sessionId, runId: chain.builder.runId, event: { type: 'notice', text: unread } });
    if (!changed.length || !this.host.stateOf) return;
    const [before, after] = await Promise.all([chain.turnStart ?? Promise.resolve(null), this.host.stateOf(chain.cwd).catch(() => null)]);
    const short = after ? after.slice(0, 12) : null; const moved = before !== null && after !== null && before !== after;
    for (const finding of changed) { if (finding.status === 'open' && !finding.reviewedAt) { finding.reviewedAt = short; if (moved && role === 'reviewer') finding.filesChanged = true; } else finding.changedAt = short; }
  }
}
