import { GEMINI_STEPS, type ChainStep, type ChatEnvelope, type ChatImage, type PlanChallenge, type RoundTableState, type SavedChain } from '../../../shared/chat';
import { HubError } from '../cli/engine-adapter';
import { apply, type Finding, findingOrigin, findingsFor, MAX_FINDINGS, parseAnswers, parseChallengeAnswers, parseChallenges, parseComparison, parseFindings } from '../../../shared/findings';
import { allowAtFull, EDITS, KEEP_IMAGES, type TableHost } from './round-table';
import { BLOCKED_LINE, SIGNAL_INSTRUCTION, taskSignal } from '../../../shared/task-signal';

/** Review rounds (Codex reviews, Opus fixes) before the planner's final review. */
export const REVIEW_ROUNDS = 2;
/** Times the planner can send work back to the fix step (CHANGES NEEDED) before the table stops and asks the person. */
export const FINAL_ROUNDS = 2;
/** The longest earlier output passed into a prompt; more is cut, and the agent is told so. */
const RELAY_LIMIT = 12_000;
const MAX_IMAGES = 10;
const MAX_CHALLENGES = 50;
/** Steps where the table waits for the person or has nothing to do. */
const RESTING: ChainStep[] = ['idle', 'plan-review', 'done', 'needs-you', 'stopped'];

type Role = 'planner' | 'builder' | 'reviewer' | 'challenger';
interface Seat { runId: string; sessionId: string; engine: 'claude' | 'codex' | 'gemini'; role: Role; busy: boolean; text: string; answer: string | null; briefed: boolean }
interface Chain {
  owner: number; cwd: string; builder: Seat; reviewer: Seat; planner: Seat;
  /** The Gemini seat (challenges the plan, reviews before Codex, compares), when the table has one. */
  challenger: Seat | null;
  step: ChainStep; stoppedAt: ChainStep | null; task: string; images: ChatImage[]; plan: string; report: string; reviewRound: number; finalRound: number;
  verdict: 'approved' | 'changes' | null; note: string; findings: Finding[];
  /** This task's challenges, and whether Gemini challenged, reviewed and compared yet (each once per task). */
  challenges: PlanChallenge[]; challenged: boolean; geminiReviewed: boolean; compared: boolean;
  /** Where this task's findings begin in `findings`: Gemini compares only those. */
  firstFinding: number;
  queued: { text: string; images: ChatImage[] } | null; kept: boolean; turnStart: Promise<string | null> | null;
  /** The seat that said TASK BLOCKED: the person's next message is its answer, in the same step. */
  blocked: Seat | null;
  /** Counts turns: a step's answer is acted on only if no newer turn began meanwhile (Stop and Continue start one). */
  attempt: number;
  /** The project's files (repositoryState) as Gemini's turn began; and Trace reading them before or after it (the table is busy meanwhile). */
  geminiBefore: string | null; checking: boolean;
}
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
/** Whether Gemini's reply challenges the plan: CHALLENGE lines, or NO CHALLENGES on the last line. */
export function isChallenge(answer: string): boolean { return parseChallenges(answer).length > 0 || /^NO CHALLENGES\.?$/i.test(lastLine(answer)); }
/** Whether Gemini's reply compares the reviews: AGREE, DISPUTE or DUPLICATE lines, or COMPARED on the last line. */
export function isComparison(answer: string): boolean { return parseComparison(answer).length > 0 || /^COMPARED\.?$/i.test(lastLine(answer)); }
/** The planner's verdict on the last non-empty line: APPROVED, or CHANGES NEEDED: what to change. */
export function verdictOf(answer: string): { approved: true } | { approved: false; changes: string } | null {
  const last = lastLine(answer);
  if (/^APPROVED\.?$/i.test(last)) return { approved: true };
  const changes = /^CHANGES NEEDED:?\s*(.*)$/i.exec(last); return changes ? { approved: false, changes: changes[1].trim() || 'See my review above.' } : null;
}

/**
 * Hierarchy Round Tables: the person's task goes through fixed steps, each to one seat. The planner (Claude, Fable 5.2 by
 * default, read-only) writes a plan, which the person approves or sends back; the builder (the leading Claude chat, Opus
 * 5.5 by default, the only seat that edits) implements it; the reviewer (Codex, read-only) reviews, as findings; the
 * builder fixes them, for up to REVIEW_ROUNDS rounds; then the planner reviews the whole and ends with APPROVED or
 * CHANGES NEEDED. Changes go back to the fix step: the builder makes them, the reviewer checks them, and the planner
 * reviews again; up to FINAL_ROUNDS times before the table asks the person.
 * With a Gemini seat (the challenger, from 1.20), once per task: Gemini challenges the plan and the planner answers
 * before the person sees it; Gemini reviews the build before Codex, without Codex's findings; after Codex's first review
 * Gemini compares the two. Codex alone checks the fixes. agy is not read-only even in plan mode, so Trace compares the
 * project's files before and after each Gemini step and stops the table if they changed.
 * The task is complete only on APPROVED. Trace passes each step's output to the next seat.
 */
export class ReviewChains {
  private chains = new Map<string, Chain>();
  constructor(private host: TableHost) {}

  has(leadRunId: string) { return this.chains.has(leadRunId); }
  private chainOf(runId: string): Chain | null {
    const own = this.chains.get(runId); if (own) return own;
    for (const chain of this.chains.values()) if (chain.reviewer.runId === runId || chain.planner.runId === runId || chain.challenger?.runId === runId) return chain;
    return null;
  }
  private leading(runId: string): Chain { const chain = this.chains.get(runId); if (!chain) throw new HubError('TABLE_NONE', 'This channel has no Round Table open.'); return chain; }
  private seatOf(runId: string, role: Role): Seat {
    const run = this.host.run(runId); if (!run) throw new HubError('TABLE_RUN', 'That chat is not running.');
    return { runId, sessionId: run.sessionId, engine: run.engine, role, busy: false, text: '', answer: null, briefed: false };
  }
  private seats(chain: Chain) { return [chain.builder, chain.reviewer, chain.planner, ...(chain.challenger ? [chain.challenger] : [])]; }
  private busy(chain: Chain) { return chain.checking || this.seats(chain).some((seat) => seat.busy); }
  /** Gemini takes part in this step of this task: it is seated, and has not done this part yet. */
  private gemini(chain: Chain, part: 'challenge' | 'review' | 'compare') {
    if (!chain.challenger) return false;
    if (part === 'challenge') return !chain.challenged;
    if (part === 'review') return !chain.geminiReviewed;
    // Comparing needs both reviews of this task: Gemini's, and Codex's first, with findings of its own.
    return chain.geminiReviewed && !chain.compared && this.taskFindings(chain).some((finding) => !finding.source && finding.round === 1);
  }
  /** This task's findings: earlier tasks' (verified, declined or still open) are not Gemini's to compare or close. */
  private taskFindings(chain: Chain) { return chain.findings.slice(chain.firstFinding); }

  private state(chain: Chain): RoundTableState {
    const working = !RESTING.includes(chain.step);
    return {
      kind: 'hierarchy', partner: { sessionId: chain.reviewer.sessionId, runId: chain.reviewer.runId, engine: 'codex' }, planner: { sessionId: chain.planner.sessionId, runId: chain.planner.runId, engine: 'claude' },
      ...(chain.challenger ? { challenger: { sessionId: chain.challenger.sessionId, runId: chain.challenger.runId, engine: 'gemini' as const } } : {}),
      driver: 'claude', rounds: REVIEW_ROUNDS, round: chain.reviewRound, phase: working ? 'answering' : 'idle', agreed: chain.verdict === 'approved',
      findings: chain.findings.map((finding) => ({ ...finding })),
      ...(chain.step === 'stopped' && this.busy(chain) ? { stopping: true } : {}),
      chain: { step: chain.step, ...(chain.stoppedAt ? { stoppedAt: chain.stoppedAt } : {}), ...(chain.blocked ? { blocked: chain.blocked.role } : {}), reviewRound: chain.reviewRound, finalRound: chain.finalRound, plan: chain.plan, verdict: chain.verdict, note: chain.note, task: chain.task, report: chain.report,
        ...(chain.challenges.length ? { challenges: chain.challenges.map((challenge) => ({ ...challenge })) } : {}), ...(chain.challenged ? { challenged: true as const } : {}), ...(chain.geminiReviewed ? { geminiReviewed: true as const } : {}), ...(chain.compared ? { compared: true as const } : {}), ...(chain.firstFinding ? { firstFinding: chain.firstFinding } : {}) },
      ...(chain.queued ? { waiting: chain.queued.text, ...this.keptImages(chain.queued.images), ...(chain.kept ? { waitingKept: true } : {}) } : {}),
    };
  }
  /** A waiting message's images go with the saved table up to KEEP_IMAGES of base64 (as at a discussion table). */
  private keptImages(images: ChatImage[]) { if (!images.length) return {}; return images.reduce((sum, image) => sum + image.data.length, 0) <= KEEP_IMAGES ? { waitingImages: images } : { waitingImagesDropped: images.length }; }
  private publish(chain: Chain) { this.host.emit(chain.owner, { sessionId: chain.builder.sessionId, runId: chain.builder.runId, event: { type: 'table', table: this.state(chain) } }); }

  /** What a seat is told about the table, once, before its first message here. */
  private brief(chain: Chain, seat: Seat) {
    const role = seat.role === 'planner'
      ? 'You are the planner and final reviewer. You do not edit files (Trace keeps you read-only). You write the plan the builder follows, and at the end you review the finished work against your plan and the review findings. Trace runs you in Claude\'s plan mode: write the whole plan in your reply, not in a plan file, and do not call ExitPlanMode; the person approves the plan in Trace.'
      : seat.role === 'builder'
        ? 'You are the builder: the only seat that edits files. You implement the planner\'s plan, then fix what the reviewers find. Carry out the plan without asking again whether to proceed; ask only about choices that are the person\'s, or before anything that publishes, deletes or cannot be undone.'
        : seat.role === 'challenger'
          ? 'You are Gemini, the challenger and second reviewer. You do not edit files, write files in the project, or run commands that change them: Trace compares the project\'s files before and after each of your steps and stops the table if anything changed. You challenge the planner\'s plan before the person sees it, review the builder\'s changes before you see Codex\'s findings, then compare your findings with Codex\'s. Answer in your reply; do not write a plan or implementation of your own.'
          : 'You are the reviewer. You do not edit files (Trace keeps you read-only). You review the builder\'s changes in the files themselves.';
    const steps = chain.challenger
      ? 'Steps: the planner plans, Gemini challenges the plan and the planner answers, the person approves the plan, the builder implements, Gemini reviews, the reviewer (Codex) reviews, Gemini compares the two reviews, the builder fixes, the reviewer checks the fixes, and the planner gives the final review.'
      : 'Steps: the planner plans, the person approves the plan, the builder implements, the reviewer reviews, the builder fixes, and the planner gives the final review.';
    return `[Trace Round Table · hierarchy] ${steps} Trace passes each step's output to the next. ${role} End each reply as your step asks. Only if you need the person first (a question, an approval, a choice that is theirs), end instead with the line ${BLOCKED_LINE} and what you need.`;
  }
  /** One step: a turn for one seat. A message the person sent meanwhile goes along with it. */
  private turn(chain: Chain, seat: Seat, step: ChainStep, text: string, images: ChatImage[] = []) {
    chain.step = step; chain.stoppedAt = null; chain.attempt++;
    let extra = ''; let pictures = images;
    if (chain.queued && !chain.kept) { extra = `\n\nThe person adds: ${chain.queued.text}`; pictures = [...images, ...chain.queued.images].slice(0, MAX_IMAGES); chain.queued = null; }
    seat.busy = true; seat.text = ''; seat.answer = null;
    const intro = seat.briefed ? '' : `${this.brief(chain, seat)}\n\n`; seat.briefed = true;
    chain.turnStart = this.host.stateOf ? this.host.stateOf(chain.cwd).catch(() => null) : null;
    this.host.send(seat.runId, `${intro}${text}${extra}`, pictures);
    this.publish(chain);
  }
  /**
   * A Gemini step: the project's files are read first, so what Gemini's turn changed can be told afterwards. Where they
   * cannot be read (not a Git repository, too many changes), Gemini is left out of this step, as the note says.
   */
  private geminiTurn(chain: Chain, step: ChainStep, text: string, images: ChatImage[] = []) {
    const seat = chain.challenger!;
    chain.step = step; chain.stoppedAt = null; chain.note = ''; chain.attempt++; chain.checking = true; const attempt = chain.attempt;
    this.publish(chain);
    const read = this.host.stateOf ? this.host.stateOf(chain.cwd).catch(() => null) : Promise.resolve(null);
    void read.then((before) => {
      chain.checking = false;
      if (this.chains.get(chain.builder.runId) !== chain) return;
      if (chain.attempt !== attempt || chain.step !== step) { this.publish(chain); return; }
      if (!before) { this.skipGemini(chain, step, 'Gemini was left out of this step: Trace cannot read this folder\'s files with Git, so it could not check that Gemini changed nothing.'); return; }
      chain.geminiBefore = before; this.turn(chain, seat, step, text, images);
    });
  }
  /** Goes on past a Gemini step (Continue without Gemini, or files Trace cannot check): that part of Gemini's work for this task is over. */
  private skipGemini(chain: Chain, step: ChainStep, note: string) {
    if (step === 'challenging') { chain.challenged = true; chain.stoppedAt = null; chain.step = chain.plan ? 'plan-review' : 'needs-you'; chain.note = note; this.publish(chain); return; }
    if (step === 'second-reviewing') { chain.geminiReviewed = true; chain.compared = true; chain.reviewRound = 1; this.turn(chain, chain.reviewer, 'reviewing', this.reviewPrompt(chain)); }
    else { chain.compared = true; this.afterReview(chain); }
    chain.note = note; this.publish(chain);
  }

  // The prompts for each step.
  private planPrompt(chain: Chain, note?: string) {
    return note
      ? `[Step: plan, revised] The person asks you to revise the plan:\n\n${note}\n\nWrite the whole plan again, as numbered steps, with the files to change and how to check the result. End with the line PLAN READY.`
      : `[Step: plan] The task:\n\n${chain.task}\n\nRead what you need in the project, then write a plan the builder can follow: numbered steps, the files to change, and how to check the result. Do not change files. End with the line PLAN READY.`;
  }
  private challengePrompt(chain: Chain) { return `[Step: challenge the plan] The task:\n\n${chain.task}\n\nThe planner's plan:\n\n${cut(chain.plan)}\n\nRead what you need in the project, but change nothing and write no plan of your own. Challenge the plan: requirements it misses, a simpler approach, and cases where it would fail. Report each on its own line as "CHALLENGE high|medium|low — the challenge" (Trace numbers them C1, C2, …). If you have none, end with the line NO CHALLENGES.`; }
  private answerPrompt(chain: Chain) {
    const list = chain.challenges.map((challenge) => `${challenge.id} (${challenge.severity}): ${challenge.text}`).join('\n');
    return `[Step: answer the challenges] Gemini challenged your plan:\n${list}\n\nAnswer each on its own line as "ACCEPTED C<n>" or "REJECTED C<n> — why". Then write the whole plan again, with what you accepted worked in, as numbered steps with the files to change and how to check the result. End with the line PLAN READY.`;
  }
  private buildPrompt(chain: Chain) { return `[Step: implement] The task:\n\n${chain.task}\n\nThe approved plan:\n\n${cut(chain.plan)}\n\nImplement it. When you are done, report the files you changed and how you checked the result.`; }
  private geminiReviewPrompt(chain: Chain) { return `[Step: Gemini review] The task:\n\n${chain.task}\n\nThe plan:\n\n${cut(chain.plan)}\n\nThe builder's report:\n\n${cut(chain.report)}\n\nReview the changes in the files; change nothing. Codex reviews after you, and you compare its findings with yours then. Report each problem on its own line as "FINDING high|medium|low path:line — the problem" (Trace numbers them). If you find nothing wrong, end with the line NO FINDINGS.`; }
  private reviewPrompt(chain: Chain) {
    const check = findingsFor(chain.findings, 'reviewer');
    return `[Step: review, round ${chain.reviewRound} of ${REVIEW_ROUNDS}] The task:\n\n${chain.task}\n\nThe plan:\n\n${cut(chain.plan)}\n\nThe builder's report:\n\n${cut(chain.report)}\n\n${check ? `${check}\n\n` : ''}Review the changes in the files. Report each problem on its own line as "FINDING high|medium|low path:line — the problem" (Trace numbers them). If you find nothing wrong, end with the line NO FINDINGS.`;
  }
  private comparePrompt(chain: Chain) {
    const line = (finding: Finding) => `${finding.id} (${finding.severity}${finding.evidence ? `, ${finding.evidence}` : ''}): ${finding.text}`;
    const task = this.taskFindings(chain);
    const codex = task.filter((finding) => !finding.source && finding.round === 1 && !finding.duplicateOf); const own = task.filter((finding) => finding.source === 'gemini');
    return `[Step: compare the reviews] Codex reviewed the same changes after you. Its findings:\n${codex.map(line).join('\n')}\n\nYour findings:\n${own.length ? own.map(line).join('\n') : 'None.'}\n\nCheck Codex's findings in the files; change nothing. Answer each of Codex's findings on its own line as "AGREE F<n>" or "DISPUTE F<n> — why". Where two findings report the same problem, write "DUPLICATE F<n> of F<m>" (Trace closes F<n>). End with the line COMPARED.`;
  }
  /** A Gemini step's prompt, built again from the saved task, plan, report and findings. */
  private geminiPrompt(chain: Chain, step: ChainStep) { return step === 'challenging' ? this.challengePrompt(chain) : step === 'second-reviewing' ? this.geminiReviewPrompt(chain) : this.comparePrompt(chain); }
  private fixPrompt(chain: Chain) {
    const open = findingsFor(chain.findings, 'driver');
    const final = chain.verdict === 'changes' && chain.note ? `The planner's final review asks for changes:\n\n${chain.note}` : '';
    const sources = chain.findings.some((finding) => finding.status === 'open' && (finding.source === 'gemini' || finding.gemini)) ? 'Each finding says whether Gemini or Codex reported it, and what Gemini said about Codex\'s.\n\n' : '';
    return `[Step: fix${final ? ', after the final review' : ''}] ${sources}${[final, open].filter(Boolean).join('\n\n')}\n\nThen report what you changed.`;
  }
  private finalPrompt(chain: Chain) {
    const record = chain.findings.length ? chain.findings.map((finding) => `${finding.id} (${finding.severity}, ${finding.status}${findingOrigin(finding) ? `, ${findingOrigin(finding)}` : ''}${finding.duplicateOf ? `, duplicate of ${finding.duplicateOf}` : ''}): ${finding.text}${finding.response ? ` · builder: ${finding.response}` : ''}${finding.check ? ` · reviewer: ${finding.check}` : ''}`).join('\n') : 'No findings.';
    const challenges = chain.challenges.length ? `\n\nGemini's challenges to the plan:\n${chain.challenges.map((challenge) => `${challenge.id} (${challenge.severity}, ${challenge.answer ?? 'not answered'}): ${challenge.text}${challenge.reason ? ` · ${challenge.reason}` : ''}`).join('\n')}` : '';
    return `[Step: final review${chain.finalRound ? `, again after changes (${chain.finalRound} of ${FINAL_ROUNDS})` : ''}] The task:\n\n${chain.task}\n\nYour plan:\n\n${cut(chain.plan)}\n\nThe builder's latest report:\n\n${cut(chain.report)}\n\nThe review record:\n${record}${challenges}\n\nCheck the finished work in the files against the task, your plan and the findings. End with the line APPROVED, or CHANGES NEEDED: and what to change.`;
  }
  private finalFixPrompt(chain: Chain) { return `[Step: changes from the final review] The planner asks for changes:\n\n${chain.note}\n\nMake them, then report what you changed.`; }

  /** `challengerRunId`: the Gemini seat, when the window found agy; without it the table works as before 1.20. */
  open(owner: number, builderRunId: string, reviewerRunId: string, plannerRunId: string, saved: { findings?: Finding[]; waiting?: string; waitingImages?: ChatImage[]; chain?: SavedChain } = {}, challengerRunId?: string): RoundTableState {
    const ids = [builderRunId, reviewerRunId, plannerRunId, ...(challengerRunId ? [challengerRunId] : [])];
    if (ids.some((id) => this.chainOf(id))) throw new HubError('TABLE_TAKEN', 'One of these chats is already at a Round Table.');
    const builder = this.seatOf(builderRunId, 'builder'); const reviewer = this.seatOf(reviewerRunId, 'reviewer'); const planner = this.seatOf(plannerRunId, 'planner');
    const challenger = challengerRunId ? this.seatOf(challengerRunId, 'challenger') : null;
    if (builder.engine !== 'claude' || planner.engine !== 'claude' || reviewer.engine !== 'codex' || (challenger && challenger.engine !== 'gemini')) throw new HubError('TABLE_ENGINES', 'A hierarchy Round Table seats Claude as builder and planner, Codex as reviewer, and Gemini as its challenger.');
    const runs = ids.map((id) => this.host.run(id)!);
    if (runs.some((run) => run.cwd !== runs[0].cwd)) throw new HubError('TABLE_FOLDER', 'All the agents must work in the same folder.');
    if (runs.some((run) => run.owner !== owner)) throw new HubError('TABLE_OWNER', 'All the chats must be open in this window.');
    const before = saved.chain;
    // A chain cut short by a restart comes back stopped at its step: Continue picks it up.
    const resumable = before && !RESTING.includes(before.step) ? before.step : null;
    const chain: Chain = { owner, cwd: runs[0].cwd, builder, reviewer, planner, challenger, step: before ? (resumable ? 'stopped' : before.step) : 'idle', stoppedAt: resumable ?? (before?.step === 'stopped' ? before.stoppedAt ?? null : null),
      task: before?.task ?? '', images: [], plan: before?.plan ?? '', report: before?.report ?? '', reviewRound: before?.reviewRound ?? 0, finalRound: before?.finalRound ?? 0, verdict: before?.verdict ?? null, note: before?.note ?? '',
      challenges: (before?.challenges ?? []).slice(0, MAX_CHALLENGES).map((challenge) => ({ ...challenge })), challenged: before?.challenged === true, geminiReviewed: before?.geminiReviewed === true, compared: before?.compared === true,
      firstFinding: Math.min(before?.firstFinding ?? 0, (saved.findings ?? []).length),
      findings: (saved.findings ?? []).slice(0, MAX_FINDINGS).map((finding) => ({ ...finding })), queued: null, kept: false, turnStart: null, blocked: null, attempt: 0, geminiBefore: null, checking: false };
    chain.firstFinding = Math.min(chain.firstFinding, chain.findings.length);
    // A seat that was waiting for the person before the restart still is (Gemini only if it is seated again).
    if (before?.blocked && chain.step === 'stopped') chain.blocked = { builder, reviewer, planner, challenger }[before.blocked] ?? null;
    if (saved.waiting !== undefined || saved.waitingImages?.length) { chain.queued = { text: saved.waiting ?? '', images: (saved.waitingImages ?? []).slice(0, MAX_IMAGES) }; chain.kept = true; }
    this.chains.set(builderRunId, chain);
    this.host.setReadOnly(builder.runId, false); this.host.setReadOnly(reviewer.runId, true); this.host.setReadOnly(planner.runId, true); if (challenger) this.host.setReadOnly(challenger.runId, true);
    this.publish(chain); return this.state(chain);
  }

  /** The person's message: a new task when the table is free, a revision while the plan waits, otherwise it goes with the next step. */
  send(leadRunId: string, text: string, images: ChatImage[]) {
    const chain = this.leading(leadRunId);
    if (chain.kept) throw new HubError('TABLE_KEPT', 'A message from before Trace restarted is waiting. Send it or drop it first (on the Round Table bar).');
    if (chain.step === 'plan-review') { this.plan(leadRunId, false, text); return; }
    // A seat that asked the person (TASK BLOCKED) gets the answer and goes on with its step.
    if (chain.step === 'stopped' && chain.blocked && chain.stoppedAt && !this.busy(chain)) {
      const seat = chain.blocked; chain.blocked = null; chain.note = ''; const answer = `[The person answers] ${text}\n\nGo on with your step.`;
      // Gemini starts a fresh conversation after a restart, so it gets the whole step again with the answer.
      if (seat.role === 'challenger') this.geminiTurn(chain, chain.stoppedAt, `${this.geminiPrompt(chain, chain.stoppedAt)}\n\n[The person answers your question] ${text}`, images); else this.turn(chain, seat, chain.stoppedAt, answer, images);
      return;
    }
    if (this.busy(chain)) {
      if (chain.queued && chain.queued.images.length + images.length > MAX_IMAGES) throw new HubError('TABLE_IMAGES', `The waiting messages already have ${chain.queued.images.length} images and a message carries at most ${MAX_IMAGES}.`);
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
    chain.challenges = []; chain.challenged = false; chain.geminiReviewed = false; chain.compared = false; chain.firstFinding = chain.findings.length;
    this.turn(chain, chain.planner, 'planning', this.planPrompt(chain), images);
  }
  /**
   * The person's reply while the table waits for them: it goes with the stopped step when it continues; with no plan
   * yet, to the planner with the task; otherwise to the builder as changes, which the planner then reviews again.
   */
  private reply(chain: Chain, leadRunId: string, text: string, images: ChatImage[]) {
    chain.note = '';
    if (chain.step === 'stopped' && chain.stoppedAt) { chain.queued = { text, images: images.slice(0, MAX_IMAGES) }; chain.kept = false; this.continue(leadRunId); return; }
    if (!chain.plan) { this.turn(chain, chain.planner, 'planning', `${this.planPrompt(chain)}\n\nThe person adds: ${text}`, images); return; }
    this.turn(chain, chain.builder, 'final-fixing', `[Step: changes from the person] The task:\n\n${chain.task}\n\nThe person says:\n\n${text}\n\nMake the changes they ask for, then report what you changed.`, images);
  }
  /** The person on the plan: approve it (the builder starts), or send it back with what to change. */
  plan(leadRunId: string, approve: boolean, note = '') {
    const chain = this.leading(leadRunId);
    if (chain.step !== 'plan-review') throw new HubError('TABLE_STEP', 'There is no plan waiting for you.');
    if (approve) this.turn(chain, chain.builder, 'implementing', this.buildPrompt(chain), chain.images);
    else { if (!note.trim()) throw new HubError('TABLE_NOTE', 'Say what to change in the plan.'); this.turn(chain, chain.planner, 'planning', this.planPrompt(chain, note)); }
    return this.state(chain);
  }
  /** Picks a stopped chain up at its step (after Stop, or a restart). `skipGemini`: a stopped Gemini step is passed over. */
  continue(leadRunId: string, skipGemini = false) {
    const chain = this.leading(leadRunId); const step = chain.stoppedAt;
    if (chain.step !== 'stopped' || !step) throw new HubError('TABLE_STEP', 'Nothing was stopped part way.');
    // A stopped seat's turn ends with a late `done`; a new turn begun before it would take that `done` as its own end.
    if (this.busy(chain)) throw new HubError('TABLE_STOPPING', 'The agent is still stopping. Continue once it has stopped.');
    const geminiStep = GEMINI_STEPS.includes(step);
    if (skipGemini && !geminiStep) throw new HubError('TABLE_STEP', 'Gemini is not at work in this step.');
    chain.blocked = null;
    // Passed over: asked for, or Gemini is no longer seated (agy was not found when the table opened again).
    if (geminiStep && (skipGemini || !chain.challenger)) { this.skipGemini(chain, step, skipGemini ? 'Gemini was left out of this step at your request.' : 'Gemini is not seated at this table now, so its step was passed over.'); return this.state(chain); }
    if (step === 'planning') this.turn(chain, chain.planner, 'planning', this.planPrompt(chain), chain.images);
    else if (step === 'challenging') this.geminiTurn(chain, 'challenging', this.challengePrompt(chain));
    else if (step === 'plan-responding') this.turn(chain, chain.planner, 'plan-responding', this.answerPrompt(chain));
    else if (step === 'implementing') this.turn(chain, chain.builder, 'implementing', this.buildPrompt(chain), chain.images);
    else if (step === 'second-reviewing') this.geminiTurn(chain, 'second-reviewing', this.geminiReviewPrompt(chain));
    else if (step === 'reviewing') this.turn(chain, chain.reviewer, 'reviewing', this.reviewPrompt(chain));
    else if (step === 'comparing') this.geminiTurn(chain, 'comparing', this.comparePrompt(chain));
    else if (step === 'fixing') this.turn(chain, chain.builder, 'fixing', this.fixPrompt(chain));
    else if (step === 'final') this.turn(chain, chain.planner, 'final', this.finalPrompt(chain));
    else if (step === 'final-fixing') this.turn(chain, chain.builder, 'final-fixing', this.finalFixPrompt(chain));
    return this.state(chain);
  }
  waiting(leadRunId: string, send: boolean) {
    const chain = this.leading(leadRunId); if (!chain.queued) return this.state(chain);
    chain.kept = false;
    if (!send) chain.queued = null;
    else if (!this.busy(chain) && (chain.step === 'idle' || chain.step === 'done' || chain.step === 'needs-you')) { const { text, images } = chain.queued; chain.queued = null; this.send(leadRunId, text, images); return this.state(chain); }
    this.publish(chain); return this.state(chain);
  }
  /** Stops the seat at work; the chain waits at its step for Continue. */
  stop(leadRunId: string) {
    const chain = this.leading(leadRunId); if (!chain.kept) chain.queued = null; chain.blocked = null;
    if (!RESTING.includes(chain.step)) { chain.stoppedAt = chain.step; chain.step = 'stopped'; }
    for (const seat of this.seats(chain)) if (seat.busy) this.host.interrupt(seat.runId);
    this.publish(chain);
  }
  close(leadRunId: string, byPerson = true) {
    const chain = this.chains.get(leadRunId); if (!chain) return;
    this.chains.delete(leadRunId);
    for (const seat of this.seats(chain)) { try { this.host.setReadOnly(seat.runId, false); } catch { /* Ended. */ } }
    this.host.emit(chain.owner, { sessionId: chain.builder.sessionId, runId: chain.builder.runId, event: { type: 'table', table: null, ...(byPerson ? { closed: true as const } : {}) } });
  }
  /**
   * A seat's process ended: the table closes until the window seats it again. Gemini's ending part way through a step
   * (a crash) still gets the file check against the files as its step began, and the table is kept stopped at that step,
   * so what Gemini changed before it ended is not missed and Continue picks the step up once Gemini runs again.
   */
  ended(runId: string) {
    const chain = this.chainOf(runId); if (!chain) return;
    const gemini = chain.challenger?.runId === runId ? chain.challenger : null;
    const inStep = gemini && (gemini.busy || chain.geminiBefore !== null || chain.checking) && (GEMINI_STEPS.includes(chain.step) || (chain.step === 'stopped' && chain.stoppedAt !== null && GEMINI_STEPS.includes(chain.stoppedAt)));
    if (!gemini || !inStep) { this.close(chain.builder.runId, false); return; }
    const step = chain.step === 'stopped' ? chain.stoppedAt! : chain.step; const before = chain.geminiBefore;
    // Ended while Trace was still reading the files before the turn: Gemini was never given the step.
    const started = gemini.busy || before !== null;
    // Out of the map at once: nothing else starts at this table; its last state still goes to the window, which keeps it.
    this.chains.delete(chain.builder.runId);
    gemini.busy = false; chain.checking = false; chain.geminiBefore = null; chain.blocked = null; chain.stoppedAt = step; chain.step = 'stopped';
    chain.note = 'Gemini\'s process ended during its step. Trace is checking the project\'s files…'; this.publish(chain);
    const check = this.host.stateOf ? this.host.stateOf(chain.cwd).catch(() => null) : Promise.resolve(null);
    void check.then((after) => {
      chain.note = !started
        ? 'Gemini\'s process ended before its step began. Reopen starts Gemini again; then Continue runs the step, or Continue without Gemini.'
        : !before || !after
        ? 'Gemini\'s process ended during its step, and Trace could not read the project\'s files to tell whether it changed them. Check them (git status) before you go on. Reopen starts Gemini again; then Continue runs the step again, or Continue without Gemini.'
        : before !== after
          ? 'Gemini\'s process ended during its step, and the project\'s files changed during it; only the builder may change them. Check the changes (git status, git diff). Reopen starts Gemini again; then Continue runs the step again, or Continue without Gemini.'
          : 'Gemini\'s process ended during its step; the project\'s files did not change. Reopen starts Gemini again; then Continue runs the step again, or Continue without Gemini.';
      this.publish(chain);
      for (const seat of this.seats(chain)) { if (seat.busy) { try { this.host.interrupt(seat.runId); } catch { /* Ended. */ } } try { this.host.setReadOnly(seat.runId, false); } catch { /* Ended. */ } }
      this.host.emit(chain.owner, { sessionId: chain.builder.sessionId, runId: chain.builder.runId, event: { type: 'table', table: null } });
    });
  }

  /** Every chat event passes here; returns a notice in place of an edit a read-only seat asked for (declined), or '' for a command allowed at Full. */
  observe(envelope: ChatEnvelope): string | null {
    const { runId, event } = envelope; const chain = this.chainOf(runId); if (!chain) return null;
    const seat = this.seats(chain).find((item) => item.runId === runId)!;
    if (event.type === 'assistant') { const words = event.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n'); if (words) seat.text = seat.text ? `${seat.text}\n${words}` : words; return null; }
    if (event.type === 'permission' && seat.role !== 'builder' && EDITS.has(event.toolName)) {
      this.host.answer(runId, event.requestId, false);
      return `Trace declined ${event.toolName} for the ${seat.role === 'challenger' ? 'Gemini seat' : seat.role}: only the builder edits files.`;
    }
    // At Full access a read-only seat's commands run without an approval card, as the person's level says.
    if (event.type === 'permission' && seat.role !== 'builder' && allowAtFull(this.host, runId, event.requestId)) return '';
    if (event.type !== 'done' || !seat.busy) return null;
    seat.busy = false; seat.answer = seat.text.trim(); seat.text = '';
    if (seat.role === 'challenger') { void this.afterGemini(chain, seat, event); return null; }
    this.finished(chain, seat, event);
    return null;
  }
  /** A seat's turn ended: an error or a stop leaves the chain stopped at its step; otherwise the next step. */
  private finished(chain: Chain, seat: Seat, event: { isError: boolean; error: string | null }) {
    if (event.isError || chain.step === 'stopped' || chain.step === 'needs-you') { if (chain.step !== 'stopped') { chain.stoppedAt = chain.step; chain.step = 'stopped'; chain.note = event.error ?? 'The agent stopped with an error.'; } this.publish(chain); return; }
    void this.advance(chain, seat).catch((error: unknown) => { chain.stoppedAt = chain.step; chain.step = 'stopped'; chain.note = `Trace could not finish this step (${error instanceof Error ? error.message : String(error)}). Continue tries it again.`; this.publish(chain); });
  }
  /**
   * Gemini's turn ended (answered, stopped or failed): before anything else, the project's files are compared with how
   * they were when it began. Any change stops the table at that step, whatever Gemini answered: the person looks first.
   */
  private async afterGemini(chain: Chain, seat: Seat, event: { isError: boolean; error: string | null }) {
    const step = chain.step === 'stopped' ? chain.stoppedAt : chain.step; const before = chain.geminiBefore;
    chain.checking = true; this.publish(chain);
    let after: string | null = null; try { after = this.host.stateOf ? await this.host.stateOf(chain.cwd) : null; } catch { after = null; }
    chain.checking = false; chain.geminiBefore = null;
    if (this.chains.get(chain.builder.runId) !== chain) return;
    if (!before || !after || before !== after) {
      chain.stoppedAt = step ?? chain.stoppedAt; chain.step = 'stopped'; chain.blocked = null;
      chain.note = !before || !after
        ? 'Trace could not read the project\'s files after Gemini\'s step, so it cannot tell whether Gemini changed them. Check them (git status), then Continue to run the step again, or Continue without Gemini.'
        : 'The project\'s files changed during Gemini\'s step, and only the builder may change them. Trace stopped the table. Check the changes (git status, git diff), then Continue to run the step again, or Continue without Gemini.';
      this.publish(chain); return;
    }
    this.finished(chain, seat, event);
  }

  /** A seat finished its step: record what it said, then the next step. */
  private async advance(chain: Chain, seat: Seat) {
    const answer = seat.answer ?? '';
    // A seat that needs the person stops the chain at its step; the person's answer goes back to it (send).
    const signal = taskSignal(answer);
    if (signal?.kind === 'blocked') { chain.stoppedAt = chain.step; chain.step = 'stopped'; chain.blocked = seat; chain.note = `The ${seat.role === 'challenger' ? 'Gemini seat' : seat.role} needs you: ${signal.reason}`; this.publish(chain); return; }
    const step = chain.step; const attempt = chain.attempt;
    // Reads into the record, then goes on only if this is still the same turn: Stop, or Stop then Continue (a new turn at
    // the same step), while the files' state was being taken leaves the old answer behind.
    const recorded = async () => { await this.record(chain, seat); return this.chains.get(chain.builder.runId) === chain && chain.step === step && chain.attempt === attempt; };
    if (chain.step === 'planning') {
      chain.plan = answer.replace(/\n?\s*PLAN READY\s*$/i, '').trim();
      if (!chain.plan) { chain.step = 'needs-you'; chain.note = 'The planner wrote no plan.'; this.publish(chain); return; }
      chain.note = '';
      if (this.gemini(chain, 'challenge')) { this.geminiTurn(chain, 'challenging', this.challengePrompt(chain)); return; }
      chain.step = 'plan-review'; this.publish(chain); return;
    }
    if (chain.step === 'challenging') {
      if (!isChallenge(answer)) { chain.stoppedAt = 'challenging'; chain.step = 'stopped'; chain.note = 'Gemini ended without CHALLENGE lines or NO CHALLENGES. Continue runs the challenge again, or Continue without Gemini.'; this.publish(chain); return; }
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
      if (this.gemini(chain, 'review')) { this.geminiTurn(chain, 'second-reviewing', this.geminiReviewPrompt(chain)); return; }
      this.turn(chain, chain.reviewer, 'reviewing', this.reviewPrompt(chain)); return;
    }
    if (chain.step === 'second-reviewing') {
      if (!isReview(answer)) { chain.stoppedAt = 'second-reviewing'; chain.step = 'stopped'; chain.note = 'Gemini ended its review without findings or NO FINDINGS. Continue runs it again, or Continue without Gemini.'; this.publish(chain); return; }
      if (!await recorded()) return;
      chain.geminiReviewed = true; this.turn(chain, chain.reviewer, 'reviewing', this.reviewPrompt(chain)); return;
    }
    if (chain.step === 'reviewing') {
      if (!isReview(answer)) { chain.stoppedAt = 'reviewing'; chain.step = 'stopped'; chain.note = 'The reviewer ended without findings or NO FINDINGS. Continue runs the review again.'; this.publish(chain); return; }
      if (!await recorded()) return;
      if (chain.reviewRound === 1 && this.gemini(chain, 'compare')) { this.geminiTurn(chain, 'comparing', this.comparePrompt(chain)); return; }
      if (chain.reviewRound === 1 && chain.geminiReviewed) chain.compared = true;
      this.afterReview(chain); return;
    }
    if (chain.step === 'comparing') {
      if (!isComparison(answer)) { chain.stoppedAt = 'comparing'; chain.step = 'stopped'; chain.note = 'Gemini ended without AGREE, DISPUTE or DUPLICATE lines or COMPARED. Continue runs the comparison again, or Continue without Gemini.'; this.publish(chain); return; }
      this.compare(chain, answer); chain.compared = true; this.afterReview(chain); return;
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
      if (verdict?.approved) { chain.verdict = 'approved'; chain.step = 'done'; chain.note = ''; this.publish(chain); return; }
      if (!verdict) { chain.step = 'needs-you'; chain.note = 'The planner ended its final review without APPROVED or CHANGES NEEDED.'; this.publish(chain); return; }
      chain.verdict = 'changes'; chain.note = verdict.changes;
      if (chain.finalRound >= FINAL_ROUNDS) { chain.step = 'needs-you'; chain.note = `The planner still asks for changes after ${FINAL_ROUNDS} rounds: ${verdict.changes}`; this.publish(chain); return; }
      // Back to the fix step: the builder makes the changes, the reviewer checks them once more, then the final review again.
      chain.finalRound++; chain.reviewRound = REVIEW_ROUNDS - 1; this.turn(chain, chain.builder, 'fixing', this.fixPrompt(chain)); return;
    }
    this.publish(chain);
  }
  /** After a review (and Gemini's comparison): the builder fixes what is open, or the planner reviews the whole. */
  private afterReview(chain: Chain) {
    if (chain.findings.some((finding) => finding.status === 'open' && !finding.duplicateOf)) { this.turn(chain, chain.builder, 'fixing', this.fixPrompt(chain)); return; }
    this.turn(chain, chain.planner, 'final', this.finalPrompt(chain));
  }
  /** Gemini's comparison into the record: its agreement or dispute on Codex's findings, and duplicates closed. */
  private compare(chain: Chain, answer: string) {
    // Only this task's findings: an earlier task's finding (verified or not) is neither judged nor a duplicate's original.
    const task = this.taskFindings(chain); const find = (id: string) => task.find((finding) => finding.id === id);
    for (const { id, verdict, of, note } of parseComparison(answer)) {
      const finding = find(id); if (!finding) continue;
      if (verdict === 'duplicate') {
        const original = of ? find(of) : undefined;
        if (!original || original === finding || original.duplicateOf || original.status !== 'open' || finding.duplicateOf || finding.status !== 'open') continue;
        finding.duplicateOf = original.id; finding.status = 'verified'; finding.check = `Duplicate of ${original.id} (Gemini)`; continue;
      }
      // Gemini's word is on Codex's findings; its own need none.
      if (finding.source === 'gemini') continue;
      finding.gemini = verdict; if (note) finding.geminiNote = note; else delete finding.geminiNote;
    }
  }

  /** Reads a seat's answer into the review record (new findings and checks from the reviewer and Gemini's review; FIXED/DECLINED from the builder), noting the files' state. */
  private async record(chain: Chain, seat: Seat) {
    if (seat.role === 'planner' || (seat.role === 'challenger' && chain.step !== 'second-reviewing')) return;
    const changed: Finding[] = []; const at = new Date().toISOString(); const answer = seat.answer ?? '';
    if (seat.role === 'reviewer' || seat.role === 'challenger') for (const found of parseFindings(answer)) {
      if (chain.findings.length >= MAX_FINDINGS) break;
      const finding: Finding = { id: `F${chain.findings.length + 1}`, ...found, status: 'open', response: '', check: '', reviewedAt: null, changedAt: null, round: Math.min(5, chain.reviewRound), at, ...(seat.role === 'challenger' ? { source: 'gemini' as const } : {}) };
      chain.findings.push(finding); changed.push(finding);
    }
    if (seat.role !== 'challenger') for (const { id, verb, note } of parseAnswers(answer, seat.role === 'reviewer' ? 'reviewer' : 'driver')) { const finding = chain.findings.find((item) => item.id === id); if (finding && !finding.duplicateOf && apply(finding, verb, note) && !changed.includes(finding)) changed.push(finding); }
    if (!changed.length || !this.host.stateOf) return;
    const [before, after] = await Promise.all([chain.turnStart ?? Promise.resolve(null), this.host.stateOf(chain.cwd).catch(() => null)]);
    const short = after ? after.slice(0, 12) : null; const moved = before !== null && after !== null && before !== after;
    for (const finding of changed) { if (finding.status === 'open' && !finding.reviewedAt) { finding.reviewedAt = short; if (moved && seat.role === 'reviewer') finding.filesChanged = true; } else finding.changedAt = short; }
  }
}
