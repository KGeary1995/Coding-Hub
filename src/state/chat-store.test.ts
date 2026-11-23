import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChatEvent, chatAnswered, chatEnded, chatNotice, chatSent, chatStarted, chatDrafts, flushChatDeltas, forgetChatsExcept, forgetLinkedChatsExcept, useChatStore } from './chat-store';

const items = () => useChatStore.getState().threads.s.items;
const event = (value: Parameters<typeof applyChatEvent>[0]['event']) => applyChatEvent({ sessionId: 's', runId: 'r', event: value });

describe('chat threads', () => {
  beforeEach(() => { useChatStore.setState({ threads: {} }); chatStarted('s', 'r', false); });
  it('shows a message sent from a phone or another computer, but not a message sent from this window twice', () => {
    chatSent('s', 'from here', []);
    applyChatEvent({ sessionId: 's', runId: 'r', event: { type: 'user', text: 'from here', images: 0 } });
    applyChatEvent({ sessionId: 's', runId: 'r', event: { type: 'user', text: 'from the phone', images: 0, remote: true } });
    const thread = useChatStore.getState().threads.s;
    expect(thread.items.filter((item) => item.kind === 'user').map((item) => (item as { text: string }).text)).toEqual(['from here', 'from the phone']);
    expect(thread.busy).toBe(true);
  });
  it('streams a reply, then merges the per-block messages Claude sends under one id', () => {
    chatSent('s', 'hello', [{ mediaType: 'image/png', data: 'AAAA' }]);
    expect(items()[0]).toMatchObject({ kind: 'user', text: 'hello', images: ['data:image/png;base64,AAAA'] });
    expect(useChatStore.getState().threads.s.busy).toBe(true);
    event({ type: 'delta', messageId: 'm1', text: 'Hel' }); event({ type: 'delta', messageId: 'm1', text: 'lo' }); flushChatDeltas();
    expect(items()[1]).toMatchObject({ kind: 'assistant', streaming: 'Hello', blocks: [] });
    event({ type: 'assistant', messageId: 'm1', blocks: [{ type: 'thinking', text: 'hmm' }] });
    event({ type: 'assistant', messageId: 'm1', blocks: [{ type: 'text', text: 'Hello' }] });
    event({ type: 'assistant', messageId: 'm1', blocks: [{ type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } }] });
    event({ type: 'assistant', messageId: 'm1', blocks: [{ type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } }] });
    expect(items()).toHaveLength(2);
    expect(items()[1]).toMatchObject({ streaming: '', blocks: [{ type: 'thinking' }, { type: 'text', text: 'Hello' }, { type: 'tool', id: 't1' }] });
    event({ type: 'tool-result', toolUseId: 't1', text: 'a.txt', isError: false, image: false });
    expect(useChatStore.getState().threads.s.results.t1).toEqual({ text: 'a.txt', isError: false, image: false });
    event({ type: 'done', isError: false, error: null });
    expect(useChatStore.getState().threads.s.busy).toBe(false);
  });
  it('tracks approvals, keeps an interrupted reply, and ignores events from an older run', () => {
    event({ type: 'permission', requestId: 'p1', toolName: 'Write', description: 'notes.txt', input: {}, canAllowEdits: true });
    chatAnswered('s', 'p1', true);
    expect(items()[0]).toMatchObject({ kind: 'permission', answer: 'allowed' });
    event({ type: 'permission', requestId: 'p2', toolName: 'Bash', description: '', input: {}, canAllowEdits: false });
    event({ type: 'delta', messageId: 'm2', text: 'partial' });
    event({ type: 'done', isError: true, error: 'Interrupted by the person.' });
    expect(items().find((item) => item.kind === 'assistant')).toMatchObject({ blocks: [{ type: 'text', text: 'partial' }], streaming: '' });
    expect(items().at(-1)).toMatchObject({ kind: 'notice', error: true, text: 'Interrupted by the person.' });
    chatEnded('s');
    expect(items().find((item) => item.kind === 'permission' && item.id === 'p2')).toMatchObject({ answer: 'closed' });
    applyChatEvent({ sessionId: 's', runId: 'old', event: { type: 'notice', text: 'stale' } });
    expect(items().some((item) => item.kind === 'notice' && item.text === 'stale')).toBe(false);
  });
  it('closes a reply Claude started by itself when it is told the reply ended, as it closes any reply', () => {
    // No message was sent: the reply's text arriving is what shows the chat as working.
    event({ type: 'delta', messageId: 'm1', text: 'The release is ' }); event({ type: 'delta', messageId: 'm1', text: 'published.' }); flushChatDeltas();
    expect(useChatStore.getState().threads.s.busy).toBe(true);
    event({ type: 'settled' });
    const thread = useChatStore.getState().threads.s;
    expect(thread.busy).toBe(false);
    // Its streamed text is kept as the reply, and no error line is added.
    expect(thread.items.at(-1)).toMatchObject({ kind: 'assistant', streaming: '', blocks: [{ type: 'text', text: 'The release is published.' }] });
    expect(thread.items.some((item) => item.kind === 'notice' && item.error)).toBe(false);
  });
  it('starts a fresh conversation empty and keeps a resumed one with a note', () => {
    chatSent('s', 'first', []);
    chatStarted('s', 'r2', true);
    expect(items().map((item) => item.kind)).toEqual(['user', 'notice']);
    chatStarted('s', 'r3', false);
    expect(items()).toEqual([]);
  });
  it('frees the conversations of channels removed from the workspace', () => {
    chatStarted('gone', 'r2', false); chatSent('gone', 'hi', [{ mediaType: 'image/png', data: 'AAAA' }]);
    forgetChatsExcept(['s']); expect(Object.keys(useChatStore.getState().threads)).toEqual(['s']);
  });
  it('frees the unsent message of a channel removed, and keeps the others’', () => {
    chatDrafts.set('s', { text: 'still writing', images: [] }); chatDrafts.set('gone', { text: 'never sent', images: [] });
    forgetChatsExcept(['s']); expect([...chatDrafts.keys()]).toEqual(['s']); chatDrafts.clear();
  });
  it('keeps a linked computer’s threads when this computer’s channels change, and frees them once that computer goes', () => {
    chatStarted('pc-2:remote', 'r9', false); chatNotice('pc-2:remote', 'from the other computer');
    forgetChatsExcept(['s']); expect(Object.keys(useChatStore.getState().threads).sort()).toEqual(['pc-2:remote', 's']);
    forgetLinkedChatsExcept(['pc-2']); expect(Object.keys(useChatStore.getState().threads).sort()).toEqual(['pc-2:remote', 's']);
    forgetLinkedChatsExcept([]); expect(Object.keys(useChatStore.getState().threads)).toEqual(['s']);
  });
  it('gathers streamed text and draws it once a frame, before anything that follows it', () => {
    let updates = 0; const stop = useChatStore.subscribe(() => { updates++; });
    for (let piece = 0; piece < 50; piece++) event({ type: 'delta', messageId: 'm', text: 'x' });
    expect(updates).toBe(0); expect(items()).toEqual([]);
    flushChatDeltas(); expect(updates).toBe(1); expect(items()[0]).toMatchObject({ kind: 'assistant', streaming: 'x'.repeat(50) });
    event({ type: 'delta', messageId: 'm', text: '!' }); event({ type: 'notice', text: 'after' }); stop();
    expect(items().map((item) => item.kind)).toEqual(['assistant', 'notice']); expect(items()[0]).toMatchObject({ streaming: 'x'.repeat(50) + '!' });
    event({ type: 'delta', messageId: 'm2', text: 'old run' }); chatStarted('s', 'r2', false); flushChatDeltas();
    expect(items()).toEqual([]);
  });
  it('updates the thread at most once a frame while a reply streams faster than the screen draws', () => {
    flushChatDeltas(); vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    let drawn = 0; const screen = setInterval(() => { drawn++; const due = [...frames.values()]; frames.clear(); for (const callback of due) callback(0); }, 16);
    let updates = 0; const stop = useChatStore.subscribe(() => { updates++; });
    try {
      for (let second = 0; second < 3; second++) {
        updates = 0; drawn = 0;
        for (let piece = 0; piece < 500; piece++) { event({ type: 'delta', messageId: 'm', text: 'x' }); vi.advanceTimersByTime(2); }
        expect(updates).toBeGreaterThan(0); expect(updates).toBeLessThanOrEqual(drawn);
      }
      vi.advanceTimersByTime(200); expect(items()[0]).toMatchObject({ streaming: 'x'.repeat(1500) });
    } finally { stop(); clearInterval(screen); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
  it('closes an approval left open when its reply ends', () => {
    event({ type: 'permission', requestId: 'p', toolName: 'Bash', description: 'ls', input: {}, canAllowEdits: false });
    event({ type: 'done', isError: true, error: 'Interrupted.' });
    expect(items().find((item) => item.kind === 'permission')).toMatchObject({ answer: 'closed' });
  });
  it('shows a resumed conversation\'s earlier messages, unless the thread still shows the conversation', () => {
    useChatStore.setState({ threads: {} }); chatStarted('s', 'r', true);
    event({ type: 'history', messages: [{ role: 'user', text: 'hi', images: 1 }, { role: 'assistant', messageId: 'm', blocks: [{ type: 'tool', id: 't', name: 'Bash', input: {} }] }], results: { t: { text: 'ok', isError: false, image: false } } });
    expect(items().map((item) => item.kind)).toEqual(['user', 'assistant', 'notice']); expect(items()[0]).toMatchObject({ text: 'hi\n[1 image]' });
    expect(useChatStore.getState().threads.s.results.t).toMatchObject({ text: 'ok' });
    event({ type: 'history', messages: [{ role: 'user', text: 'again', images: 0 }], results: {} }); expect(items()).toHaveLength(3);
    event({ type: 'user', text: 'new', images: 0 }); expect(items()).toHaveLength(3);
  });
  it('keeps the thread when a linked computer\'s newer Trace sends an event type this version does not know', () => {
    event({ type: 'assistant', messageId: 'm', blocks: [{ type: 'text', text: 'Hello' }] });
    const before = useChatStore.getState().threads.s;
    event({ type: 'some-newer-event' } as unknown as Parameters<typeof event>[0]);
    expect(useChatStore.getState().threads.s).toBe(before);
    event({ type: 'notice', text: 'later' });
    expect(items().map((item) => item.kind)).toEqual(['assistant', 'notice']);
  });
});
