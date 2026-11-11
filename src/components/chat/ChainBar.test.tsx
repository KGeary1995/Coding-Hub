import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoundTableState } from '../../../shared/chat';
import { ChainBar, type ChainSeat, Item } from './ChatParts';

const table = (step: NonNullable<RoundTableState['chain']>['step'], extra: Partial<RoundTableState> = {}): RoundTableState => ({ kind: 'hierarchy', partner: { sessionId: 'r', runId: 'r', engine: 'codex' }, driver: 'claude', rounds: 2, round: 1, phase: 'answering', agreed: false, chain: { step, task: 'Task', plan: 'Plan', report: '', reviewRound: 1, finalRound: 0, verdict: null, note: '' }, ...extra });
const seats: ChainSeat[] = [
  { role: 'Planner', name: 'Fable 5.2', colour: 'planner', state: 'running', tokens: 12_000 },
  { role: 'Builder', name: 'Opus 5.5', colour: 'claude', state: 'working', tokens: 48_000 },
  { role: 'Reviewer', name: 'Codex', colour: 'codex', state: 'running', tokens: 0 },
];
const bar = (state: RoundTableState) => renderToStaticMarkup(<ChainBar table={state} busy plannerName="Fable 5.2" builderName="Opus 5.5" seats={seats} onRequest={() => {}} />);

describe('the hierarchy bar says which model is at work', () => {
  it('names the model on each step', () => {
    expect(bar(table('planning'))).toContain('Fable 5.2 writing the plan…'); expect(bar(table('implementing'))).toContain('Opus 5.5 building…');
    expect(bar(table('reviewing'))).toContain('Codex reviewing (round 1 of 2)'); expect(bar(table('final'))).toContain('Fable 5.2 giving the final review…');
  });
  it('lists all three seats with what each is doing and its tokens today, the planner in its own colour', () => {
    const html = bar(table('implementing'));
    expect(html).toContain('seat-hex seat-planner'); expect(html).toMatch(/Fable 5\.2<\/strong>Planner · running · 12k tok today/); expect(html).toMatch(/class="working"><i class="seat-hex seat-claude"[^>]*><\/i><strong>Opus 5\.5<\/strong>Builder · working/);
    expect(html).toMatch(/Codex<\/strong>Reviewer · running<\/li>/);
  });
  it('labels the planner’s messages with its model, in its own colour', () => {
    const html = renderToStaticMarkup(<Item item={{ kind: 'assistant', id: 'a', blocks: [{ type: 'text', text: 'The plan.' }], streaming: '' }} results={{}} agent="Fable 5.2" author="planner" role="Planner" answer={() => () => {}} view={() => {}} />);
    expect(html).toContain('table-planner'); expect(html).toContain('Fable 5.2 · Planner');
  });
});

describe('the hierarchy bar with a Gemini seat', () => {
  const gemini = { challenger: { sessionId: 'g', runId: 'g', engine: 'gemini' as const } };
  const withChain = (step: NonNullable<RoundTableState['chain']>['step'], chain: Partial<NonNullable<RoundTableState['chain']>> = {}, extra: Partial<RoundTableState> = gemini) => { const state = table(step, extra); return { ...state, chain: { ...state.chain!, ...chain } }; };
  it('adds the Challenge step only when Gemini is seated, and says what Gemini is doing', () => {
    expect(bar(table('planning'))).not.toContain('>Challenge<'); expect(bar(table('planning', gemini))).toContain('>Challenge<');
    expect(bar(table('challenging', gemini))).toContain('Gemini challenging the plan…'); expect(bar(table('plan-responding', gemini))).toContain('Fable 5.2 answering Gemini&#x27;s challenges…');
    expect(bar(table('second-reviewing', gemini))).toContain('Gemini reviewing, before Codex…'); expect(bar(table('comparing', gemini))).toContain('Gemini comparing its review with Codex&#x27;s…');
    expect(bar(table('second-reviewing', gemini))).toMatch(/<li class="current" aria-current="step">Review<\/li>/);
  });
  it('lists each challenge with the planner’s answer at plan review, and says when there were none', () => {
    const html = bar(withChain('plan-review', { challenged: true, challenges: [{ id: 'C1', severity: 'high', text: 'Misses mobile', answer: 'accepted' }, { id: 'C2', severity: 'low', text: 'Use a partial', answer: 'rejected', reason: 'one file only' }] }));
    expect(html).toContain('<details class="chain-challenges" open="">'); expect(html).toContain('C1 · high</strong> Misses mobile'); expect(html).toContain('Fable 5.2: Accepted');
    expect(html).toContain('Fable 5.2: Rejected, one file only'); expect(html).toContain('1 accepted');
    expect(bar(withChain('plan-review', { challenged: true }))).toContain('Gemini raised no challenges');
  });
  it('offers Continue without Gemini only when a Gemini step stopped, and sends skipGemini', () => {
    const requests: unknown[] = [];
    const stopped = (at: 'challenging' | 'reviewing') => renderToStaticMarkup(<ChainBar table={withChain('stopped', { stoppedAt: at })} busy={false} plannerName="Fable 5.2" builderName="Opus 5.5" onRequest={(request) => requests.push(request)} />);
    expect(stopped('challenging')).toContain('Continue without Gemini'); expect(stopped('reviewing')).not.toContain('Continue without Gemini');
  });
  it('shows who reported each finding and Gemini’s word on it, and a closed duplicate', () => {
    const at = '2026-11-11T00:00:00.000Z'; const base = { severity: 'medium' as const, evidence: 'a.ts:1', status: 'open' as const, response: '', check: '', reviewedAt: null, changedAt: null, round: 1, at };
    const html = bar(table('fixing', { ...gemini, findings: [{ ...base, id: 'F1', text: 'g', source: 'gemini' }, { ...base, id: 'F2', text: 'c', gemini: 'dispute', geminiNote: 'wrong file' }, { ...base, id: 'F3', text: 'd', status: 'verified', duplicateOf: 'F1', check: 'Duplicate of F1 (Gemini)' }] }));
    expect(html).toContain('from Gemini'); expect(html).toContain('from Codex; Gemini disputes: wrong file'); expect(html).toContain('duplicate of F1 (closed by Gemini)'); expect(html).toContain('<small>Closed');
  });
  it('labels Gemini’s messages, in its own colour', () => {
    const html = renderToStaticMarkup(<Item item={{ kind: 'assistant', id: 'a', blocks: [{ type: 'text', text: 'CHALLENGE high — x' }], streaming: '' }} results={{}} agent="Gemini" author="gemini" role="Challenger" answer={() => () => {}} view={() => {}} />);
    expect(html).toContain('table-gemini'); expect(html).toContain('Gemini · Challenger');
  });
});

