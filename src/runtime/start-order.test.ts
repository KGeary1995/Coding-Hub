import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types';

const fake = vi.hoisted(() => ({ watchers: new Map<string, (data: string) => void>(), typed: [] as [string, string][], started: [] as string[], fail: new Set<string>(), asked: [] as (string | undefined)[], prompted: false }));
vi.mock('./terminals', () => ({ watchOutput: (id: string, watch: (data: string) => void) => { fake.watchers.set(id, watch); return () => fake.watchers.delete(id); }, writeTerminal: async (id: string, data: string) => { fake.typed.push([id, data]); return true; },
  // A request and its Enter (sent on its own by the real one) are recorded as one, as these tests read them.
  submitTerminal: async (id: string, text: string) => { fake.typed.push([id, text + '\r']); return true; } }));
vi.mock('./use-native-host', async () => {
  const { useWorkspaceStore } = await import('../state/workspace-store');
  return { startSession: async (id: string, options: { firstRequest?: string } = {}) => {
    fake.started.push(id); fake.asked.push(options.firstRequest);
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id !== id ? item : fake.fail.has(id) ? { ...item, status: 'error' as const, error: 'No such program.' } : { ...item, status: 'running' as const, runId: `run-${id}` }) }));
    return fake.prompted && Boolean(options.firstRequest);
  } };
});
const { createSession, useWorkspaceStore } = await import('../state/workspace-store');
const { cancelStartOrder, startInOrder, useStartOrder } = await import('./start-order');

function workspace(...sessions: Session[]) { useWorkspaceStore.setState({ sessions, tiles: sessions.map((session, i) => ({ sessionId: session.id, x: (i % 2) * 6, y: Math.floor(i / 2) * 10, w: 6, h: 10, minW: 3, minH: 10 })) }); }
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

beforeEach(() => { fake.watchers.clear(); fake.typed = []; fake.started = []; fake.fail.clear(); fake.asked = []; fake.prompted = false; useStartOrder.setState({ progress: null, notice: null }); });

describe('Start in order', () => {
  it('starts by step, types the shell command, waits for the text, and sends the agent its request', async () => {
    const server = { ...createSession('shell'), startup: { order: 1, command: 'npm run dev', waitFor: 'ready' } };
    const agent = { ...createSession('claude'), startup: { order: 2, prompt: 'Open the app and check the home page.' } };
    const other = createSession('codex');
    workspace(agent, other, server);
    const run = startInOrder();
    await until(() => Boolean(useStartOrder.getState().progress?.waiting));
    expect(fake.started).toEqual([server.id]); expect(fake.typed).toEqual([[server.id, 'npm run dev\r']]);
    fake.watchers.get(server.id)!('\x1b[32mVITE\x1b[0m Rea'); fake.watchers.get(server.id)!('dy in 300 ms');
    await run;
    expect(fake.started).toEqual([server.id, agent.id]);
    const sessions = useWorkspaceStore.getState().sessions;
    // The agent's first request goes once its output has been quiet (READY_QUIET_MS; this fake agent writes nothing).
    for (let i = 0; i < 100 && fake.typed.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.typed[1]).toEqual([agent.id, `Open the app and check the home page.${'\r'}`]);
    expect(sessions.find((item) => item.id === other.id)?.status).toBe('idle');
    expect(useStartOrder.getState()).toEqual({ progress: null, notice: null });
  }, 10_000);
  it('stops, saying why, when a channel does not start', async () => {
    const first = { ...createSession('shell'), startup: { order: 1 } }; const second = { ...createSession('shell'), startup: { order: 2 } };
    workspace(first, second); fake.fail.add(first.id);
    await startInOrder();
    expect(fake.started).toEqual([first.id]); expect(useStartOrder.getState().notice).toBe('CH1 did not start: No such program. The rest were not started.');
  });
  it('stops when the channel waited for stops, and Stop ends the wait', async () => {
    const server = { ...createSession('shell'), startup: { order: 1, waitFor: 'listening' } }; const next = { ...createSession('shell'), startup: { order: 2 } };
    workspace(server, next);
    let run = startInOrder(); await until(() => Boolean(useStartOrder.getState().progress?.waiting));
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === server.id ? { ...item, status: 'exited' as const } : item) }));
    await run; expect(useStartOrder.getState().notice).toBe('CH1 stopped before “listening” appeared. The rest were not started.');
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => ({ ...item, status: 'idle' as const, runId: null })) })); fake.started = [];
    run = startInOrder(); await until(() => Boolean(useStartOrder.getState().progress?.waiting));
    cancelStartOrder(); await run;
    expect(fake.started).toEqual([server.id]); expect(useStartOrder.getState().notice).toMatch(/was stopped/);
  });
});

describe('the first request', () => {
  it('goes to a terminal agent once its output has been quiet, and to the tile if never ready', async () => {
    vi.useFakeTimers();
    try {
      const { sendWhenReady, READY_QUIET_MS, READY_LIMIT_MS } = await import('./start-order');
      const agent = { ...createSession('claude'), status: 'running' as const, runId: 'r1' }; workspace(agent);
      const sent = sendWhenReady(agent.id, 'Check the build.');
      fake.watchers.get(agent.id)!('Do you trust the files in this folder?');
      useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => ({ ...item, attention: { message: 'Trust?', at: '' } })) }));
      await vi.advanceTimersByTimeAsync(READY_QUIET_MS * 2); expect(fake.typed).toEqual([]);
      useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => ({ ...item, attention: null })) }));
      await vi.advanceTimersByTimeAsync(READY_QUIET_MS + 500); await sent;
      expect(fake.typed).toEqual([[agent.id, 'Check the build.\r']]);
      fake.typed = [];
      const busy = { ...createSession('codex'), status: 'running' as const, runId: 'r2', attention: { message: 'Approve?', at: '' } }; workspace(busy);
      const offered = sendWhenReady(busy.id, 'Hello'); await vi.advanceTimersByTimeAsync(READY_LIMIT_MS + 1000); await offered;
      expect(fake.typed).toEqual([]); expect(useWorkspaceStore.getState().sessions[0].preparedRequest).toEqual({ prompt: 'Hello', label: 'Send first request' });
    } finally { vi.useRealTimers(); }
  });
  it('goes to a custom agent at its start when its definition takes it as arguments, and is not typed again', async () => {
    vi.useFakeTimers();
    try {
      const { READY_QUIET_MS } = await import('./start-order');
      const custom = { ...createSession('custom', undefined, { id: 'aider', name: 'Aider' }), startup: { order: 1, prompt: 'Fix the build.' } };
      const claude = { ...createSession('claude'), startup: { order: 2, prompt: 'Review it.' } };
      workspace(custom, claude); fake.prompted = true;
      await startInOrder(); await vi.advanceTimersByTimeAsync(READY_QUIET_MS + 1000);
      // Only the custom agent is asked to take it at start; Claude Code's is typed as before.
      expect(fake.asked).toEqual(['Fix the build.', undefined]); expect(fake.typed).toEqual([[claude.id, 'Review it.' + String.fromCharCode(13)]]);
    } finally { vi.useRealTimers(); }
  });
});
