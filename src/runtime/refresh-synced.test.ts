import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type HubRequest, type UsageRecord } from '../../shared/hub';
import { useHubStore } from '../state/hub-store';
import { refreshSynced } from './use-native-host';

const record = (runId: string, patch: Partial<UsageRecord> = {}): UsageRecord => ({ runId, sessionId: 's', engine: 'claude', model: 'm', cwd: '/p', timestamp: new Date().toISOString(), input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: null, context: null, cost: null, ...patch });
const host = globalThis as unknown as { window?: unknown };
afterEach(() => { delete host.window; useHubStore.setState({ usage: [], preferences: DEFAULT_PREFERENCES }); });

describe('refreshing after a device sync', () => {
  it('takes recalculated costs and other computers’ runs, keeps live updates made meanwhile, and drops vanished remote runs', async () => {
    const prices = [{ model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }];
    useHubStore.setState({ usage: [record('done'), record('running', { output: 5 }), record('gone', { machine: 'laptop' })], preferences: DEFAULT_PREFERENCES });
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    host.window = { codingHub: { hub: async (request: HubRequest) => {
      if (request.action === 'preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, prices } };
      await pending;
      return { ok: true, value: [record('done', { cost: 0.5 }), record('running', { output: 5, cost: 0.1 }), record('remote', { machine: 'laptop' })] };
    } } };
    const refresh = refreshSynced();
    // A live update for the running session arrives while the request is out.
    useHubStore.getState().upsert(record('running', { output: 9 })); release(); await refresh;
    const usage = useHubStore.getState().usage; const byRun = new Map(usage.map((item) => [item.runId, item]));
    expect(byRun.get('done')?.cost).toBe(0.5); expect(byRun.get('running')?.output).toBe(9); expect(byRun.has('remote')).toBe(true); expect(byRun.has('gone')).toBe(false);
    expect(useHubStore.getState().preferences.prices).toEqual(prices);
  });
});
