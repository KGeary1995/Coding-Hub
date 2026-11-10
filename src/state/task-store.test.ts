import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../shared/workbench';

const calls: Record<string, unknown>[] = []; let listed: Task[] = []; let transcript: unknown = null;
vi.mock('../runtime/workbench', () => ({ workbench: vi.fn(async (request: Record<string, unknown>) => { calls.push(request); return request.action === 'channel-transcript' ? transcript : request.action === 'task-list' ? listed : request.action === 'task-send' ? { task: listed[0], prompt: 'Task: Fix it.' } : null; }) }));
vi.mock('../runtime/terminals', () => ({ writeTerminal: vi.fn(async () => true) }));

const { sendTask, startTaskAutomation, taskTurnDone, useTaskStore } = await import('./task-store');
const { useChatStore } = await import('./chat-store');
const { useWorkspaceStore } = await import('./workspace-store');
const { useActivityStore } = await import('./activity-store');
const working = (sessionId: string, extra: Partial<Task> = {}): Task => ({ id: crypto.randomUUID(), title: 'Fix it', directory: '/project', sessionId, scope: ['**'], status: 'active', notes: '', verificationId: null, createdAt: new Date().toISOString(), sentAt: new Date(Date.now() - 60000).toISOString(), ...extra });
const statusCalls = () => calls.filter((call) => call.action === 'task-status');

describe('a turn ending moves a working task only when the agent says it is done', () => {
  beforeEach(() => { calls.length = 0; transcript = null; });
  it('sends a reply ending in TASK COMPLETE to Ready for review', async () => {
    const task = working('a'); useTaskStore.setState({ tasks: [task] });
    await taskTurnDone('a', false, 'Changed a.ts; tests pass.\n\n**TASK COMPLETE**');
    expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'review', outcome: 'finished' }]);
  });
  it('keeps a task in Working when the agent is blocked, with what it needs, or ends without the line', async () => {
    const task = working('b'); listed = [task]; useTaskStore.setState({ tasks: [task] });
    await taskTurnDone('b', false, 'Which database should I use?\nTASK BLOCKED: choose Postgres or SQLite');
    await taskTurnDone('b', false, 'Should I also update the docs?');
    expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'active', outcome: 'blocked', outcomeNote: 'choose Postgres or SQLite' }, { action: 'task-status', id: task.id, status: 'active', outcome: 'unconfirmed' }]);
  });
  it('reads a terminal channel\u2019s reply from its transcript', async () => {
    const task = working('t'); useTaskStore.setState({ tasks: [task] });
    transcript = { type: 'history', messages: [{ role: 'user', text: 'go', images: 0 }, { role: 'assistant', messageId: 'm', blocks: [{ type: 'text', text: 'Done.\nTASK COMPLETE' }] }], results: {} };
    await taskTurnDone('t'); expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'review', outcome: 'finished' }]);
  });
  it('keeps a task in Working, marked failed, when the turn ended in an error or was interrupted', async () => {
    const task = working('e'); useTaskStore.setState({ tasks: [task] });
    await taskTurnDone('e', true, 'TASK COMPLETE'); expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'active', outcome: 'failed' }]);
  });
  it('ignores a turn that ends within seconds of the send (the CLI taking the message)', async () => {
    useTaskStore.setState({ tasks: [working('c', { sentAt: new Date().toISOString() })] });
    await taskTurnDone('c', false, 'TASK COMPLETE'); expect(statusCalls()).toHaveLength(0);
  });
});

describe('task automation never takes silence or a stop for completion', () => {
  beforeEach(() => { calls.length = 0; vi.useFakeTimers(); });
  const run = async (session: Record<string, unknown>, samples: number[], task: Task) => {
    useWorkspaceStore.setState({ sessions: [{ config: { engine: 'codex', chat: false }, attention: null, ...session }] as never });
    useActivityStore.setState({ samples: { [session.id as string]: samples } } as never); listed = [task]; useTaskStore.setState({ tasks: [task] });
    const stop = startTaskAutomation(); await vi.advanceTimersByTimeAsync(5000); stop(); vi.useRealTimers();
    return statusCalls();
  };
  it('marks a quiet terminal task but leaves it in Working', async () => {
    const task = working('q'); expect(await run({ id: 'q', status: 'running' }, Array(45).fill(0), task)).toEqual([{ action: 'task-status', id: task.id, status: 'active', outcome: 'quiet' }]);
  });
  it('does nothing to a quiet channel that is waiting for an approval', async () => {
    expect(await run({ id: 'w', status: 'running', attention: { message: 'Allow?', at: new Date().toISOString() } }, Array(45).fill(0), working('w'))).toEqual([]);
  });
  it('clears the quiet mark when the channel draws again', async () => {
    const task = working('r', { outcome: 'quiet' }); expect(await run({ id: 'r', status: 'running' }, [...Array(44).fill(0), 3], task)).toEqual([{ action: 'task-status', id: task.id, status: 'active' }]);
  });
  it('keeps a task whose channel stopped or failed in Working, marked', async () => {
    const stopped = working('s'); expect(await run({ id: 's', status: 'exited' }, [], stopped)).toEqual([{ action: 'task-status', id: stopped.id, status: 'active', outcome: 'stopped' }]);
    calls.length = 0; vi.useFakeTimers(); const failed = working('f'); expect(await run({ id: 'f', status: 'error' }, [], failed)).toEqual([{ action: 'task-status', id: failed.id, status: 'active', outcome: 'failed' }]);
  });
});

describe('sending a task to a Round Table', () => {
  it('goes to both agents through table-send, and to a plain chat through send', async () => {
    const chats: Record<string, unknown>[] = []; (globalThis as { window?: unknown }).window = { codingHub: { chat: vi.fn(async (request: Record<string, unknown>) => { chats.push(request); return { ok: true, value: null }; }) } };
    const lead = { id: 'lead', status: 'running', runId: crypto.randomUUID(), config: { engine: 'claude', chat: true } };
    useWorkspaceStore.setState({ sessions: [lead] as never }); const task = working('lead'); listed = [task]; useTaskStore.setState({ tasks: [task] });
    useChatStore.setState({ threads: { lead: { runId: lead.runId, items: [], results: {}, busy: false, model: null, table: { partner: { sessionId: 'p', runId: crypto.randomUUID(), engine: 'codex' }, driver: 'claude', rounds: 2, round: 0, phase: 'idle', agreed: false } } } });
    await sendTask(task.id); expect(chats.at(-1)).toMatchObject({ action: 'table-send', sessionId: 'lead', text: 'Task: Fix it.' });
    useChatStore.setState({ threads: {} }); await sendTask(task.id); expect(chats.at(-1)).toMatchObject({ action: 'send', sessionId: 'lead' });
  });
});
