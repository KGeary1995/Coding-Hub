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

describe('what a tool call does, in full', () => {
  const asking = (toolName: string, input: Record<string, unknown>, answer: 'allowed' | null = null): ChatItem => ({ kind: 'permission', id: 'p', toolName, description: '', input, canAllowEdits: true, answer });
  it('an approval for an edit shows what it removes and adds, each edit of a MultiEdit, and a new file’s content', () => {
    const edit = renderToStaticMarkup(<Item {...props(asking('Edit', { file_path: '/p/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }))} />);
    expect(edit).toContain('<pre>p/src/a.ts</pre>'); expect(edit).toContain('<pre class="removed">const a = 1;</pre><pre class="added">const a = 2;</pre>');
    const many = renderToStaticMarkup(<Item {...props(asking('MultiEdit', { file_path: '/p/b.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'm', new_string: 'n' }] }))} />);
    expect(many.match(/class="chat-diff"/g)).toHaveLength(2);
    // Shown under another name (Claude's display name): the input decides.
    const write = renderToStaticMarkup(<Item {...props(asking('Create file', { file_path: '/p/new.md', content: '# New\n' }))} />);
    expect(write).toContain('<pre class="added"># New\n</pre>'); expect(write).not.toContain('class="removed"');
  });
  it('a command or a list of file names adds nothing more; the changes fold away once answered', () => {
    expect(renderToStaticMarkup(<Item {...props(asking('Bash', { command: 'npm test' }))} />)).not.toContain('chat-permission-changes');
    expect(renderToStaticMarkup(<Item {...props(asking('File changes', { files: ['a.ts'] }))} />)).not.toContain('chat-permission-changes');
    expect(renderToStaticMarkup(<Item {...props(asking('Edit', { old_string: 'a', new_string: 'b' }, 'allowed'))} />)).toMatch(/class="chat-permission allowed"[\s\S]*chat-permission-changes/);
  });
  it('a Bash card shows its whole command when opened, as its one-line summary cuts it short', () => {
    const command = 'npm run build && node scripts/desktop-smoke.cjs --long-flag value '.repeat(4);
    const call: ChatItem = { kind: 'assistant', id: 'b', blocks: [{ type: 'tool', id: 't', name: 'Bash', input: { command } }], streaming: '' };
    const html = renderToStaticMarkup(<Item {...props(call)} />);
    expect(html).toContain(`<pre class="chat-tool-input">${command.replace(/&/g, '&amp;')}</pre>`);
  });
});

describe('a command or file change from Codex or Gemini CLI', () => {
  const asking = (toolName: string, input: Record<string, unknown>): ChatItem => ({ kind: 'permission', id: 'p', toolName, description: 'Run it', input, canAllowEdits: true, answer: null });
  it('a Shell approval shows its whole command, and a file-change approval the files with their folders', () => {
    const command = 'npm run build && node scripts/remote-smoke.cjs && node scripts/workbench-smoke.cjs && node scripts/design-smoke.cjs --long';
    expect(command.length).toBeGreaterThan(120);
    expect(renderToStaticMarkup(<Item {...props(asking('Shell', { command }))} />)).toContain(`<pre>${command.replace(/&/g, '&amp;')}</pre>`);
    expect(renderToStaticMarkup(<Item {...props(asking('File changes', { files: ['/p/src/a.ts', '/p/docs/b.md'] }))} />)).toContain('<pre>/p/src/a.ts\n/p/docs/b.md</pre>');
  });
  it('offers Codex’s session-wide allow to a Codex seat whatever its name, and Claude’s to a Claude seat named Codex', () => {
    const draw = (agent: string, engine: 'claude' | 'codex') => renderToStaticMarkup(<Item {...props(asking('Shell', { command: 'ls' }))} agent={agent} engine={engine} />);
    expect(draw('Reviewer', 'codex')).toContain('Allow for this session'); expect(draw('Reviewer', 'codex')).not.toContain('Allow edits this run');
    expect(draw('Codex', 'claude')).toContain('Allow edits this run');
    // Without a seat (an older caller), the name decides as before.
    expect(renderToStaticMarkup(<Item {...props(asking('Shell', { command: 'ls' }))} agent="Codex" />)).toContain('Allow for this session');
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
  it('shows a seat whose usage is not measured yet as a dash, and keeps 0 for a counted zero', () => {
    const seats = [...counted(12_400, 0), { ...counted(0, 0)[1], id: 'g', engine: 'gemini' as const, name: 'Gemini CLI', working: 'Gemini CLI', colour: 'gemini' as const, tokens: null }];
    const html = renderToStaticMarkup(<TableBar leadEngine="claude" table={table} busy={false} seats={seats} onRequest={() => {}} />);
    expect(html).toMatch(/<b class="seat-text-codex">Codex 0<\/b> · <b class="seat-text-gemini">Gemini CLI —<\/b>/);
    expect(html).toContain('Gemini CLI — (—: not measured yet)');
  });
  it('says who is writing, not "Your turn", while the lead writes a reply nobody asked it for', () => {
    const bar = (busy: boolean) => renderToStaticMarkup(<TableBar leadEngine="claude" table={table} busy={busy} onRequest={() => {}} />);
    expect(bar(true)).toContain('<span class="table-status" aria-live="polite">Claude is working</span>'); expect(bar(true)).not.toContain('Your turn');
    expect(bar(false)).toContain('<span class="table-status" aria-live="polite">Your turn</span>');
    // A hidden seat that is the one working is named, not the lead.
    const seats = counted(0, 0).map((seat, index) => index ? { ...seat, state: 'working' } : seat);
    expect(renderToStaticMarkup(<TableBar leadEngine="claude" table={table} busy seats={seats} onRequest={() => {}} />)).toContain('<span class="table-status" aria-live="polite">Codex is working</span>');
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
