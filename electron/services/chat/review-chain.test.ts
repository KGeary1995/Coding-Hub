import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent, ChatImage } from '../../../shared/chat';
import type { TableHost } from './round-table';
import { FINAL_ROUNDS, isReview, legacySeats, REVIEW_ROUNDS, ReviewChains, verdictOf } from './review-chain';
import { SIGNAL_INSTRUCTION } from '../../../shared/task-signal';
import { savedChainSchema } from '../../../shared/schemas';
import { forFollowers } from '../remote/chat-replay';

const BUILDER = '11111111-1111-4111-8111-111111111111'; const REVIEWER = '22222222-2222-4222-8222-222222222222'; const PLANNER = '33333333-3333-4333-8333-333333333333';
function setup() {
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex'; cwd: string; owner: number; permissions?: 'ask' | 'edits' | 'full' }> = {
    [BUILDER]: { sessionId: 'builder', engine: 'claude', cwd: '/p', owner: 1 }, [REVIEWER]: { sessionId: 'reviewer', engine: 'codex', cwd: '/p', owner: 1 }, [PLANNER]: { sessionId: 'planner', engine: 'claude', cwd: '/p', owner: 1 },
  };
  const sent: { runId: string; text: string; images: ChatImage[] }[] = []; const modes: Record<string, boolean> = {}; const answers: { requestId: string; allow: boolean }[] = []; const interrupted: string[] = []; const events: ChatEnvelope[] = [];
  const host: TableHost = { run: (id) => runs[id] ?? null, send: (runId, text, images) => { sent.push({ runId, text, images }); }, setReadOnly: (id, ro) => { modes[id] = ro; }, answer: (_r, requestId, allow) => { answers.push({ requestId, allow }); }, interrupt: (id) => { interrupted.push(id); }, emit: (_o, e) => { events.push(e); } };
  const chains = new ReviewChains(host);
  const reply = async (runId: string, text: string, isError = false) => {
    const event: ChatEvent = { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] }; chains.observe({ sessionId: runs[runId].sessionId, runId, event });
    chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'done', isError, error: isError ? 'crashed' : null } }); await new Promise((resolve) => setTimeout(resolve, 0));
    // The reviewer challenges each task's plan once (review-chain-challenge.test.ts); here it has none.
    if (challenges.auto && runId === PLANNER && last().chain?.step === 'challenging') await reply(REVIEWER, 'NO CHALLENGES');
  };
  const challenges = { auto: true };
  const last = () => (events.filter((e) => e.event.type === 'table').at(-1)!.event as Extract<ChatEvent, { type: 'table' }>).table!;
  const tables = () => events.filter((e) => e.event.type === 'table').map((e) => (e.event as Extract<ChatEvent, { type: 'table' }>).table!);
  return { chains, sent, modes, answers, interrupted, reply, last, runs, challenges, tables, events };
}
/** A table at its final review: the task given, the plan approved, built, and reviewed with no findings. */
async function atFinal(task = 'Add a footer.') {
  const table = setup(); const { chains, reply, last } = table; chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, task, []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
  await reply(BUILDER, 'Built.'); await reply(REVIEWER, 'NO FINDINGS'); expect(last().chain!.step).toBe('final');
  return table;
}
const IMAGE = (n: number) => ({ mediaType: 'image/png' as const, data: `iVBORw0KGgo${n}` });

describe('hierarchy Round Table', () => {
  it('plans, waits for the plan to be approved, builds, reviews, fixes, and completes only on the planner’s APPROVED', async () => {
    const { chains, sent, modes, reply, last } = setup();
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER));
    expect(modes).toEqual({ [BUILDER]: false, [REVIEWER]: true, [PLANNER]: true }); expect(last()).toMatchObject({ kind: 'hierarchy', planner: { sessionId: 'planner' }, chain: { step: 'idle' } });
    chains.send(BUILDER, 'Add a footer.', []);
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('You are the planner'); expect(sent.at(-1)!.text).toContain('Add a footer.');
    await reply(PLANNER, '1. Edit page.html\n2. Check it\nPLAN READY');
    expect(last().chain).toMatchObject({ step: 'plan-review', plan: '1. Edit page.html\n2. Check it' }); expect(sent.map((item) => item.runId)).toEqual([PLANNER, REVIEWER]);
    chains.plan(BUILDER, true);
    expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(sent.at(-1)!.text).toContain('1. Edit page.html'); expect(last().chain!.step).toBe('implementing');
    await reply(BUILDER, 'Changed page.html.');
    expect(sent.at(-1)!.runId).toBe(REVIEWER); expect(sent.at(-1)!.text).toContain('Changed page.html.'); expect(last().chain).toMatchObject({ step: 'reviewing', reviewRound: 1 });
    await reply(REVIEWER, 'FINDING medium page.html:3 — footer not closed');
    expect(last().findings).toMatchObject([{ id: 'F1', status: 'open' }]); expect(sent.at(-1)!.runId).toBe(BUILDER); expect(sent.at(-1)!.text).toContain('F1 (medium, page.html:3)');
    await reply(BUILDER, 'FIXED F1: closed the tag');
    expect(last().chain).toMatchObject({ step: 'reviewing', reviewRound: 2 }); expect(sent.at(-1)!.text).toContain('waiting for your check');
    await reply(REVIEWER, 'VERIFIED F1\nNO FINDINGS');
    expect(last().findings![0].status).toBe('verified'); expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('[Step: final review]');
    await reply(PLANNER, 'All good.\nAPPROVED');
    expect(last()).toMatchObject({ agreed: true, phase: 'idle', chain: { step: 'done', verdict: 'approved' } });
  });
  it('sends a plan back with the person’s note, and a message during the plan review counts as that note', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan A\nPLAN READY');
    expect(() => chains.plan(BUILDER, false, ' ')).toThrow(/Say what to change/);
    chains.send(BUILDER, 'Use the existing helper instead.', []);
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER }); expect(sent.at(-1)!.text).toContain('Use the existing helper instead.'); expect(last().chain!.step).toBe('planning');
  });
  it('sends the pictures given with a plan sent back to the planner, and keeps them with the task for Continue and the builder', async () => {
    const { chains, sent, reply } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', [IMAGE(1)]); await reply(PLANNER, 'Plan A\nPLAN READY');
    chains.send(BUILDER, 'Match this layout.', [IMAGE(2)]);
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER, images: [IMAGE(2)] }); expect(sent.at(-1)!.text).toContain('Match this layout.');
    chains.stop(BUILDER); await reply(PLANNER, '', true); chains.continue(BUILDER);
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER, images: [IMAGE(1), IMAGE(2)] });
    await reply(PLANNER, 'Plan B\nPLAN READY'); chains.plan(BUILDER, true);
    expect(sent.at(-1)).toMatchObject({ runId: BUILDER, images: [IMAGE(1), IMAGE(2)] });
    // More than a message carries is refused, not dropped.
    const full = setup(); full.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); full.chains.send(BUILDER, 'Task', Array.from({ length: 9 }, (_, n) => IMAGE(n))); await full.reply(PLANNER, 'Plan\nPLAN READY');
    expect(() => full.chains.send(BUILDER, 'Like these.', [IMAGE(10), IMAGE(11)])).toThrow(/at most 10\. Send at most 1 picture with/); expect(full.last().chain!.step).toBe('plan-review');
    full.chains.send(BUILDER, 'Like this.', [IMAGE(10)]); await full.reply(PLANNER, 'Plan\nPLAN READY');
    expect(() => full.chains.send(BUILDER, 'And this.', [IMAGE(11)])).toThrow(/Send the change without pictures/);
  });
  it('skips the fix step when the reviewer finds nothing, sends CHANGES NEEDED back to the builder, and asks the person after the limit', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    await reply(BUILDER, 'Done.'); await reply(REVIEWER, 'Looks right.\nNO FINDINGS'); expect(last().chain!.step).toBe('final');
    for (let round = 1; round <= FINAL_ROUNDS; round++) {
      // Changes from the final review go back to the fix step, then to the reviewer once more, then to the planner.
      await reply(PLANNER, 'CHANGES NEEDED: rename the class'); expect(last().chain).toMatchObject({ step: 'fixing', finalRound: round }); expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(sent.at(-1)!.text).toContain("The planner's final review asks for changes:\n\nrename the class");
      await reply(BUILDER, 'Renamed.'); expect(last().chain).toMatchObject({ step: 'reviewing', reviewRound: REVIEW_ROUNDS }); expect(sent.at(-1)!.runId).toBe(REVIEWER);
      await reply(REVIEWER, 'NO FINDINGS'); expect(last().chain!.step).toBe('final'); expect(sent.at(-1)!.runId).toBe(PLANNER);
    }
    await reply(PLANNER, 'CHANGES NEEDED: still wrong'); expect(last().chain).toMatchObject({ step: 'needs-you', verdict: 'changes' }); expect(last().chain!.note).toContain(`after ${FINAL_ROUNDS} rounds`);
  });
  it('declines edits from the planner and reviewer, never the builder’s', () => {
    const { chains, answers } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER));
    expect(chains.observe({ sessionId: 'planner', runId: PLANNER, event: { type: 'permission', requestId: 'r1', toolName: 'Write', description: '', input: {}, canAllowEdits: true } })).toContain('only the builder edits');
    expect(chains.observe({ sessionId: 'reviewer', runId: REVIEWER, event: { type: 'permission', requestId: 'r2', toolName: 'File changes', description: '', input: {}, canAllowEdits: true } })).toContain('only the builder edits');
    expect(chains.observe({ sessionId: 'builder', runId: BUILDER, event: { type: 'permission', requestId: 'r3', toolName: 'Write', description: '', input: {}, canAllowEdits: true } })).toBeNull();
    expect(answers).toEqual([{ requestId: 'r1', allow: false }, { requestId: 'r2', allow: false }]);
  });
  it('allows the planner’s and reviewer’s commands at Full access only, still declines their edits, and leaves the builder’s to the person', () => {
    const { chains, answers, runs } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER));
    const ask = (runId: string, requestId: string, toolName: string) => chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'permission', requestId, toolName, description: '', input: {}, canAllowEdits: false } });
    for (const level of ['ask', 'edits'] as const) { runs[PLANNER].permissions = level; runs[REVIEWER].permissions = level; expect(ask(PLANNER, `p-${level}`, 'Bash')).toBeNull(); expect(ask(REVIEWER, `r-${level}`, 'Shell')).toBeNull(); }
    expect(answers).toEqual([]);
    for (const id of [PLANNER, REVIEWER, BUILDER]) runs[id].permissions = 'full';
    expect(ask(PLANNER, 'p1', 'Bash')).toBe(''); expect(ask(REVIEWER, 'r1', 'Shell')).toBe('');
    expect(ask(PLANNER, 'p2', 'Write')).toContain('only the builder edits'); expect(ask(PLANNER, 'p3', 'ExitPlanMode')).toContain('only the builder edits');
    expect(ask(BUILDER, 'b1', 'Bash')).toBeNull();
    expect(answers).toEqual([{ requestId: 'p1', allow: true }, { requestId: 'r1', allow: true }, { requestId: 'p2', allow: false }, { requestId: 'p3', allow: false }]);
  });
  it('stops at a step and continues it; an error stops it too; a restart brings it back stopped at that step', async () => {
    const { chains, sent, interrupted, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    chains.stop(BUILDER); expect(interrupted).toEqual([BUILDER]); expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'implementing' });
    await reply(BUILDER, 'partial'); expect(last().chain!.step).toBe('stopped');
    chains.continue(BUILDER); expect(last().chain!.step).toBe('implementing'); expect(sent.at(-1)!.runId).toBe(BUILDER);
    await reply(BUILDER, 'boom', true); expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'implementing', note: 'crashed' });
    const saved = last().chain!;
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: { ...saved, step: 'reviewing', stoppedAt: undefined }, findings: [] });
    expect(after.last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'reviewing', task: 'Task', plan: 'Plan' }); after.chains.continue(BUILDER); expect(after.sent.at(-1)!.runId).toBe(REVIEWER);
  });
  it('stops when a seat says TASK BLOCKED, and sends the person\u2019s answer back to that seat in the same step', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    await reply(BUILDER, 'Half done.\nTASK BLOCKED: Which database?');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'implementing', note: 'The builder needs you: Which database?' }); expect(sent.at(-1)!.runId).toBe(BUILDER);
    chains.send(BUILDER, 'Use SQLite.', []);
    expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(sent.at(-1)!.text).toContain('[The person answers] Use SQLite.'); expect(last().chain!.step).toBe('implementing');
    await reply(BUILDER, 'Done with SQLite.'); expect(last().chain!.step).toBe('reviewing');
  });
  it('saves a waiting message\u2019s images with the table, as a discussion table does', () => {
    const { chains, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []);
    const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }; chains.send(BUILDER, 'See this.', [image]);
    expect(last()).toMatchObject({ waiting: 'See this.', waitingImages: [image] });
  });
  it('keeps a Stop made while the files\u2019 state is still being taken', async () => {
    const { chains, sent, reply, last } = setup(); let release: (value: string) => void = () => {};
    (chains as unknown as { host: TableHost }).host.stateOf = () => new Promise<string>((resolve) => { release = resolve; });
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    await reply(REVIEWER, 'FINDING high a.ts:1 — bug'); const before = sent.length;
    chains.stop(BUILDER); expect(last().chain!.step).toBe('stopped');
    release('a'.repeat(64)); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(last().chain!.step).toBe('stopped'); expect(sent.length).toBe(before);
  });
  it('after a restart, the answer to a blocked seat still goes to that seat in its step, not to a new task', async () => {
    const { chains, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Original task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    await reply(BUILDER, 'TASK BLOCKED: Which database?'); const saved = last().chain!; expect(saved).toMatchObject({ step: 'stopped', stoppedAt: 'implementing', blocked: 'builder' });
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: saved, findings: [] });
    after.chains.send(BUILDER, 'Use SQLite.', []);
    expect(after.sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(after.sent.at(-1)!.text).toContain('[The person answers] Use SQLite.');
    expect(after.last().chain).toMatchObject({ step: 'implementing', task: 'Original task' });
  });
  it('leaves an old answer behind when Stop then Continue happen while the files’ state is still being taken', async () => {
    const { chains, sent, reply, last } = setup(); const pending: ((value: string) => void)[] = [];
    (chains as unknown as { host: TableHost }).host.stateOf = () => new Promise<string>((resolve) => { pending.push(resolve); });
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    const flush = async () => { for (const resolve of pending.splice(0)) resolve('a'.repeat(64)); for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
    await flush();
    await reply(REVIEWER, 'FINDING high a.ts:1 — bug');
    chains.stop(BUILDER); chains.continue(BUILDER); expect(last().chain!.step).toBe('reviewing'); const before = sent.length;
    await flush();
    // The old review's answer does not move the resumed review on to Fix.
    expect(last().chain!.step).toBe('reviewing'); expect(sent.length).toBe(before); expect(sent.at(-1)!.runId).toBe(REVIEWER);
  });
  it('waits for a stopped seat to stop before Continue, so its late end does not move the resumed step on', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    chains.stop(BUILDER); expect(last()).toMatchObject({ stopping: true, chain: { step: 'stopped', stoppedAt: 'implementing' } });
    // The builder has not ended its interrupted turn yet: Continue is refused rather than taking that end as its own.
    expect(() => chains.continue(BUILDER)).toThrow(/still stopping/); const before = sent.length;
    await reply(BUILDER, 'Half built.'); expect(last().stopping).toBeUndefined(); expect(last().chain!.step).toBe('stopped'); expect(sent.length).toBe(before);
    chains.continue(BUILDER); expect(last().chain!.step).toBe('implementing'); expect(sent.at(-1)!.runId).toBe(BUILDER);
    await reply(BUILDER, 'Built.'); expect(last().chain).toMatchObject({ step: 'reviewing', report: 'Built.' });
  });
  it('keeps a task’s TASK COMPLETE instruction out of the steps, and reads a verdict followed by TASK COMPLETE', async () => {
    const { chains, sent } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER));
    chains.send(BUILDER, `Task t-0123abcd: Add a footer. ${SIGNAL_INSTRUCTION}`, []);
    expect(sent.at(-1)!.text).toContain('Task t-0123abcd: Add a footer.'); expect(sent.at(-1)!.text).not.toContain(SIGNAL_INSTRUCTION); expect(sent.at(-1)!.text).toContain('TASK BLOCKED:');
    expect(verdictOf('Looks right.\nAPPROVED\nTASK COMPLETE')).toEqual({ approved: true }); expect(verdictOf('CHANGES NEEDED: rename it\n**TASK COMPLETE**')).toEqual({ approved: false, changes: 'rename it' });
    expect(verdictOf('TASK COMPLETE')).toBeNull();
  });
  it('takes the person’s reply while the table waits for them as part of the same task, and plans it again once the final review is reached', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Add a footer.', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    await reply(BUILDER, 'Built.'); await reply(REVIEWER, 'NO FINDINGS');
    for (let round = 0; round < FINAL_ROUNDS; round++) { await reply(PLANNER, 'CHANGES NEEDED: rename it'); await reply(BUILDER, 'Renamed.'); await reply(REVIEWER, 'NO FINDINGS'); }
    await reply(PLANNER, 'CHANGES NEEDED: still wrong'); expect(last().chain!.step).toBe('needs-you');
    // Needs you, with a plan: the reply goes to the planner, who plans again; the builder gets nothing until that plan is approved.
    const before = sent.length;
    chains.send(BUILDER, 'Keep the old name, it is fine.', []);
    expect(sent.slice(before).map((item) => item.runId)).toEqual([PLANNER]);
    const prompt = sent.at(-1)!.text; expect(prompt).toContain('[Step: plan again, after the final review]'); expect(prompt).toContain('Keep the old name'); expect(prompt).toContain('Your plan so far:\n\nPlan'); expect(prompt).toContain('still wrong');
    expect(last().chain).toMatchObject({ step: 'planning', finalRound: 0, reviewRound: 0, verdict: null, plan: 'Plan', replan: `The planner still asks for changes after ${FINAL_ROUNDS} rounds: still wrong` });
    expect(last().chain!.task).toContain('Add a footer.'); expect(last().chain!.task).toContain('Keep the old name, it is fine.');
    await reply(PLANNER, 'Plan 2\nPLAN READY');
    // Codex challenges the new plan (none here), and it waits for the person.
    expect(sent.slice(before).map((item) => item.runId)).toEqual([PLANNER, REVIEWER]); expect(last().chain).toMatchObject({ step: 'plan-review', plan: 'Plan 2' }); expect(last().chain).not.toHaveProperty('replan');
    chains.plan(BUILDER, true); expect(sent.at(-1)!.runId).toBe(BUILDER); expect(sent.at(-1)!.text).toContain('Plan 2'); expect(last().chain!.step).toBe('implementing');
    // Stopped before the final review: the reply goes along with the step it continues (the build).
    chains.stop(BUILDER); await reply(BUILDER, 'partial'); chains.send(BUILDER, 'Look at the footer too.', []);
    expect(sent.at(-1)!.runId).toBe(BUILDER); expect(sent.at(-1)!.text).toContain('[Step: implement]'); expect(sent.at(-1)!.text).toContain('The person adds: Look at the footer too.'); expect(last().chain!.step).toBe('implementing');
    // A task from Tasks is still a new task; so is a message once the work is done.
    chains.stop(BUILDER); await reply(BUILDER, 'partial'); chains.send(BUILDER, `Task t-0123abcd: Other. ${SIGNAL_INSTRUCTION}`, []);
    expect(last().chain).toMatchObject({ step: 'planning', task: 'Task t-0123abcd: Other.' });
    await reply(PLANNER, 'Plan B\nPLAN READY'); chains.plan(BUILDER, true); await reply(BUILDER, 'Done.'); await reply(REVIEWER, 'NO FINDINGS'); await reply(PLANNER, 'APPROVED');
    chains.send(BUILDER, 'Next thing.', []); expect(last().chain).toMatchObject({ step: 'planning', task: 'Next thing.' });
  });
  it('sends a reply to the planner with the task when the table stopped before there was a plan', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Add a footer.', []);
    await reply(PLANNER, '   '); expect(last().chain!.step).toBe('needs-you');
    chains.send(BUILDER, 'Write the plan for page.html only.', []);
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('Add a footer.'); expect(sent.at(-1)!.text).toContain('The person adds: Write the plan for page.html only.'); expect(last().chain!.task).toBe('Add a footer.');
  });
  it('tells only the planner that it writes its plan in the reply, not in a plan file', async () => {
    const { chains, sent, reply } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []);
    const brief = 'write the whole plan in your reply, not in a plan file, and do not call ExitPlanMode';
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain(brief);
    // The reviewer is briefed at its first turn: the challenge to the plan.
    const toReviewer = sent.length;
    await reply(PLANNER, 'Plan'); expect(sent[toReviewer].runId).toBe(REVIEWER); expect(sent[toReviewer].text).toContain('You are the reviewer'); expect(sent[toReviewer].text).not.toContain(brief);
    chains.plan(BUILDER, true); expect(sent.at(-1)!.runId).toBe(BUILDER); expect(sent.at(-1)!.text).toContain('You are the builder'); expect(sent.at(-1)!.text).not.toContain(brief);
    await reply(BUILDER, 'Built.'); expect(sent.at(-1)!.runId).toBe(REVIEWER); expect(sent.at(-1)!.text).not.toContain('You are the reviewer'); expect(sent.at(-1)!.text).not.toContain(brief);
  });
  it('stops at the review when the reviewer ends without findings or NO FINDINGS, and Continue sends the review again', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    for (const answer of ['', 'Should I also check the tests?']) {
      const before = sent.length; await reply(REVIEWER, answer);
      expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'reviewing', note: 'The reviewer ended without findings or NO FINDINGS. Continue runs the review again.' }); expect(sent.length).toBe(before);
      chains.continue(BUILDER); expect(sent.at(-1)!.runId).toBe(REVIEWER); expect(sent.at(-1)!.text).toContain('[Step: review, round 1'); expect(last().chain!.step).toBe('reviewing');
    }
    await reply(REVIEWER, '**NO FINDINGS**'); expect(last().chain!.step).toBe('final');
  });
  it('moves on from a second review that only verifies the fixes', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    await reply(REVIEWER, 'FINDING low a.ts:1 — typo'); await reply(BUILDER, 'FIXED F1: spelled it'); expect(last().chain).toMatchObject({ step: 'reviewing', reviewRound: 2 });
    await reply(REVIEWER, 'VERIFIED F1'); expect(last().findings![0].status).toBe('verified'); expect(last().chain!.step).toBe('final'); expect(sent.at(-1)!.runId).toBe(PLANNER);
  });
  it('notes the files’ state before the builder’s and reviewer’s turns, not before the planner’s, whose answers are never recorded', async () => {
    const { chains, reply } = setup(); const asked: number[] = []; let turns = 0;
    (chains as unknown as { host: TableHost }).host.stateOf = () => { asked.push(turns); return Promise.resolve('a'.repeat(64)); };
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); expect(asked).toEqual([]);
    turns = 1; await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); expect(asked.length).toBeGreaterThan(0); const before = asked.length;
    turns = 2; await reply(BUILDER, 'Built.'); expect(asked.length).toBeGreaterThan(before);
    // The reviewer's NO FINDINGS sends the planner its final review: no snapshot for that turn.
    const reviewed = asked.length; turns = 3; await reply(REVIEWER, 'NO FINDINGS'); expect(asked.length).toBe(reviewed);
  });
  it('says which review lines it could not read, and records the numbered ones it can', async () => {
    const { chains, reply, last, events } = setup();
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    await reply(REVIEWER, '1. FINDING high a.ts:1 — leaks\nFINDING: the cache never expires');
    expect(last().findings!.map((finding) => finding.text)).toEqual(['leaks']);
    expect(events.some((e) => e.event.type === 'notice' && e.event.text.includes('“FINDING: the cache never expires”'))).toBe(true);
  });
  it('keeps what it saves within what a workspace can hold: waiting messages and a long plan', async () => {
    const { chains, reply, last } = setup();
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []);
    chains.send(BUILDER, 'a'.repeat(150_000), []); expect(() => chains.send(BUILDER, 'b'.repeat(60_000), [])).toThrow(/longer than 200,000 characters/);
    expect(last().waiting).toBe('a'.repeat(150_000));
    await reply(PLANNER, 'P'.repeat(250_000) + '\nPLAN READY'); expect(last().chain!.plan.length).toBeLessThanOrEqual(200_000);
  });
  it('keeps the task’s images with the saved table, gets them back when it reopens, and never gives them to followers', async () => {
    const first = setup(); first.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); first.chains.send(BUILDER, 'Match the mockup', [IMAGE(1), IMAGE(2)]);
    const saved = first.last().chain!; expect(saved.images).toEqual([IMAGE(1), IMAGE(2)]); expect(savedChainSchema.safeParse(saved).success).toBe(true);
    const shared = forFollowers(first.events.filter((e) => e.event.type === 'table').at(-1)!).event as Extract<ChatEvent, { type: 'table' }>;
    expect(shared.table!.chain).toMatchObject({ task: 'Match the mockup' }); expect(shared.table!.chain!.images).toBeUndefined(); expect(saved.images).toHaveLength(2);
    // Reopened after a restart (cut short while planning), the step continues with the same images.
    const second = setup(); second.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: savedChainSchema.parse(saved) });
    expect(second.last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'planning', images: [IMAGE(1), IMAGE(2)] });
    second.chains.continue(BUILDER); expect(second.sent.at(-1)).toMatchObject({ runId: PLANNER, images: [IMAGE(1), IMAGE(2)] });
  });
  it('keeps task images too large for a saved workspace only while the table runs, so the workspace stays saveable', async () => {
    const { chains, sent, last, reply } = setup(); const big = (n: number) => ({ mediaType: 'image/png' as const, data: String(n).repeat(3_000_001) });
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Match the mockup', [big(1), big(2)]);
    expect(last().chain!.images).toBeUndefined(); expect(savedChainSchema.safeParse(last().chain).success).toBe(true);
    await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(sent.at(-1)!.images).toHaveLength(2);
    // The saved shape refuses more than 10 images or more than 6 MB of them, as for a waiting message.
    const chain = { step: 'idle' as const, task: '', plan: '', report: '', reviewRound: 0, finalRound: 0, verdict: null, note: '' };
    expect(savedChainSchema.safeParse({ ...chain, images: [big(1), big(2)] }).success).toBe(false);
    expect(savedChainSchema.safeParse({ ...chain, images: Array.from({ length: 11 }, (_, n) => IMAGE(n)) }).success).toBe(false);
  });
  it('gives a step continued after a restart the task’s saved images', () => {
    const { chains, sent } = setup();
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: { step: 'stopped', stoppedAt: 'implementing', task: 'Match the mockup', plan: '1. Edit', report: '', reviewRound: 0, finalRound: 0, verdict: null, note: '', challenged: true, images: [IMAGE(1), IMAGE(2)] } });
    chains.continue(BUILDER); expect(sent.at(-1)).toMatchObject({ runId: BUILDER, images: [IMAGE(1), IMAGE(2)] });
  });
  it('says why when Trace cannot finish a step', async () => {
    const { chains, reply, last } = setup(); let fail = false;
    (chains as unknown as { host: TableHost }).host.stateOf = () => { if (fail) throw new Error('git is missing'); return Promise.resolve('a'.repeat(64)); };
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    fail = true; await reply(REVIEWER, 'FINDING high a.ts:1 — bug');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'reviewing', note: 'Trace could not finish this step (git is missing). Continue tries it again.' });
  });
  it('reads the planner’s verdict only from its last line', () => {
    expect(verdictOf('Fine.\n**APPROVED**')).toEqual({ approved: true }); expect(verdictOf('CHANGES NEEDED: add tests')).toEqual({ approved: false, changes: 'add tests' });
    expect(verdictOf('APPROVED\nBut should I check more?')).toBeNull(); expect(REVIEW_ROUNDS).toBe(2);
  });
  it('counts a reply as a review only with findings, answers to findings, or NO FINDINGS on its last line', () => {
    expect(isReview('FINDING low a.ts:1 — typo')).toBe(true); expect(isReview('VERIFIED F2')).toBe(true); expect(isReview('All fine.\n- NO FINDINGS.')).toBe(true); expect(isReview('NO FINDINGS\nTASK COMPLETE')).toBe(true);
    expect(isReview('')).toBe(false); expect(isReview('NO FINDINGS\nWant me to look at the tests?')).toBe(false); expect(isReview('FIXED F1')).toBe(false);
  });
});

describe('a follow-up once the final review is reached goes back to the planner', () => {
  const builderTurns = (sent: { runId: string }[], from: number) => sent.slice(from).filter((item) => item.runId === BUILDER).length;
  it('a message during the final review, then CHANGES NEEDED: the planner plans again, with the request', async () => {
    const { chains, sent, reply, last } = await atFinal();
    chains.send(BUILDER, 'Also add a header.', []); expect(last().waiting).toBe('Also add a header.'); const before = sent.length;
    await reply(PLANNER, 'CHANGES NEEDED: rename it');
    expect(sent.slice(before).map((item) => item.runId)).toEqual([PLANNER]); expect(sent.at(-1)!.text).toContain('Also add a header.'); expect(sent.at(-1)!.text).toContain('Your final review asked for changes:\n\nrename it');
    expect(last().chain).toMatchObject({ step: 'planning', replan: 'rename it', finalRound: 0 }); expect(last().waiting).toBeUndefined();
    await reply(PLANNER, 'Plan 2'); expect(last().chain!.step).toBe('plan-review'); expect(builderTurns(sent, before)).toBe(0);
    chains.plan(BUILDER, true); expect(sent.at(-1)!.runId).toBe(BUILDER);
  });
  it('a message during the final review, then APPROVED: the task is done, and the message starts the next task', async () => {
    const { chains, sent, reply, last, tables } = await atFinal();
    chains.send(BUILDER, 'Also add a header.', []); const before = sent.length;
    await reply(PLANNER, 'APPROVED');
    expect(tables().some((table) => table.chain?.step === 'done' && table.chain.verdict === 'approved' && table.chain.task === 'Add a footer.')).toBe(true);
    expect(last().chain).toMatchObject({ step: 'planning', task: 'Also add a header.', plan: '' }); expect(last().chain).not.toHaveProperty('replan'); expect(last().waiting).toBeUndefined();
    expect(sent.slice(before).map((item) => item.runId)).toEqual([PLANNER]); expect(sent.at(-1)!.text).toContain('[Step: plan] The task:\n\nAlso add a header.');
  });
  it('a message during the final review that ends with no verdict goes to the planner instead of asking the person', async () => {
    const { chains, sent, reply, last } = await atFinal(); chains.send(BUILDER, 'Also add a header.', []);
    await reply(PLANNER, 'Looks fine, I think.'); expect(last().chain).toMatchObject({ step: 'planning', replan: '' }); expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).not.toContain('Your final review asked');
  });
  it('stopped at a fix or a review the final review sent back, a typed reply goes to the planner (C1)', async () => {
    for (const at of ['fixing', 'reviewing'] as const) {
      const { chains, sent, reply, last } = await atFinal();
      await reply(PLANNER, 'CHANGES NEEDED: rename it'); expect(last().chain).toMatchObject({ step: 'fixing', finalRound: 1 });
      if (at === 'reviewing') { await reply(BUILDER, 'Renamed.'); expect(last().chain!.step).toBe('reviewing'); }
      chains.stop(BUILDER); await reply(at === 'fixing' ? BUILDER : REVIEWER, 'partial'); expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: at });
      const before = sent.length; chains.send(BUILDER, 'Leave the name.', []);
      expect(sent.slice(before).map((item) => item.runId)).toEqual([PLANNER]); expect(sent.at(-1)!.text).toContain('[Step: plan again'); expect(sent.at(-1)!.text).toContain('Leave the name.');
      // At the fix the final review's request is still open; once the builder has made it (at the review), it is not asked again.
      expect(last().chain).toMatchObject({ step: 'planning', finalRound: 0, replan: at === 'fixing' ? 'rename it' : '' }); expect(last().chain!.task).toContain('Leave the name.');
    }
  });
  it('a message waiting at Stop goes to the planner on Continue, not to the final review (C2)', async () => {
    const { chains, sent, reply, last } = await atFinal();
    chains.send(BUILDER, 'Also add a header.', []); chains.stop(BUILDER); await reply(PLANNER, 'partial'); const before = sent.length;
    chains.continue(BUILDER);
    expect(sent.slice(before).map((item) => item.runId)).toEqual([PLANNER]); expect(sent.at(-1)!.text).toContain('[Step: plan again'); expect(sent.at(-1)!.text).not.toContain('[Step: final review');
    expect(last().chain!.step).toBe('planning'); expect(last().chain!.task).toContain('Also add a header.');
  });
  it('a message typed while the planner is still stopping goes to the planner on Continue (C2)', async () => {
    const { chains, sent, reply, last } = await atFinal();
    chains.stop(BUILDER); chains.send(BUILDER, 'Also add a header.', []); expect(last().waiting).toBe('Also add a header.');
    await reply(PLANNER, 'partial'); chains.continue(BUILDER);
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('[Step: plan again'); expect(last().chain!.task).toContain('Also add a header.');
  });
  it('joins a message still waiting and a new reply, with all their images, into the task (C3)', async () => {
    const { chains, sent, reply, last } = await atFinal();
    chains.stop(BUILDER); chains.send(BUILDER, 'First.', [IMAGE(1)]); await reply(PLANNER, 'partial');
    chains.send(BUILDER, 'Second.', [IMAGE(2), IMAGE(3)]);
    expect(last().chain!.task).toBe("Add a footer.\n\n[The person's follow-up after the final review]\nFirst.\n\nSecond.");
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('First.\n\nSecond.'); expect(sent.at(-1)!.images).toEqual([IMAGE(1), IMAGE(2), IMAGE(3)]);
  });
  it('refuses a follow-up too long or with too many images, and changes nothing (C3)', async () => {
    const { chains, sent, reply, last } = await atFinal();
    chains.stop(BUILDER); chains.send(BUILDER, 'First.', [IMAGE(1)]); await reply(PLANNER, 'partial'); const before = sent.length; const state = JSON.stringify(last());
    expect(() => chains.send(BUILDER, 'x'.repeat(410_000), [])).toThrow(/longer than 410,000 characters/);
    expect(() => chains.send(BUILDER, 'More.', Array.from({ length: 10 }, (_, n) => IMAGE(n + 2)))).toThrow(/11 images/);
    expect(sent.length).toBe(before); expect(JSON.stringify(last())).toBe(state); expect(last()).toMatchObject({ waiting: 'First.', chain: { step: 'stopped', stoppedAt: 'final', task: 'Add a footer.' } });
  });
  it('a waiting follow-up too long to join the task stops the table at its next step, request kept; dropped, Continue runs that step (F1)', async () => {
    const { chains, sent, reply, last } = await atFinal('x'.repeat(409_990));
    chains.send(BUILDER, 'Also add a header.', []); const before = sent.length;
    await reply(PLANNER, 'CHANGES NEEDED: rename it');
    expect(sent.length).toBe(before); expect(last()).toMatchObject({ waiting: 'Also add a header.', chain: { step: 'stopped', stoppedAt: 'fixing', verdict: 'changes', note: 'rename it', finalRound: 1 } });
    expect(last().chain!.held).toContain('longer than 410,000 characters'); expect(last().chain).not.toHaveProperty('replan');
    // Continue with the message still there stops again, as before.
    chains.continue(BUILDER); expect(sent.length).toBe(before); expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'fixing', note: 'rename it' });
    chains.waiting(BUILDER, false); expect(last().waiting).toBeUndefined(); expect(last().chain).not.toHaveProperty('held');
    chains.continue(BUILDER);
    expect(sent.at(-1)!.runId).toBe(BUILDER); expect(sent.at(-1)!.text).toContain("The planner's final review asks for changes:\n\nrename it"); expect(last().chain).toMatchObject({ step: 'fixing', finalRound: 1 });
    await reply(BUILDER, 'Renamed.'); await reply(REVIEWER, 'NO FINDINGS'); expect(last().chain!.step).toBe('final');
  });
  it('a task as long as one message (199,990 characters) still takes a follow-up: waiting, after CHANGES NEEDED, and a two-character reply at needs-you (F1)', async () => {
    const { chains, sent, reply, last } = await atFinal('x'.repeat(199_990));
    chains.send(BUILDER, 'Also add a header.', []); await reply(PLANNER, 'CHANGES NEEDED: rename it');
    expect(last().chain).toMatchObject({ step: 'planning', replan: 'rename it' }); expect(last().chain).not.toHaveProperty('held'); expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('Also add a header.');
    const other = await atFinal('x'.repeat(199_990)); await other.reply(PLANNER, 'Looks fine, I think.'); expect(other.last().chain!.step).toBe('needs-you');
    other.chains.send(BUILDER, 'ok', []); expect(other.sent.at(-1)!.runId).toBe(PLANNER); expect(other.last().chain).toMatchObject({ step: 'planning' }); expect(other.last().chain!.task.endsWith('\nok')).toBe(true);
    // A follow-up as long as the longest message fits too.
    const longest = await atFinal('x'.repeat(200_000)); await longest.reply(PLANNER, 'Looks fine, I think.'); longest.chains.send(BUILDER, 'y'.repeat(200_000), []); expect(longest.last().chain!.step).toBe('planning');
  });
  it('a waiting follow-up too long, after a final review with no verdict or with its rounds used up: stopped at the final review; dropped, Continue runs it again (F1)', async () => {
    for (const exit of ['no verdict', 'rounds used up'] as const) {
      const { chains, sent, reply, last } = await atFinal('x'.repeat(409_990));
      if (exit === 'rounds used up') for (let round = 0; round < FINAL_ROUNDS; round++) { await reply(PLANNER, 'CHANGES NEEDED: rename it'); await reply(BUILDER, 'Renamed.'); await reply(REVIEWER, 'NO FINDINGS'); }
      chains.send(BUILDER, 'Also add a header.', []); const before = sent.length;
      await reply(PLANNER, exit === 'no verdict' ? 'Looks fine, I think.' : 'CHANGES NEEDED: still wrong');
      expect(sent.length).toBe(before); expect(last()).toMatchObject({ waiting: 'Also add a header.', chain: { step: 'stopped', stoppedAt: 'final' } }); expect(last().chain!.held).toContain('longer than 410,000 characters');
      if (exit === 'rounds used up') expect(last().chain).toMatchObject({ verdict: 'changes', note: 'still wrong', finalRound: FINAL_ROUNDS });
      chains.waiting(BUILDER, false); expect(last().waiting).toBeUndefined(); expect(last().chain).not.toHaveProperty('held');
      expect(() => chains.continue(BUILDER)).not.toThrow();
      expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('[Step: final review'); expect(last().chain!.step).toBe('final');
    }
  });
  it('Send now that send() refuses leaves the message waiting as it was, with its images (F2)', async () => {
    const { reply, last } = await atFinal('x'.repeat(409_990));
    await reply(PLANNER, 'Looks fine, I think.'); expect(last().chain!.step).toBe('needs-you');
    const saved = last().chain!;
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: saved, findings: [], waiting: 'Also add a header.', waitingImages: [IMAGE(1)] });
    expect(() => after.chains.waiting(BUILDER, true)).toThrow(/longer than 410,000/);
    expect(after.last()).toMatchObject({ waiting: 'Also add a header.', waitingImages: [IMAGE(1)], waitingKept: true, chain: { step: 'needs-you' } }); expect(after.sent).toEqual([]);
    after.chains.waiting(BUILDER, false); expect(after.last().waiting).toBeUndefined();
  });
  it('a task from Tasks sent during the final review is not merged into this task: it starts as the next task once this one is approved (F3)', async () => {
    const { chains, sent, reply, last, tables } = await atFinal(`Task: Add a footer. ${SIGNAL_INSTRUCTION}`);
    chains.send(BUILDER, `Task: Add a header. ${SIGNAL_INSTRUCTION}`, []); const before = sent.length;
    await reply(PLANNER, 'CHANGES NEEDED: rename it');
    // The fix goes on without it; it is never added to a step's prompt or to this task.
    expect(sent.slice(before).map((item) => item.runId)).toEqual([BUILDER]); expect(sent.at(-1)!.text).not.toContain('Add a header'); expect(last().chain!.task).toBe('Task: Add a footer.');
    await reply(BUILDER, 'Renamed.'); await reply(REVIEWER, 'NO FINDINGS'); expect(sent.slice(before).some((item) => item.text.includes('Add a header'))).toBe(false); expect(last().chain!.nextTasks).toEqual([`Task: Add a header. ${SIGNAL_INSTRUCTION}`]); expect(last().waiting).toBeUndefined();
    await reply(PLANNER, 'APPROVED');
    expect(tables().some((table) => table.chain?.step === 'done' && table.chain.task === 'Task: Add a footer.')).toBe(true);
    expect(last().chain).toMatchObject({ step: 'planning', task: 'Task: Add a header.' }); expect(last().chain).not.toHaveProperty('nextTasks');
  });
  it('a typed follow-up and a waiting task from Tasks: the follow-up is planned again, the task keeps waiting (F3)', async () => {
    const { chains, sent, reply, last } = await atFinal(`Task: Add a footer. ${SIGNAL_INSTRUCTION}`);
    chains.stop(BUILDER); chains.send(BUILDER, `Task: Add a header. ${SIGNAL_INSTRUCTION}`, []); await reply(PLANNER, 'partial');
    chains.send(BUILDER, 'Keep the old colour.', []);
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('Keep the old colour.'); expect(sent.at(-1)!.text).not.toContain('Add a header');
    expect(last().chain!.task).toBe("Task: Add a footer.\n\n[The person's follow-up after the final review]\nKeep the old colour."); expect(last().chain!.nextTasks).toEqual([`Task: Add a header. ${SIGNAL_INSTRUCTION}`]);
  });
  it('a typed correction after a task from Tasks is queued stays apart from it, and goes to the planner before any more building (F4)', async () => {
    const header = `Task: Add a header. ${SIGNAL_INSTRUCTION}`;
    const { chains, sent, reply, last } = await atFinal(`Task: Add a footer. ${SIGNAL_INSTRUCTION}`);
    chains.send(BUILDER, header, []); chains.send(BUILDER, 'Do not rename it; keep the old name.', []);
    expect(last()).toMatchObject({ waiting: 'Do not rename it; keep the old name.', chain: { nextTasks: [header] } }); const before = sent.length;
    await reply(PLANNER, 'CHANGES NEEDED: rename it');
    expect(sent.slice(before).map((item) => item.runId)).toEqual([PLANNER]); expect(sent.at(-1)!.text).toContain('[Step: plan again'); expect(sent.at(-1)!.text).toContain('Do not rename it; keep the old name.'); expect(sent.at(-1)!.text).not.toContain('Add a header');
    expect(last().chain).toMatchObject({ step: 'planning', nextTasks: [header] }); expect(last().chain!.task).toContain('keep the old name'); expect(last().waiting).toBeUndefined();
    // The same with the correction typed first.
    const other = await atFinal(`Task: Add a footer. ${SIGNAL_INSTRUCTION}`); other.chains.send(BUILDER, 'Keep the old name.', []); other.chains.send(BUILDER, header, []);
    await other.reply(PLANNER, 'CHANGES NEEDED: rename it'); expect(other.sent.at(-1)!.runId).toBe(PLANNER); expect(other.last().chain).toMatchObject({ step: 'planning', nextTasks: [header] });
  });
  it('tasks from Tasks waiting start one per approval, in order; at most ten wait (F4)', async () => {
    const task = (name: string) => `Task: ${name}. ${SIGNAL_INSTRUCTION}`;
    const { chains, reply, last } = await atFinal(task('A'));
    chains.send(BUILDER, task('B'), []); chains.send(BUILDER, task('C'), []);
    for (let n = 0; n < 8; n++) chains.send(BUILDER, task(`D${n}`), []);
    expect(() => chains.send(BUILDER, task('E'), [])).toThrow(/10 tasks from Tasks already wait/);
    await reply(PLANNER, 'APPROVED'); expect(last().chain).toMatchObject({ step: 'planning', task: 'Task: B.' }); expect(last().chain!.nextTasks![0]).toBe(task('C'));
    await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.'); await reply(REVIEWER, 'NO FINDINGS'); await reply(PLANNER, 'APPROVED');
    expect(last().chain).toMatchObject({ step: 'planning', task: 'Task: C.' }); expect(last().chain!.nextTasks).toHaveLength(8);
  });
  it('tasks from Tasks waiting are kept through a restart, and wait behind a kept message until it is sent or dropped (F4)', async () => {
    const header = `Task: Add a header. ${SIGNAL_INSTRUCTION}`;
    const { chains, reply, last } = await atFinal(); chains.send(BUILDER, header, []); chains.stop(BUILDER); await reply(PLANNER, 'partial');
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: last().chain!, findings: [], waiting: 'Kept message.' });
    expect(after.last().chain!.nextTasks).toEqual([header]);
    after.chains.continue(BUILDER); await after.reply(PLANNER, 'APPROVED');
    expect(after.last()).toMatchObject({ waiting: 'Kept message.', waitingKept: true, chain: { step: 'done', nextTasks: [header] } });
    after.chains.waiting(BUILDER, false); expect(after.last().chain).toMatchObject({ step: 'planning', task: 'Task: Add a header.' }); expect(after.sent.at(-1)!.runId).toBe(PLANNER);
  });
  it('a task from Tasks kept from before a restart and sent while the table works waits with the other tasks, not with a step (F4)', async () => {
    const header = `Task: Add a header. ${SIGNAL_INSTRUCTION}`;
    const { chains, reply, last } = await atFinal(); chains.stop(BUILDER); await reply(PLANNER, 'partial');
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: last().chain!, findings: [], waiting: header });
    after.chains.continue(BUILDER); after.chains.waiting(BUILDER, true);
    expect(after.last().waiting).toBeUndefined(); expect(after.last().chain!.nextTasks).toEqual([header]);
    await after.reply(PLANNER, 'CHANGES NEEDED: rename it'); expect(after.sent.at(-1)!.runId).toBe(BUILDER); expect(after.sent.at(-1)!.text).not.toContain('Add a header');
  });
  it('stopped before the final review with a task from Tasks waiting, a reply goes with the step and the task keeps waiting (F3)', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Add a footer.', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    chains.stop(BUILDER); chains.send(BUILDER, `Task: Add a header. ${SIGNAL_INSTRUCTION}`, []); await reply(BUILDER, 'partial');
    chains.send(BUILDER, 'Use the blue.', []);
    expect(sent.at(-1)!.runId).toBe(BUILDER); expect(sent.at(-1)!.text).toContain('The person adds: Use the blue.'); expect(sent.at(-1)!.text).not.toContain('Add a header');
    expect(last().chain).toMatchObject({ step: 'implementing', nextTasks: [`Task: Add a header. ${SIGNAL_INSTRUCTION}`] }); expect(last().waiting).toBeUndefined();
  });
  it('Stop while planning again, then Continue: the prompt still has the follow-up, the old plan and the final review’s request (C4)', async () => {
    const { chains, sent, reply, last } = await atFinal();
    chains.send(BUILDER, 'Also add a header.', []); await reply(PLANNER, 'CHANGES NEEDED: rename it'); const first = sent.at(-1)!.text;
    chains.stop(BUILDER); await reply(PLANNER, 'partial'); chains.continue(BUILDER);
    const again = sent.at(-1)!.text; expect(sent.at(-1)!.runId).toBe(PLANNER);
    for (const part of ['Also add a header.', 'Your plan so far:\n\nPlan', "The builder's latest report:\n\nBuilt.", 'rename it']) expect(again).toContain(part);
    // The same prompt as the first time, without the brief the planner had then.
    expect(first.endsWith(again)).toBe(true);
  });
  it('the same after a restart at that step (C4)', async () => {
    const { chains, reply, last } = await atFinal();
    chains.send(BUILDER, 'Also add a header.', []); await reply(PLANNER, 'CHANGES NEEDED: rename it'); const saved = last().chain!;
    expect(saved).toMatchObject({ step: 'planning', replan: 'rename it' });
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: saved, findings: [] }); expect(after.last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'planning', replan: 'rename it' });
    after.chains.continue(BUILDER); const prompt = after.sent.at(-1)!.text; expect(after.sent.at(-1)!.runId).toBe(PLANNER);
    for (const part of ['[Step: plan again', 'Also add a header.', 'Your plan so far:\n\nPlan', 'rename it']) expect(prompt).toContain(part);
    await after.reply(PLANNER, 'Plan 2'); expect(after.last().chain).toMatchObject({ step: 'plan-review', plan: 'Plan 2' }); expect(after.sent.some((item) => item.runId === BUILDER)).toBe(false);
  });
  it('a message kept from before a restart still waits for Send now after APPROVED (C5)', async () => {
    const { chains, reply, last } = await atFinal(); chains.stop(BUILDER); await reply(PLANNER, 'partial'); const saved = last().chain!;
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: saved, findings: [], waiting: 'Kept message.' });
    after.chains.continue(BUILDER); expect(after.sent.at(-1)!.text).toContain('[Step: final review'); expect(after.sent.at(-1)!.text).not.toContain('Kept message.');
    await after.reply(PLANNER, 'APPROVED'); expect(after.last()).toMatchObject({ waiting: 'Kept message.', waitingKept: true, chain: { step: 'done', verdict: 'approved' } }); expect(after.sent.length).toBe(1);
  });
  it('a blocked seat after the final review gets only its answer; a message waiting goes to the planner once that step ends', async () => {
    const { chains, sent, reply, last } = await atFinal();
    await reply(PLANNER, 'CHANGES NEEDED: rename it'); chains.send(BUILDER, 'Also add a header.', []);
    await reply(BUILDER, 'TASK BLOCKED: Which name?'); expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'fixing', blocked: 'builder' });
    chains.send(BUILDER, 'Use Footer.', []);
    expect(sent.at(-1)!.runId).toBe(BUILDER); expect(sent.at(-1)!.text).toContain('[The person answers] Use Footer.'); expect(sent.at(-1)!.text).not.toContain('Also add a header.'); expect(last().waiting).toBe('Also add a header.');
    await reply(BUILDER, 'Renamed to Footer.');
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('[Step: plan again'); expect(last().chain).toMatchObject({ step: 'planning', report: 'Renamed to Footer.' }); expect(last().chain!.task).toContain('Also add a header.');
  });
  it('a task from Tasks keeps its mark in the task after a follow-up, without its TASK COMPLETE instruction', async () => {
    const { chains, reply, last } = await atFinal(`Task t-0123abcd: Add a footer. ${SIGNAL_INSTRUCTION}`);
    chains.stop(BUILDER); await reply(PLANNER, 'partial'); chains.send(BUILDER, 'Also add a header.', []); expect(last().chain!.step).toBe('planning');
    expect(last().chain!.task).toContain('Task t-0123abcd: Add a footer.'); expect(last().chain!.task).toContain('Also add a header.'); expect(last().chain!.task).not.toContain(SIGNAL_INSTRUCTION);
  });
});

describe('a plan owed by the planner is never lost', () => {
  /** A table whose plan the person sent back with a note; the planner is revising it. */
  const revising = async () => {
    const table = setup(); const { chains, reply } = table; chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Add a footer.', []); await reply(PLANNER, 'Plan A');
    chains.plan(BUILDER, false, 'Use the existing helper.'); return table;
  };
  it('Stop during a revision, then Continue, and the same after a restart: the planner is asked the person’s note again', async () => {
    const { chains, sent, reply, last } = await revising();
    expect(last().chain).toMatchObject({ step: 'planning', revision: 'Use the existing helper.', plan: 'Plan A' });
    chains.stop(BUILDER); await reply(PLANNER, 'partial'); chains.continue(BUILDER);
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('[Step: plan, revised]'); expect(sent.at(-1)!.text).toContain('Use the existing helper.');
    chains.stop(BUILDER); await reply(PLANNER, 'partial'); const saved = last().chain!;
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: saved, findings: [] }); after.chains.continue(BUILDER);
    expect(after.sent.at(-1)!.text).toContain('[Step: plan, revised] The person asks you to revise the plan:\n\nUse the existing helper.');
    await after.reply(PLANNER, 'Plan B'); expect(after.last().chain).toMatchObject({ step: 'plan-review', plan: 'Plan B' }); expect(after.last().chain).not.toHaveProperty('revision');
  });
  it('refuses a revision note over 200,000 characters and changes nothing', async () => {
    const { chains, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan A');
    expect(() => chains.plan(BUILDER, false, 'x'.repeat(200_001))).toThrow(/fewer than 200,000 characters/); expect(last().chain!.step).toBe('plan-review'); expect(last().chain).not.toHaveProperty('revision');
  });
  it('an empty answer to a revision keeps the old plan and the note; a reply joins the note, and both survive Stop and a restart (C1)', async () => {
    const { chains, sent, reply, last } = await revising();
    await reply(PLANNER, '   '); expect(last().chain).toMatchObject({ step: 'needs-you', note: 'The planner wrote no plan.', plan: 'Plan A', revision: 'Use the existing helper.' });
    chains.send(BUILDER, 'And keep the old colours.', []);
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(last().chain).toMatchObject({ step: 'planning', plan: 'Plan A', revision: 'Use the existing helper.\n\nAnd keep the old colours.', task: 'Add a footer.' });
    chains.stop(BUILDER); await reply(PLANNER, 'partial'); const saved = last().chain!;
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: saved, findings: [] }); after.chains.continue(BUILDER);
    const prompt = after.sent.at(-1)!.text; expect(prompt).toContain('Use the existing helper.'); expect(prompt).toContain('And keep the old colours.'); expect(after.last().chain!.plan).toBe('Plan A');
  });
  it('an empty answer to a re-plan after CHANGES NEEDED keeps the plan, the request and the follow-up; a reply joins them, through Stop and a restart (C1)', async () => {
    const { chains, sent, reply, last } = await atFinal(); chains.send(BUILDER, 'Also add a header.', []); await reply(PLANNER, 'CHANGES NEEDED: rename it');
    expect(last().chain).toMatchObject({ step: 'planning', replan: 'rename it' });
    await reply(PLANNER, ''); expect(last().chain).toMatchObject({ step: 'needs-you', plan: 'Plan', replan: 'rename it' });
    const before = sent.length; chains.send(BUILDER, 'Use h2 for it.', []);
    expect(sent.slice(before).map((item) => item.runId)).toEqual([PLANNER]); expect(last().chain).toMatchObject({ step: 'planning', replan: 'rename it', finalRound: 0 });
    expect(last().chain!.task).toBe("Add a footer.\n\n[The person's follow-up after the final review]\nAlso add a header.\n\nUse h2 for it.");
    chains.stop(BUILDER); await reply(PLANNER, 'partial'); const saved = last().chain!;
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: saved, findings: [] }); after.chains.continue(BUILDER);
    const prompt = after.sent.at(-1)!.text;
    for (const part of ['[Step: plan again', 'Your plan so far:\n\nPlan', 'Your final review asked for changes:\n\nrename it', 'Also add a header.', 'Use h2 for it.']) expect(prompt).toContain(part);
  });
  it('a reply too long to join what the planner owes is refused, and nothing changes', async () => {
    const { chains, reply, last } = await revising(); await reply(PLANNER, ''); const state = JSON.stringify(last());
    expect(() => chains.send(BUILDER, 'x'.repeat(410_000), [])).toThrow(/longer than 410,000 characters/); expect(JSON.stringify(last())).toBe(state);
  });
  it('a builder that answers with nothing does not change where a reply goes after the final review (C2)', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Add a footer.', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    await reply(BUILDER, ''); await reply(REVIEWER, 'NO FINDINGS'); expect(last().chain).toMatchObject({ step: 'final', report: '' });
    await reply(PLANNER, 'Looks fine, I think.'); expect(last().chain!.step).toBe('needs-you');
    chains.send(BUILDER, 'Add a test too.', []);
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('[Step: plan again'); expect(last().chain!.task).toContain('Add a test too.');
  });
  it('a follow-up after the final review takes the place of a revision still owed', async () => {
    const { chains, reply, last } = await atFinal(); chains.stop(BUILDER); await reply(PLANNER, 'partial');
    chains.send(BUILDER, 'Also add a header.', []); await reply(PLANNER, 'Plan 2'); expect(last().chain!.step).toBe('plan-review');
    chains.plan(BUILDER, false, 'Smaller.'); expect(last().chain).toMatchObject({ revision: 'Smaller.' });
    await reply(PLANNER, 'Plan 3'); expect(last().chain).toMatchObject({ step: 'plan-review', plan: 'Plan 3' }); expect(last().chain).not.toHaveProperty('revision'); expect(last().chain).not.toHaveProperty('replan');
  });
  /** Stops the planner, opens the table again as after a restart, and returns the prompt Continue sends. */
  const restartPrompt = async (table: ReturnType<typeof setup>) => {
    table.chains.stop(BUILDER); await table.reply(PLANNER, 'partial'); const saved = table.last().chain!;
    const after = setup(); after.chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER), { chain: saved, findings: [] }); after.chains.continue(BUILDER); return after.sent.at(-1)!.text;
  };
  it('revision, Stop, a typed correction: it joins the note, and Stop and a restart keep it (F5)', async () => {
    const table = await revising(); const { chains, sent, reply, last } = table;
    chains.stop(BUILDER); await reply(PLANNER, 'partial'); chains.send(BUILDER, 'Keep the old colours.', []);
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('Use the existing helper.\n\nKeep the old colours.'); expect(sent.at(-1)!.text).not.toContain('The person adds');
    expect(last().chain).toMatchObject({ step: 'planning', revision: 'Use the existing helper.\n\nKeep the old colours.' });
    expect(await restartPrompt(table)).toContain('Use the existing helper.\n\nKeep the old colours.');
  });
  it('revision, Stop, a reply too long to join the note: refused, and nothing changes (F5)', async () => {
    const { chains, sent, reply, last } = await revising(); chains.stop(BUILDER); await reply(PLANNER, 'partial'); const before = sent.length; const state = JSON.stringify(last());
    expect(() => chains.send(BUILDER, 'x'.repeat(410_000), [])).toThrow(/longer than 410,000 characters/); expect(sent.length).toBe(before); expect(JSON.stringify(last())).toBe(state);
  });
  it('revision, Stop, a correction typed while the planner is still stopping, then Continue: it joins the note too (F5)', async () => {
    const table = await revising(); const { chains, sent, reply, last } = table;
    chains.stop(BUILDER); chains.send(BUILDER, 'Keep the old colours.', []); expect(last().waiting).toBe('Keep the old colours.');
    await reply(PLANNER, 'partial'); chains.continue(BUILDER);
    expect(sent.at(-1)!.text).toContain('Use the existing helper.\n\nKeep the old colours.'); expect(last().chain!.revision).toBe('Use the existing helper.\n\nKeep the old colours.'); expect(last().waiting).toBeUndefined();
    expect(await restartPrompt(table)).toContain('Keep the old colours.');
  });
  it('feedback sent while the planner revises, an empty answer, then a reply: both join the note in order, and a restart keeps them (F5)', async () => {
    const table = await revising(); const { chains, sent, reply, last } = table;
    chains.send(BUILDER, 'Keep the old colours.', []); expect(last().waiting).toBe('Keep the old colours.');
    await reply(PLANNER, ''); expect(last()).toMatchObject({ waiting: 'Keep the old colours.', chain: { step: 'needs-you', revision: 'Use the existing helper.' } });
    chains.send(BUILDER, 'And a dark mode.', []);
    const note = 'Use the existing helper.\n\nKeep the old colours.\n\nAnd a dark mode.';
    expect(sent.at(-1)!.text).toContain(note); expect(sent.at(-1)!.text).not.toContain('The person adds'); expect(last().chain!.revision).toBe(note); expect(last().waiting).toBeUndefined();
    expect(await restartPrompt(table)).toContain(note);
  });
  it('the same for a re-plan after the final review: the feedback joins the task (F5)', async () => {
    const table = await atFinal(); const { chains, sent, reply, last } = table;
    chains.send(BUILDER, 'Also add a header.', []); await reply(PLANNER, 'CHANGES NEEDED: rename it');
    chains.send(BUILDER, 'Use h2 for it.', []); await reply(PLANNER, ''); chains.send(BUILDER, 'And make it blue.', []);
    const task = "Add a footer.\n\n[The person's follow-up after the final review]\nAlso add a header.\n\nUse h2 for it.\n\nAnd make it blue.";
    expect(last().chain).toMatchObject({ step: 'planning', task, replan: 'rename it' }); expect(sent.at(-1)!.text).toContain(task);
    const prompt = await restartPrompt(table); expect(prompt).toContain(task); expect(prompt).toContain('rename it');
  });
  it('a planner that asked the person while revising gets the answer as it is; a message waiting still joins the note after (F5)', async () => {
    const { chains, sent, reply, last } = await revising();
    chains.send(BUILDER, 'Keep the old colours.', []); await reply(PLANNER, 'TASK BLOCKED: Which helper?');
    chains.send(BUILDER, 'formatDate.', []);
    expect(sent.at(-1)!.text).toContain('[The person answers] formatDate.'); expect(last().chain!.revision).toBe('Use the existing helper.\n\nKeep the old colours.'); expect(last().waiting).toBeUndefined();
  });
});

describe('tasks from Tasks waiting at a table can be dropped, and go back to Tasks when it closes', () => {
  const task = (name: string) => `Task: ${name}. ${SIGNAL_INSTRUCTION}`;
  /** The tasks each table event said were removed without starting, in order. */
  const discards = (events: ChatEnvelope[]) => events.flatMap((e) => e.event.type === 'table' && e.event.discarded ? [e.event.discarded] : []);
  const waitingThree = async () => { const table = await atFinal(task('A')); for (const name of ['B', 'C', 'D']) table.chains.send(BUILDER, task(name), []); return table; };
  it('drops the task asked for, says so to the window, and the rest still start in order', async () => {
    const { chains, reply, last, events } = await waitingThree();
    chains.dropNext(BUILDER, 1, task('C').slice(0, 200));
    expect(last().chain!.nextTasks).toEqual([task('B'), task('D')]); expect(discards(events)).toEqual([[task('C')]]);
    await reply(PLANNER, 'APPROVED'); expect(last().chain).toMatchObject({ step: 'planning', task: 'Task: B.', nextTasks: [task('D')] });
    await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.'); await reply(REVIEWER, 'NO FINDINGS'); await reply(PLANNER, 'APPROVED');
    expect(last().chain).toMatchObject({ step: 'planning', task: 'Task: D.' }); expect(last().chain).not.toHaveProperty('nextTasks'); expect(discards(events)).toHaveLength(1);
  });
  it('refuses a head that no longer matches (the task started meanwhile) and an index out of range, changing nothing', async () => {
    const { chains, reply, last, events } = await waitingThree();
    const head = task('B').slice(0, 200); await reply(PLANNER, 'APPROVED');
    // B started; C is at index 0 now, and the person's Drop it for B must not drop C.
    expect(() => chains.dropNext(BUILDER, 0, head)).toThrow(/no longer waiting/); expect(() => chains.dropNext(BUILDER, 5, task('C').slice(0, 200))).toThrow(/no longer waiting/);
    expect(() => chains.dropNext(BUILDER, 0, '')).toThrow(/no longer waiting/);
    expect(last().chain!.nextTasks).toEqual([task('C'), task('D')]); expect(discards(events)).toEqual([]);
  });
  it('closed by the person: the tasks still waiting at that moment are discarded, not the one that started; a task sent after is refused', async () => {
    const { chains, reply, events } = await atFinal(task('A')); chains.send(BUILDER, task('B'), []); chains.send(BUILDER, task('C'), []);
    await reply(PLANNER, 'APPROVED'); chains.close(BUILDER);
    expect(discards(events)).toEqual([[task('C')]]); expect(events.at(-1)!.event).toMatchObject({ type: 'table', table: null, closed: true });
    expect(() => chains.send(BUILDER, task('E'), [])).toThrow(/no Round Table open/);
  });
  it('closed because a seat ended: nothing is discarded (the tasks stay with the saved table for Reopen)', async () => {
    const { chains, last, events } = await atFinal(task('A')); chains.send(BUILDER, task('B'), []); const saved = last().chain!;
    chains.ended(PLANNER); expect(discards(events)).toEqual([]); expect(events.at(-1)!.event).toMatchObject({ type: 'table', table: null }); expect(events.at(-1)!.event).not.toHaveProperty('closed');
    expect(saved.nextTasks).toEqual([task('B')]);
  });
  it('a message sent while a seat still ran a turn from before the table starts when that turn ends', async () => {
    const { chains, sent, runs, last } = setup(); (runs[PLANNER] as { busy?: boolean }).busy = true;
    chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Add a footer.', []);
    expect(sent).toEqual([]); expect(last()).toMatchObject({ waiting: 'Add a footer.' });
    chains.observe({ sessionId: 'planner', runId: PLANNER, event: { type: 'done', isError: false, error: null } });
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER }); expect(sent.at(-1)!.text).toContain('Add a footer.'); expect(last().chain!.step).toBe('planning');
  });
  it('passes on the end of a long report, where the files changed and checks run are', async () => {
    const { chains, sent, reply } = setup(); chains.open(1, BUILDER, legacySeats(REVIEWER, PLANNER)); chains.send(BUILDER, 'Add a footer.', []);
    await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, `${'x'.repeat(13_000)}\nFiles changed: page.html. Checks: tests pass.`);
    expect(sent.at(-1)!.runId).toBe(REVIEWER); expect(sent.at(-1)!.text).toContain('[… earlier part shortened by Trace]\nxxx'); expect(sent.at(-1)!.text).toContain('Files changed: page.html. Checks: tests pass.');
  });
});
