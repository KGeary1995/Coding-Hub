import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../shared/workbench';
import { MAX_CHANNELS } from '../../shared/schemas';
import { arrangeTiles, createSession, useWorkspaceStore } from '../state/workspace-store';
import { useTaskStore } from '../state/task-store';
import { scheduledRun } from './scheduled-run';
import { useAgentStore } from '../state/agent-store';
import { agentLook } from '../../shared/agent-look';

const typed: { id: string; data: string }[] = [];
// A terminal's screen needs a DOM: what is typed into one is recorded instead, and its output stays quiet.
vi.mock('./terminals', () => ({ focusTerminal: () => {}, routeTerminalEvent: () => {}, terminalDimensions: () => ({ cols: 100, rows: 24 }), releaseRemovedTerminals: () => {}, watchOutput: () => () => {}, writeTerminal: async (id: string, data: string) => { typed.push({ id, data }); return true; }, submitTerminal: async (id: string, text: string) => { typed.push({ id, data: text + '\r' }); return true; } }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); typed.length = 0; useTaskStore.setState({ tasks: [] }); });

const TASK = '33333333-3333-4333-8333-333333333333'; const CHANNEL = '44444444-4444-4444-8444-444444444444';
const find = (id: string) => useWorkspaceStore.getState().sessions.find((session) => session.id === id);
/** A desktop host that starts and stops runs at once, with one queued task, and records the workbench requests. */
function host() {
  const requests: { action: string }[] = []; let next = 0;
  const task: Task = { id: TASK, title: 'Review the code for bugs', details: 'Review the code for bugs.', directory: '/project', sessionId: CHANNEL, scope: ['**'], status: 'queued', notes: '', verificationId: null, createdAt: new Date().toISOString() };
  const codingHub = {
    startSession: vi.fn(async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => ({ ok: true, value: { sessionId, runId: `0000000${next++}-1111-4111-8111-111111111111`, pid: 10, cwd, engine: find(sessionId)!.config.engine } })),
    stopSession: vi.fn(async ({ sessionId, runId }: { sessionId: string; runId: string }) => { setTimeout(() => useWorkspaceStore.getState().applyEvent({ type: 'exit', sessionId, runId, exitCode: 0 }), 5); return { ok: true, value: null }; }),
    workbench: vi.fn(async (request: { action: string }) => { requests.push(request); if (request.action === 'task-list') return { ok: true, value: [task] }; if (request.action === 'task-send') { task.status = 'active'; return { ok: true, value: { task, prompt: 'Task t-0000aaaa: Review the code for bugs. Review the code for bugs.' } }; } return { ok: true, value: task }; }),
  };
  vi.stubGlobal('window', { codingHub }); vi.stubGlobal('document', { querySelector: () => null }); vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
  const first = createSession('shell'); useWorkspaceStore.setState({ persistenceReady: true, rootDirectory: '/project', sessions: [first], tiles: arrangeTiles([first], 'grid'), layoutMode: 'grid' });
  return { codingHub, requests, task, first };
}
const request = (engine: 'claude' | 'codex' | 'gemini', replace?: string) => ({ requestId: 'r1', taskId: TASK, sessionId: CHANNEL, engine, directory: '/repos/app', title: 'Review the code for bugs', ...(replace ? { replace } : {}) });

describe('a scheduled run in the window', () => {
  it('opens a chat channel for Claude Code or Codex in the job’s folder, with the run’s id, and starts it', async () => {
    host(); expect(await scheduledRun(request('codex'))).toBeUndefined();
    expect(find(CHANNEL)).toMatchObject({ title: 'Review the code for bugs', status: 'running', binding: { mode: 'independent', cwd: '/repos/app' }, config: { engine: 'codex', chat: true } });
    expect(useWorkspaceStore.getState().tiles.some((tile) => tile.sessionId === CHANNEL)).toBe(true);
  });
  it('opens Gemini in a terminal, and types its task once the agent has gone quiet', async () => {
    vi.useFakeTimers(); const { requests, task } = host();
    expect(await scheduledRun(request('gemini'))).toBeUndefined();
    const session = find(CHANNEL)!; expect(session.config).toEqual({ engine: 'gemini', model: '' }); expect(session.status).toBe('running');
    // The window sends it by itself (deliver), after 3 s of quiet output.
    await vi.advanceTimersByTimeAsync(2000); expect(typed).toEqual([]); await vi.advanceTimersByTimeAsync(1500);
    expect(requests.map((item) => item.action)).toContain('task-send');
    expect(typed).toEqual([{ id: CHANNEL, data: 'Task t-0000aaaa: Review the code for bugs. Review the code for bugs.\r' }]); expect(task.status).toBe('active');
  });
  it('starts a custom agent with its task as arguments when its definition takes them, and types nothing', async () => {
    vi.useFakeTimers(); const { codingHub, requests } = host();
    useAgentStore.setState({ agents: [{ id: 'aider', look: agentLook({ id: 'aider', name: 'Aider' }), definition: { schema: 1, id: 'aider', name: 'Aider', program: { command: 'aider' }, firstRequest: { args: ['--message', '{prompt}'] } }, active: true, program: 'aider', problem: null }], loaded: true });
    codingHub.startSession.mockImplementation(async (start: { sessionId: string; cwd: string; firstRequest?: string }) => ({ ok: true, value: { sessionId: start.sessionId, runId: '00000009-1111-4111-8111-111111111111', pid: 10, cwd: start.cwd, engine: 'custom', ...(start.firstRequest ? { prompted: true } : {}) } }) as never);
    expect(await scheduledRun({ ...request('gemini'), engine: 'custom', agent: 'aider' })).toBeUndefined();
    expect(codingHub.startSession.mock.calls[0][0]).toMatchObject({ firstRequest: 'Task t-0000aaaa: Review the code for bugs. Review the code for bugs.' });
    expect(requests.filter((item) => item.action === 'task-send')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000); expect(typed).toEqual([]);
    useAgentStore.setState({ agents: [] });
  });
  it('with every channel taken, says so and adds nothing', async () => {
    host(); const sessions = Array.from({ length: MAX_CHANNELS }, () => createSession('shell')); useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'grid') });
    expect(await scheduledRun(request('claude'))).toBe("This computer already has 8 channels. Close one there first."); expect(find(CHANNEL)).toBeUndefined();
  });
  it('closes the job’s previous channel first, which frees its place', async () => {
    const { codingHub } = host(); const sessions = Array.from({ length: MAX_CHANNELS }, () => createSession('shell')); useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'grid') });
    const previous = sessions[3]; expect(await scheduledRun(request('claude', previous.id))).toBeUndefined();
    expect(find(previous.id)).toBeUndefined(); expect(find(CHANNEL)?.status).toBe('running'); expect(codingHub.startSession).toHaveBeenCalledTimes(1);
  });
  it('refuses until the workspace has loaded', async () => {
    host(); useWorkspaceStore.setState({ persistenceReady: false });
    expect(await scheduledRun(request('claude'))).toBe('Trace was still opening its workspace.');
  });
});

describe('a schedule in words', () => {
  it('says each kind plainly', async () => {
    const { describeSchedule } = await import('../components/ScheduledJobsCard');
    expect(describeSchedule({ kind: 'daily', time: '08:00' })).toBe('Every day at 08:00');
    expect(describeSchedule({ kind: 'weekdays', time: '09:30', days: [5, 1, 3] })).toBe('Mon, Wed and Fri at 09:30');
    expect(describeSchedule({ kind: 'hours', every: 6, time: '08:15' })).toBe('Every 6 hours (02:15, 08:15, 14:15, 20:15)');
    expect(describeSchedule({ kind: 'hours', every: 1, time: '00:30' })).toBe('Every hour at :30');
  });
});
