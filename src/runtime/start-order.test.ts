import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types';

const fake = vi.hoisted(() => ({ watchers: new Map<string, (data: string) => void>(), typed: [] as [string, string][], started: [] as string[], fail: new Set<string>() }));
vi.mock('./terminals', () => ({ watchOutput: (id: string, watch: (data: string) => void) => { fake.watchers.set(id, watch); return () => fake.watchers.delete(id); }, writeTerminal: async (id: string, data: string) => { fake.typed.push([id, data]); return true; } }));
vi.mock('./use-native-host', async () => {
  const { useWorkspaceStore } = await import('../state/workspace-store');
  return { startSession: async (id: string) => {
    fake.started.push(id);
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id !== id ? item : fake.fail.has(id) ? { ...item, status: 'failed', error: 'No such program.' } : { ...item, status: 'running', runId: `run-${id}` }) }));
  } };
});
const { createSession, useWorkspaceStore } = await import('../state/workspace-store');
const { cancelStartOrder, startInOrder, useStartOrder } = await import('./start-order');

function workspace(...sessions: Session[]) { useWorkspaceStore.setState({ sessions, tiles: sessions.map((session, i) => ({ sessionId: session.id, x: (i % 2) * 6, y: Math.floor(i / 2) * 10, w: 6, h: 10, minW: 3, minH: 10 })) }); }
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

beforeEach(() => { fake.watchers.clear(); fake.typed = []; fake.started = []; fake.fail.clear(); useStartOrder.setState({ progress: null, notice: null }); });

describe('Start in order', () => {
  it('starts by step, types the shell command, offers the agent its request, and waits for the text', async () => {
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
    expect(sessions.find((item) => item.id === agent.id)?.preparedRequest).toEqual({ prompt: 'Open the app and check the home page.', label: 'Send first request' });
    expect(sessions.find((item) => item.id === other.id)?.status).toBe('idle');
    expect(useStartOrder.getState()).toEqual({ progress: null, notice: null });
  });
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
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id === server.id ? { ...item, status: 'exited' } : item) }));
    await run; expect(useStartOrder.getState().notice).toBe('CH1 stopped before “listening” appeared. The rest were not started.');
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => ({ ...item, status: 'idle', runId: null })) })); fake.started = [];
    run = startInOrder(); await until(() => Boolean(useStartOrder.getState().progress?.waiting));
    cancelStartOrder(); await run;
    expect(fake.started).toEqual([server.id]); expect(useStartOrder.getState().notice).toMatch(/was stopped/);
  });
});
