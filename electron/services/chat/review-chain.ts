import { late, type ChainStep, type ChatEnvelope, type ChatImage, type PlanChallenge, type RoundTableState, type SavedChain } from '../../../shared/chat';
import { HubError } from '../cli/engine-adapter';
import { apply, type Finding, findingsFor, makeRoomForFinding, MAX_FINDINGS, parseAnswers, parseChallengeAnswers, parseChallenges, parseFindings, unreadLines, unreadNotice } from '../../../shared/findings';
import { allowAtFull, checkWaiting, isEdit, KEEP_IMAGES, type TableHost } from './round-table';
import { BLOCKED_LINE, SIGNAL_INSTRUCTION, taskSignal } from '../../../shared/task-signal';

/** Review rounds (Codex reviews, Opus fixes) before the planner's final review. */
export const REVIEW_ROUNDS = 2;
/** Times the planner can send work back to the fix step (CHANGES NEEDED) before the table stops and asks the person. */
export const FINAL_ROUNDS = 2;
/** The longest earlier output passed into a prompt; more is cut, and the agent is told so. */
const RELAY_LIMIT = 12_000;
const MAX_IMAGES = 10;
/**
 * The task's images go with the saved chain only within what a saved workspace accepts (savedChainSchema: MAX_IMAGES, and
 * KEEP_IMAGES of base64); beyond that they are kept only for as long as the table runs, so the workspace stays saveable.
 */
const savedImages = (images: ChatImage[]) => images.length && images.length <= MAX_IMAGES && images.reduce((sum, image) => sum + image.data.length, 0) <= KEEP_IMAGES ? { images } : {};
const MAX_CHALLENGES = 50;
/** Steps where the table waits for the person or has nothing to do. */
const RESTING: ChainStep[] = ['idle', 'plan-review', 'done', 'needs-you', 'stopped'];

type Role = 'planner' | 'builder' | 'reviewer';
interface Seat { runId: string; sessionId: string; engine: 'claude' | 'codex'; role: Role; busy: boolean; text: string; answer: string | null; briefed: boolean;
  /** Still in a turn from before this table opened (Reopen while it worked): its `done` ends that old turn, never a step. */
  stale?: boolean }
interface Chain {
  owner: number; cwd: string; builder: Seat; reviewer: Seat; planner: Seat;
  step: ChainStep; stoppedAt: ChainStep | null; task: string; images: ChatImage[]; plan: string; report: string; reviewRound: number; finalRound: number;
  verdict: 'approved' | 'changes' | null; note: string; findings: Finding[];
  /** This task's challenges, and whether its plan was challenged yet (once per task). */
  challenges: PlanChallenge[]; challenged: boolean;
  queued: { text: string; images: ChatImage[] } | null; kept: boolean; turnStart: Promise<string | null> | null;
  /** The seat that said TASK BLOCKED: the person's next message is its answer, in the same step. */
  blocked: Seat | null;
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
const cut = (text: string) => text.length > RELAY_LIMIT ? `${text.slice(0, RELAY_LIMIT)}\n[… shortened by Trace]` : text;
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
 * Hierarchy Round Tables: the person's task goes through fixed steps, each to one seat. The planner (Claude, Fable 5.2 by
 * default, read-only) writes a plan; once per task the reviewer (Codex, read-only) challenges it, and the planner answers
 * each challenge and writes the plan again, before the person sees it. The person approves the plan or sends it back;
 * the builder (the leading Claude chat, Opus 5.5 by default, the only seat that edits) implements it; the reviewer
 * reviews, as findings; the builder fixes them, for up to REVIEW_ROUNDS rounds; then the planner reviews the whole and
 * ends with APPROVED or CHANGES NEEDED. Changes go back to the fix step: the builder makes them, the reviewer checks
 * them, and the planner reviews again; up to FINAL_ROUNDS times before the table asks the person.
 * What the person writes once the final review is reached goes back to the planner, who plans again (replan); the
 * reviewer challenges that plan and the person approves it before the builder starts. The task is complete only on APPROVED. Trace passes each step's output to the next seat.
 */
export class ReviewChains {
  private chains = new Map<string, Chain>();
  constructor(private host: TableHost) {}

  has(leadRunId: string) { return this.chains.has(leadRunId); }
  private chainOf(runId: string): Chain | null {
    const own = this.chains.get(runId); if (own) return own;
    for (const chain of this.chains.values()) if (chain.reviewer.runId === runId || chain.planner.runId === runId) return chain;
    return null;
  }
  private leading(runId: string): Chain { const chain = this.chains.get(runId); if (!chain) throw new HubError('TABLE_NONE', 'This channel has no Round Table open.'); return chain; }
  private seatOf(runId: string, role: Role): Seat {
    const run = this.host.run(runId); if (!run) throw new HubError('TABLE_RUN', 'That chat is not running.');
    // A seat still working on a turn from before (a table closed while it worked) counts as busy until that turn ends.
    return { runId, sessionId: run.sessionId, engine: run.engine, role, busy: run.busy === true, text: '', answer: null, briefed: false, ...(run.busy ? { stale: true } : {}) };
  }
  private seats(chain: Chain) { return [chain.builder, chain.reviewer, chain.planner]; }
  private busy(chain: Chain) { return this.seats(chain).some((seat) => seat.busy); }
  private state(chain: Chain): RoundTableState {
    const working = !RESTING.includes(chain.step);
    return {
      kind: 'hierarchy', partner: { sessionId: chain.reviewer.sessionId, runId: chain.reviewer.runId, engine: 'codex' }, planner: { sessionId: chain.planner.sessionId, runId: chain.planner.runId, engine: 'claude' },
      driver: 'claude', rounds: REVIEW_ROUNDS, round: chain.reviewRound, phase: working ? 'answering' : 'idle', agreed: chain.verdict === 'approved',
      findings: chain.findings.map((finding) => ({ ...finding })),
      ...(chain.step === 'stopped' && this.busy(chain) ? { stopping: true } : {}),
      chain: { step: chain.step, ...(chain.stoppedAt ? { stoppedAt: chain.stoppedAt } : {}), ...(chain.blocked ? { blocked: chain.blocked.role } : {}), reviewRound: chain.reviewRound, finalRound: chain.finalRound, plan: keep(chain.plan), verdict: chain.verdict, note: chain.note, task: chain.task, report: keep(chain.report),
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
    const role = seat.role === 'planner'
      ? 'You are the planner and final reviewer. You do not edit files (Trace keeps you read-only). You write the plan the builder follows, and at the end you review the finished work against your plan and the review findings. Trace runs you in Claude\'s plan mode: write the whole plan in your reply, not in a plan file, and do not call ExitPlanMode; the person approves the plan in Trace.'
      : seat.role === 'builder'
        ? 'You are the builder: the only seat that edits files. You implement the planner\'s plan, then fix what the reviewers find. Carry out the plan without asking again whether to proceed; ask only about choices that are the person\'s, or before anything that publishes, deletes or cannot be undone.'
        : 'You are the reviewer. You challenge the planner\'s plan before the person sees it, and later review the builder\'s changes in the files. You do not edit files.';
    const steps = 'Steps: the planner plans, the reviewer (Codex) challenges the plan and the planner answers, the person approves the plan, the builder implements, the reviewer reviews, the builder fixes, and the planner gives the final review.';
    return `[Trace Round Table · hierarchy] ${steps} Trace passes each step's output to the next. ${role} End each reply as your step asks. Only if you need the person first (a question, an approval, a choice that is theirs), end instead with the line ${BLOCKED_LINE} and what you need.`;
  }
  /**
   * One step: a turn for one seat. A message the person sent meanwhile goes along with it; at or after the final review
   * it goes to the planner instead (replan). `hold`: the step runs without it (a blocked seat's answer), and the message
   * waits for the step after.
   */
  private turn(chain: Chain, seat: Seat, step: ChainStep, text: string, images: ChatImage[] = [], hold = false) {
    let waiting = hold ? null : this.followUp(chain);
    // A follow-up too long to join the task stops the table at this step, its request kept: once the person drops the
    // message, Continue runs the step as it would have run.
    if (waiting && late(chain, step)) { if (!this.replan(chain, null, false)) { chain.step = 'stopped'; chain.stoppedAt = step; chain.blocked = null; this.publish(chain); } return; }
    // A plan still owed: the message joins what the planner is asked, saved (Stop, a restart or an empty answer keeps it).
    // The plain planning prompt is built again with it; a blocked planner's answer goes as it is, with the message added.
    if (waiting && step === 'planning' && this.owed(chain)) {
      const plain = text === this.planPrompt(chain); const problem = this.owe(chain, waiting.text);
      if (problem) { chain.held = `${problem} Drop the waiting message to go on.`; chain.step = 'stopped'; chain.stoppedAt = step; chain.blocked = null; this.publish(chain); return; }
      if (plain) { text = this.planPrompt(chain); images = [...images, ...waiting.images].slice(0, MAX_IMAGES); chain.queued = null; waiting = null; }
    }
    chain.step = step; chain.stoppedAt = null; chain.attempt++; chain.held = null;
    let extra = ''; let pictures = images;
    if (waiting) { extra = `\n\nThe person adds: ${waiting.text}`; pictures = [...images, ...waiting.images].slice(0, MAX_IMAGES); chain.queued = null; }
    seat.busy = true; seat.text = ''; seat.answer = null;
    const intro = seat.briefed ? '' : `${this.brief(chain, seat)}\n\n`; seat.briefed = true;
    // The files' state before a turn, for record(); a planner's answer is never recorded there, so its turns skip the hash.
    chain.turnStart = this.host.stateOf && seat.role !== 'planner' ? this.host.stateOf(chain.cwd).catch(() => null) : null;
    this.host.send(seat.runId, `${intro}${text}${extra}`, pictures);
    this.publish(chain);
  }
  /**
   * The person wrote once the final review was reached: their message (with one still waiting, not kept) joins the task,
   * and the planner plans again from where the work stands; the reviewer challenges that plan and the person approves it.
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
    this.turn(chain, chain.planner, 'planning', this.planPrompt(chain), images);
    return true;
  }
  /**
   * The message the person wrote meanwhile that goes along with the next step (or into a re-plan). Not one kept from
   * before a restart (it waits for Send now), and not a task from Tasks: that is a task of its own, tracked by its mark
   * in the chain's task, so it waits and starts as the next task once this one is done (or on Send now).
   */
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
  private followUp(chain: Chain) { return chain.queued && !chain.kept && !fromTasks(chain.queued.text, chain.queued.images) ? chain.queued : null; }
  // The prompts for each step.
  /** Built only from what the chain saves (revision, replan, task), so Continue and a restart at this step ask the same. */
  private planPrompt(chain: Chain) {
    if (chain.revision !== null) return `[Step: plan, revised] The person asks you to revise the plan:\n\n${chain.revision}\n\nWrite the whole plan again, as numbered steps, with the files to change and how to check the result. End with the line PLAN READY.`;
    if (chain.replan !== null) {
      const open = findingsFor(chain.findings, 'driver');
      return `[Step: plan again, after the final review] The person wrote after the final review; their follow-up is at the end of the task. The task:\n\n${chain.task}\n\nYour plan so far:\n\n${cut(chain.plan)}\n\nThe builder's latest report:\n\n${cut(chain.report)}\n\n${open ? `${open}\n\n` : ''}${chain.replan ? `Your final review asked for changes:\n\n${chain.replan}\n\n` : ''}Read what you need in the project, then write the whole plan again for what is still to do (the follow-up, and anything left from before): numbered steps, the files to change, and how to check the result. Do not change files. End with the line PLAN READY.`;
    }
    return `[Step: plan] The task:\n\n${chain.task}\n\nRead what you need in the project, then write a plan the builder can follow: numbered steps, the files to change, and how to check the result. Do not change files. End with the line PLAN READY.`;
  }
  private challengePrompt(chain: Chain) { return `[Step: challenge the plan] The task:\n\n${chain.task}\n\nThe planner's plan:\n\n${cut(chain.plan)}\n\nRead what you need in the project, but change nothing and write no plan of your own. Challenge the plan: requirements it misses, a simpler approach, and cases where it would fail. Report each on its own line as "CHALLENGE high|medium|low — the challenge" (Trace numbers them C1, C2, …). If you have none, end with the line NO CHALLENGES.`; }
  private answerPrompt(chain: Chain) {
    const list = chain.challenges.map((challenge) => `${challenge.id} (${challenge.severity}): ${challenge.text}`).join('\n');
    return `[Step: answer the challenges] The reviewer challenged your plan:\n${list}\n\nAnswer each on its own line as "ACCEPTED C<n>" or "REJECTED C<n> — why". Then write the whole plan again, with what you accepted worked in, as numbered steps with the files to change and how to check the result. End with the line PLAN READY.`;
  }
  private buildPrompt(chain: Chain) { return `[Step: implement] The task:\n\n${chain.task}\n\nThe approved plan:\n\n${cut(chain.plan)}\n\nImplement it. When you are done, report the files you changed and how you checked the result.`; }
  private reviewPrompt(chain: Chain) {
    const check = findingsFor(chain.findings, 'reviewer');
    return `[Step: review, round ${chain.reviewRound} of ${REVIEW_ROUNDS}] The task:\n\n${chain.task}\n\nThe plan:\n\n${cut(chain.plan)}\n\nThe builder's report:\n\n${cut(chain.report)}\n\n${check ? `${check}\n\n` : ''}Review the changes in the files. Report each problem on its own line as "FINDING high|medium|low path:line — the problem" (Trace numbers them). If you find nothing wrong, end with the line NO FINDINGS.`;
  }
  private fixPrompt(chain: Chain) {
    const open = findingsFor(chain.findings, 'driver');
    const final = chain.verdict === 'changes' && chain.note ? `The planner's final review asks for changes:\n\n${chain.note}` : '';
    return `[Step: fix${final ? ', after the final review' : ''}] ${[final, open].filter(Boolean).join('\n\n')}\n\nThen report what you changed.`;
  }
  private finalPrompt(chain: Chain) {
    const record = chain.findings.length ? chain.findings.map((finding) => `${finding.id} (${finding.severity}, ${finding.status}): ${finding.text}${finding.response ? ` · builder: ${finding.response}` : ''}${finding.check ? ` · reviewer: ${finding.check}` : ''}`).join('\n') : 'No findings.';
    const challenges = chain.challenges.length ? `\n\nThe reviewer's challenges to the plan:\n${chain.challenges.map((challenge) => `${challenge.id} (${challenge.severity}, ${challenge.answer ?? 'not answered'}): ${challenge.text}${challenge.reason ? ` · ${challenge.reason}` : ''}`).join('\n')}` : '';
    return `[Step: final review${chain.finalRound ? `, again after changes (${chain.finalRound} of ${FINAL_ROUNDS})` : ''}] The task:\n\n${chain.task}\n\nYour plan:\n\n${cut(chain.plan)}\n\nThe builder's latest report:\n\n${cut(chain.report)}\n\nThe review record:\n${record}${challenges}\n\nCheck the finished work in the files against the task, your plan and the findings. End with the line APPROVED, or CHANGES NEEDED: and what to change.`;
  }
  private finalFixPrompt(chain: Chain) { return `[Step: changes from the final review] The planner asks for changes:\n\n${chain.note}\n\nMake them, then report what you changed.`; }

  open(owner: number, builderRunId: string, reviewerRunId: string, plannerRunId: string, saved: { findings?: Finding[]; waiting?: string; waitingImages?: ChatImage[]; chain?: SavedChain } = {}): RoundTableState {
    const ids = [builderRunId, reviewerRunId, plannerRunId];
    if (ids.some((id) => this.chainOf(id))) throw new HubError('TABLE_TAKEN', 'One of these chats is already at a Round Table.');
    const builder = this.seatOf(builderRunId, 'builder'); const reviewer = this.seatOf(reviewerRunId, 'reviewer'); const planner = this.seatOf(plannerRunId, 'planner');
    if (builder.engine !== 'claude' || planner.engine !== 'claude' || reviewer.engine !== 'codex') throw new HubError('TABLE_ENGINES', 'A hierarchy Round Table seats Claude as builder and planner, and Codex as reviewer.');
    const runs = ids.map((id) => this.host.run(id)!);
    if (runs.some((run) => run.cwd !== runs[0].cwd)) throw new HubError('TABLE_FOLDER', 'All the agents must work in the same folder.');
    if (runs.some((run) => run.owner !== owner)) throw new HubError('TABLE_OWNER', 'All the chats must be open in this window.');
    const before = saved.chain;
    // A chain cut short by a restart comes back stopped at its step: Continue picks it up.
    const resumable = before && !RESTING.includes(before.step) ? before.step : null;
    const chain: Chain = { owner, cwd: runs[0].cwd, builder, reviewer, planner, step: before ? (resumable ? 'stopped' : before.step) : 'idle', stoppedAt: resumable ?? (before?.step === 'stopped' ? before.stoppedAt ?? null : null),
      task: before?.task ?? '', images: (before?.images ?? []).slice(0, MAX_IMAGES), plan: before?.plan ?? '', report: before?.report ?? '', reviewRound: before?.reviewRound ?? 0, finalRound: before?.finalRound ?? 0, verdict: before?.verdict ?? null, note: before?.note ?? '',
      challenges: (before?.challenges ?? []).slice(0, MAX_CHALLENGES).map((challenge) => ({ ...challenge })), challenged: before?.challenged === true,
      findings: (saved.findings ?? []).slice(0, MAX_FINDINGS).map((finding) => ({ ...finding })), queued: null, kept: false, turnStart: null, blocked: null, attempt: 0, unrecorded: 0, replan: before?.replan ?? null, revision: before?.revision ?? null, held: before?.held ?? null, nextTasks: (before?.nextTasks ?? []).slice(0, MAX_NEXT_TASKS) };
    // A seat that was waiting for the person before the restart still is.
    if (before?.blocked && chain.step === 'stopped') chain.blocked = { builder, reviewer, planner }[before.blocked] ?? null;
    if (saved.waiting !== undefined || saved.waitingImages?.length) { chain.queued = { text: saved.waiting ?? '', images: (saved.waitingImages ?? []).slice(0, MAX_IMAGES) }; chain.kept = true; }
    this.chains.set(builderRunId, chain);
    this.host.setReadOnly(builder.runId, false); this.host.setReadOnly(reviewer.runId, true); this.host.setReadOnly(planner.runId, true);
    // A seat still at work from before is stopped; the table waits (Stopping…) until its old turn has ended.
    for (const seat of this.seats(chain)) if (seat.stale) { try { this.host.interrupt(seat.runId); } catch { /* Ended. */ } }
    this.publish(chain); return this.state(chain);
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
    // with TASK COMPLETE, which would push each step's own last line (PLAN READY, APPROVED) aside: here the planner's
    // APPROVED completes the task, and each seat's brief says when to end with TASK BLOCKED.
    chain.task = text.replace(SIGNAL_INSTRUCTION, '').trim(); chain.images = images; chain.plan = ''; chain.report = ''; chain.reviewRound = 0; chain.finalRound = 0; chain.verdict = null; chain.note = '';
    chain.challenges = []; chain.challenged = false; chain.replan = null; chain.revision = null;
    this.turn(chain, chain.planner, 'planning', this.planPrompt(chain), images);
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
      else this.turn(chain, chain.planner, 'planning', this.planPrompt(chain), pictures);
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
    this.turn(chain, chain.planner, 'planning', `${this.planPrompt(chain)}\n\nThe person adds: ${text}`, images);
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
      chain.revision = note; chain.images = [...chain.images, ...images]; this.turn(chain, chain.planner, 'planning', this.planPrompt(chain), images);
    }
    return this.state(chain);
  }
  /** Picks a stopped chain up at its step (after Stop, or a restart). `skipChallenge`: a stopped challenge is left out. */
  continue(leadRunId: string, skipChallenge = false) {
    const chain = this.leading(leadRunId); const step = chain.stoppedAt;
    if (chain.step !== 'stopped' || !step) throw new HubError('TABLE_STEP', 'Nothing was stopped part way.');
    // A stopped seat's turn ends with a late `done`; a new turn begun before it would take that `done` as its own end.
    if (this.busy(chain)) throw new HubError('TABLE_STOPPING', 'The agent is still stopping. Continue once it has stopped.');
    if (skipChallenge && step !== 'challenging') throw new HubError('TABLE_STEP', 'Only a stopped challenge can be left out.');
    chain.blocked = null;
    if (skipChallenge) { chain.challenged = true; chain.stoppedAt = null; chain.step = chain.plan ? 'plan-review' : 'needs-you'; chain.note = 'The challenge was left out at your request.'; this.publish(chain); return this.state(chain); }
    if (step === 'planning') this.turn(chain, chain.planner, 'planning', this.planPrompt(chain), chain.images);
    else if (step === 'challenging') this.turn(chain, chain.reviewer, 'challenging', this.challengePrompt(chain));
    else if (step === 'plan-responding') this.turn(chain, chain.planner, 'plan-responding', this.answerPrompt(chain));
    else if (step === 'implementing') this.turn(chain, chain.builder, 'implementing', this.buildPrompt(chain), chain.images);
    else if (step === 'reviewing') this.turn(chain, chain.reviewer, 'reviewing', this.reviewPrompt(chain));
    else if (step === 'fixing') this.turn(chain, chain.builder, 'fixing', this.fixPrompt(chain));
    else if (step === 'final') this.turn(chain, chain.planner, 'final', this.finalPrompt(chain));
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
    for (const seat of this.seats(chain)) if (seat.busy) this.host.interrupt(seat.runId);
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
    for (const seat of this.seats(chain)) { try { this.host.setReadOnly(seat.runId, false); } catch { /* Ended. */ } }
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
    for (const seat of this.seats(chain)) if (seat.busy && seat.runId !== runId) { try { this.host.interrupt(seat.runId); } catch { /* Ended. */ } }
    this.close(chain.builder.runId, false);
  }

  /** Every chat event passes here; returns a notice in place of an edit a read-only seat asked for (declined), or '' for a command allowed at Full. */
  observe(envelope: ChatEnvelope): string | null {
    const { runId, event } = envelope; const chain = this.chainOf(runId); if (!chain) return null;
    const seat = this.seats(chain).find((item) => item.runId === runId)!;
    if (event.type === 'assistant') { const words = event.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n'); if (words) seat.text = seat.text ? `${seat.text}\n${words}` : words; return null; }
    if (event.type === 'permission' && seat.role !== 'builder' && isEdit(event)) {
      this.host.answer(runId, event.requestId, false);
      return `Trace declined ${event.toolName} for the ${seat.role}: only the builder edits files.`;
    }
    // At Full access a read-only seat's commands run without an approval card, as the person's level says.
    if (event.type === 'permission' && seat.role !== 'builder' && allowAtFull(this.host, runId, event.requestId)) return '';
    if (event.type !== 'done' || !seat.busy) return null;
    // The end of a turn from before this table opened: the seat is free now, and no step moves on it.
    if (seat.stale) { seat.busy = false; seat.stale = false; seat.text = ''; this.publish(chain); return null; }
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
    const answer = seat.answer ?? '';
    // A seat that needs the person stops the chain at its step; the person's answer goes back to it (send).
    const signal = taskSignal(answer);
    if (signal?.kind === 'blocked') { chain.stoppedAt = chain.step; chain.step = 'stopped'; chain.blocked = seat; chain.note = `The ${seat.role} needs you: ${signal.reason}`; this.publish(chain); return; }
    const step = chain.step; const attempt = chain.attempt;
    // Reads into the record, then goes on only if this is still the same turn: Stop, or Stop then Continue (a new turn at
    // the same step), while the files' state was being taken leaves the old answer behind.
    const recorded = async () => { await this.record(chain, seat); return this.chains.get(chain.builder.runId) === chain && chain.step === step && chain.attempt === attempt; };
    if (chain.step === 'planning') {
      // An empty answer keeps everything as it was (the plan before, and the revision or re-plan still owed), for the person's reply.
      const plan = answer.replace(/\n?\s*PLAN READY\s*$/i, '').trim();
      if (!plan) { chain.step = 'needs-you'; chain.note = 'The planner wrote no plan.'; this.publish(chain); return; }
      chain.plan = plan; chain.note = ''; chain.replan = null; chain.revision = null;
      // Once per task the reviewer challenges the plan before the person sees it; a revised plan is not challenged again.
      if (!chain.challenged) { this.turn(chain, chain.reviewer, 'challenging', this.challengePrompt(chain)); return; }
      chain.step = 'plan-review'; this.publish(chain); return;
    }
    if (chain.step === 'challenging') {
      if (!isChallenge(answer)) { chain.stoppedAt = 'challenging'; chain.step = 'stopped'; chain.note = 'The reviewer ended without CHALLENGE lines or NO CHALLENGES. Continue runs the challenge again, or Continue without the challenge.'; this.publish(chain); return; }
      chain.challenged = true; chain.challenges = parseChallenges(answer).slice(0, MAX_CHALLENGES).map((challenge, index) => ({ id: `C${index + 1}`, ...challenge }));
      if (chain.challenges.length) { this.turn(chain, chain.planner, 'plan-responding', this.answerPrompt(chain)); return; }
      chain.step = 'plan-review'; this.publish(chain); return;
    }
    if (chain.step === 'plan-responding') {
      for (const { id, answer: verdict, reason } of parseChallengeAnswers(answer)) { const challenge = chain.challenges.find((item) => item.id === id); if (challenge) { challenge.answer = verdict; challenge.reason = reason; } }
      // The plan is what is left once the answers to the challenges (shown with them) and PLAN READY are taken out.
      const plan = answer.split(/\r?\n/).filter((line) => !parseChallengeAnswers(line).length).join('\n').replace(/\n?\s*PLAN READY\s*$/i, '').trim();
      if (plan) chain.plan = plan; else chain.note = 'The planner answered the challenges without writing the plan again; this is its plan from before them.';
      chain.step = 'plan-review'; this.publish(chain); return;
    }
    if (chain.step === 'implementing' || chain.step === 'final-fixing') {
      chain.report = answer || chain.report; if (!await recorded()) return;
      if (chain.step === 'final-fixing') { this.turn(chain, chain.planner, 'final', this.finalPrompt(chain)); return; }
      chain.reviewRound = 1;
      this.turn(chain, chain.reviewer, 'reviewing', this.reviewPrompt(chain)); return;
    }
    if (chain.step === 'reviewing') {
      if (!isReview(answer)) { chain.stoppedAt = 'reviewing'; chain.step = 'stopped'; chain.note = 'The reviewer ended without findings or NO FINDINGS. Continue runs the review again.'; this.publish(chain); return; }
      if (!await recorded()) return;
      if (chain.unrecorded) { const count = chain.unrecorded; chain.unrecorded = 0; chain.step = 'needs-you'; chain.note = `The review record is full (${MAX_FINDINGS} findings, none verified), so ${count} new ${count === 1 ? 'finding' : 'findings'} from this review could not be recorded. Close the table to save the record to shared memory, then open it again and give the task again.`; this.publish(chain); return; }
      this.afterReview(chain); return;
    }
    if (chain.step === 'fixing') {
      chain.report = answer || chain.report; if (!await recorded()) return;
      // The planner's changes are done once the builder has had its turn at them.
      if (chain.verdict === 'changes') { chain.verdict = null; chain.note = ''; }
      if (chain.reviewRound < REVIEW_ROUNDS) { chain.reviewRound++; this.turn(chain, chain.reviewer, 'reviewing', this.reviewPrompt(chain)); return; }
      this.turn(chain, chain.planner, 'final', this.finalPrompt(chain)); return;
    }
    if (chain.step === 'final') {
      const verdict = verdictOf(answer);
      // A message the person wrote during the final review (not one kept from before a restart, nor a task from Tasks).
      const followUp = this.followUp(chain) !== null;
      if (verdict?.approved) {
        chain.verdict = 'approved'; chain.step = 'done'; chain.note = ''; chain.held = null; this.publish(chain);
        // This task is done (Tasks moves it on). Next: a message the person wrote meanwhile, then the tasks from Tasks in
        // order, one per approval. A message kept from before a restart still waits for Send now.
        if (chain.queued && !chain.kept) { const { text, images } = chain.queued; chain.queued = null; this.send(chain.builder.runId, text, images); }
        else if (!chain.queued && chain.nextTasks.length) this.send(chain.builder.runId, chain.nextTasks.shift()!, []);
        return;
      }
      // A follow-up too long to plan again with the task (held says why) stops the table at the final review, its verdict
      // and note kept: once the person drops the message, Continue runs the final review again.
      const heldAtFinal = () => { chain.step = 'stopped'; chain.stoppedAt = 'final'; chain.blocked = null; this.publish(chain); };
      if (!verdict) { if (followUp) { if (!this.replan(chain, null, false)) heldAtFinal(); return; } chain.step = 'needs-you'; chain.note = 'The planner ended its final review without APPROVED or CHANGES NEEDED.'; this.publish(chain); return; }
      chain.verdict = 'changes'; chain.note = verdict.changes;
      if (chain.finalRound >= FINAL_ROUNDS && followUp) { if (!this.replan(chain, null, false)) heldAtFinal(); return; }
      if (chain.finalRound >= FINAL_ROUNDS) { chain.step = 'needs-you'; chain.note = `The planner still asks for changes after ${FINAL_ROUNDS} rounds: ${verdict.changes}`; this.publish(chain); return; }
      // Back to the fix step: the builder makes the changes, the reviewer checks them once more, then the final review again.
      // With a message from the person waiting, turn() sends it all to the planner instead (replan).
      chain.finalRound++; chain.reviewRound = REVIEW_ROUNDS - 1; this.turn(chain, chain.builder, 'fixing', this.fixPrompt(chain)); return;
    }
    this.publish(chain);
  }
  /** After a review: the builder fixes what is open (a duplicate in a record from 1.20 is not), or the planner reviews the whole. */
  private afterReview(chain: Chain) {
    if (chain.findings.some((finding) => finding.status === 'open' && !finding.duplicateOf)) { this.turn(chain, chain.builder, 'fixing', this.fixPrompt(chain)); return; }
    this.turn(chain, chain.planner, 'final', this.finalPrompt(chain));
  }
  /** Reads a seat's answer into the review record (new findings and checks from the reviewer; FIXED/DECLINED from the builder), noting the files' state. */
  private async record(chain: Chain, seat: Seat) {
    if (seat.role === 'planner') return;
    const changed: Finding[] = []; const at = new Date().toISOString(); const answer = seat.answer ?? '';
    if (seat.role === 'reviewer') for (const found of parseFindings(answer)) {
      const id = makeRoomForFinding(chain.findings); if (!id) { chain.unrecorded++; continue; }
      const finding: Finding = { id, ...found, status: 'open', response: '', check: '', reviewedAt: null, changedAt: null, round: Math.min(5, chain.reviewRound), at };
      chain.findings.push(finding); changed.push(finding);
    }
    for (const { id, verb, note } of parseAnswers(answer, seat.role === 'reviewer' ? 'reviewer' : 'driver')) { const finding = chain.findings.find((item) => item.id === id); if (finding && !finding.duplicateOf && apply(finding, verb, note) && !changed.includes(finding)) changed.push(finding); }
    // A line that looks like a review line but could not be read is named, rather than left out of the record without a word.
    const unread = unreadNotice(unreadLines(answer, seat.role === 'reviewer' ? 'reviewer' : 'driver')); if (unread) this.host.emit(chain.owner, { sessionId: chain.builder.sessionId, runId: chain.builder.runId, event: { type: 'notice', text: unread } });
    if (!changed.length || !this.host.stateOf) return;
    const [before, after] = await Promise.all([chain.turnStart ?? Promise.resolve(null), this.host.stateOf(chain.cwd).catch(() => null)]);
    const short = after ? after.slice(0, 12) : null; const moved = before !== null && after !== null && before !== after;
    for (const finding of changed) { if (finding.status === 'open' && !finding.reviewedAt) { finding.reviewedAt = short; if (moved && seat.role === 'reviewer') finding.filesChanged = true; } else finding.changedAt = short; }
  }
}
