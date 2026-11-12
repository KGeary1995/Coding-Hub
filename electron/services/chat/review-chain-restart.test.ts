import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent, SavedChain } from '../../../shared/chat';
import type { TableHost } from './round-table';
import { ReviewChains } from './review-chain';

const BUILDER = '11111111-1111-4111-8111-111111111111'; const REVIEWER = '22222222-2222-4222-8222-222222222222'; const PLANNER = '33333333-3333-4333-8333-333333333333';
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

/** A hierarchy table whose host says which runs are still in a turn (`busy`), and whose files' state can be held back. */
function setup() {
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex'; cwd: string; owner: number; busy?: boolean }> = {
    [BUILDER]: { sessionId: 'builder', engine: 'claude', cwd: '/p', owner: 1 }, [REVIEWER]: { sessionId: 'reviewer', engine: 'codex', cwd: '/p', owner: 1 }, [PLANNER]: { sessionId: 'planner', engine: 'claude', cwd: '/p', owner: 1 },
  };
  const sent: { runId: string; text: string }[] = []; const interrupted: string[] = []; const events: ChatEnvelope[] = [];
  let hold: Promise<void> | null = null;
  const host: TableHost = { run: (id) => runs[id] ?? null, send: (runId, text) => { sent.push({ runId, text }); }, setReadOnly: () => {}, answer: () => {}, interrupt: (id) => { interrupted.push(id); }, emit: (_o, e) => { events.push(e); },
    stateOf: async () => { if (hold) await hold; return 'a'.repeat(64); } };
  const chains = new ReviewChains(host);
  const reply = async (runId: string, text: string) => {
    await settle();
    chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] } });
    chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'done', isError: false, error: null } }); await settle();
  };
  const last = () => (events.filter((e) => e.event.type === 'table' && (e.event as { table: unknown }).table).at(-1)!.event as Extract<ChatEvent, { type: 'table' }>).table!;
  const holdState = () => { let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; }); return () => { hold = null; release(); }; };
  return { chains, runs, sent, interrupted, reply, last, holdState };
}
const stoppedAtBuild: SavedChain = { step: 'stopped', stoppedAt: 'implementing', task: 'Add a footer', plan: '1. Edit page.html', report: '', reviewRound: 0, finalRound: 0, verdict: null, note: '', challenged: true };

describe('a hierarchy table stopped and opened again', () => {
  it('stops the seats still at work when another seat ends', () => {
    const { chains, interrupted } = setup();
    chains.open(1, BUILDER, REVIEWER, PLANNER, { chain: stoppedAtBuild }); chains.continue(BUILDER);
    // The planner's process ends while the builder builds: the table closes, and the builder is stopped with it.
    chains.ended(PLANNER);
    expect(interrupted).toEqual([BUILDER]); expect(chains.has(BUILDER)).toBe(false);
  });
  it('waits for a seat still in its old turn, and never takes that turn\'s end for the new step', async () => {
    const { chains, runs, sent, interrupted, reply, last } = setup();
    // Reopened while the builder is still working on the build it was given before.
    runs[BUILDER].busy = true;
    chains.open(1, BUILDER, REVIEWER, PLANNER, { chain: stoppedAtBuild });
    expect(interrupted).toEqual([BUILDER]);
    expect(last()).toMatchObject({ stopping: true, chain: { step: 'stopped', stoppedAt: 'implementing' } });
    expect(() => chains.continue(BUILDER)).toThrow(/still stopping/);
    // The old turn ends: nothing moves on, and Continue works.
    await reply(BUILDER, 'Half of the old build.');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'implementing' }); expect(last().stopping).toBeUndefined();
    expect(sent).toHaveLength(0);
    chains.continue(BUILDER);
    expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(sent.at(-1)!.text).toContain('[Step: implement]');
    await reply(BUILDER, 'Built the footer.');
    expect(sent.at(-1)).toMatchObject({ runId: REVIEWER }); expect(sent.at(-1)!.text).toContain('Built the footer.');
    expect(last().chain).toMatchObject({ step: 'reviewing', report: 'Built the footer.' });
  });
});

describe('Stop and a full review record', () => {
  it('keeps a message sent before Stop, and it goes with the step when it continues', async () => {
    const { chains, sent, reply, last } = setup();
    chains.open(1, BUILDER, REVIEWER, PLANNER, { chain: stoppedAtBuild }); chains.continue(BUILDER);
    chains.send(BUILDER, 'use the brand colours', []);
    chains.stop(BUILDER); await reply(BUILDER, '');
    expect(last()).toMatchObject({ waiting: 'use the brand colours', chain: { step: 'stopped' } });
    chains.continue(BUILDER);
    expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(sent.at(-1)!.text).toContain('The person adds: use the brand colours');
  });
  it('stops for the person when a review reports findings the full record cannot take, instead of passing as clean', async () => {
    const { chains, sent, reply, last } = setup();
    const at = new Date().toISOString();
    const findings = Array.from({ length: 50 }, (_, i) => ({ id: `F${i + 1}`, severity: 'low' as const, evidence: '', text: `f${i + 1}`, status: 'open' as const, response: '', check: '', reviewedAt: null, changedAt: null, round: 1, at }));
    chains.open(1, BUILDER, REVIEWER, PLANNER, { chain: { ...stoppedAtBuild, stoppedAt: 'reviewing', reviewRound: 1, report: 'Built.' }, findings });
    chains.continue(BUILDER);
    await reply(REVIEWER, 'FINDING high a.ts:1 — a real problem');
    expect(last().chain).toMatchObject({ step: 'needs-you' }); expect(last().chain!.note).toContain('1 new finding');
    expect(sent.at(-1)).toMatchObject({ runId: REVIEWER });
  });
});

describe('a message sent between two steps of a task', () => {
  it('waits for the next step instead of starting a new task', async () => {
    const { chains, sent, reply, last, holdState } = setup();
    chains.open(1, BUILDER, REVIEWER, PLANNER, { chain: stoppedAtBuild }); chains.continue(BUILDER);
    await reply(BUILDER, 'Built the footer.');
    // The review ends with a finding; Trace records the files' state for it, and no seat is busy meanwhile.
    const release = holdState();
    await reply(REVIEWER, 'FINDING medium page.html:3 — footer not closed');
    expect(last().chain!.step).toBe('reviewing');
    chains.send(BUILDER, 'also check the mobile layout', []);
    expect(last()).toMatchObject({ waiting: 'also check the mobile layout', chain: { task: 'Add a footer' } });
    release(); await settle();
    // The fix goes on with the same task, and the message goes with it.
    expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(sent.at(-1)!.text).toContain('[Step: fix]');
    expect(sent.at(-1)!.text).toContain('The person adds: also check the mobile layout');
    expect(last().chain).toMatchObject({ step: 'fixing', task: 'Add a footer', plan: '1. Edit page.html' });
    expect(sent.some((item) => item.runId === PLANNER)).toBe(false);
  });
});
