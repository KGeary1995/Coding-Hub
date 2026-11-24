import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelTools, type ChannelToolsHost } from './channel-tools';
import { inProject, type TaskToolsHost } from './task-tools';
import type { Task } from '../../../shared/workbench';

const tools: ChannelTools[] = [];
afterEach(() => { for (const item of tools.splice(0)) item.close(); });
const RUN = '11111111-1111-4111-8111-111111111111';
const PROJECT = path.resolve('/work/app'); const OTHER = path.resolve('/work/other');
const ID = { mine: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', done: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', other: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const made = (id: string, directory: string, status: Task['status'], notes = ''): Task => ({ id, title: `Task ${id.slice(0, 1)}`, directory, sessionId: null, scope: ['**'], status, notes, verificationId: null, createdAt: '2026-11-24T00:00:00.000Z' });
function setup(options: { channels?: boolean; tasks?: boolean; folder?: string } = {}) {
  const state = { channels: options.channels ?? false, tasks: options.tasks ?? true, changed: 0 };
  let board = [made(ID.mine, PROJECT, 'queued', 'From the person.'), made(ID.done, PROJECT, 'done'), made(ID.other, OTHER, 'queued')];
  const host: ChannelToolsHost = { enabled: () => state.channels, channels: () => [{ channel: 2, sessionId: 'me', name: 'Builder', engine: 'codex', running: true, waiting: null, folder: PROJECT }], sessionOf: (runId) => runId === RUN ? 'me' : null, replies: () => [], send: async () => {} };
  const put = (task: Task) => { board = [...board.filter((item) => item.id !== task.id), task]; return task; };
  const tasks: TaskToolsHost = {
    enabled: () => state.tasks, folderOf: (runId) => runId === RUN ? options.folder ?? path.join(PROJECT, 'src') : null, list: () => board, changed: () => { state.changed++; },
    add: async (fields) => put({ ...made('dddddddd-dddd-4ddd-8ddd-dddddddddddd', fields.directory, 'queued', fields.notes), title: fields.title, ...(fields.details ? { details: fields.details } : {}) }),
    status: async (id, status) => put({ ...board.find((item) => item.id === id)!, status }), notes: (id, notes) => put({ ...board.find((item) => item.id === id)!, notes }),
  };
  const item = new ChannelTools(host); item.tasks = tasks; tools.push(item);
  return { item, state, board: () => board };
}

describe('task tools', () => {
  it('lists only the tasks of the project the channel works in, by status if asked', async () => {
    const { item } = setup();
    const listed = await item.run(RUN, 'task-list', {}) as { tasks: { id: string }[] };
    expect(listed.tasks.map((task) => task.id)).toEqual([ID.mine, ID.done]);
    expect((await item.run(RUN, 'task-list', { status: 'done' }) as { tasks: { id: string }[] }).tasks.map((task) => task.id)).toEqual([ID.done]);
    expect(inProject(PROJECT, PROJECT)).toBe(true); expect(inProject(path.resolve('/work/app-two'), PROJECT)).toBe(false); expect(inProject(path.resolve('/work'), PROJECT)).toBe(false);
  });
  it('adds a task to To do in the caller\'s folder, marked as added by its channel', async () => {
    const { item, state, board } = setup({ folder: PROJECT });
    const { task } = await item.run(RUN, 'task-add', { title: '  Write the tests ', details: 'For the parser.' }) as { task: Task };
    expect(task).toMatchObject({ title: 'Write the tests', details: 'For the parser.', status: 'queued', notes: 'Added by the agent in CH2 (Builder).' });
    expect(board().find((item) => item.id === task.id)?.directory).toBe(PROJECT); expect(state.changed).toBe(1);
  });
  it('moves a task to Working or review with a signed note, but never to Done, and never out of Done', async () => {
    const { item, state, board } = setup();
    const { task } = await item.run(RUN, 'task-update', { id: ID.mine, status: 'review', note: 'Tests pass; check the error text.' }) as { task: Task };
    expect(task).toMatchObject({ status: 'review', notes: 'From the person.\nCH2: Tests pass; check the error text.' }); expect(state.changed).toBe(1);
    await expect(item.run(RUN, 'task-update', { id: ID.mine, status: 'done' })).rejects.toMatchObject({ code: 'TASK_TOOLS_DONE' });
    await expect(item.run(RUN, 'task-update', { id: ID.done, status: 'active' })).rejects.toMatchObject({ code: 'TASK_TOOLS_DONE' });
    expect(board().find((item) => item.id === ID.mine)?.status).toBe('review');
  });
  it('treats another project\'s task as missing, and refuses bad input and full notes', async () => {
    const { item } = setup();
    await expect(item.run(RUN, 'task-update', { id: ID.other, note: 'x' })).rejects.toMatchObject({ code: 'TASK_TOOLS_MISSING' });
    await expect(item.run(RUN, 'task-update', { id: ID.mine })).rejects.toThrow(/status, a note, or both/);
    await expect(item.run(RUN, 'task-update', { id: ID.mine, status: 'queued' })).rejects.toThrow();
    await expect(item.run(RUN, 'task-update', { id: ID.mine, title: 'Renamed' })).rejects.toThrow();
    await expect(item.run(RUN, 'task-add', { title: 'x'.repeat(151) })).rejects.toThrow();
    await expect(item.run(RUN, 'task-add', { title: '' })).rejects.toThrow();
    for (let i = 0; i < 2; i++) await item.run(RUN, 'task-update', { id: ID.mine, note: 'n'.repeat(900) });
    await expect(item.run(RUN, 'task-update', { id: ID.mine, note: 'n'.repeat(300) })).rejects.toMatchObject({ code: 'TASK_TOOLS_NOTES_FULL' });
  });
  it('answers only while its own setting is on, and says which tools to list', async () => {
    const { item, state } = setup(); await item.start();
    const url = item.register(RUN)!; expect(url).toBeTruthy();
    const post = (route: string, body: unknown = {}) => fetch(`${url}/${route}`, { method: 'POST', body: JSON.stringify(body) });
    expect(await (await post('tools')).json()).toEqual({ channels: false, tasks: true });
    expect((await post('task-list')).status).toBe(200);
    // Channel tools stay off while only the task tools are on.
    expect((await post('list')).status).toBe(409);
    const bad = await post('task-update', { id: 'nope' }); expect(bad.status).toBe(400); expect((await bad.json() as { error: string }).error).toMatch(/^Invalid request: id/);
    state.tasks = false; const refused = await post('task-list'); expect(refused.status).toBe(409); expect((await refused.json() as { error: string }).error).toMatch(/Task tools are off/);
    expect(item.register('22222222-2222-4222-8222-222222222222')).toBeNull();
    state.channels = true; expect(await (await post('tools')).json()).toEqual({ channels: true, tasks: false });
  });
});
