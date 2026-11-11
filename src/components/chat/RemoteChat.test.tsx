import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoundTableState } from '../../../shared/chat';
// Server rendering reads a store's initial state, so the threads come from this stand-in.
let threads: Record<string, unknown> = {};
vi.mock('../../state/chat-store', () => ({ EMPTY_THREAD: null, useChatStore: (select: (state: { threads: Record<string, unknown> }) => unknown) => select({ threads }), chatAnswered: () => {} }));
const { RemoteChat } = await import('./RemoteChat');

const table: RoundTableState = { kind: 'hierarchy', partner: { sessionId: 'rev', runId: 'r', engine: 'codex' }, planner: { sessionId: 'plan', runId: 'p', engine: 'claude' }, driver: 'claude', rounds: 2, round: 1, phase: 'answering', agreed: false,
  chain: { step: 'reviewing', task: 'Add a footer', plan: '1. Edit', report: '', reviewRound: 1, finalRound: 0, verdict: null, note: '' } };
const said = (id: string, order: number, text: string) => ({ kind: 'assistant' as const, id, order, blocks: [{ type: 'text' as const, text }], streaming: '' });

describe('a hierarchy Round Table on the phone and other computers', () => {
  it('shows the planner’s messages with the builder’s and the reviewer’s, labelled, under the steps bar', () => {
    threads = {
      lead: { runId: 'l', items: [said('b1', 2, 'Built the footer.')], results: {}, busy: false, model: null, table },
      plan: { runId: 'p', items: [{ kind: 'user', id: 'u', order: 0, text: '[Step: plan] …', images: [], at: '' }, said('p1', 1, 'Plan: 1. Edit page.html')], results: {}, busy: false, model: null },
      rev: { runId: 'r', items: [said('r1', 3, 'Reviewing now.')], results: {}, busy: true, model: null },
    };
    const follow = vi.fn(() => () => {});
    const html = renderToStaticMarkup(<RemoteChat sessionId="lead" runId="l" engine="claude" running send={async () => {}} follow={follow} />);
    expect(html).toContain('Round Table · hierarchy'); expect(html).toContain('Codex reviewing (round 1 of 2)');
    // In order: planner, builder, reviewer; Trace's prompt to the planner stays out.
    expect(html.indexOf('Plan: 1. Edit page.html')).toBeLessThan(html.indexOf('Built the footer.')); expect(html.indexOf('Built the footer.')).toBeLessThan(html.indexOf('Reviewing now.'));
    expect(html).not.toContain('[Step: plan]'); expect(html).toContain('Claude · Planner'); expect(html).toContain('Claude · Builder'); expect(html).toContain('Codex · Reviewer');
    expect(html).not.toContain('Models');
  });
  it('shows the Gemini seat’s messages too, follows them, and its step on the bar', () => {
    const withGemini: RoundTableState = { ...table, challenger: { sessionId: 'gem', runId: 'g', engine: 'gemini' }, chain: { ...table.chain!, step: 'second-reviewing' } };
    threads = {
      lead: { runId: 'l', items: [said('b1', 1, 'Built the footer.')], results: {}, busy: false, model: null, table: withGemini },
      gem: { runId: 'g', items: [{ kind: 'user', id: 'u', order: 0, text: '[Step: Gemini review] …', images: [], at: '' }, said('g1', 2, 'FINDING low a.ts:1 — x')], results: {}, busy: true, model: null },
    };
    const follow = vi.fn(() => () => {});
    const html = renderToStaticMarkup(<RemoteChat sessionId="lead" runId="l" engine="claude" running send={async () => {}} follow={follow} />);
    expect(html).toContain('Gemini reviewing, before Codex…'); expect(html).toContain('Gemini · Challenger'); expect(html).toContain('FINDING low a.ts:1');
    expect(html).not.toContain('[Step: Gemini review]'); expect(html).toContain('Gemini is working');
  });
});

