import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoundTableState } from '../../../shared/chat';
import { ChainBar, type ChainSeat, foldChainBar, Item, waitingLabel } from './ChatParts';

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
    expect(html).toContain('seat-hex seat-planner'); expect(html).toMatch(/Fable 5\.2<\/strong><span>Planner · running<span class="seat-tokens"> · 12k tok today<\/span>/); expect(html).toMatch(/class="working" title="48k new tokens today"><i class="seat-hex seat-claude"[^>]*><\/i><strong>Opus 5\.5<\/strong><span>Builder · working/);
    // A seat with no tokens yet shows none, and has no tooltip.
    expect(html).toMatch(/<li class=""><i class="seat-hex seat-codex"[^>]*><\/i><strong>Codex<\/strong><span>Reviewer · running<\/span><\/li>/);
  });
  it('offers Review again while the final review still asks for changes after its rounds, until the most rounds (1.43.0)', () => {
    const idle = (state: RoundTableState) => renderToStaticMarkup(<ChainBar table={state} busy={false} plannerName="Fable 5.2" builderName="Opus 5.5" seats={seats} onRequest={() => {}} />);
    const at = (finalRound: number, verdict: 'changes' | null) => { const base = table('needs-you'); return { ...base, chain: { ...base.chain!, finalRound, verdict } }; };
    expect(idle(at(2, 'changes'))).toContain('>Review again</button>'); expect(idle(at(2, 'changes'))).toContain('round 3 of at most 5');
    expect(idle(at(5, 'changes'))).not.toContain('Review again'); expect(idle(at(2, null))).not.toContain('Review again');
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

describe('the hierarchy bar: tasks from Tasks waiting', () => {
  const task = (name: string) => `Task: ${name}. When you are done, end with TASK COMPLETE. ${'x'.repeat(250)}`;
  const state = (detached = false) => { const base = table('final'); const html = renderToStaticMarkup(<ChainBar table={{ ...base, chain: { ...base.chain!, nextTasks: [task('B'), task('C')] } }} busy plannerName="Fable 5.2" builderName="Opus 5.5" onRequest={() => {}} {...(detached ? { detached: { note: 'Not open.' } } : {})} />); return html; };
  it('lists each with its own Drop it, which asks to drop that one by index and the start of its text', () => {
    const html = state(); expect(html).toContain('2 tasks from Tasks'); expect(html).toContain('Task: B.'); expect(html).toContain('Task: C.');
    const requests: unknown[] = []; const base = table('final');
    const element = ChainBar({ table: { ...base, chain: { ...base.chain!, nextTasks: [task('B'), task('C')] } }, busy: true, plannerName: 'Fable 5.2', builderName: 'Opus 5.5', onRequest: (request) => requests.push(request) });
    const drops: (() => void)[] = []; const walk = (node: unknown) => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(walk); return; } const props = (node as { type?: unknown; props?: { children?: unknown; onClick?: () => void } }).props; if ((node as { type?: unknown }).type === 'button' && props?.children === 'Drop it' && props.onClick) drops.push(props.onClick); walk(props?.children); };
    walk(element); expect(drops).toHaveLength(2);
    drops[1](); expect(requests).toEqual([{ action: 'table-next-drop', index: 1, head: task('C').slice(0, 200) }]);
  });
  it('offers no Drop it on a table that is not open (the host could not do it)', () => { expect(state(true)).not.toContain('>Drop it<'); });
});

describe('the hierarchy bar folds in a tile too short for it', () => {
  it('folds when the whole bar would leave the conversation less than half the tile, and only in a tile', () => {
    // A four-tile grid at 1100x800: the whole bar 137 px over a 90 px thread in a 352 px tile.
    expect(foldChainBar(137, 137 + 90, 352)).toBe(true);
    // At 900x700 (292 px tile), and folded already (33 px bar, 162 px thread): the measure is the whole bar's, so it stays folded.
    expect(foldChainBar(139, 139 + 28, 292)).toBe(true); expect(foldChainBar(139, 33 + 134, 292)).toBe(true);
    // Four columns at 1440x900: 185 px of bar in an 808 px tile leaves 450 px of conversation, so it stays whole.
    expect(foldChainBar(185, 185 + 450, 808)).toBe(false);
    // Exactly half is enough; a box with no height (not in a tile, or not shown) never folds.
    expect(foldChainBar(100, 300, 400)).toBe(false); expect(foldChainBar(100, 299, 400)).toBe(true); expect(foldChainBar(500, 0, 0)).toBe(false);
  });
  it('is drawn whole until it is measured (and on the phone, where it is not in a tile)', () => {
    const html = bar(table('implementing'));
    expect(html).toMatch(/^<div class="table-bar chain-bar" role="group" aria-label="Round Table">/); expect(html).not.toContain('chain-fold'); expect(html).not.toContain('chain-summary');
  });
  /** The bar's element tree, as the tests above walk it: each button by its text or name, with its class. */
  const parts = (state: RoundTableState, busy = true) => {
    const element = ChainBar({ table: state, busy, plannerName: 'Fable 5.2', builderName: 'Opus 5.5', seats, onRequest: () => {}, detached: undefined }) as unknown as { props: { summary: JSX.Element; children: unknown } };
    const found: Record<string, string> = {};
    const walk = (node: unknown) => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(walk); return; } const { type, props } = node as { type?: unknown; props?: { children?: unknown; className?: string; 'aria-label'?: string } }; if (type === 'button') found[props?.['aria-label'] ?? renderToStaticMarkup(node as JSX.Element).replace(/<[^>]*>/g, '')] = props?.className ?? ''; walk(props?.children); };
    walk(element.props.children); return { found, summary: renderToStaticMarkup(element.props.summary) };
  };
  it('keeps the step’s buttons and Close on the folded line, and every control in the bar', () => {
    const working = parts(table('implementing')); expect(working.found['Stop']).toContain('chain-act'); expect(working.found['Close the Round Table']).toContain('chain-act');
    const review = parts(table('plan-review'), false); expect(review.found['Approve plan']).toContain('chain-act'); expect(review.found['Stop']).toBeUndefined();
    const stopped = parts({ ...table('stopped'), chain: { ...table('stopped').chain!, stoppedAt: 'challenging' } }, false);
    expect(stopped.found['Continue']).toContain('chain-act'); expect(stopped.found['Continue without the challenge']).toContain('chain-act');
  });
  it('sums up what is running and who sits at each level, in their colours', () => {
    const { summary } = parts(table('implementing'));
    expect(summary).toContain('aria-live="polite"'); expect(summary).toContain('title="Opus 5.5 building… · planner Fable 5.2, builder Opus 5.5, reviewer Codex"');
    expect(summary).toMatch(/^<span class="chain-summary"[^>]*>Opus 5\.5 building…<span aria-hidden="true"> · <\/span><b class="seat-text-planner">Fable 5\.2<\/b><span aria-hidden="true"> › <\/span><b class="seat-text-claude">Opus 5\.5<\/b><span aria-hidden="true"> › <\/span><b class="seat-text-codex">Codex<\/b><\/span>$/);
    expect(parts(table('plan-review'), false).summary).toContain('Fable 5.2&#x27;s plan is ready');
  });
  it('names the findings still open on the folded line', () => {
    const findings = [{ id: 'F1', severity: 'high' as const, evidence: '', text: 'a', status: 'open' as const }, { id: 'F2', severity: 'low' as const, evidence: '', text: 'b', status: 'verified' as const }];
    expect(parts({ ...table('reviewing'), findings } as RoundTableState).summary).toContain('<b class="chain-fold-findings"> · 1 finding open</b>');
  });
  it('offers a seat’s own conversation on the desktop, as the discussion bar does', () => {
    const shown: (string | null)[] = []; const show = { seats: [{ id: 'p', name: 'Fable 5.2' }, { id: 'r', name: 'Codex' }], showing: 'r', onShow: (seat: string | null) => { shown.push(seat); } };
    const html = renderToStaticMarkup(<ChainBar table={table('implementing')} busy plannerName="Fable 5.2" builderName="Opus 5.5" seats={seats} show={show} onRequest={() => {}} />);
    expect(html).toContain('<select aria-label="Show an agent&#x27;s own conversation"><option value="">Round Table thread</option><option value="p">Fable 5.2</option><option value="r" selected="">Codex</option></select>');
    expect(bar(table('implementing'))).not.toContain('Show an agent');
  });
  it('names how many challenges the plan has on the folded line, as their list is behind the disclosure', () => {
    const challenged = table('plan-review'); const chain = { ...challenged.chain!, challenged: true as const, challenges: [{ id: 'C1', severity: 'high' as const, text: 'Misses mobile' }, { id: 'C2', severity: 'low' as const, text: 'Use a partial' }] };
    const { summary } = parts({ ...challenged, chain }, false);
    expect(summary).toContain('<b class="chain-fold-challenges"> · 2 challenges</b>'); expect(summary).toContain('title="Fable 5.2&#x27;s plan is ready · 2 challenges · ');
    expect(parts(table('plan-review'), false).summary).not.toContain('chain-fold-challenges');
  });
  it('draws a waiting message as a span of its own in the bar, which the sheet keeps in view on the folded line', () => {
    // chat.css shows `span.table-waiting` under a folded bar's line: Send now and Drop it are the person's to press.
    const html = renderToStaticMarkup(<ChainBar table={table('idle', { waiting: 'Next task', waitingKept: true })} busy={false} plannerName="Fable 5.2" builderName="Opus 5.5" seats={seats} onRequest={() => {}} />);
    expect(html).toMatch(/<span class="table-waiting" role="status">Kept from before Trace restarted: <q>Next task<\/q><button[^>]*>Send now<\/button><button[^>]*>Drop it<\/button>/);
    // It is a child of the bar itself, which is what the sheet's rule selects.
    const element = ChainBar({ table: table('needs-you', { waiting: 'Next task' }), busy: false, plannerName: 'Fable 5.2', builderName: 'Opus 5.5', seats, onRequest: () => {}, detached: undefined }) as unknown as { props: { children: unknown[] } };
    expect(element.props.children.flat().some((child) => (child as { type?: string; props?: { className?: string } } | null)?.type === 'span' && (child as { props: { className: string } }).props.className === 'table-waiting')).toBe(true);
  });
});

describe('the hierarchy bar of a table with its own seats', () => {
  type Chain = NonNullable<RoundTableState['chain']>;
  const seated = (list: { id: string; engine: 'claude' | 'codex'; duties: ('plan' | 'challenge' | 'build' | 'review' | 'final')[]; name?: string }[], step: Chain['step'], chain: Partial<Chain> = {}, extra: Partial<RoundTableState> = {}): RoundTableState => ({ ...table(step), partner: { sessionId: list[1].id, runId: 'r', engine: list[1].engine }, seats: list.map((seat) => ({ sessionId: seat.id, runId: `run-${seat.id}`, engine: seat.engine, duties: seat.duties, ...(seat.name ? { name: seat.name } : {}) })), chain: { ...table(step).chain!, ...chain }, ...extra });
  const render = (state: RoundTableState, extra: Partial<Parameters<typeof ChainBar>[0]> = {}) => renderToStaticMarkup(<ChainBar table={state} busy={false} plannerName="x" builderName="y" onRequest={() => {}} {...extra} />);
  const steps = (html: string) => [...html.matchAll(/<li class="[^"]*"(?: aria-current="step")?>([^<]*)<\/li>/g)].map((match) => match[1]);
  const basic = [{ id: 'b', engine: 'claude' as const, duties: ['build' as const] }, { id: 'p', engine: 'claude' as const, duties: ['plan' as const] }, { id: 'r', engine: 'codex' as const, duties: ['review' as const] }];

  it('shows only the steps it has: no challenge without a challenger, no final review without a final seat', () => {
    expect(steps(render(seated(basic, 'planning')))).toEqual(['Plan', 'Approve', 'Build', 'Review', 'Fix']);
    // Challengers and a final seat bring their steps back; without reviewers there is no review or fix.
    const lean = [{ id: 'b', engine: 'claude' as const, duties: ['build' as const] }, { id: 'p', engine: 'claude' as const, duties: ['plan' as const, 'challenge' as const, 'final' as const] }];
    expect(steps(render(seated(lean, 'planning')))).toEqual(['Plan', 'Challenge', 'Approve', 'Build', 'Final review']);
    // A table before 1.26 has every step, as ever.
    expect(steps(render(table('planning')))).toEqual(['Plan', 'Challenge', 'Approve', 'Build', 'Review', 'Fix', 'Final review']);
  });
  it('names the seats, with what each does, instead of the fixed roles', () => {
    const html = render(seated([{ id: 'b', engine: 'claude', duties: ['build'] }, { id: 'p', engine: 'claude', duties: ['plan', 'final'], name: 'Lead planner' }, { id: 'r', engine: 'codex', duties: ['review'] }], 'planning'), { seats: [{ id: 'p', role: 'Plans, final review', detail: 'Fable 5.2', name: 'Lead planner', colour: 'planner', state: 'working', tokens: 0 }] });
    expect(html).toContain('Lead planner writing the plan…'); expect(html).toMatch(/<strong>Lead planner<\/strong><span>Plans, final review · Fable 5\.2 · working<\/span>/);
    expect(html).not.toContain('Codex'); expect(html).toContain('Close the Round Table and stop its other agents');
  });
  it('says whose turn it is when several seats review, one after another', () => {
    const two = [...basic, { id: 'r2', engine: 'claude' as const, duties: ['review' as const] }];
    const html = render(seated(two, 'reviewing', { turnSeat: 'r2', reviewRound: 1 }));
    expect(html).toContain('Reviewer 2 reviewing (round 1 of 2)'); expect(html).toMatch(/<li class="current" aria-current="step">Review · Reviewer 2<\/li>/);
    // With one reviewer there is only one turn, so the step shows no name.
    expect(render(seated(basic, 'reviewing', { turnSeat: 'r', reviewRound: 1 }))).toMatch(/<li class="current" aria-current="step">Review<\/li>/);
    // Before the host names a turn, every seat that takes the step is named.
    expect(render(seated(two, 'reviewing', { reviewRound: 1 }))).toContain('Reviewer and Reviewer 2 reviewing (round 1 of 2)');
  });
  it('says two challengers raised no challenges, and who challenges when the plan is sent back', () => {
    const two = [...basic, { id: 'c1', engine: 'codex' as const, duties: ['challenge' as const] }, { id: 'c2', engine: 'claude' as const, duties: ['challenge' as const] }];
    expect(render(seated(two, 'plan-review', { challenged: true }))).toContain('(the challengers raised no challenges)');
    expect(render(seated(two, 'challenging', { turnSeat: 'c2' }))).toContain('Challenger 2 challenging the plan…');
    expect(render(seated(two, 'stopped', { stoppedAt: 'challenging' }))).toContain('title="Show the plan to you without the challenges"');
    expect(render(seated(two, 'plan-review', { challenged: true, challenges: [{ id: 'C1', severity: 'low', text: 't' }] }))).toContain('Challenges to the plan · 1');
  });
  it('is done when the review rounds end, with no final reviewer to approve it', () => {
    expect(render(seated(basic, 'done'))).toContain('Done: the review rounds are over'); expect(render(seated([...basic.slice(0, 2), { id: 'f', engine: 'codex', duties: ['final'] }], 'done'))).toContain('Approved by Final reviewer');
  });
  it('sets the review rounds while the table rests, only for a table with reviewers, and has a Seats button where it is given one', () => {
    const requests: unknown[] = []; const state = seated(basic, 'idle');
    const element = ChainBar({ table: state, busy: false, plannerName: 'x', builderName: 'y', onRequest: (request) => requests.push(request), onSeats: () => {} });
    const html = renderToStaticMarkup(element); expect(html).toContain('aria-label="Review rounds"'); expect(html).toMatch(/<option value="1">1<\/option><option value="2" selected="">2<\/option>/); expect(html).toContain('>Seats<');
    const find = (node: unknown): { props: { onChange: (event: { target: { value: string } }) => void } } | null => { if (!node || typeof node !== 'object') return null; if (Array.isArray(node)) { for (const child of node) { const found = find(child); if (found) return found; } return null; } const props = (node as { props?: { children?: unknown; 'aria-label'?: string } }).props; if (props?.['aria-label'] === 'Review rounds') return node as never; return find(props?.children); };
    find(element)!.props.onChange({ target: { value: '4' } }); expect(requests).toEqual([{ action: 'table-rounds', rounds: 4 }]);
    expect(render(state, { busy: true })).toMatch(/<select aria-label="Review rounds" disabled=""/);
    expect(render(seated(basic.slice(0, 2), 'idle'))).not.toContain('Review rounds'); expect(render(table('idle'))).not.toContain('Review rounds'); expect(render(state)).not.toContain('Seats</span>');
  });
});
