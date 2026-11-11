import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent } from '../../../shared/chat';
import type { TableHost } from './round-table';
import { FINAL_ROUNDS, REVIEW_ROUNDS, ReviewChains, verdictOf } from './review-chain';
import { SIGNAL_INSTRUCTION } from '../../../shared/task-signal';

const BUILDER = '11111111-1111-4111-8111-111111111111'; const REVIEWER = '22222222-2222-4222-8222-222222222222'; const PLANNER = '33333333-3333-4333-8333-333333333333';
function setup() {
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex'; cwd: string; owner: number }> = {
    [BUILDER]: { sessionId: 'builder', engine: 'claude', cwd: '/p', owner: 1 }, [REVIEWER]: { sessionId: 'reviewer', engine: 'codex', cwd: '/p', owner: 1 }, [PLANNER]: { sessionId: 'planner', engine: 'claude', cwd: '/p', owner: 1 },
  };
  const sent: { runId: string; text: string }[] = []; const modes: Record<string, boolean> = {}; const answers: { requestId: string; allow: boolean }[] = []; const interrupted: string[] = []; const events: ChatEnvelope[] = [];
  const host: TableHost = { run: (id) => runs[id] ?? null, send: (runId, text) => { sent.push({ runId, text }); }, setReadOnly: (id, ro) => { modes[id] = ro; }, answer: (_r, requestId, allow) => { answers.push({ requestId, allow }); }, interrupt: (id) => { interrupted.push(id); }, emit: (_o, e) => { events.push(e); } };
  const chains = new ReviewChains(host);
  const reply = async (runId: string, text: string, isError = false) => {
    const event: ChatEvent = { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] }; chains.observe({ sessionId: runs[runId].sessionId, runId, event });
    chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'done', isError, error: isError ? 'crashed' : null } }); await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const last = () => (events.filter((e) => e.event.type === 'table').at(-1)!.event as Extract<ChatEvent, { type: 'table' }>).table!;
  return { chains, sent, modes, answers, interrupted, reply, last };
}

describe('hierarchy Round Table', () => {
  it('plans, waits for the plan to be approved, builds, reviews, fixes, and completes only on the planner’s APPROVED', async () => {
    const { chains, sent, modes, reply, last } = setup();
    chains.open(1, BUILDER, REVIEWER, PLANNER);
    expect(modes).toEqual({ [BUILDER]: false, [REVIEWER]: true, [PLANNER]: true }); expect(last()).toMatchObject({ kind: 'hierarchy', planner: { sessionId: 'planner' }, chain: { step: 'idle' } });
    chains.send(BUILDER, 'Add a footer.', []);
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('You are the planner'); expect(sent.at(-1)!.text).toContain('Add a footer.');
    await reply(PLANNER, '1. Edit page.html\n2. Check it\nPLAN READY');
    expect(last().chain).toMatchObject({ step: 'plan-review', plan: '1. Edit page.html\n2. Check it' }); expect(sent).toHaveLength(1);
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
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, REVIEWER, PLANNER); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan A\nPLAN READY');
    expect(() => chains.plan(BUILDER, false, ' ')).toThrow(/Say what to change/);
    chains.send(BUILDER, 'Use the existing helper instead.', []);
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER }); expect(sent.at(-1)!.text).toContain('Use the existing helper instead.'); expect(last().chain!.step).toBe('planning');
  });
  it('skips the fix step when the reviewer finds nothing, sends CHANGES NEEDED back to the builder, and asks the person after the limit', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, REVIEWER, PLANNER); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
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
    const { chains, answers } = setup(); chains.open(1, BUILDER, REVIEWER, PLANNER);
    expect(chains.observe({ sessionId: 'planner', runId: PLANNER, event: { type: 'permission', requestId: 'r1', toolName: 'Write', description: '', input: {}, canAllowEdits: true } })).toContain('only the builder edits');
    expect(chains.observe({ sessionId: 'reviewer', runId: REVIEWER, event: { type: 'permission', requestId: 'r2', toolName: 'File changes', description: '', input: {}, canAllowEdits: true } })).toContain('only the builder edits');
    expect(chains.observe({ sessionId: 'builder', runId: BUILDER, event: { type: 'permission', requestId: 'r3', toolName: 'Write', description: '', input: {}, canAllowEdits: true } })).toBeNull();
    expect(answers).toEqual([{ requestId: 'r1', allow: false }, { requestId: 'r2', allow: false }]);
  });
  it('stops at a step and continues it; an error stops it too; a restart brings it back stopped at that step', async () => {
    const { chains, sent, interrupted, reply, last } = setup(); chains.open(1, BUILDER, REVIEWER, PLANNER); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    chains.stop(BUILDER); expect(interrupted).toEqual([BUILDER]); expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'implementing' });
    await reply(BUILDER, 'partial'); expect(last().chain!.step).toBe('stopped');
    chains.continue(BUILDER); expect(last().chain!.step).toBe('implementing'); expect(sent.at(-1)!.runId).toBe(BUILDER);
    await reply(BUILDER, 'boom', true); expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'implementing', note: 'crashed' });
    const saved = last().chain!;
    const after = setup(); after.chains.open(1, BUILDER, REVIEWER, PLANNER, { chain: { ...saved, step: 'reviewing', stoppedAt: undefined }, findings: [] });
    expect(after.last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'reviewing', task: 'Task', plan: 'Plan' }); after.chains.continue(BUILDER); expect(after.sent.at(-1)!.runId).toBe(REVIEWER);
  });
  it('stops when a seat says TASK BLOCKED, and sends the person\u2019s answer back to that seat in the same step', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, REVIEWER, PLANNER); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    await reply(BUILDER, 'Half done.\nTASK BLOCKED: Which database?');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'implementing', note: 'The builder needs you: Which database?' }); expect(sent.at(-1)!.runId).toBe(BUILDER);
    chains.send(BUILDER, 'Use SQLite.', []);
    expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(sent.at(-1)!.text).toContain('[The person answers] Use SQLite.'); expect(last().chain!.step).toBe('implementing');
    await reply(BUILDER, 'Done with SQLite.'); expect(last().chain!.step).toBe('reviewing');
  });
  it('saves a waiting message\u2019s images with the table, as a discussion table does', () => {
    const { chains, last } = setup(); chains.open(1, BUILDER, REVIEWER, PLANNER); chains.send(BUILDER, 'Task', []);
    const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }; chains.send(BUILDER, 'See this.', [image]);
    expect(last()).toMatchObject({ waiting: 'See this.', waitingImages: [image] });
  });
  it('keeps a Stop made while the files\u2019 state is still being taken', async () => {
    const { chains, sent, reply, last } = setup(); let release: (value: string) => void = () => {};
    (chains as unknown as { host: TableHost }).host.stateOf = () => new Promise<string>((resolve) => { release = resolve; });
    chains.open(1, BUILDER, REVIEWER, PLANNER); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    await reply(REVIEWER, 'FINDING high a.ts:1 — bug'); const before = sent.length;
    chains.stop(BUILDER); expect(last().chain!.step).toBe('stopped');
    release('a'.repeat(64)); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(last().chain!.step).toBe('stopped'); expect(sent.length).toBe(before);
  });
  it('after a restart, the answer to a blocked seat still goes to that seat in its step, not to a new task', async () => {
    const { chains, reply, last } = setup(); chains.open(1, BUILDER, REVIEWER, PLANNER); chains.send(BUILDER, 'Original task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    await reply(BUILDER, 'TASK BLOCKED: Which database?'); const saved = last().chain!; expect(saved).toMatchObject({ step: 'stopped', stoppedAt: 'implementing', blocked: 'builder' });
    const after = setup(); after.chains.open(1, BUILDER, REVIEWER, PLANNER, { chain: saved, findings: [] });
    after.chains.send(BUILDER, 'Use SQLite.', []);
    expect(after.sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(after.sent.at(-1)!.text).toContain('[The person answers] Use SQLite.');
    expect(after.last().chain).toMatchObject({ step: 'implementing', task: 'Original task' });
  });
  it('leaves an old answer behind when Stop then Continue happen while the files’ state is still being taken', async () => {
    const { chains, sent, reply, last } = setup(); const pending: ((value: string) => void)[] = [];
    (chains as unknown as { host: TableHost }).host.stateOf = () => new Promise<string>((resolve) => { pending.push(resolve); });
    chains.open(1, BUILDER, REVIEWER, PLANNER); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    const flush = async () => { for (const resolve of pending.splice(0)) resolve('a'.repeat(64)); for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
    await flush();
    await reply(REVIEWER, 'FINDING high a.ts:1 — bug');
    chains.stop(BUILDER); chains.continue(BUILDER); expect(last().chain!.step).toBe('reviewing'); const before = sent.length;
    await flush();
    // The old review's answer does not move the resumed review on to Fix.
    expect(last().chain!.step).toBe('reviewing'); expect(sent.length).toBe(before); expect(sent.at(-1)!.runId).toBe(REVIEWER);
  });
  it('waits for a stopped seat to stop before Continue, so its late end does not move the resumed step on', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, REVIEWER, PLANNER); chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    chains.stop(BUILDER); expect(last()).toMatchObject({ stopping: true, chain: { step: 'stopped', stoppedAt: 'implementing' } });
    // The builder has not ended its interrupted turn yet: Continue is refused rather than taking that end as its own.
    expect(() => chains.continue(BUILDER)).toThrow(/still stopping/); const before = sent.length;
    await reply(BUILDER, 'Half built.'); expect(last().stopping).toBeUndefined(); expect(last().chain!.step).toBe('stopped'); expect(sent.length).toBe(before);
    chains.continue(BUILDER); expect(last().chain!.step).toBe('implementing'); expect(sent.at(-1)!.runId).toBe(BUILDER);
    await reply(BUILDER, 'Built.'); expect(last().chain).toMatchObject({ step: 'reviewing', report: 'Built.' });
  });
  it('keeps a task’s TASK COMPLETE instruction out of the steps, and reads a verdict followed by TASK COMPLETE', async () => {
    const { chains, sent } = setup(); chains.open(1, BUILDER, REVIEWER, PLANNER);
    chains.send(BUILDER, `Task t-0123abcd: Add a footer. ${SIGNAL_INSTRUCTION}`, []);
    expect(sent.at(-1)!.text).toContain('Task t-0123abcd: Add a footer.'); expect(sent.at(-1)!.text).not.toContain(SIGNAL_INSTRUCTION); expect(sent.at(-1)!.text).toContain('TASK BLOCKED:');
    expect(verdictOf('Looks right.\nAPPROVED\nTASK COMPLETE')).toEqual({ approved: true }); expect(verdictOf('CHANGES NEEDED: rename it\n**TASK COMPLETE**')).toEqual({ approved: false, changes: 'rename it' });
    expect(verdictOf('TASK COMPLETE')).toBeNull();
  });
  it('reads the planner’s verdict only from its last line', () => {
    expect(verdictOf('Fine.\n**APPROVED**')).toEqual({ approved: true }); expect(verdictOf('CHANGES NEEDED: add tests')).toEqual({ approved: false, changes: 'add tests' });
    expect(verdictOf('APPROVED\nBut should I check more?')).toBeNull(); expect(REVIEW_ROUNDS).toBe(2);
  });
});
