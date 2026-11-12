import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
import { CodexStream } from './codex-stream';

/** Codex's app server as seen in a probe of codex-cli 0.164: JSON-RPC lines, responses by id, server requests for approvals. */
function codex(options: import('./codex-stream').CodexThreadOptions = { cwd: '/p', model: '', reasoningEffort: null }) {
  const sent: Record<string, unknown>[] = []; const events: ChatEvent[] = [];
  const stream = new CodexStream((line) => sent.push(JSON.parse(line)), (event) => events.push(event), options);
  const reply = (id: number, result: unknown) => stream.push(JSON.stringify({ id, result }) + '\n');
  const notify = (method: string, params: unknown) => stream.push(JSON.stringify({ method, params }) + '\n');
  return { stream, sent, events, reply, notify };
}

describe('Codex chat permissions', () => {
  it('starts a thread at the channel’s level and sends a changed level with the next turn only', () => {
    const { stream, sent, reply } = codex({ cwd: '/p', model: '', reasoningEffort: null, permissions: 'full' });
    stream.start(); reply(1, {});
    expect(sent[2]).toMatchObject({ method: 'thread/start', params: { approvalPolicy: 'never', sandbox: 'danger-full-access' } });
    reply(2, { thread: { id: 't' }, approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } });
    stream.send('one', []); expect((sent.at(-1)!.params as Record<string, unknown>).approvalPolicy).toBeUndefined();
    stream.setPermissions('edits'); stream.send('two', []);
    expect(sent.at(-1)).toMatchObject({ method: 'turn/start', params: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } } });
    stream.send('three', []); expect((sent.at(-1)!.params as Record<string, unknown>).sandboxPolicy).toBeUndefined();
  });
  it('puts back the level Codex last accepted when a turn refuses a new one, and sends the policy again', () => {
    const { stream, sent, events, reply } = codex({ cwd: '/p', model: '', reasoningEffort: null, permissions: 'ask' });
    stream.start(); reply(1, {}); reply(2, { thread: { id: 't' }, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } });
    stream.setPermissions('edits'); stream.send('one', []); reply((sent.at(-1) as { id: number }).id, { turn: { id: 'turn-1' } });
    stream.setPermissions('full'); stream.send('two', []);
    stream.push(JSON.stringify({ id: (sent.at(-1) as { id: number }).id, error: { message: 'danger-full-access is not allowed' } }) + '\n');
    expect(events.filter((event) => event.type === 'permissions')).toEqual([{ type: 'permissions', level: 'edits' }]);
    expect(events.some((event) => event.type === 'notice' && event.text.includes('not allowed'))).toBe(true);
    // The next turn carries the accepted level's policy again.
    stream.send('three', []); expect(sent.at(-1)).toMatchObject({ method: 'turn/start', params: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } } });
  });
  it('keeps a level chosen while a refused turn was on its way', () => {
    const { stream, sent, events, reply } = codex({ cwd: '/p', model: '', reasoningEffort: null, permissions: 'edits' });
    stream.start(); reply(1, {}); reply(2, { thread: { id: 't' } });
    stream.setPermissions('full'); stream.send('one', []); const pending = (sent.at(-1) as { id: number }).id;
    stream.setPermissions('ask');
    stream.push(JSON.stringify({ id: pending, error: { message: 'no' } }) + '\n');
    expect(events.filter((event) => event.type === 'permissions')).toEqual([]);
    stream.send('two', []); expect((sent.at(-1)!.params as Record<string, unknown>).approvalPolicy).toBe('on-request');
  });
  it('returns Ask to what Codex reported for the person’s settings, and keeps a reviewer read-only', () => {
    const { stream, sent, reply } = codex();
    stream.start(); reply(1, {});
    expect(sent[2].params).not.toHaveProperty('approvalPolicy');
    const own = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    reply(2, { thread: { id: 't' }, approvalPolicy: 'untrusted', sandbox: own });
    stream.setPermissions('full'); stream.setReadOnly(true); stream.send('review', []);
    expect(sent.at(-1)).toMatchObject({ params: { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } } });
    stream.setReadOnly(false); stream.setPermissions('ask'); stream.send('back', []);
    expect(sent.at(-1)).toMatchObject({ params: { approvalPolicy: 'untrusted', sandboxPolicy: own } });
  });
});

describe('Codex chat protocol', () => {
  it('answers every message with an error once the thread could not start, instead of leaving it waiting', () => {
    const { stream, events, reply } = codex(); stream.start(); reply(1, {});
    stream.push(JSON.stringify({ id: 2, error: { message: 'Unknown model' } }) + '\n');
    expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'Unknown model' });
    stream.send('hello', []);
    expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'Unknown model Restart the channel to try again.' });
  });
  it('applies a Stop pressed before Codex named the turn as soon as it does', () => {
    const { stream, sent, reply, notify } = codex(); stream.start(); reply(1, {}); reply(2, { thread: { id: 'thread-1' } });
    stream.send('long task', []); const start = sent.at(-1) as { id: number }; expect(start).toMatchObject({ method: 'turn/start' });
    stream.interrupt(); expect(sent.at(-1)).toBe(start);
    // The turn/started notification can come before turn/start's reply; either names the turn once.
    notify('turn/started', { turn: { id: 'turn-9' } });
    expect(sent.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-9' } });
    reply(start.id, { turn: { id: 'turn-9' } }); expect(sent.filter((message) => message.method === 'turn/interrupt')).toHaveLength(1);
  });
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
    // An approval left open when its turn ends (interrupted) is closed and can no longer be answered.
    stream.push(JSON.stringify({ id: 53, method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'd', command: 'npm test', reason: null } }) + '\n');
    stream.push(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'u', status: 'interrupted' } } }) + '\n');
    expect(events.slice(-2)).toEqual([{ type: 'permission-done', requestId: 'codex-53' }, { type: 'done', isError: true, error: 'Interrupted.' }]);
    expect(stream.answer('codex-53', true)).toBe(false);
    // A failed start says so.
    const failed = codex(); failed.stream.start(); failed.reply(1, {}); failed.stream.push(JSON.stringify({ id: 2, error: { message: 'Not signed in' } }) + '\n');
    expect(failed.events).toEqual([{ type: 'done', isError: true, error: 'Not signed in' }]);
  });
  it('skips lines that are not messages instead of throwing', () => {
    const { stream, events } = codex(); stream.start();
    expect(() => stream.push('null\n[1,2]\n"text"\n42\n{"method":"turn/completed","params":null}\n')).not.toThrow();
    expect(events.filter((event) => event.type !== 'done')).toEqual([]);
  });
});

describe('Stop while Codex is still opening its conversation', () => {
  it('drops the waiting message and ends its turn, so Stop never waits for a turn that has not started', () => {
    const { stream, sent, events, reply } = codex();
    stream.start(); reply(1, {});
    stream.send('hello', []);
    stream.interrupt();
    expect(events.filter((event) => event.type === 'done')).toEqual([{ type: 'done', isError: true, error: 'Stopped before Codex had opened the conversation.' }]);
    // The thread opens later: the dropped message is not sent after all.
    reply(2, { thread: { id: 't' } });
    expect(sent.some((message) => message.method === 'turn/start')).toBe(false);
  });
});
