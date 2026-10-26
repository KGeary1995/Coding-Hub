import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
import { CodexStream } from './codex-stream';

/** Codex's app server as seen in a probe of codex-cli 0.164: JSON-RPC lines, responses by id, server requests for approvals. */
function codex(options = { cwd: '/p', model: '', reasoningEffort: null as string | null }) {
  const sent: Record<string, unknown>[] = []; const events: ChatEvent[] = [];
  const stream = new CodexStream((line) => sent.push(JSON.parse(line)), (event) => events.push(event), options);
  const reply = (id: number, result: unknown) => stream.push(JSON.stringify({ id, result }) + '\n');
  const notify = (method: string, params: unknown) => stream.push(JSON.stringify({ method, params }) + '\n');
  return { stream, sent, events, reply, notify };
}

describe('Codex chat protocol', () => {
  it('starts a thread after initialize, sends images as data URLs, and turns items into chat events', () => {
    const { stream, sent, events, reply, notify } = codex({ cwd: '/p', model: 'gpt-x', reasoningEffort: 'high' });
    stream.start();
    expect(sent[0]).toMatchObject({ id: 1, method: 'initialize' });
    reply(1, { userAgent: 'codex' });
    expect(sent[1]).toEqual({ method: 'initialized' });
    expect(sent[2]).toMatchObject({ id: 2, method: 'thread/start', params: { cwd: '/p', model: 'gpt-x', config: { model_reasoning_effort: 'high' } } });
    // A message written before the thread exists waits for it.
    stream.send('what is this', [{ mediaType: 'image/png', data: 'AAAA' }]);
    expect(sent).toHaveLength(3);
    reply(2, { thread: { id: 'thread-1' }, model: 'gpt-x' });
    expect(events[0]).toEqual({ type: 'ready', conversationId: 'thread-1', model: 'gpt-x' });
    expect(sent[3]).toMatchObject({ method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'image', url: 'data:image/png;base64,AAAA' }, { type: 'text', text: 'what is this' }] } });
    reply(3, { turn: { id: 'turn-1', status: 'inProgress' } });
    notify('item/agentMessage/delta', { itemId: 'm1', delta: 'Curly ' }); notify('item/agentMessage/delta', { itemId: 'm1', delta: 'braces.' });
    notify('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Curly braces.' } });
    notify('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'inProgress' } });
    notify('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed', aggregatedOutput: 'a.txt\n', exitCode: 0 } });
    notify('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: '/p/notes.txt', kind: { type: 'add' }, diff: '+ok' }], status: 'inProgress' } });
    notify('item/completed', { item: { type: 'fileChange', id: 'f1', changes: [{ path: '/p/notes.txt', kind: { type: 'add' }, diff: '+ok' }], status: 'completed' } });
    stream.interrupt();
    expect(sent.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } });
    expect(events.slice(1)).toEqual([
      { type: 'delta', messageId: 'm1', text: 'Curly ' }, { type: 'delta', messageId: 'm1', text: 'braces.' },
      { type: 'assistant', messageId: 'm1', blocks: [{ type: 'text', text: 'Curly braces.' }] },
      { type: 'assistant', messageId: 'c1', blocks: [{ type: 'tool', id: 'c1', name: 'Bash', input: { command: 'ls' } }] },
      { type: 'tool-result', toolUseId: 'c1', text: 'a.txt\n', isError: false, image: false },
      { type: 'assistant', messageId: 'f1', blocks: [{ type: 'tool', id: 'f1', name: 'Edit', input: { file_path: '/p/notes.txt' } }] },
      { type: 'tool-result', toolUseId: 'f1', text: 'add /p/notes.txt\n+ok', isError: false, image: false },
      { type: 'done', isError: false, error: null },
    ]);
  });
  it('turns Codex approval requests into approvals, answers them, and declines requests it does not handle', () => {
    const { stream, sent, events, reply } = codex();
    stream.start(); reply(1, {}); reply(2, { thread: { id: 't' } });
    stream.push(JSON.stringify({ id: 50, method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'c', command: 'rm -rf build', reason: null } }) + '\n');
    stream.push(JSON.stringify({ id: 51, method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'f', reason: 'Write notes' } }) + '\n');
    stream.push(JSON.stringify({ id: 52, method: 'item/tool/requestUserInput', params: {} }) + '\n');
    expect(events.filter((event) => event.type === 'permission')).toEqual([
      { type: 'permission', requestId: 'codex-50', toolName: 'Shell', description: 'rm -rf build', input: { command: 'rm -rf build' }, canAllowEdits: true },
      { type: 'permission', requestId: 'codex-51', toolName: 'File changes', description: 'Write notes', input: { files: [] }, canAllowEdits: true },
    ]);
    expect(sent.at(-1)).toMatchObject({ id: 52, error: { code: -32601 } });
    expect(stream.answer('codex-50', false)).toBe(true); expect(sent.at(-1)).toEqual({ id: 50, result: { decision: 'decline' } });
    expect(stream.answer('codex-51', true, true)).toBe(true); expect(sent.at(-1)).toEqual({ id: 51, result: { decision: 'acceptForSession' } });
    expect(stream.answer('codex-51', true)).toBe(false);
    // A failed start says so.
    const failed = codex(); failed.stream.start(); failed.reply(1, {}); failed.stream.push(JSON.stringify({ id: 2, error: { message: 'Not signed in' } }) + '\n');
    expect(failed.events).toEqual([{ type: 'done', isError: true, error: 'Not signed in' }]);
  });
});
