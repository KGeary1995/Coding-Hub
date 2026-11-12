import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../shared/workbench';

const calls: Record<string, unknown>[] = []; let listed: Task[] = []; let transcript: unknown = null;
vi.mock('../runtime/workbench', () => ({ workbench: vi.fn(async (request: Record<string, unknown>) => { calls.push(request); return request.action === 'channel-transcript' ? transcript : request.action === 'task-list' ? listed : request.action === 'task-send' ? { task: listed[0], prompt: 'Task: Fix it.' } : null; }) }));
vi.mock('../runtime/terminals', () => ({ writeTerminal: vi.fn(async () => true) }));

const { chainTasks, sendTask, startTaskAutomation, taskTurnDone, useTaskStore } = await import('./task-store');
const { useChatStore } = await import('./chat-store');
const { useWorkspaceStore } = await import('./workspace-store');
const { useActivityStore } = await import('./activity-store');
const working = (sessionId: string, extra: Partial<Task> = {}): Task => ({ id: crypto.randomUUID(), title: 'Fix it', directory: '/project', sessionId, scope: ['**'], status: 'active', notes: '', verificationId: null, createdAt: new Date().toISOString(), sentAt: new Date(Date.now() - 60000).toISOString(), ...extra });
const statusCalls = () => calls.filter((call) => call.action === 'task-status');

describe('a turn ending moves a working task only when the agent says it is done', () => {
  beforeEach(() => { calls.length = 0; transcript = null; });
  it('sends a reply ending in TASK COMPLETE to Ready for review', async () => {
    const task = working('a'); useTaskStore.setState({ tasks: [task] });
    await taskTurnDone('a', false, { text: 'Changed a.ts; tests pass.\n\n**TASK COMPLETE**' });
    expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'review', outcome: 'finished' }]);
  });
  it('keeps a task in Working when the agent is blocked, with what it needs, or ends without the line', async () => {
    const task = working('b'); listed = [task]; useTaskStore.setState({ tasks: [task] });
    await taskTurnDone('b', false, { text: 'Which database should I use?\nTASK BLOCKED: choose Postgres or SQLite' });
    await taskTurnDone('b', false, { text: 'Should I also update the docs?' });
    expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'active', outcome: 'blocked', outcomeNote: 'choose Postgres or SQLite' }, { action: 'task-status', id: task.id, status: 'active', outcome: 'unconfirmed' }]);
  });
  it('reads a terminal channel\u2019s reply from its transcript', async () => {
    const task = working('t'); useTaskStore.setState({ tasks: [task] });
    transcript = { type: 'history', messages: [{ role: 'user', text: 'Task: Fix it. Do it.', images: 0 }, { role: 'assistant', messageId: 'm', blocks: [{ type: 'text', text: 'Done.\nTASK COMPLETE' }] }], results: {} };
    await taskTurnDone('t'); expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'review', outcome: 'finished' }]);
  });
  it('never takes an earlier task’s TASK COMPLETE for the next task sent to the same channel', async () => {
    const second = working('t2', { title: 'Write the docs' }); listed = [second]; useTaskStore.setState({ tasks: [second] });
    transcript = { type: 'history', messages: [{ role: 'user', text: 'Task: Fix it. ...', images: 0 }, { role: 'assistant', messageId: 'a', blocks: [{ type: 'text', text: 'TASK COMPLETE' }] }, { role: 'user', text: 'Task: Write the docs. ...', images: 0 }], results: {} };
    await taskTurnDone('t2'); expect(statusCalls()).toEqual([{ action: 'task-status', id: second.id, status: 'active', outcome: 'unconfirmed' }]);
    calls.length = 0; (transcript as { messages: unknown[] }).messages.push({ role: 'assistant', messageId: 'b', blocks: [{ type: 'text', text: 'Docs written.\nTASK COMPLETE' }] });
    useTaskStore.setState({ tasks: [{ ...second, outcome: 'unconfirmed' }] }); listed = [{ ...second, outcome: 'unconfirmed' }];
    await taskTurnDone('t2'); expect(statusCalls()).toEqual([{ action: 'task-status', id: second.id, status: 'review', outcome: 'finished' }]);
  });
  it('gives a turn end to the task sent last when an earlier one on the same channel is still active', async () => {
    const instruction = (await import('../../shared/task-signal')).SIGNAL_INSTRUCTION;
    const first = working('two', { title: 'Fix it', sendId: 't-11111111', sentAt: new Date(Date.now() - 120000).toISOString() });
    const second = working('two', { title: 'Write the docs', sendId: 't-22222222', sentAt: new Date(Date.now() - 60000).toISOString() });
    // The older task first in the list, as the host writes it after the newer one is sent.
    useTaskStore.setState({ tasks: [first, second] }); listed = [first, second];
    transcript = { type: 'history', messages: [
      { role: 'user', text: `Task t-11111111: Fix it. ${instruction}`, images: 0 }, { role: 'assistant', messageId: 'a', blocks: [{ type: 'text', text: 'Which file?' }] },
      { role: 'user', text: `Task t-22222222: Write the docs. ${instruction}`, images: 0 }, { role: 'assistant', messageId: 'b', blocks: [{ type: 'text', text: 'Docs written.\nTASK COMPLETE' }] },
    ], results: {} };
    await taskTurnDone('two');
    expect(statusCalls()).toEqual([{ action: 'task-status', id: second.id, status: 'review', outcome: 'finished' }]);
  });
  it('gives a turn end to the older task when the newer one was typed before that turn ended (not in the conversation yet)', async () => {
    const instruction = (await import('../../shared/task-signal')).SIGNAL_INSTRUCTION;
    const first = working('busy', { title: 'Fix it', sendId: 't-33333333', sentAt: new Date(Date.now() - 120000).toISOString() });
    const second = working('busy', { title: 'Write the docs', sendId: 't-44444444', sentAt: new Date(Date.now() - 60000).toISOString() });
    useTaskStore.setState({ tasks: [first, second] }); listed = [first, second];
    transcript = { type: 'history', messages: [
      { role: 'user', text: `Task t-33333333: Fix it. ${instruction}`, images: 0 }, { role: 'assistant', messageId: 'a', blocks: [{ type: 'text', text: 'Fixed it.\nTASK COMPLETE' }] },
    ], results: {} };
    await taskTurnDone('busy');
    expect(statusCalls()).toEqual([{ action: 'task-status', id: first.id, status: 'review', outcome: 'finished' }]);
  });
  it('reads a chat seat’s own conversation after the task’s prompt', async () => {
    const task = working('c2', { title: 'Rename the file' }); listed = [task]; useTaskStore.setState({ tasks: [task] });
    useChatStore.setState({ threads: { seat: { runId: null, items: [{ kind: 'user', id: 'u0', text: 'Task: Old one. x', images: [], at: '' }, { kind: 'assistant', id: 'a0', blocks: [{ type: 'text', text: 'TASK COMPLETE' }], streaming: '' }, { kind: 'user', id: 'u1', text: '[Trace Round Table] ...\n\nTask: Rename the file. Do it.', images: [], at: '' }, { kind: 'assistant', id: 'a1', blocks: [{ type: 'text', text: 'Renamed.\nTASK COMPLETE' }], streaming: '' }], results: {}, busy: false, model: null } } as never });
    await taskTurnDone('c2', false, { chat: 'seat' }); expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'review', outcome: 'finished' }]);
  });
  it('keeps a task in Working, marked failed, when the turn ended in an error or was interrupted', async () => {
    const task = working('e'); useTaskStore.setState({ tasks: [task] });
    await taskTurnDone('e', true, { text: 'TASK COMPLETE' }); expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'active', outcome: 'failed' }]);
  });
  it('ignores a terminal turn that ends within seconds of the send (the CLI taking the message), but not a quick chat reply', async () => {
    const quick = working('c', { sentAt: new Date().toISOString() }); useTaskStore.setState({ tasks: [quick] }); listed = [quick];
    transcript = { type: 'history', messages: [{ role: 'user', text: 'Task: Fix it. Do it.', images: 0 }, { role: 'assistant', messageId: 'q', blocks: [{ type: 'text', text: 'TASK COMPLETE' }] }], results: {} };
    await taskTurnDone('c'); expect(statusCalls()).toHaveLength(0);
    // A chat that answers at once, asking something, still shows in Needs you.
    useChatStore.setState({ threads: { seat: { runId: 'r', items: [{ kind: 'user', id: 'u', order: 1, text: 'Task: Fix it. Do it.', images: [], at: '' }, { kind: 'assistant', id: 'a', order: 2, blocks: [{ type: 'text', text: 'TASK BLOCKED: which file?' }], streaming: '' }], results: {}, busy: false, model: null } } as never });
    await taskTurnDone('c', false, { chat: 'seat' });
    expect(statusCalls()).toEqual([{ action: 'task-status', id: quick.id, status: 'active', outcome: 'blocked', outcomeNote: 'which file?' }]);
    useChatStore.setState({ threads: {} });
  });
});

describe('task automation never takes silence or a stop for completion', () => {
  beforeEach(() => { calls.length = 0; transcript = null; vi.useFakeTimers(); });
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
  it('reads a blocked quiet terminal again, and takes its later TASK COMPLETE', async () => {
    const task = working('k', { outcome: 'blocked', outcomeNote: 'which file?' });
    transcript = { type: 'history', messages: [{ role: 'user', text: 'Task: Fix it. x', images: 0 }, { role: 'assistant', messageId: 'a', blocks: [{ type: 'text', text: 'Used a.ts.\nTASK COMPLETE' }] }], results: {} };
    expect(await run({ id: 'k', status: 'running' }, Array(45).fill(0), task)).toEqual([{ action: 'task-status', id: task.id, status: 'review', outcome: 'finished' }]);
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

describe('sending a task to a terminal that waits for an approval', () => {
  it('is refused, so the prompt’s Enter never answers the approval', async () => {
    calls.length = 0;
    const terminal = { id: 'term', status: 'running', runId: crypto.randomUUID(), config: { engine: 'claude', model: '' }, attention: { message: 'Approve Bash', at: new Date().toISOString() } };
    useWorkspaceStore.setState({ sessions: [terminal] as never }); const task = working('term'); listed = [task]; useTaskStore.setState({ tasks: [task] });
    await expect(sendTask(task.id)).rejects.toThrow(/waiting for you/);
    expect(calls.some((call) => call.action === 'task-send')).toBe(false);
  });
});

describe('a hierarchy table’s verdict moves the task it worked on', () => {
  const chain = (task: string) => ({ kind: 'hierarchy' as const, partner: { sessionId: 'r', runId: 'r', engine: 'codex' as const }, driver: 'claude' as const, rounds: 2, round: 0, phase: 'idle' as const, agreed: true,
    chain: { step: 'done' as const, task, plan: 'P', report: 'R', reviewRound: 2, finalRound: 0, verdict: 'approved' as const, note: '' } });
  it('marks the task whose prompt the chain carries, and leaves a task sent after it untouched', async () => {
    calls.length = 0;
    const a = working('hier', { title: 'Fix it', sendId: 't-55555555', sentAt: new Date(Date.now() - 120000).toISOString() });
    const b = working('hier', { title: 'Write the docs', sendId: 't-66666666', sentAt: new Date(Date.now() - 60000).toISOString() });
    useTaskStore.setState({ tasks: [a, b] }); listed = [a, b];
    chainTasks('hier', chain('Task t-55555555: Fix it. Keep it small.'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusCalls()).toEqual([{ action: 'task-status', id: a.id, status: 'review', outcome: 'finished' }]);
  });
  it('marks nothing when the chain carries none of the working tasks, one of them or several', async () => {
    calls.length = 0;
    const a = working('hier2', { title: 'Fix it', sendId: 't-77777777' }); const b = working('hier2', { title: 'Write the docs', sendId: 't-88888888' });
    useTaskStore.setState({ tasks: [a, b] }); listed = [a, b];
    chainTasks('hier2', chain('Something typed at the table'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusCalls()).toEqual([]);
    useTaskStore.setState({ tasks: [a] }); listed = [a];
    chainTasks('hier2', chain('Something typed at the table'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusCalls()).toEqual([]);
  });
  it('leaves the next task alone when the approved chain for the first is published again after it moved to review', async () => {
    calls.length = 0;
    const a = working('hier3', { title: 'Fix it', sendId: 't-bbbbbbb1', sentAt: new Date(Date.now() - 120000).toISOString() });
    const b = working('hier3', { title: 'Write the docs', sendId: 't-bbbbbbb2', sentAt: new Date(Date.now() - 60000).toISOString() });
    const approvedA = chain('Task t-bbbbbbb1: Fix it. Keep it small.');
    useTaskStore.setState({ tasks: [a, b] }); listed = [a, b];
    chainTasks('hier3', approvedA); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusCalls()).toEqual([{ action: 'task-status', id: a.id, status: 'review', outcome: 'finished' }]);
    // A is in review now; B is the only task working. The table publishes A's approved chain again (a restart, say).
    calls.length = 0; const reviewed = { ...a, status: 'review' as const, outcome: 'finished' as const };
    useTaskStore.setState({ tasks: [reviewed, b] }); listed = [reviewed, b];
    chainTasks('hier3', approvedA); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusCalls()).toEqual([]);
  });
});

describe('a terminal whose conversation cannot be read', () => {
  // Reading it fails inside the transcript request (a getter that throws stands in for a failed request).
  const unreadable = () => { transcript = { get messages() { throw new Error('transcript unavailable'); } }; };
  it('leaves its one task unconfirmed, without failing', async () => {
    calls.length = 0; unreadable();
    const task = working('quiet'); useTaskStore.setState({ tasks: [task] }); listed = [task];
    await expect(taskTurnDone('quiet')).resolves.toBeUndefined();
    expect(statusCalls()).toEqual([{ action: 'task-status', id: task.id, status: 'active', outcome: 'unconfirmed' }]);
  });
  it('marks none of several tasks, since which one the turn was about cannot be told', async () => {
    calls.length = 0; unreadable();
    const a = working('quiet2', { title: 'Fix it', sendId: 't-99999999', sentAt: new Date(Date.now() - 120000).toISOString() });
    const b = working('quiet2', { title: 'Write the docs', sendId: 't-aaaaaaa1', sentAt: new Date(Date.now() - 60000).toISOString() });
    useTaskStore.setState({ tasks: [a, b] }); listed = [a, b];
    await taskTurnDone('quiet2'); await taskTurnDone('quiet2', true);
    expect(statusCalls()).toEqual([]);
  });
});

describe('a task waiting at a Round Table', () => {
  it('neither takes the running task’s TASK COMPLETE nor cuts its reply short, though its prompt already shows in the thread', async () => {
    calls.length = 0;
    const instruction = (await import('../../shared/task-signal')).SIGNAL_INSTRUCTION;
    const a = working('table', { title: 'Fix it', sendId: 't-f0000001', sentAt: new Date(Date.now() - 120000).toISOString() });
    const b = working('table', { title: 'Write the docs', sendId: 't-f0000002', sentAt: new Date(Date.now() - 60000).toISOString() });
    useTaskStore.setState({ tasks: [a, b] }); listed = [a, b];
    const promptA = `Task t-f0000001: Fix it. ${instruction}`; const promptB = `Task t-f0000002: Write the docs. ${instruction}`;
    const table = { partner: { sessionId: 'p', runId: 'p', engine: 'codex' }, driver: 'claude', rounds: 2, round: 0, phase: 'answering', agreed: false, waiting: promptB };
    // B was sent while Claude worked on A: shown at once, kept waiting by the table; A's reply finished after it.
    useChatStore.setState({ threads: { table: { runId: 'r', items: [
      { kind: 'user', id: 'u1', order: 1, text: promptA, images: [], at: '' },
      { kind: 'user', id: 'u2', order: 2, text: promptB, images: [], at: '' },
      { kind: 'assistant', id: 'a1', order: 3, blocks: [{ type: 'text', text: 'Fixed it.\nTASK COMPLETE' }], streaming: '' },
    ], results: {}, busy: false, model: null, table } } as never });
    await taskTurnDone('table', false, { chat: 'table' });
    expect(statusCalls()).toEqual([{ action: 'task-status', id: a.id, status: 'review', outcome: 'finished' }]);
    useChatStore.setState({ threads: {} });
  });
});
