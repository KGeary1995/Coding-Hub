import { beforeEach, describe, expect, it } from 'vitest';
import { applyChatEvent, chatAnswered, chatEnded, chatSent, chatStarted, forgetChatsExcept, useChatStore } from './chat-store';

const items = () => useChatStore.getState().threads.s.items;
const event = (value: Parameters<typeof applyChatEvent>[0]['event']) => applyChatEvent({ sessionId: 's', runId: 'r', event: value });

describe('chat threads', () => {
  beforeEach(() => { useChatStore.setState({ threads: {} }); chatStarted('s', 'r', false); });
  it('streams a reply, then merges the per-block messages Claude sends under one id', () => {
    chatSent('s', 'hello', [{ mediaType: 'image/png', data: 'AAAA' }]);
    expect(items()[0]).toMatchObject({ kind: 'user', text: 'hello', images: ['data:image/png;base64,AAAA'] });
    expect(useChatStore.getState().threads.s.busy).toBe(true);
    event({ type: 'delta', messageId: 'm1', text: 'Hel' }); event({ type: 'delta', messageId: 'm1', text: 'lo' });
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
});
