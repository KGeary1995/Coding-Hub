import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../shared/workbench';

const saved: Record<string, unknown>[] = []; const sent: string[] = []; let startOk = true;
vi.mock('./use-native-host', () => ({ startSession: vi.fn(async (id: string) => { const { useWorkspaceStore } = await import('../state/workspace-store'); useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, status: startOk ? 'running' : 'error', error: startOk ? null : 'Apply shared rules first.', runId: crypto.randomUUID() } : session) })); }) }));
vi.mock('../state/task-store', async () => { const { create } = await import('zustand'); return { useTaskStore: create(() => ({ tasks: [] as Task[] })), saveTask: vi.fn(async (task: Record<string, unknown>) => { saved.push(task); return task; }), sendTask: vi.fn(async (id: string) => { sent.push(id); }) }; });

const { startTaskInWorktree } = await import('./task-worktree');
const { useTaskStore } = await import('../state/task-store');
const { useWorkspaceStore, createSession } = await import('../state/workspace-store');
const task: Task = { id: crypto.randomUUID(), title: 'Fix it', directory: '/project', sessionId: null, scope: ['**'], status: 'queued', notes: '', verificationId: null, createdAt: new Date().toISOString() };
const tree = { id: crypto.randomUUID(), repository: '/project', directory: '/worktrees/abc', branch: 'coding-hub/abc', createdAt: new Date().toISOString() };

describe('starting a task in its own worktree', () => {
  beforeEach(() => {
    saved.length = 0; sent.length = 0; startOk = true;
    useTaskStore.setState({ tasks: [task] }); const first = createSession('claude');
    useWorkspaceStore.setState({ sessions: [first], tiles: [{ i: first.id, x: 0, y: 0, w: 6, h: 6 }] } as never);
    (globalThis as { window?: unknown }).window = { codingHub: { projectTools: vi.fn(async () => ({ ok: true, value: tree })) } };
  });
  it('creates the worktree, adds a chat channel there, moves the task to it and sends it', async () => {
    await expect(startTaskInWorktree(task.id, 'codex')).resolves.toEqual(tree);
    const channel = useWorkspaceStore.getState().sessions.at(-1)!;
    expect(channel.config).toMatchObject({ engine: 'codex', chat: true }); expect(channel.binding).toEqual({ mode: 'independent', cwd: tree.directory });
    expect(saved[0]).toMatchObject({ id: task.id, sessionId: channel.id, directory: tree.directory }); expect(sent).toEqual([task.id]);
  });
  it('says where it stopped when the channel does not start, and does not send', async () => {
    startOk = false;
    await expect(startTaskInWorktree(task.id, 'claude')).rejects.toThrow(/coding-hub\/abc and its channel are ready, but the channel did not start: Apply shared rules first/); expect(sent).toEqual([]);
  });
});
