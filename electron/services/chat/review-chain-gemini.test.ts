import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent, SavedChain } from '../../../shared/chat';
import type { TableHost } from './round-table';
import { ReviewChains } from './review-chain';

const BUILDER = '11111111-1111-4111-8111-111111111111'; const REVIEWER = '22222222-2222-4222-8222-222222222222'; const PLANNER = '33333333-3333-4333-8333-333333333333'; const GEMINI = '44444444-4444-4444-8444-444444444444';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

/** A hierarchy table with a Gemini seat in a Git folder whose files Trace reads as `files.state` (null: not Git). */
function setup() {
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex' | 'gemini'; cwd: string; owner: number; permissions?: 'ask' | 'edits' | 'full' }> = {
    [BUILDER]: { sessionId: 'builder', engine: 'claude', cwd: '/p', owner: 1 }, [REVIEWER]: { sessionId: 'reviewer', engine: 'codex', cwd: '/p', owner: 1 }, [PLANNER]: { sessionId: 'planner', engine: 'claude', cwd: '/p', owner: 1 }, [GEMINI]: { sessionId: 'gemini', engine: 'gemini', cwd: '/p', owner: 1 },
  };
  const files = { state: 'a'.repeat(64) as string | null };
  const sent: { runId: string; text: string }[] = []; const modes: Record<string, boolean> = {}; const answers: { requestId: string; allow: boolean }[] = []; const interrupted: string[] = []; const events: ChatEnvelope[] = [];
  const host: TableHost = { run: (id) => runs[id] ?? null, send: (runId, text) => { sent.push({ runId, text }); }, setReadOnly: (id, ro) => { modes[id] = ro; }, answer: (_r, requestId, allow) => { answers.push({ requestId, allow }); }, interrupt: (id) => { interrupted.push(id); }, emit: (_o, e) => { events.push(e); }, stateOf: async () => files.state };
  const chains = new ReviewChains(host);
  /** A seat answers; Gemini may change the files while it does (`during`). */
  const reply = async (runId: string, text: string, options: { isError?: boolean; during?: () => void } = {}) => {
    await settle(); options.during?.();
    const event: ChatEvent = { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] }; chains.observe({ sessionId: runs[runId].sessionId, runId, event });
    chains.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'done', isError: options.isError ?? false, error: options.isError ? 'crashed' : null } }); await settle();
  };
  const last = () => (events.filter((e) => e.event.type === 'table').at(-1)!.event as Extract<ChatEvent, { type: 'table' }>).table!;
  const to = async () => { await settle(); return sent.at(-1)!; };
  const open = (saved: { chain?: SavedChain } = {}, gemini = true) => chains.open(1, BUILDER, REVIEWER, PLANNER, { findings: [], ...saved }, gemini ? GEMINI : undefined);
  return { chains, sent, modes, answers, interrupted, reply, last, to, open, files, runs };
}

describe('hierarchy Round Table with a Gemini seat', () => {
  it('runs the whole flow: plan, Gemini challenges, the planner answers, approval, build, Gemini reviews first, Codex reviews unaware, Gemini compares, fix, Codex verifies, final review', async () => {
    const { chains, sent, modes, reply, last, to, open } = setup();
    open();
    expect(modes).toEqual({ [BUILDER]: false, [REVIEWER]: true, [PLANNER]: true, [GEMINI]: true });
    expect(last()).toMatchObject({ challenger: { sessionId: 'gemini', engine: 'gemini' } });
    chains.send(BUILDER, 'Add a footer.', []);
    expect(sent.at(-1)!.text).toContain('Gemini challenges the plan');
    await reply(PLANNER, '1. Edit page.html\nPLAN READY');
    // Gemini challenges before the person sees the plan.
    expect(await to()).toMatchObject({ runId: GEMINI }); expect(sent.at(-1)!.text).toContain('You are Gemini, the challenger'); expect(sent.at(-1)!.text).toContain('1. Edit page.html');
    expect(last().chain!.step).toBe('challenging');
    await reply(GEMINI, 'CHALLENGE high — the footer must show on mobile too\nCHALLENGE low — use a partial');
    expect(last().chain).toMatchObject({ step: 'plan-responding', challenges: [{ id: 'C1', severity: 'high' }, { id: 'C2', severity: 'low' }] });
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER }); expect(sent.at(-1)!.text).toContain('C1 (high): the footer must show on mobile too');
    await reply(PLANNER, 'ACCEPTED C1\nREJECTED C2 — one file only\n1. Edit page.html, with a mobile rule\nPLAN READY');
    expect(last().chain).toMatchObject({ step: 'plan-review', plan: '1. Edit page.html, with a mobile rule', challenges: [{ id: 'C1', answer: 'accepted' }, { id: 'C2', answer: 'rejected', reason: 'one file only' }] });
    chains.plan(BUILDER, true); await reply(BUILDER, 'Changed page.html.');
    // Gemini reviews first, before Codex.
    expect(await to()).toMatchObject({ runId: GEMINI }); expect(last().chain!.step).toBe('second-reviewing');
    await reply(GEMINI, 'FINDING medium page.html:3 — footer not closed\nFINDING low page.html:9 — no alt text');
    expect(last().findings).toMatchObject([{ id: 'F1', source: 'gemini' }, { id: 'F2', source: 'gemini' }]);
    // Codex reviews without Gemini's findings.
    expect(sent.at(-1)).toMatchObject({ runId: REVIEWER }); expect(sent.at(-1)!.text).not.toContain('footer not closed'); expect(last().chain!.step).toBe('reviewing');
    await reply(REVIEWER, 'FINDING medium page.html:3 — unclosed footer tag\nFINDING high page.css:1 — breaks the header');
    expect(last().findings!.slice(2)).toMatchObject([{ id: 'F3' }, { id: 'F4' }]); expect(last().findings![2].source).toBeUndefined();
    // Gemini compares the two reviews.
    expect(await to()).toMatchObject({ runId: GEMINI }); expect(sent.at(-1)!.text).toContain('F3 (medium, page.html:3): unclosed footer tag'); expect(sent.at(-1)!.text).toContain('F1 (medium, page.html:3): footer not closed');
    await reply(GEMINI, 'DUPLICATE F3 of F1\nDISPUTE F4 — the header is in another file\nCOMPARED');
    expect(last().findings).toMatchObject([{ id: 'F1' }, { id: 'F2' }, { id: 'F3', duplicateOf: 'F1', status: 'verified' }, { id: 'F4', gemini: 'dispute', geminiNote: 'the header is in another file' }]);
    // The builder sees every open finding with where it came from and Gemini's view; not the duplicate.
    expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); const fix = sent.at(-1)!.text;
    expect(fix).toContain('F1 (medium, page.html:3, from Gemini)'); expect(fix).toContain('F4 (high, page.css:1, from Codex; Gemini disputes: the header is in another file)'); expect(fix).not.toContain('F3 (');
    await reply(BUILDER, 'FIXED F1: closed it\nFIXED F2: added alt\nDECLINED F4: not this change');
    // Codex alone checks the fixes, Gemini's included.
    expect(sent.at(-1)).toMatchObject({ runId: REVIEWER }); expect(sent.at(-1)!.text).toContain('F1 (medium, page.html:3, from Gemini, fixed: closed it)');
    await reply(REVIEWER, 'VERIFIED F1\nVERIFIED F2\nVERIFIED F4\nNO FINDINGS');
    expect(sent.at(-1)).toMatchObject({ runId: PLANNER }); expect(sent.at(-1)!.text).toContain('Gemini\'s challenges to the plan'); expect(sent.at(-1)!.text).toContain('F3 (medium, verified, duplicate of F1)');
    await reply(PLANNER, 'APPROVED');
    expect(last().chain).toMatchObject({ step: 'done', verdict: 'approved' });
    expect(sent.filter((item) => item.runId === GEMINI)).toHaveLength(3);
  });
  it('goes to plan review when Gemini has no challenges, and skips the comparison when Codex finds nothing', async () => {
    const { chains, sent, reply, last, to, open } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan\nPLAN READY'); await to(); await reply(GEMINI, 'Looks complete.\nNO CHALLENGES');
    expect(last().chain).toMatchObject({ step: 'plan-review', challenged: true }); expect(last().chain!.challenges).toBeUndefined();
    chains.plan(BUILDER, true); await reply(BUILDER, 'Built.'); await to(); await reply(GEMINI, 'FINDING low a.ts:1 — typo');
    await reply(REVIEWER, 'NO FINDINGS');
    // Nothing of Codex's to compare: the builder fixes Gemini's finding.
    expect(sent.at(-1)).toMatchObject({ runId: BUILDER }); expect(last().chain).toMatchObject({ step: 'fixing', compared: true });
  });
  it('works as before without a Gemini seat', async () => {
    const { chains, sent, reply, last, open } = setup(); open({}, false); chains.send(BUILDER, 'Task', []);
    expect(sent.at(-1)!.text).not.toContain('Gemini');
    await reply(PLANNER, 'Plan'); expect(last().chain!.step).toBe('plan-review'); expect(last().challenger).toBeUndefined();
    chains.plan(BUILDER, true); await reply(BUILDER, 'Built.'); expect(sent.at(-1)!.runId).toBe(REVIEWER);
  });
  it('stops the table when the files change during a Gemini step, whatever Gemini answered, and Continue without Gemini goes on', async () => {
    const { chains, sent, reply, last, to, open, files } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan'); await to();
    await reply(GEMINI, 'NO CHALLENGES', { during: () => { files.state = 'b'.repeat(64); } });
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'challenging' }); expect(last().chain!.note).toContain('files changed during Gemini');
    expect(last().chain!.challenged).toBeUndefined();
    expect(() => chains.continue(BUILDER, true)).not.toThrow();
    expect(last().chain).toMatchObject({ step: 'plan-review', challenged: true, note: 'Gemini was left out of this step at your request.' });
    chains.plan(BUILDER, true); await reply(BUILDER, 'Built.');
    // Gemini still reviews this task (only the challenge was passed over).
    expect(await to()).toMatchObject({ runId: GEMINI });
    // Changed during the review: stopped again, nothing recorded; Continue runs the review again.
    await reply(GEMINI, 'FINDING high a.ts:1 — bug', { during: () => { files.state = 'c'.repeat(64); } });
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'second-reviewing' }); expect(last().findings).toEqual([]);
    const before = sent.length; chains.continue(BUILDER); expect(await to()).toMatchObject({ runId: GEMINI }); expect(sent.length).toBe(before + 1);
    await reply(GEMINI, 'NO FINDINGS'); expect(sent.at(-1)!.runId).toBe(REVIEWER);
  });
  it('stops on a change even when Gemini’s turn failed, so a later Continue does not take the changed files as its start', async () => {
    const { chains, reply, last, to, open, files } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan'); await to();
    await reply(GEMINI, '', { isError: true, during: () => { files.state = 'd'.repeat(64); } });
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'challenging' }); expect(last().chain!.note).toContain('files changed during Gemini');
  });
  it('leaves Gemini out of a step when the folder’s files cannot be read (not Git), and says so', async () => {
    const { chains, sent, reply, last, open, files } = setup(); files.state = null; open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan'); await settle();
    expect(sent.some((item) => item.runId === GEMINI)).toBe(false);
    expect(last().chain).toMatchObject({ step: 'plan-review' }); expect(last().chain!.note).toContain('cannot read this folder');
  });
  it('stops on an answer that is not a challenge, review or comparison; Continue runs it again; Continue without Gemini passes it over', async () => {
    const { chains, sent, reply, last, to, open } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan'); await to(); await reply(GEMINI, 'Here is my own plan instead.');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'challenging' });
    chains.continue(BUILDER); expect(await to()).toMatchObject({ runId: GEMINI }); await reply(GEMINI, 'NO CHALLENGES'); chains.plan(BUILDER, true);
    await reply(BUILDER, 'Built.'); await to(); await reply(GEMINI, 'All good, I think.');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'second-reviewing' });
    chains.continue(BUILDER, true); expect(sent.at(-1)!.runId).toBe(REVIEWER); expect(last().chain).toMatchObject({ step: 'reviewing', geminiReviewed: true, compared: true });
    await reply(REVIEWER, 'FINDING low a.ts:1 — x'); expect(sent.at(-1)!.runId).toBe(BUILDER);
    // Continue without Gemini is only for a Gemini step.
    chains.stop(BUILDER); await reply(BUILDER, '', { isError: true }); expect(() => chains.continue(BUILDER, true)).toThrow(/not at work/);
  });
  it('stops and continues at each Gemini step, and a restart brings each back stopped there', async () => {
    for (const step of ['challenging', 'second-reviewing', 'comparing'] as const) {
      const { chains, sent, interrupted, reply, last, to, open } = setup(); open(); chains.send(BUILDER, 'Task', []);
      await reply(PLANNER, 'Plan'); await to();
      if (step !== 'challenging') { await reply(GEMINI, 'NO CHALLENGES'); chains.plan(BUILDER, true); await reply(BUILDER, 'Built.'); await to(); }
      if (step === 'comparing') { await reply(GEMINI, 'FINDING low a.ts:1 — g'); await reply(REVIEWER, 'FINDING low b.ts:1 — c'); await to(); }
      expect(last().chain!.step).toBe(step);
      chains.stop(BUILDER); expect(interrupted).toEqual([GEMINI]); expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: step });
      await reply(GEMINI, '', { isError: true }); expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: step }); expect(last().stopping).toBeUndefined();
      const count = sent.length; chains.continue(BUILDER); expect(await to()).toMatchObject({ runId: GEMINI }); expect(sent.length).toBe(count + 1); expect(last().chain!.step).toBe(step);
      // A restart: the saved chain comes back stopped at the step; Gemini is briefed again with its next message.
      const saved = last().chain!; const after = setup(); after.open({ chain: saved });
      expect(after.last().chain).toMatchObject({ step: 'stopped', stoppedAt: step });
      after.chains.continue(BUILDER); const resent = await after.to(); expect(resent.runId).toBe(GEMINI); expect(resent.text).toContain('You are Gemini, the challenger');
    }
  });
  it('restarts a plan-responding step with the planner, and passes a Gemini step over when Gemini is no longer seated', async () => {
    const { chains, reply, last, to, open } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan'); await to(); await reply(GEMINI, 'CHALLENGE medium — x'); expect(last().chain!.step).toBe('plan-responding');
    const saved = last().chain!;
    const again = setup(); again.open({ chain: saved }); again.chains.continue(BUILDER); expect(again.sent.at(-1)).toMatchObject({ runId: PLANNER }); expect(again.sent.at(-1)!.text).toContain('C1 (medium): x');
    const without = setup(); without.open({ chain: { ...saved, step: 'challenging' } }, false);
    without.chains.continue(BUILDER); expect(without.last().chain).toMatchObject({ step: 'plan-review', note: expect.stringContaining('not seated') });
  });
  it('sends the person’s answer back to Gemini when it says TASK BLOCKED, with the file check around it', async () => {
    const { chains, sent, reply, last, to, open, files } = setup(); open(); chains.send(BUILDER, 'Task', []);
    await reply(PLANNER, 'Plan'); await to(); await reply(GEMINI, 'TASK BLOCKED: Which browsers matter?');
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'challenging', blocked: 'challenger', note: 'The Gemini seat needs you: Which browsers matter?' });
    chains.send(BUILDER, 'Only Chrome.', []); expect(await to()).toMatchObject({ runId: GEMINI }); expect(sent.at(-1)!.text).toContain('[The person answers] Only Chrome.');
    await reply(GEMINI, 'NO CHALLENGES', { during: () => { files.state = 'e'.repeat(64); } });
    expect(last().chain).toMatchObject({ step: 'stopped', stoppedAt: 'challenging' });
  });
  it('declines Gemini’s file changes, allows its commands at Full access only, and refuses it as builder, planner or reviewer', () => {
    const { chains, answers, runs, open } = setup(); open();
    const ask = (requestId: string, toolName: string) => chains.observe({ sessionId: 'gemini', runId: GEMINI, event: { type: 'permission', requestId, toolName, description: '', input: {}, canAllowEdits: false } });
    expect(ask('g1', 'File changes')).toContain('Gemini seat: only the builder edits'); expect(ask('g2', 'Shell')).toBeNull();
    runs[GEMINI].permissions = 'full'; expect(ask('g3', 'Shell')).toBe(''); expect(ask('g4', 'File changes')).toContain('only the builder edits');
    expect(answers).toEqual([{ requestId: 'g1', allow: false }, { requestId: 'g3', allow: true }, { requestId: 'g4', allow: false }]);
    const other = setup(); expect(() => other.chains.open(1, BUILDER, GEMINI, PLANNER)).toThrow(/Codex as reviewer/); expect(() => other.chains.open(1, BUILDER, REVIEWER, PLANNER, {}, REVIEWER)).toThrow();
  });
  it('closes the table when the Gemini seat’s run ends', () => {
    const { chains, open, last } = setup(); open(); chains.ended(GEMINI); expect(last()).toBeNull();
  });
});
