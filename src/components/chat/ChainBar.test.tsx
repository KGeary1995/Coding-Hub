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
