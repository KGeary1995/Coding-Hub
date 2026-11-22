import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent, SavedChain } from '../../../shared/chat';
import type { SeatDuty } from '../../../shared/table-seats';
import { savedChainSchema } from '../../../shared/schemas';
import { preferencesSchema } from '../hub/preferences';
import { DEFAULT_PREFERENCES } from '../../../shared/hub';
import type { TableHost } from './round-table';
import { FINAL_ROUNDS, legacySeats, ReviewChains } from './review-chain';

const BUILDER = '11111111-1111-4111-8111-111111111111'; const PLANNER = '22222222-2222-4222-8222-222222222222'; const FIRST = '33333333-3333-4333-8333-333333333333'; const SECOND = '44444444-4444-4444-8444-444444444444'; const SPARE = '55555555-5555-4555-8555-555555555555';
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

/** Five running chats in one folder: a Claude builder, a Claude planner, a Codex and a Claude for reviewing, and a spare Codex. */
function setup(engines: Partial<Record<string, 'claude' | 'codex'>> = {}) {
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex'; cwd: string; owner: number; busy?: boolean }> = {
    [BUILDER]: { sessionId: 'builder', engine: engines[BUILDER] ?? 'claude', cwd: '/p', owner: 1 }, [PLANNER]: { sessionId: 'planner', engine: engines[PLANNER] ?? 'claude', cwd: '/p', owner: 1 },
    [FIRST]: { sessionId: 'first', engine: 'codex', cwd: '/p', owner: 1 }, [SECOND]: { sessionId: 'second', engine: engines[SECOND] ?? 'claude', cwd: '/p', owner: 1 }, [SPARE]: { sessionId: 'spare', engine: 'codex', cwd: '/p', owner: 1 },
  };
  const sent: { runId: string; text: string }[] = []; const modes: Record<string, boolean> = {}; const answers: { requestId: string; allow: boolean }[] = []; const interrupted: string[] = []; const events: ChatEnvelope[] = [];
  const host: TableHost = { run: (id) => runs[id] ?? null, send: (runId, text) => { sent.push({ runId, text }); }, setReadOnly: (id, readOnly) => { modes[id] = readOnly; }, answer: (_r, requestId, allow) => { answers.push({ requestId, allow }); }, interrupt: (id) => { interrupted.push(id); }, emit: (_o, envelope) => { events.push(envelope); } };
  const chains = new ReviewChains(host);
  const reply = async (runId: string, text: string) => {
    chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] } });
    chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'done', isError: false, error: null } }); await settle();
  };
  const last = () => (events.filter((envelope) => envelope.event.type === 'table' && (envelope.event as { table: unknown }).table).at(-1)!.event as Extract<ChatEvent, { type: 'table' }>).table!;
  const step = () => last().chain!.step;
  return { chains, runs, sent, modes, answers, interrupted, events, reply, last, step };
}
const seat = (runId: string, ...duties: SeatDuty[]) => ({ runId, duties });
/** Planner (plans, final review) and two reviewers, one after the other. */
const twoReviewers = [seat(PLANNER, 'plan', 'final'), seat(FIRST, 'review'), seat(SECOND, 'review')];

describe('a hierarchy table with the seats the person chose', () => {
  it('two reviewers review one after another; the second sees the first one’s findings; no challenger: the plan goes straight to the person', async () => {
    const { chains, sent, reply, last, step } = setup();
    chains.open(1, BUILDER, twoReviewers);
    expect(last()).toMatchObject({ seats: [{ sessionId: 'builder', duties: ['build'] }, { sessionId: 'planner', duties: ['plan', 'final'] }, { sessionId: 'first', duties: ['review'] }, { sessionId: 'second', duties: ['review'] }], partner: { sessionId: 'first' }, planner: { sessionId: 'planner' }, rounds: 2 });
    chains.send(BUILDER, 'Add a cache.', []);
    expect(sent.at(-1)!.text).toContain('Steps: the planner (Claude Code) plans, the person approves the plan, the builder (Claude Code) implements, Reviewer (Codex) and Reviewer 2 (Claude Code) review one after another, the builder fixes, and the planner gives the final review.');
    await reply(PLANNER, 'Plan\nPLAN READY'); expect(step()).toBe('plan-review');
    chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    expect(sent.at(-1)!.runId).toBe(FIRST); expect(last().chain).toMatchObject({ step: 'reviewing', reviewRound: 1, turnSeat: 'first' });
    await reply(FIRST, 'FINDING high a.ts:1 — leak');
    expect(sent.at(-1)!.runId).toBe(SECOND); expect(last().chain).toMatchObject({ step: 'reviewing', reviewRound: 1, turnSeat: 'second' });
    expect(sent.at(-1)!.text).toContain('Open findings already in the record (do not report these again):\nF1 (high, a.ts:1): leak'); expect(sent.at(-1)!.text).toContain('You are Reviewer 2. You review the builder\'s changes in the files, as findings.');
    await reply(SECOND, 'FINDING low b.ts:2 — typo');
    expect(sent.at(-1)!.runId).toBe(BUILDER); expect(sent.at(-1)!.text).toContain('F1 (high, a.ts:1): leak'); expect(sent.at(-1)!.text).toContain('F2 (low, b.ts:2): typo');
    await reply(BUILDER, 'FIXED F1: closed it\nFIXED F2: spelled it');
    expect(sent.at(-1)!.runId).toBe(FIRST); expect(last().chain!.reviewRound).toBe(2);
    await reply(FIRST, 'VERIFIED F1\nVERIFIED F2'); expect(sent.at(-1)!.runId).toBe(SECOND); await reply(SECOND, 'NO FINDINGS');
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(step()).toBe('final'); expect(last().chain!.turnSeat).toBeUndefined();
    await reply(PLANNER, 'APPROVED'); expect(last().chain).toMatchObject({ step: 'done', verdict: 'approved' });
  });
  it('with no reviewer, the build goes straight to the final review', async () => {
    const { chains, sent, reply, step } = setup(); chains.open(1, BUILDER, [seat(PLANNER, 'plan', 'final')]);
    chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true);
    expect(sent.at(-1)!.text).not.toContain('reviews'); await reply(BUILDER, 'Built.');
    expect(sent.at(-1)!.runId).toBe(PLANNER); expect(sent.at(-1)!.text).toContain('[Step: final review]'); expect(step()).toBe('final');
    // CHANGES NEEDED: fixed, then (no reviewer) the final review again.
    await reply(PLANNER, 'CHANGES NEEDED: rename it'); expect(step()).toBe('fixing'); await reply(BUILDER, 'Renamed.'); expect(step()).toBe('final');
  });
  it('with no final reviewer, the task is complete once reviewed, and what waits starts', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, [seat(PLANNER, 'plan'), seat(FIRST, 'challenge', 'review')]);
    chains.send(BUILDER, 'Task', []); expect(sent.at(-1)!.text).not.toContain('final review');
    await reply(PLANNER, 'Plan'); await reply(FIRST, 'NO CHALLENGES'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    chains.send(BUILDER, 'Next task.', []);
    await reply(FIRST, 'NO FINDINGS');
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER, text: expect.stringContaining('[Step: plan] The task:\n\nNext task.') }); expect(last().chain).toMatchObject({ step: 'planning', task: 'Next task.' });
  });
  it('with neither reviewers nor a final reviewer, the task is complete once built', async () => {
    const { chains, reply, last } = setup(); chains.open(1, BUILDER, [seat(PLANNER, 'plan')]);
    chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    expect(last()).toMatchObject({ agreed: true, chain: { step: 'done', verdict: 'approved', report: 'Built.' } });
  });
  it('a Codex builder with a Codex planner and a Claude reviewer: any engine in any seat', async () => {
    const { chains, sent, modes, reply, last, answers } = setup({ [BUILDER]: 'codex', [PLANNER]: 'codex' });
    chains.open(1, BUILDER, [seat(PLANNER, 'plan', 'final'), seat(SECOND, 'review')]);
    expect(modes).toEqual({ [BUILDER]: false, [PLANNER]: true, [SECOND]: true }); expect(last()).toMatchObject({ driver: 'codex', planner: { engine: 'codex' }, partner: { sessionId: 'second', engine: 'claude' } });
    chains.send(BUILDER, 'Task', []);
    expect(sent.at(-1)!.text).toContain('Write the whole plan in your reply, not in a file'); expect(sent.at(-1)!.text).not.toContain('ExitPlanMode');
    expect(chains.observe({ sessionId: 'second', runId: SECOND, event: { type: 'permission', requestId: 'e1', toolName: 'Edit', description: '', input: {}, canAllowEdits: true } })).toBe('Trace declined Edit for the reviewer: only the builder edits files.');
    expect(chains.observe({ sessionId: 'builder', runId: BUILDER, event: { type: 'permission', requestId: 'e2', toolName: 'File changes', description: '', input: {}, canAllowEdits: true } })).toBeNull();
    expect(answers).toEqual([{ requestId: 'e1', allow: false }]);
    await reply(PLANNER, 'Plan'); chains.plan(BUILDER, true); expect(sent.at(-1)!.text).toContain('You are the builder: the only seat that edits files.');
    await reply(BUILDER, 'Built.'); expect(sent.at(-1)!.runId).toBe(SECOND); await reply(SECOND, 'FINDING medium a.ts:3 — off by one');
    expect(last().findings).toMatchObject([{ id: 'F1', status: 'open' }]);
  });
  it('a planner that also reviews: its review lines are read in the review step, never at planning', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, [seat(PLANNER, 'plan', 'review', 'final')]);
    chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'FINDING high x.ts:1 — not a review yet\nPlan'); expect(last().findings).toEqual([]);
    chains.plan(BUILDER, true); await reply(BUILDER, 'Built.'); expect(sent.at(-1)).toMatchObject({ runId: PLANNER, text: expect.stringContaining('[Step: review, round 1 of 2]') });
    await reply(PLANNER, 'FINDING high a.ts:1 — leak'); expect(last().findings).toMatchObject([{ id: 'F1', text: 'leak' }]); expect(sent.at(-1)!.runId).toBe(BUILDER);
    await reply(BUILDER, 'FIXED F1: done'); await reply(PLANNER, 'VERIFIED F1\nNO FINDINGS'); expect(last().findings![0].status).toBe('verified');
    expect(sent.at(-1)!.text).toContain('[Step: final review]'); expect(sent.at(-1)!.text).toContain('Your plan:');
  });
  it('two challengers challenge in turn, numbered on; the second sees what the first raised; the planner answers all', async () => {
    const { chains, sent, reply, last } = setup(); chains.open(1, BUILDER, [seat(PLANNER, 'plan', 'final'), seat(FIRST, 'challenge'), seat(SECOND, 'challenge', 'review')]);
    chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan');
    expect(sent.at(-1)!.runId).toBe(FIRST); await reply(FIRST, 'CHALLENGE high — misses mobile\nCHALLENGE low — use a partial');
    expect(sent.at(-1)!.runId).toBe(SECOND); expect(sent.at(-1)!.text).toContain('Already raised by the challenger (do not raise these again):\nC1 (high): misses mobile\nC2 (low): use a partial');
    await reply(SECOND, 'CHALLENGE medium — no test');
    expect(last().chain!.challenges!.map((challenge) => challenge.id)).toEqual(['C1', 'C2', 'C3']); expect(sent.at(-1)).toMatchObject({ runId: PLANNER, text: expect.stringContaining('The challengers challenged your plan:\nC1 (high): misses mobile') });
    await reply(PLANNER, 'ACCEPTED C1, C3\nREJECTED C2 — one file\nPlan 2'); expect(last().chain).toMatchObject({ step: 'plan-review', plan: 'Plan 2' });
  });
  it('honours the review rounds it is opened with, and changes them only at rest', async () => {
    const { chains, sent, reply, last, step } = setup(); chains.open(1, BUILDER, legacySeats(FIRST, PLANNER), { rounds: 1 }); expect(last().rounds).toBe(1);
    chains.send(BUILDER, 'Task', []); await reply(PLANNER, 'Plan'); await reply(FIRST, 'NO CHALLENGES');
    expect(() => chains.setRounds(BUILDER, 3)).not.toThrow(); expect(last().rounds).toBe(3); expect(chains.setRounds(BUILDER, 9).rounds).toBe(5); expect(chains.setRounds(BUILDER, 0).rounds).toBe(1);
    chains.plan(BUILDER, true); expect(() => chains.setRounds(BUILDER, 3)).toThrow(/while the table waits/);
    await reply(BUILDER, 'Built.'); expect(sent.at(-1)!.text).toContain('[Step: review, round 1 of 1]');
    await reply(FIRST, 'FINDING low a.ts:1 — typo'); await reply(BUILDER, 'FIXED F1: done');
    // One round only: after the fix, the final review.
    expect(step()).toBe('final'); expect(sent.at(-1)!.runId).toBe(PLANNER);
    // CHANGES NEEDED goes back to the fix and one more review, whatever the rounds.
    await reply(PLANNER, 'CHANGES NEEDED: rename'); await reply(BUILDER, 'Renamed.'); expect(last().chain).toMatchObject({ step: 'reviewing', reviewRound: 1 });
  });
});

describe('a hierarchy table with several reviewers, stopped and opened again', () => {
  /** A table in the second reviewer's turn of round 1. */
  const atSecond = async () => { const table = setup(); table.chains.open(1, BUILDER, twoReviewers); table.chains.send(BUILDER, 'Task', []); await table.reply(PLANNER, 'Plan'); table.chains.plan(BUILDER, true); await table.reply(BUILDER, 'Built.'); await table.reply(FIRST, 'NO FINDINGS'); return table; };
  it('Stop and Continue in the second reviewer’s turn give the review to the second reviewer again', async () => {
    const { chains, sent, interrupted, reply, last } = await atSecond();
    chains.stop(BUILDER); expect(interrupted).toEqual([SECOND]); await reply(SECOND, 'partial');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'reviewing', turnSeat: 'second' });
    chains.continue(BUILDER); expect(sent.at(-1)!.runId).toBe(SECOND); expect(last().chain).toMatchObject({ step: 'reviewing', turnSeat: 'second' });
  });
  it('a restart in the second reviewer’s turn picks the review up with that reviewer (turnSeat)', async () => {
    const { chains, reply, last } = await atSecond(); chains.stop(BUILDER); await reply(SECOND, 'partial');
    const saved = savedChainSchema.parse(last().chain); expect(saved.turnSeat).toBe('second');
    const after = setup(); after.chains.open(1, BUILDER, twoReviewers, { chain: saved, findings: [] });
    after.chains.continue(BUILDER); expect(after.sent.at(-1)!.runId).toBe(SECOND); expect(after.sent.at(-1)!.text).toContain('[Step: review, round 1 of 2]');
    await after.reply(SECOND, 'NO FINDINGS'); expect(after.last().chain!.step).toBe('final');
    // Without turnSeat (a table saved before 1.26) the first reviewer takes it.
    const older = setup(); const { turnSeat: _turn, ...legacy } = saved; older.chains.open(1, BUILDER, twoReviewers, { chain: legacy as SavedChain, findings: [] });
    older.chains.continue(BUILDER); expect(older.sent.at(-1)!.runId).toBe(FIRST);
  });
  it('a reviewer that said TASK BLOCKED gets the answer, also after a restart (blockedSeat), and the old kind is still saved', async () => {
    const { reply, last } = await atSecond();
    await reply(SECOND, 'TASK BLOCKED: Which branch?');
    const saved = last().chain!; expect(saved).toMatchObject({ step: 'stopped', stoppedAt: 'reviewing', blocked: 'reviewer', blockedSeat: 'second', note: 'Reviewer 2 needs you: Which branch?' });
    const after = setup(); after.chains.open(1, BUILDER, twoReviewers, { chain: saved, findings: [] });
    after.chains.send(BUILDER, 'main.', []);
    expect(after.sent.at(-1)).toMatchObject({ runId: SECOND, text: expect.stringContaining('[The person answers] main.') }); expect(after.last().chain!.step).toBe('reviewing');
    // Only the old kind saved: the first seat that reviews.
    const older = setup(); const { blockedSeat: _seat, ...legacy } = saved; older.chains.open(1, BUILDER, twoReviewers, { chain: legacy as SavedChain, findings: [] });
    older.chains.send(BUILDER, 'main.', []); expect(older.sent.at(-1)!.runId).toBe(FIRST);
  });
});

describe('changing a hierarchy table’s seats', () => {
  it('adds, removes and re-tasks seats between tasks; renames at any resting step; never while a seat works', async () => {
    const { chains, sent, modes, reply, last } = setup(); chains.open(1, BUILDER, legacySeats(FIRST, PLANNER));
    const lead = { runId: BUILDER, duties: ['build'] as SeatDuty[] };
    // Idle: a second reviewer joins, read-only; the old reviewer only challenges now.
    chains.setSeats(BUILDER, [lead, seat(PLANNER, 'plan', 'final'), seat(FIRST, 'challenge'), { ...seat(SECOND, 'review'), name: 'Opus', instructions: 'Look at the tests.' }]);
    expect(modes[SECOND]).toBe(true); expect(last().seats!.map((item) => item.sessionId)).toEqual(['builder', 'planner', 'first', 'second']); expect(last().partner.sessionId).toBe('second');
    chains.send(BUILDER, 'Task', []);
    expect(() => chains.setSeats(BUILDER, [lead, seat(PLANNER, 'plan', 'final')])).toThrow(/once the agents have finished/);
    await reply(PLANNER, 'Plan'); await reply(FIRST, 'NO CHALLENGES'); expect(last().chain!.step).toBe('plan-review');
    // At the plan review: names may change, seats and duties may not.
    expect(() => chains.setSeats(BUILDER, [lead, seat(PLANNER, 'plan', 'final'), seat(FIRST, 'challenge')])).toThrow(/between tasks/);
    chains.setSeats(BUILDER, [lead, { ...seat(PLANNER, 'plan', 'final'), name: 'Fable' }, seat(FIRST, 'challenge'), { ...seat(SECOND, 'review'), name: 'Opus', instructions: 'Look at the tests.' }]);
    chains.plan(BUILDER, true); expect(sent.at(-1)!.text).toContain('Fable (Claude Code) plans');
    await reply(BUILDER, 'Built.'); expect(sent.at(-1)!.runId).toBe(SECOND); expect(sent.at(-1)!.text).toContain("[The person's own instructions for you at this table]\nLook at the tests.");
    expect(() => chains.setSeats(BUILDER, [lead, seat(PLANNER, 'plan', 'final')])).toThrow(/once the agents have finished/);
    await reply(SECOND, 'NO FINDINGS'); await reply(PLANNER, 'APPROVED'); expect(last().chain!.step).toBe('done');
    // Done: the second reviewer leaves (it may edit again); the builder must stay and keep building only.
    expect(() => chains.setSeats(BUILDER, [seat(PLANNER, 'plan', 'final'), seat(FIRST, 'review')])).toThrow(/keeps its seat/);
    expect(() => chains.setSeats(BUILDER, [lead, seat(FIRST, 'review')])).toThrow(/exactly one planner/);
    chains.setSeats(BUILDER, [lead, seat(PLANNER, 'plan', 'final'), seat(FIRST, 'review')]);
    expect(modes[SECOND]).toBe(false); expect(chains.isSeated(SECOND)).toBe(false); expect(last().seats).toHaveLength(3);
  });
  it('refuses a chat already at another table, and opens only seats that make a hierarchy', () => {
    const { chains } = setup(); chains.open(1, BUILDER, [seat(PLANNER, 'plan', 'final')]);
    expect(() => chains.setSeats(BUILDER, [seat(BUILDER, 'build'), seat(PLANNER, 'plan', 'final'), seat(SPARE, 'review')])).not.toThrow();
    const other = setup(); other.chains.open(1, SECOND, [seat(SPARE, 'plan')]);
    expect(() => other.chains.setSeats(SECOND, [seat(SECOND, 'build'), seat(SPARE, 'plan')])).not.toThrow();
    expect(() => other.chains.open(1, BUILDER, [seat(SPARE, 'plan')])).toThrow(/already at a Round Table/);
    expect(() => other.chains.open(1, BUILDER, [seat(PLANNER, 'review')])).toThrow(/exactly one planner/);
    expect(() => other.chains.open(1, BUILDER, [seat(PLANNER, 'plan', 'build')])).toThrow(/exactly one builder/);
  });
  it('closes when any seat ends, found by any seat', () => {
    const { chains, interrupted } = setup(); chains.open(1, BUILDER, twoReviewers); chains.send(BUILDER, 'Task', []);
    expect(chains.isSeated(SECOND)).toBe(true); chains.ended(SECOND);
    expect(chains.has(BUILDER)).toBe(false); expect(interrupted).toEqual([PLANNER]);
  });
  it('still asks the person after FINAL_ROUNDS of changes', () => { expect(FINAL_ROUNDS).toBe(2); });
});

describe('Round Table presets in the preferences', () => {
  const preset = { id: 'mine', name: 'Two reviewers', kind: 'hierarchy' as const, rounds: 3, seats: [{ engine: 'claude' as const, model: '', duties: ['build'] }, { engine: 'codex' as const, model: 'gpt-6.1-sol', duties: ['plan', 'final'], name: 'Planner', instructions: 'Keep it small.' }, { engine: 'claude' as const, model: 'claude-opus-5-5', duties: ['review'] }] };
  it('keeps the person’s presets, and refuses too many or a malformed one', () => {
    expect(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, tablePresets: [preset, { id: 'talk', name: 'Three agents', kind: 'discussion', rounds: 2, driver: 1, seats: [{ engine: 'claude', model: '' }, { engine: 'codex', model: '' }, { engine: 'claude', model: '' }] }] }).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES }).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, tablePresets: Array.from({ length: 21 }, (_, n) => ({ ...preset, id: `p${n}` })) }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, tablePresets: [{ ...preset, seats: [{ engine: 'gemini', model: '' }, preset.seats[1]] }] }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, tablePresets: [{ ...preset, extra: true }] }).success).toBe(false);
  });
});
