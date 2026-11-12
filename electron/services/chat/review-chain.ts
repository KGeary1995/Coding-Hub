import { type ChainStep, type ChatEnvelope, type ChatImage, type PlanChallenge, type RoundTableState, type SavedChain } from '../../../shared/chat';
import { HubError } from '../cli/engine-adapter';
import { apply, type Finding, findingsFor, MAX_FINDINGS, parseAnswers, parseChallengeAnswers, parseChallenges, parseFindings } from '../../../shared/findings';
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

type Role = 'planner' | 'builder' | 'reviewer';
interface Seat { runId: string; sessionId: string; engine: 'claude' | 'codex'; role: Role; busy: boolean; text: string; answer: string | null; briefed: boolean }
interface Chain {
  owner: number; cwd: string; builder: Seat; reviewer: Seat; planner: Seat;
  step: ChainStep; stoppedAt: ChainStep | null; task: string; images: ChatImage[]; plan: string; report: string; reviewRound: number; finalRound: number;
  verdict: 'approved' | 'changes' | null; note: string; findings: Finding[];
  /** This task's challenges, and whether its plan was challenged yet (once per task). */
  challenges: PlanChallenge[]; challenged: boolean;
  queued: { text: string; images: ChatImage[] } | null; kept: boolean; turnStart: Promise<string | null> | null;
  /** The seat that said TASK BLOCKED: the person's next message is its answer, in the same step. */
  blocked: Seat | null;
  /** Counts turns: a step's answer is acted on only if no newer turn began meanwhile (Stop and Continue start one). */
  attempt: number;
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
 * The task is complete only on APPROVED. Trace passes each step's output to the next seat.
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
    return { runId, sessionId: run.sessionId, engine: run.engine, role, busy: false, text: '', answer: null, briefed: false };
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
      chain: { step: chain.step, ...(chain.stoppedAt ? { stoppedAt: chain.stoppedAt } : {}), ...(chain.blocked ? { blocked: chain.blocked.role } : {}), reviewRound: chain.reviewRound, finalRound: chain.finalRound, plan: chain.plan, verdict: chain.verdict, note: chain.note, task: chain.task, report: chain.report,
        ...(chain.challenges.length ? { challenges: chain.challenges.map((challenge) => ({ ...challenge })) } : {}), ...(chain.challenged ? { challenged: true as const } : {}) },
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
        : 'You are the reviewer. You challenge the planner\'s plan before the person sees it, and later review the builder\'s changes in the files. You do not edit files.';
    const steps = 'Steps: the planner plans, the reviewer (Codex) challenges the plan and the planner answers, the person approves the plan, the builder implements, the reviewer reviews, the builder fixes, and the planner gives the final review.';
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
  // The prompts for each step.
  private planPrompt(chain: Chain, note?: string) {
    return note
      ? `[Step: plan, revised] The person asks you to revise the plan:\n\n${note}\n\nWrite the whole plan again, as numbered steps, with the files to change and how to check the result. End with the line PLAN READY.`
      : `[Step: plan] The task:\n\n${chain.task}\n\nRead what you need in the project, then write a plan the builder can follow: numbered steps, the files to change, and how to check the result. Do not change files. End with the line PLAN READY.`;
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
      task: before?.task ?? '', images: [], plan: before?.plan ?? '', report: before?.report ?? '', reviewRound: before?.reviewRound ?? 0, finalRound: before?.finalRound ?? 0, verdict: before?.verdict ?? null, note: before?.note ?? '',
      challenges: (before?.challenges ?? []).slice(0, MAX_CHALLENGES).map((challenge) => ({ ...challenge })), challenged: before?.challenged === true,
      findings: (saved.findings ?? []).slice(0, MAX_FINDINGS).map((finding) => ({ ...finding })), queued: null, kept: false, turnStart: null, blocked: null, attempt: 0 };
    // A seat that was waiting for the person before the restart still is.
    if (before?.blocked && chain.step === 'stopped') chain.blocked = { builder, reviewer, planner }[before.blocked] ?? null;
    if (saved.waiting !== undefined || saved.waitingImages?.length) { chain.queued = { text: saved.waiting ?? '', images: (saved.waitingImages ?? []).slice(0, MAX_IMAGES) }; chain.kept = true; }
    this.chains.set(builderRunId, chain);
    this.host.setReadOnly(builder.runId, false); this.host.setReadOnly(reviewer.runId, true); this.host.setReadOnly(planner.runId, true);
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
      this.turn(chain, seat, chain.stoppedAt, answer, images);
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
    chain.challenges = []; chain.challenged = false;
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
  /** A seat's process ended: the table closes until the window seats it again. */
  ended(runId: string) {
    const chain = this.chainOf(runId); if (chain) this.close(chain.builder.runId, false);
  }

  /** Every chat event passes here; returns a notice in place of an edit a read-only seat asked for (declined), or '' for a command allowed at Full. */
  observe(envelope: ChatEnvelope): string | null {
    const { runId, event } = envelope; const chain = this.chainOf(runId); if (!chain) return null;
    const seat = this.seats(chain).find((item) => item.runId === runId)!;
    if (event.type === 'assistant') { const words = event.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n'); if (words) seat.text = seat.text ? `${seat.text}\n${words}` : words; return null; }
    if (event.type === 'permission' && seat.role !== 'builder' && EDITS.has(event.toolName)) {
      this.host.answer(runId, event.requestId, false);
      return `Trace declined ${event.toolName} for the ${seat.role}: only the builder edits files.`;
    }
    // At Full access a read-only seat's commands run without an approval card, as the person's level says.
    if (event.type === 'permission' && seat.role !== 'builder' && allowAtFull(this.host, runId, event.requestId)) return '';
    if (event.type !== 'done' || !seat.busy) return null;
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
      chain.plan = answer.replace(/\n?\s*PLAN READY\s*$/i, '').trim();
      if (!chain.plan) { chain.step = 'needs-you'; chain.note = 'The planner wrote no plan.'; this.publish(chain); return; }
      chain.note = '';
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
      if (verdict?.approved) { chain.verdict = 'approved'; chain.step = 'done'; chain.note = ''; this.publish(chain); return; }
      if (!verdict) { chain.step = 'needs-you'; chain.note = 'The planner ended its final review without APPROVED or CHANGES NEEDED.'; this.publish(chain); return; }
      chain.verdict = 'changes'; chain.note = verdict.changes;
      if (chain.finalRound >= FINAL_ROUNDS) { chain.step = 'needs-you'; chain.note = `The planner still asks for changes after ${FINAL_ROUNDS} rounds: ${verdict.changes}`; this.publish(chain); return; }
      // Back to the fix step: the builder makes the changes, the reviewer checks them once more, then the final review again.
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
      if (chain.findings.length >= MAX_FINDINGS) break;
      const finding: Finding = { id: `F${chain.findings.length + 1}`, ...found, status: 'open', response: '', check: '', reviewedAt: null, changedAt: null, round: Math.min(5, chain.reviewRound), at };
      chain.findings.push(finding); changed.push(finding);
    }
    for (const { id, verb, note } of parseAnswers(answer, seat.role === 'reviewer' ? 'reviewer' : 'driver')) { const finding = chain.findings.find((item) => item.id === id); if (finding && !finding.duplicateOf && apply(finding, verb, note) && !changed.includes(finding)) changed.push(finding); }
    if (!changed.length || !this.host.stateOf) return;
    const [before, after] = await Promise.all([chain.turnStart ?? Promise.resolve(null), this.host.stateOf(chain.cwd).catch(() => null)]);
    const short = after ? after.slice(0, 12) : null; const moved = before !== null && after !== null && before !== after;
    for (const finding of changed) { if (finding.status === 'open' && !finding.reviewedAt) { finding.reviewedAt = short; if (moved && seat.role === 'reviewer') finding.filesChanged = true; } else finding.changedAt = short; }
  }
}
