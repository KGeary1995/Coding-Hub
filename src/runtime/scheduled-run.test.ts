import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../shared/workbench';
import { MAX_CHANNELS } from '../../shared/schemas';
import { arrangeTiles, createSession, useWorkspaceStore } from '../state/workspace-store';
import { loadTasks, sendTask, useTaskStore } from '../state/task-store';
import { scheduledRun, sendPreparedTask } from './scheduled-run';
import { READY_LIMIT_MS } from './start-order';
import { useAgentStore } from '../state/agent-store';
import { agentLook } from '../../shared/agent-look';

const typed: { id: string; data: string }[] = []; const terminal = { refuses: false };
// A terminal's screen needs a DOM: what is typed into one is recorded instead, and its output stays quiet.
vi.mock('./terminals', () => ({ focusTerminal: () => {}, routeTerminalEvent: () => {}, terminalDimensions: () => ({ cols: 100, rows: 24 }), releaseRemovedTerminals: () => {}, watchOutput: () => () => {}, writeTerminal: async (id: string, data: string) => { typed.push({ id, data }); return true; }, submitTerminal: async (id: string, text: string) => { if (terminal.refuses) return false; typed.push({ id, data: text + '\r' }); return true; } }));
afterEach(() => { terminal.refuses = false; vi.useRealTimers(); vi.unstubAllGlobals(); typed.length = 0; useTaskStore.setState({ tasks: [] }); });

const TASK = '33333333-3333-4333-8333-333333333333'; const CHANNEL = '44444444-4444-4444-8444-444444444444';
const find = (id: string) => useWorkspaceStore.getState().sessions.find((session) => session.id === id);
/** A desktop host that starts and stops runs at once, with one queued task, and records the workbench requests. */
function host() {
  const requests: { action: string }[] = []; let next = 0; let sends = 0;
  const task: Task = { id: TASK, title: 'Review the code for bugs', details: 'Review the code for bugs.', directory: '/project', sessionId: CHANNEL, scope: ['**'], status: 'queued', notes: '', verificationId: null, createdAt: new Date().toISOString() };
  const codingHub = {
    startSession: vi.fn(async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => ({ ok: true, value: { sessionId, runId: `0000000${next++}-1111-4111-8111-111111111111`, pid: 10, cwd, engine: find(sessionId)!.config.engine } })),
    stopSession: vi.fn(async ({ sessionId, runId }: { sessionId: string; runId: string }) => { setTimeout(() => useWorkspaceStore.getState().applyEvent({ type: 'exit', sessionId, runId, exitCode: 0 }), 5); return { ok: true, value: null }; }),
    workbench: vi.fn(async (request: { action: string; status?: Task['status'] }) => { requests.push(request); if (request.action === 'task-list') return { ok: true, value: [task] }; if (request.action === 'task-status') { task.status = request.status!; if (task.status === 'queued') delete task.sendId; return { ok: true, value: task }; } if (request.action === 'task-send') { task.status = 'active'; task.sendId = `t-0000000${sends++}`; return { ok: true, value: { task, prompt: 'Task t-0000aaaa: Review the code for bugs. Review the code for bugs.' } }; } return { ok: true, value: task }; }),
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
  it('offers the task on its channel when the agent was not ready, and sends it as the task (marked sent) when pressed', async () => {
    vi.useFakeTimers(); const { requests, task } = host();
    expect(await scheduledRun(request('gemini'))).toBeUndefined();
    // A trust question the person has not answered: nothing is typed while it shows, and after 2 minutes the task is offered.
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, attention: { message: 'Trust this folder?', at: new Date().toISOString() } } : item) }));
    await vi.advanceTimersByTimeAsync(READY_LIMIT_MS + 1000);
    expect(typed).toEqual([]); expect(task.status).toBe('queued'); expect(find(CHANNEL)?.preparedRequest).toEqual({ prompt: 'Review the code for bugs.', label: 'Send first request', taskId: TASK });
    // Pressed while the question still shows: nothing is typed into it, and the task stays in To do.
    expect(await sendPreparedTask(TASK, CHANNEL)).toBe('That channel is waiting for you. Answer what it asks first, then send the task.');
    expect(typed).toEqual([]); expect(task.status).toBe('queued'); expect(find(CHANNEL)?.error).toBe('That channel is waiting for you. Answer what it asks first, then send the task.');
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, attention: null } : item) }));
    // The board could not be read: the offer stays for another try.
    const { codingHub } = window as unknown as { codingHub: { workbench: ReturnType<typeof vi.fn> } }; const real = codingHub.workbench.getMockImplementation()!;
    codingHub.workbench.mockImplementationOnce(async () => ({ ok: false, error: { code: 'HOST_ERROR', message: 'Unavailable.' } }));
    expect(await sendPreparedTask(TASK, CHANNEL)).toBe('Trace could not read the Tasks board. Try again.'); expect(find(CHANNEL)?.preparedRequest?.taskId).toBe(TASK);
    codingHub.workbench.mockImplementation(real);
    // Sent: the reason it showed goes with it.
    expect(await sendPreparedTask(TASK, CHANNEL)).toBeNull(); expect(find(CHANNEL)?.error).toBeNull();
    expect(requests.filter((item) => item.action === 'task-send')).toHaveLength(1); expect(task.status).toBe('active');
    expect(typed).toEqual([{ id: CHANNEL, data: 'Task t-0000aaaa: Review the code for bugs. Review the code for bugs.\r' }]);
  });
  it('puts a task marked sent at the start but never typed back in To do, unless it was sent again meanwhile', async () => {
    vi.useFakeTimers(); const { codingHub, task } = host();
    useAgentStore.setState({ agents: [{ id: 'aider', look: agentLook({ id: 'aider', name: 'Aider' }), definition: { schema: 1, id: 'aider', name: 'Aider', program: { command: 'aider' }, firstRequest: { args: ['--message', '{prompt}'] } }, active: true, program: 'aider', problem: null }], loaded: true });
    const waiting = () => useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, attention: { message: 'Trust this folder?', at: new Date().toISOString() } } : item) }));
    // The host did not take the prompt as arguments (too long, say): the window is to type it, but a question shows.
    expect(await scheduledRun({ ...request('gemini'), engine: 'custom', agent: 'aider' })).toBeUndefined(); waiting();
    expect(task.status).toBe('active'); await vi.advanceTimersByTimeAsync(READY_LIMIT_MS + 1000); expect(task.status).toBe('queued');
    // Sent again from the board while it waited: left as sent, and not offered.
    useWorkspaceStore.setState({ sessions: useWorkspaceStore.getState().sessions.filter((item) => item.id !== CHANNEL) });
    expect(await scheduledRun({ ...request('gemini'), engine: 'custom', agent: 'aider' })).toBeUndefined(); waiting();
    await vi.advanceTimersByTimeAsync(1000); task.sendId = 't-0000beef'; await vi.advanceTimersByTimeAsync(READY_LIMIT_MS); expect(task.status).toBe('active'); expect(find(CHANNEL)?.preparedRequest).toBeUndefined();
    // Its channel did not take the typing: back in To do, and offered with a note.
    useWorkspaceStore.setState({ sessions: useWorkspaceStore.getState().sessions.filter((item) => item.id !== CHANNEL) }); terminal.refuses = true; task.notes = '';
    expect(await scheduledRun({ ...request('gemini'), engine: 'custom', agent: 'aider' })).toBeUndefined(); await vi.advanceTimersByTimeAsync(5000);
    expect(task.status).toBe('queued'); expect(find(CHANNEL)?.preparedRequest?.taskId).toBe(TASK); expect(codingHub.workbench.mock.calls.some(([item]) => (item as { action: string }).action === 'task-save')).toBe(true);
    useAgentStore.setState({ agents: [] });
  });
  it('sends a task put back in To do while it waited as the task anew, and leaves one given to another channel in To do', async () => {
    vi.useFakeTimers(); const { requests, task } = host();
    useAgentStore.setState({ agents: [{ id: 'aider', look: agentLook({ id: 'aider', name: 'Aider' }), definition: { schema: 1, id: 'aider', name: 'Aider', program: { command: 'aider' }, firstRequest: { args: ['--message', '{prompt}'] } }, active: true, program: 'aider', problem: null }], loaded: true });
    const asking = (on: boolean) => useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, attention: on ? { message: 'Trust this folder?', at: new Date().toISOString() } : null } : item) }));
    expect(await scheduledRun({ ...request('gemini'), engine: 'custom', agent: 'aider' })).toBeUndefined(); asking(true);
    // Dragged back to To do on the board meanwhile (its mark goes), then the agent is ready: it is marked sent again.
    await vi.advanceTimersByTimeAsync(1000); task.status = 'queued'; delete task.sendId; asking(false); await vi.advanceTimersByTimeAsync(12_000);
    expect(requests.filter((item) => item.action === 'task-send')).toHaveLength(2); expect(task.status).toBe('active'); expect(typed).toHaveLength(1);
    // Another run, whose task is given to another channel while it waits: not typed here, and back in To do, not left Working.
    useWorkspaceStore.setState({ sessions: useWorkspaceStore.getState().sessions.filter((item) => item.id !== CHANNEL) }); task.status = 'queued'; delete task.sendId; typed.length = 0;
    expect(await scheduledRun({ ...request('gemini'), engine: 'custom', agent: 'aider' })).toBeUndefined(); asking(true);
    await vi.advanceTimersByTimeAsync(1000); task.sessionId = '55555555-5555-4555-8555-555555555555'; asking(false); await vi.advanceTimersByTimeAsync(12_000);
    expect(typed).toEqual([]); expect(task.status).toBe('queued'); expect(find(CHANNEL)?.preparedRequest).toBeUndefined();
    useAgentStore.setState({ agents: [] });
  });
  it('takes the offer away once the task is sent from the Tasks board, so it is not sent twice', async () => {
    const { task } = host(); expect(await scheduledRun(request('gemini'))).toBeUndefined();
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, preparedRequest: { prompt: 'Review the code for bugs.', label: 'Send first request', taskId: TASK } } : item) }));
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, attention: { message: 'Trust this folder?', at: new Date().toISOString() } } : item) }));
    expect(await sendPreparedTask(TASK, CHANNEL)).toMatch(/waiting for you/); expect(find(CHANNEL)?.error).toMatch(/waiting for you/);
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, attention: null } : item) }));
    await loadTasks(); await sendTask(TASK); expect(task.status).toBe('active'); expect(find(CHANNEL)?.preparedRequest).toBeUndefined(); expect(find(CHANNEL)?.error).toBeNull();
  });
  it('neither types nor offers again a task sent from the Tasks board while it waited', async () => {
    vi.useFakeTimers(); const { requests } = host(); expect(await scheduledRun(request('gemini'))).toBeUndefined();
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, attention: { message: 'Trust this folder?', at: new Date().toISOString() } } : item) }));
    await vi.advanceTimersByTimeAsync(1000);
    // The person answers the question and presses Send on the board; the agent then goes quiet.
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, attention: null } : item) }));
    await loadTasks(); await sendTask(TASK); await vi.advanceTimersByTimeAsync(READY_LIMIT_MS);
    expect(requests.filter((item) => item.action === 'task-send')).toHaveLength(1); expect(typed).toHaveLength(1); expect(find(CHANNEL)?.preparedRequest).toBeUndefined();
  });
  it('drops an offer whose task was finished or removed, and sends nothing', async () => {
    const { requests, task } = host(); expect(await scheduledRun(request('gemini'))).toBeUndefined();
    const offer = () => useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === CHANNEL ? { ...item, preparedRequest: { prompt: 'Review the code for bugs.', label: 'Send first request', taskId: TASK } } : item) }));
    vi.useFakeTimers(); offer(); task.status = 'done'; expect(await sendPreparedTask(TASK, CHANNEL)).toBe('That task was already done.'); expect(find(CHANNEL)?.preparedRequest).toBeUndefined();
    // Its button went with it, so the reason goes by itself.
    expect(find(CHANNEL)?.error).toBe('That task was already done.'); await vi.advanceTimersByTimeAsync(10_000); expect(find(CHANNEL)?.error).toBeNull();
    offer(); requests.length = 0; const { codingHub } = { codingHub: (window as unknown as { codingHub: { workbench: ReturnType<typeof vi.fn> } }).codingHub };
    codingHub.workbench.mockImplementation(async (item: { action: string }) => { requests.push(item); return { ok: true, value: [] }; });
    expect(await sendPreparedTask(TASK, CHANNEL)).toBe('That task is no longer on the Tasks board.'); expect(find(CHANNEL)?.preparedRequest).toBeUndefined();
    expect(requests.map((item) => item.action)).not.toContain('task-send'); expect(typed).toEqual([]);
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
