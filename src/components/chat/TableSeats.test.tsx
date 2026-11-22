import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoundTableState } from '../../../shared/chat';
import type { TableSeatState } from '../../../shared/table-seats';
import type { ChatItem, ChatThread } from '../../state/chat-store';
import { EMPTY, Item, type ItemProps, mergeThread, seatAnswers, TableBar, ThreadItems } from './ChatParts';
import { followSeats, seatViews, tableSeatIds } from './seat-view';

/** The first element of a rendered tree (a component called as a function) that matches. */
type Node = { type?: unknown; props: { children?: unknown; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void; [key: string]: unknown } };
function find(tree: unknown, match: (node: Node) => boolean): Node | null {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child, match); if (found) return found; } return null; }
  const node = tree as Node; if (node.props && match(node)) return node;
  return node.props ? find(node.props.children, match) : null;
}
const text = (node: Node) => JSON.stringify(node.props.children);

/** Four seats at a discussion table: Claude Code drives, then Codex (named), Claude Code and Codex review. */
const seatsOfFour: TableSeatState[] = [
  { sessionId: 'a', runId: 'ra', engine: 'claude' }, { sessionId: 'b', runId: 'rb', engine: 'codex', name: 'Skeptic' }, { sessionId: 'c', runId: 'rc', engine: 'claude' }, { sessionId: 'd', runId: 'rd', engine: 'codex' },
];
const four: RoundTableState = { partner: { sessionId: 'b', runId: 'rb', engine: 'codex' }, driver: 'claude', rounds: 2, round: 0, phase: 'idle', agreed: false, seats: seatsOfFour, driverSeat: 'a' };
const said = (id: string, order: number, body: string): ChatItem => ({ kind: 'assistant', id, order, blocks: [{ type: 'text', text: body }], streaming: '' });
const thread = (items: ChatItem[]): ChatThread => ({ ...EMPTY, items });

describe('a Round Table of four seats', () => {
  it('numbers seats that would share a name, and says what each does: the driver or a review', () => {
    expect(seatViews(four, 'claude', {}, 'a').map((seat) => `${seat.name}:${seat.role}`)).toEqual(['Claude Code:driver', 'Skeptic:reviewer', 'Claude Code 2:reviewer', 'Codex:reviewer']);
    expect(tableSeatIds(four, 'a')).toEqual(['b', 'c', 'd']);
  });
  it('merges every seat’s messages in order, each labelled with its seat’s name, and answers an approval from the third seat', () => {
    const views = seatViews(four, 'claude', {}, 'a');
    const asks: ChatItem = { kind: 'permission', id: 'req-1', order: 4, toolName: 'Bash', description: '', input: { command: 'ls' }, canAllowEdits: false, answer: null };
    const entries = mergeThread([
      { seat: views[0], thread: thread([said('m1', 1, 'First.')]) },
      { seat: views[1], thread: thread([said('m2', 3, 'Third.'), { kind: 'user', id: 'u', order: 2, text: 'Trace prompt', images: [], at: '' }]) },
      { seat: views[2], thread: thread([said('m3', 2, 'Second.'), asks]) }, { seat: views[3], thread: thread([]) },
    ]);
    // Trace's prompt to a seat stays out; the rest is in the order it came.
    expect(entries.map(({ item }) => item.id)).toEqual(['m1', 'm3', 'm2', 'req-1']);
    const answered: unknown[][] = []; const answerFor = seatAnswers({ current: (...args: unknown[]) => { answered.push(args); } });
    const html = renderToStaticMarkup(<ThreadItems entries={entries} table answerFor={answerFor} view={() => {}} />);
    expect(html).toContain('Claude Code · Driver'); expect(html).toContain('Skeptic · Review'); expect(html).toContain('Claude Code 2 · Review'); expect(html).toContain('Claude Code 2 wants to use Bash'); expect(html).not.toContain('Trace prompt');
    // The same handler for a seat every time (so sameItem holds), and the answer goes to the seat the card came from.
    expect(answerFor('c')).toBe(answerFor('c')); expect(answerFor('c')).not.toBe(answerFor('b'));
    const cards = (ThreadItems({ entries, table: true, answerFor, view: () => {} }) as ReactElement<{ children: ReactElement<ItemProps>[] }>).props.children;
    const card = cards.find((element) => element.props.item.kind === 'permission')!; expect(card.props.agent).toBe('Claude Code 2');
    const draw = (Item as unknown as { type: (props: ItemProps) => ReactElement<{ answer: (allow: boolean, allowEdits?: boolean) => void }> }).type;
    draw(card.props).props.answer(true); expect(answered).toEqual([['c', 'req-1', true, undefined]]);
  });
  it('lists who sits there, names who drives in a list of seats, and sends the seat and its engine when another is chosen', () => {
    const requests: unknown[] = []; const bar = () => TableBar({ leadEngine: 'claude', table: four, busy: false, onRequest: (request) => requests.push(request), onSeats: () => {} });
    const html = renderToStaticMarkup(bar());
    expect(html).toContain('Claude Code drives · Skeptic, Claude Code 2 and Codex review'); expect(html).toContain('aria-label="Agent that edits files"'); expect(html).not.toContain('Swap'); expect(html).toContain('>Seats<'); expect(html).toContain('replies to the others');
    expect(html).toMatch(/<option value="a" selected="">Claude Code<\/option><option value="b">Skeptic<\/option>/); expect(html.match(/<i class="seat-(claude|codex)">/g)).toHaveLength(4);
    find(bar(), (node) => node.props['aria-label'] === 'Agent that edits files')!.props.onChange!({ target: { value: 'b' } });
    expect(requests).toEqual([{ action: 'table-driver', driver: 'codex', seat: 'b' }]);
  });
  it('keeps Swap with two seats, naming the seat as well as its engine, and says all, not both, with more', () => {
    const requests: unknown[] = []; const two: RoundTableState = { ...four, seats: seatsOfFour.slice(0, 2) };
    const element = TableBar({ leadEngine: 'claude', table: two, busy: true, onRequest: (request) => requests.push(request) });
    find(element, (node) => node.type === 'button' && text(node).includes('Swap'))!.props.onClick!(); expect(requests).toEqual([{ action: 'table-driver', driver: 'codex', seat: 'b' }]);
    expect(renderToStaticMarkup(element)).toContain('Stop both'); expect(renderToStaticMarkup(TableBar({ leadEngine: 'claude', table: four, busy: true, onRequest: () => {} }))).toContain('Stop all');
    expect(renderToStaticMarkup(TableBar({ leadEngine: 'claude', table: { ...four, phase: 'answering' }, busy: false, onRequest: () => {} }))).toContain('All answering');
  });
  it('offers a list of seats to show, and a Seats button that waits while the table works', () => {
    const seats = seatViews(four, 'claude', {}, 'a');
    const html = renderToStaticMarkup(TableBar({ leadEngine: 'claude', table: four, busy: true, seats, onShow: () => {}, onSeats: () => {}, onRequest: () => {} }));
    expect(html).toContain('aria-label="Show an agent&#x27;s own conversation"'); expect(html).toContain('<option value="" selected="">Round Table thread</option>'); expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Seats can be changed when the Round Table is not working"/);
    // One other seat: the button as before.
    expect(renderToStaticMarkup(TableBar({ leadEngine: 'claude', table: { ...four, seats: seatsOfFour.slice(0, 2) }, busy: false, onShow: () => {}, onRequest: () => {} }))).toContain('Show Skeptic');
  });
});

describe('a table from before seats', () => {
  const old: RoundTableState = { partner: { sessionId: 'p', runId: 'r', engine: 'codex' }, driver: 'claude', rounds: 2, round: 0, phase: 'idle', agreed: false };
  it('reads as Claude and its partner: Swap names the engine only, Stop says both, and there is no Seats button', () => {
    const requests: unknown[] = []; const element = TableBar({ leadEngine: 'claude', table: old, busy: true, onRequest: (request) => requests.push(request) });
    const html = renderToStaticMarkup(element); expect(html).toContain('Stop both'); expect(html).not.toContain('Seats'); expect(html).not.toContain('Edits files');
    find(element, (node) => node.type === 'button' && text(node).includes('Swap'))!.props.onClick!(); expect(requests).toEqual([{ action: 'table-driver', driver: 'codex' }]);
    expect(seatViews(old, 'claude').map((seat) => seat.name)).toEqual(['Claude', 'Codex']);
  });
  it('lists its planner and builder as it always did', () => {
    expect(seatViews({ ...old, kind: 'hierarchy', planner: { sessionId: 'pl', runId: 'x', engine: 'claude' } }, 'claude', { builder: 'Opus 5.5', planner: 'Fable 5.2' }, 'lead').map((seat) => `${seat.id}:${seat.name}:${seat.role}`)).toEqual(['lead:Opus 5.5:Builder', 'p:Codex:Reviewer', 'pl:Fable 5.2:Planner']);
  });
});

describe('following the other seats of a table', () => {
  it('follows each seat once and stops following them all', () => {
    const log: string[] = []; const follow = (id: string) => { log.push(`follow ${id}`); return () => { log.push(`stop ${id}`); }; };
    const stop = followSeats(follow, tableSeatIds(four, 'a')); stop();
    expect(log).toEqual(['follow b', 'follow c', 'follow d', 'stop b', 'stop c', 'stop d']);
  });
});
