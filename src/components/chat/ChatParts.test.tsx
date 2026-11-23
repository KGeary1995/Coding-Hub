import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatBlock } from '../../../shared/chat';
import type { ChatItem, ToolResult } from '../../state/chat-store';
import { Item, type ItemProps, sameItem, TableBar } from './ChatParts';
import { seatViews } from './seat-view';

const said = (id: string, text: string, streaming = ''): ChatItem => ({ kind: 'assistant', id, blocks: [{ type: 'text', text }], streaming });
const answer = () => () => {}; const view = () => {};
const props = (item: ChatItem, results: Record<string, ToolResult> = {}): ItemProps => ({ item, results, agent: 'Claude', answer, view });

/**
 * There is no DOM here, so this draws the thread as React would decide to: an item is drawn again only when sameItem
 * says its props changed (Item is React.memo with sameItem). Counted per item across a streamed piece.
 */
function redrawn(before: ItemProps[], after: ItemProps[]) { return after.filter((next, index) => !before[index] || !sameItem(before[index], next)).map((next) => next.item.id); }

describe('a chat thread draws again only what changed', () => {
  it('Item is memoized with sameItem', () => {
    expect((Item as unknown as { compare: unknown }).compare).toBe(sameItem);
  });
  it('a streamed piece redraws only the message being streamed, not the settled ones', () => {
    const settled = Array.from({ length: 200 }, (_, index) => said(`m${index}`, `Message **${index}**`));
    const streaming = said('live', '', 'Hel');
    const results = {};
    const before = [...settled, streaming].map((item) => props(item, results));
    // A delta: the store copies the items array and replaces only the streaming item; settled items keep their object.
    const after = [...settled, { ...streaming, streaming: 'Hello' }].map((item) => props(item, results));
    expect(redrawn(before, after)).toEqual(['live']);
  });
  it('a new answer handler on every render would redraw everything, so callers keep it steady', () => {
    const item = said('a', 'Done.');
    expect(sameItem(props(item), { ...props(item), answer: () => () => {} })).toBe(false);
  });
  it('a tool result redraws only the message holding that tool call', () => {
    const tool: ChatBlock = { type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } };
    const withTool: ChatItem = { kind: 'assistant', id: 'b', blocks: [tool], streaming: '' };
    const other = said('c', 'Other.');
    const before = { t0: { text: 'old', isError: false, image: false } };
    const after = { ...before, t1: { text: 'files', isError: false, image: false } };
    expect(sameItem(props(other, before), props(other, after))).toBe(true);
    expect(sameItem(props(withTool, before), props(withTool, after))).toBe(false);
  });
});

describe('a message that does not match this version still draws', () => {
  it('a tool call without its input, and a block of an unknown kind, do not stop the thread', () => {
    const odd = { kind: 'assistant', id: 'x', streaming: '', blocks: [{ type: 'tool', id: 't', name: 'Mystery' }, { type: 'diagram', text: 'new' }, { type: 'text', text: 'Still here.' }] } as unknown as ChatItem;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = renderToStaticMarkup(<Item {...props(odd)} />);
    error.mockRestore();
    expect(html).toContain('Mystery'); expect(html).toContain('Still here.'); expect(html).not.toContain('diagram');
  });
  it('an approval whose input is null', () => {
    const asks = { kind: 'permission', id: 'p', toolName: 'Bash', description: 'Run it', input: null, canAllowEdits: false, answer: null } as unknown as ChatItem;
    const html = renderToStaticMarkup(<Item {...props(asks)} />);
    expect(html).toContain('wants to use Bash'); expect(html).toContain('Allow');
  });
});

describe('answering an approval', () => {
  it('asks for the handler when the person answers, not when the card is drawn', () => {
    const sent: string[] = []; let run = 'first';
    const answerFor = vi.fn((id: string) => (allow: boolean) => { sent.push(`${run}:${id}:${allow}`); });
    const asks: ChatItem = { kind: 'permission', id: 'p', toolName: 'Bash', description: '', input: {}, canAllowEdits: false, answer: null };
    const draw = (Item as unknown as { type: (props: ItemProps) => ReactElement<{ answer: (allow: boolean) => void }> }).type;
    const card = draw({ ...props(asks), answer: answerFor });
    expect(answerFor).not.toHaveBeenCalled();
    run = 'second'; card.props.answer(true);
    expect(sent).toEqual(['second:p:true']);
  });
});

describe('a Round Table message waiting to go', () => {
  it('says how many images it carries, also on a phone or linked computer, which gets only the count', () => {
    const table = { partner: { sessionId: 'p', runId: 'r', engine: 'codex' as const }, driver: 'claude' as const, rounds: 2, round: 0, phase: 'discussing' as const, agreed: false, waiting: 'Also the docs.' };
    const bar = (extra: object) => renderToStaticMarkup(<TableBar leadEngine="claude" table={{ ...table, ...extra }} busy={false} onRequest={() => {}} />);
    expect(bar({ waitingImageCount: 2 })).toContain(' + 2 images');
    expect(bar({ waitingImages: [{ mediaType: 'image/png', data: 'AA==' }] })).toContain(' + 1 image');
    expect(bar({})).not.toContain('image');
  });
});


describe('a Round Table bar and its token counts', () => {
  const table = { partner: { sessionId: 'p', runId: 'r', engine: 'codex' as const }, driver: 'claude' as const, rounds: 2, round: 0, phase: 'idle' as const, agreed: false };
  const counted = (lead: number, partner: number) => seatViews(table, 'claude').map((seat, index) => ({ ...seat, tokens: index ? partner : lead }));
  it('names who is making the changes in a part of its own, so a narrow tile can take the name out and keep the status on its line', () => {
    const html = renderToStaticMarkup(<TableBar leadEngine="claude" table={{ ...table, phase: 'acting' as const }} busy onRequest={() => {}} />);
    expect(html).toMatch(/<span class="table-status" aria-live="polite"><span class="table-acting-who">[^<]+ <\/span><span class="table-acting-what">making the changes<\/span><\/span>/);
    // Any other state is its plain words.
    expect(renderToStaticMarkup(<TableBar leadEngine="claude" table={table} busy={false} onRequest={() => {}} />)).toContain('<span class="table-status" aria-live="polite">Your turn</span>');
  });
  it('keeps who drives and the counts in a tooltip as well as in the bar, so a narrow tile can take them out of the bar', () => {
    const html = renderToStaticMarkup(<TableBar leadEngine="claude" table={table} busy={false} seats={counted(12_400, 800)} onRequest={() => {}} />);
    expect(html).toContain('<span class="table-group" title="Claude drives · Codex reviews. New tokens today: Claude 12k · Codex 800">');
    expect(html).toContain('<span class="table-roles">Claude drives · Codex reviews</span>');
    expect(html).toMatch(/class="table-tokens tnum"[^>]*><b class="seat-text-claude">Claude 12k<\/b> · <b class="seat-text-codex">Codex 800<\/b>/);
  });
  it('has no counts where it is given none (a phone, a linked computer)', () => {
    const html = renderToStaticMarkup(<TableBar leadEngine="claude" table={table} busy={false} onRequest={() => {}} />);
    expect(html).not.toContain('tokens'); expect(html).toContain('<span class="table-group" title="Claude drives · Codex reviews">');
  });
  it('keeps Swap’s label as its name where a narrow tile shows only its icon', () => {
    expect(renderToStaticMarkup(<TableBar leadEngine="claude" table={table} busy={false} onRequest={() => {}} />)).toMatch(/<span class="table-swap">Swap<\/span><\/button>/);
  });
});
