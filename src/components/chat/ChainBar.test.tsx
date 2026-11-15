import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoundTableState } from '../../../shared/chat';
import { ChainBar, type ChainSeat, Item, waitingLabel } from './ChatParts';

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

describe('the hierarchy bar: Codex challenges the plan', () => {
  const withChain = (step: NonNullable<RoundTableState['chain']>['step'], chain: Partial<NonNullable<RoundTableState['chain']>> = {}) => { const state = table(step); return { ...state, chain: { ...state.chain!, ...chain } }; };
  it('always shows the Challenge step, and says what Codex and the planner are doing in it', () => {
    expect(bar(table('planning'))).toContain('>Challenge<');
    expect(bar(table('challenging'))).toContain('Codex challenging the plan…'); expect(bar(table('plan-responding'))).toContain('Fable 5.2 answering Codex&#x27;s challenges…');
    expect(bar(table('challenging'))).toMatch(/<li class="current" aria-current="step">Challenge<\/li>/);
    expect(bar(table('reviewing'))).toMatch(/<li class="current" aria-current="step">Review<\/li>/);
    expect(bar(table('challenging'))).not.toMatch(/gemini/i);
  });
  it('lists each challenge with the planner’s answer at plan review, and says when there were none', () => {
    const html = bar(withChain('plan-review', { challenged: true, challenges: [{ id: 'C1', severity: 'high', text: 'Misses mobile', answer: 'accepted' }, { id: 'C2', severity: 'low', text: 'Use a partial', answer: 'rejected', reason: 'one file only' }] }));
    expect(html).toContain('<details class="chain-challenges" open="">'); expect(html).toContain('Codex&#x27;s challenges · 2'); expect(html).toContain('C1 · high</strong> Misses mobile'); expect(html).toContain('Fable 5.2: Accepted');
    expect(html).toContain('Fable 5.2: Rejected, one file only'); expect(html).toContain('1 accepted');
    expect(bar(withChain('plan-review', { challenged: true }))).toContain('(Codex raised no challenges)');
    // Left out at the person's request: the bar says so, not that Codex found nothing.
    const skipped = bar(withChain('plan-review', { challenged: true, note: 'The challenge was left out at your request.' }));
    expect(skipped).not.toContain('raised no challenges'); expect(skipped).toContain('The challenge was left out at your request.');
  });
  it('offers Continue without the challenge only when the challenge stopped, and sends skipChallenge', () => {
    const requests: unknown[] = [];
    const stopped = (at: 'challenging' | 'reviewing') => renderToStaticMarkup(<ChainBar table={withChain('stopped', { stoppedAt: at })} busy={false} plannerName="Fable 5.2" builderName="Opus 5.5" onRequest={(request) => requests.push(request)} />);
    expect(stopped('challenging')).toContain('Continue without the challenge'); expect(stopped('reviewing')).not.toContain('Continue without the challenge');
    const element = ChainBar({ table: withChain('stopped', { stoppedAt: 'challenging' }), busy: false, plannerName: 'Fable 5.2', builderName: 'Opus 5.5', onRequest: (request) => requests.push(request) });
    const find = (node: unknown): { props: { onClick: () => void } } | null => { if (!node || typeof node !== 'object') return null; const props = (node as { props?: { children?: unknown; onClick?: () => void } }).props; if (props?.children === 'Continue without the challenge') return node as never; for (const child of [props?.children].flat()) { const found = find(child); if (found) return found; } return null; };
    find(element)!.props.onClick(); expect(requests).toEqual([{ action: 'table-continue', skipChallenge: true }]);
  });
  it('shows a finding saved by 1.20 with Gemini’s marks without them', () => {
    const at = '2026-11-11T00:00:00.000Z'; const base = { severity: 'medium' as const, evidence: 'a.ts:1', status: 'open' as const, response: '', check: '', reviewedAt: null, changedAt: null, round: 1, at };
    const html = bar(table('fixing', { findings: [{ ...base, id: 'F1', text: 'g', source: 'gemini' }, { ...base, id: 'F2', text: 'c', gemini: 'dispute', geminiNote: 'wrong file' }] }));
    expect(html).toContain('F1 · medium'); expect(html).not.toContain('from Gemini'); expect(html).not.toContain('wrong file');
  });
  it('closes the table, stopping the planner and reviewer', () => {
    expect(bar(table('idle'))).toContain('title="Close the Round Table and stop its planner and reviewer"'); expect(bar(table('idle'))).not.toContain('seat-gemini');
  });
});


describe('the hierarchy bar: a message waiting', () => {
  type Chain = NonNullable<RoundTableState['chain']>;
  const at = (step: Chain['step'], chain: Partial<Chain> = {}, extra: Partial<RoundTableState> = {}): RoundTableState => { const state = table(step, { waiting: 'Also add a header.', ...extra }); return { ...state, chain: { ...state.chain!, ...chain } }; };
  /** The buttons the bar shows, by their text, each with what it asks for when pressed. */
  const buttons = (state: RoundTableState) => {
    const requests: unknown[] = []; const found: Record<string, () => unknown> = {};
    const walk = (node: unknown) => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(walk); return; } const props = (node as { type?: unknown; props?: { children?: unknown; onClick?: () => void } }).props; if ((node as { type?: unknown }).type === 'button' && typeof props?.children === 'string' && props.onClick) { const click = props.onClick; found[props.children] = () => { requests.length = 0; click(); return requests[0]; }; } walk(props?.children); };
    walk(ChainBar({ table: state, busy: state.chain?.step !== 'needs-you' && state.chain?.step !== 'stopped', plannerName: 'Fable 5.2', builderName: 'Opus 5.5', onRequest: (request) => requests.push(request) }));
    return found;
  };
  it('says where it will go at each step', () => {
    expect(waitingLabel(at('needs-you'))).toBe('Waiting (Send now sends it to the planner): ');
    expect(waitingLabel(at('stopped', { stoppedAt: 'final' }))).toBe('Goes to the planner when you continue: ');
    expect(waitingLabel(at('stopped', { stoppedAt: 'fixing', finalRound: 1 }))).toBe('Goes to the planner when you continue: ');
    expect(waitingLabel(at('stopped', { stoppedAt: 'fixing' }))).toBe('Goes with the step when you continue: ');
    expect(waitingLabel(at('final'))).toBe('Goes to the planner after the final review, or starts the next task if it approves: ');
    expect(waitingLabel(at('reviewing', { finalRound: 1 }))).toBe('Goes to the planner as a follow-up: '); expect(waitingLabel(at('fixing', { finalRound: 2 }))).toBe('Goes to the planner as a follow-up: ');
    expect(waitingLabel(at('reviewing'))).toBe('Goes with the next step, or to the planner if the final review is next: '); expect(waitingLabel(at('fixing'))).toBe('Goes with the next step, or to the planner if the final review is next: ');
    for (const step of ['planning', 'challenging', 'implementing'] as const) expect(waitingLabel(at(step))).toBe('Goes with the next step: ');
    expect(bar(at('final'))).toContain('Goes to the planner after the final review'); expect(bar(at('final', {}, { waitingKept: true }))).toContain('Kept from before Trace restarted: ');
  });
  it('offers Send now and Drop it when the table needs the person, each sending its request', () => {
    const found = buttons(at('needs-you'));
    expect(Object.keys(found)).toEqual(expect.arrayContaining(['Send now', 'Drop it']));
    expect(found['Send now']()).toEqual({ action: 'table-waiting', send: true }); expect(found['Drop it']()).toEqual({ action: 'table-waiting', send: false });
  });
  it('offers Drop it when stopped, not while a seat is still stopping, and neither while the table works', () => {
    const stopped = buttons(at('stopped', { stoppedAt: 'final' }));
    expect(stopped['Drop it']()).toEqual({ action: 'table-waiting', send: false }); expect(stopped['Send now']).toBeUndefined();
    expect(buttons(at('stopped', { stoppedAt: 'final' }, { stopping: true }))['Drop it']).toBeUndefined();
    const working = buttons(at('final')); expect(working['Drop it']).toBeUndefined(); expect(working['Send now']).toBeUndefined();
  });
});
