import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent, SavedChain } from '../../../shared/chat';
import type { TableHost } from './round-table';
import { ReviewChains } from './review-chain';

const BUILDER = '11111111-1111-4111-8111-111111111111'; const REVIEWER = '22222222-2222-4222-8222-222222222222'; const PLANNER = '33333333-3333-4333-8333-333333333333';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

/** A hierarchy table in a folder whose files Trace reads as `files.state` (null: not a Git folder). */
function setup(state: string | null = 'a'.repeat(64)) {
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex'; cwd: string; owner: number }> = {
    [BUILDER]: { sessionId: 'builder', engine: 'claude', cwd: '/p', owner: 1 }, [REVIEWER]: { sessionId: 'reviewer', engine: 'codex', cwd: '/p', owner: 1 }, [PLANNER]: { sessionId: 'planner', engine: 'claude', cwd: '/p', owner: 1 },
  };
  const sent: { runId: string; text: string }[] = []; const events: ChatEnvelope[] = [];
  const host: TableHost = { run: (id) => runs[id] ?? null, send: (runId, text) => { sent.push({ runId, text }); }, setReadOnly: () => {}, answer: () => {}, interrupt: () => {}, emit: (_o, e) => { events.push(e); }, stateOf: async () => state };
  const chains = new ReviewChains(host);
  const reply = async (runId: string, text: string) => {
    await settle();
    chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] } });
    chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'done', isError: false, error: null } }); await settle();
  };
  const last = () => (events.filter((e) => e.event.type === 'table').at(-1)!.event as Extract<ChatEvent, { type: 'table' }>).table!;
  const open = (saved: { chain?: SavedChain } = {}) => chains.open(1, BUILDER, REVIEWER, PLANNER, { findings: [], ...saved });
  return { chains, sent, reply, last, open };
}

describe('hierarchy Round Table: Codex challenges the plan', () => {
  it('plan, Codex challenges, the planner answers and rewrites the plan, then the person sees it', async () => {
    const { chains, sent, reply, last, open } = setup(); open();
    chains.send(BUILDER, 'Add a footer.', []);
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER }); expect(sent.at(-1)!.text).toContain('the reviewer (Codex) challenges the plan and the planner answers');
    await reply(PLANNER, '1. Edit page.html\nPLAN READY');
    expect(sent.at(-1)).toMatchObject({ runId: REVIEWER }); expect(last().chain!.step).toBe('challenging');
    const challenge = sent.at(-1)!.text;
    expect(challenge).toContain('[Step: challenge the plan]'); expect(challenge).toContain('1. Edit page.html');
    expect(challenge).toContain('You are the reviewer. You challenge the planner\'s plan before the person sees it');
    await reply(REVIEWER, 'CHALLENGE high — the footer must show on mobile too\nCHALLENGE low — use a partial');
    expect(last().chain).toMatchObject({ step: 'plan-responding', challenges: [{ id: 'C1', severity: 'high' }, { id: 'C2', severity: 'low' }] });
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER });
    expect(sent.at(-1)!.text).toContain('The reviewer challenged your plan:'); expect(sent.at(-1)!.text).toContain('C1 (high): the footer must show on mobile too');
    await reply(PLANNER, 'ACCEPTED C1\nREJECTED C2 — one file only\n1. Edit page.html, with a mobile rule\nPLAN READY');
    expect(last().chain).toMatchObject({ step: 'plan-review', plan: '1. Edit page.html, with a mobile rule', challenges: [{ id: 'C1', answer: 'accepted' }, { id: 'C2', answer: 'rejected', reason: 'one file only' }] });
    expect(sent.some((item) => /gemini/i.test(item.text))).toBe(false);
  });
  it('goes to plan review when Codex has no challenges', async () => {
    const { chains, reply, last, open } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan\nPLAN READY'); await reply(REVIEWER, 'Looks complete.\nNO CHALLENGES');
    expect(last().chain).toMatchObject({ step: 'plan-review', challenged: true, plan: 'Plan' }); expect(last().chain!.challenges).toBeUndefined();
  });
  it('stops at the challenge when Codex answers with neither CHALLENGE lines nor NO CHALLENGES', async () => {
    const { chains, reply, last, open } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan\nPLAN READY'); await reply(REVIEWER, 'I think it is fine, mostly.');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'challenging' }); expect(last().chain!.note).toContain('Continue without the challenge');
  });
  it('Continue without the challenge goes to plan review; only a stopped challenge can be left out', async () => {
    const { chains, sent, reply, last, open } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan\nPLAN READY'); chains.stop(BUILDER); await reply(REVIEWER, '');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'challenging' });
    const count = sent.length;
    chains.continue(BUILDER, true);
    expect(last().chain).toMatchObject({ step: 'plan-review', challenged: true, note: 'The challenge was left out at your request.' }); expect(sent).toHaveLength(count);
    // Approved and stopped while building: the build cannot be "left out".
    chains.plan(BUILDER, true); chains.stop(BUILDER); await reply(BUILDER, '');
    expect(() => chains.continue(BUILDER, true)).toThrow(/Only a stopped challenge/);
    chains.continue(BUILDER); expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(last().chain!.step).toBe('implementing');
  });
  it('Continue at a stopped challenge asks Codex again', async () => {
    const { chains, sent, reply, last, open } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan\nPLAN READY'); await reply(REVIEWER, 'Hmm.');
    chains.continue(BUILDER);
    expect(sent.at(-1)).toMatchObject({ runId: REVIEWER }); expect(sent.at(-1)!.text).toContain('[Step: challenge the plan]'); expect(last().chain!.step).toBe('challenging');
  });
  it('does not challenge a plan revised at the person\'s request, and challenges a new task\'s plan', async () => {
    const { chains, sent, reply, last, open } = setup(); open(); chains.send(BUILDER, 'Task one', []);
    await reply(PLANNER, 'Plan\nPLAN READY'); await reply(REVIEWER, 'NO CHALLENGES');
    chains.plan(BUILDER, false, 'Smaller, please');
    await reply(PLANNER, 'Smaller plan\nPLAN READY');
    expect(last().chain).toMatchObject({ step: 'plan-review', plan: 'Smaller plan' });
    expect(sent.filter((item) => item.runId === REVIEWER)).toHaveLength(1);
    // Done with the first task, a new one is challenged again.
    chains.plan(BUILDER, true); await reply(BUILDER, 'Built.'); await reply(REVIEWER, 'NO FINDINGS'); await reply(PLANNER, 'APPROVED');
    expect(last().chain!.step).toBe('done');
    chains.send(BUILDER, 'Task two', []); await reply(PLANNER, 'Plan two\nPLAN READY');
    expect(last().chain).toMatchObject({ step: 'challenging', task: 'Task two' }); expect(last().chain!.challenged).toBeUndefined();
  });
  it('goes from the build straight to Codex\'s review, round 1', async () => {
    const { chains, sent, reply, last, open } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan\nPLAN READY'); await reply(REVIEWER, 'NO CHALLENGES'); chains.plan(BUILDER, true);
    await reply(BUILDER, 'Changed a.ts.');
    expect(sent.at(-1)).toMatchObject({ runId: REVIEWER }); expect(sent.at(-1)!.text).toContain('[Step: review, round 1 of 2]');
    expect(last().chain).toMatchObject({ step: 'reviewing', reviewRound: 1 });
  });
  it('runs the whole flow in a folder that is not a Git repository', async () => {
    const { chains, sent, reply, last, open } = setup(null); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan\nPLAN READY');
    expect(last().chain!.step).toBe('challenging');
    await reply(REVIEWER, 'CHALLENGE medium — say how to test it');
    await reply(PLANNER, 'ACCEPTED C1\nPlan with a test\nPLAN READY');
    expect(last().chain).toMatchObject({ step: 'plan-review', plan: 'Plan with a test' });
    chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    await reply(REVIEWER, 'FINDING low a.ts:1 — typo');
    expect(last().findings).toMatchObject([{ id: 'F1', status: 'open', reviewedAt: null }]);
    await reply(BUILDER, 'FIXED F1: fixed'); await reply(REVIEWER, 'VERIFIED F1\nNO FINDINGS');
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER }); expect(sent.at(-1)!.text).toContain('The reviewer\'s challenges to the plan:'); expect(sent.at(-1)!.text).toContain('C1 (medium, accepted)');
    await reply(PLANNER, 'APPROVED');
    expect(last().chain).toMatchObject({ step: 'done', verdict: 'approved' });
  });
  it('closes the table when any seat ends', () => {
    const { chains, open } = setup(); open();
    chains.ended(REVIEWER);
    expect(chains.has(BUILDER)).toBe(false);
  });
});
