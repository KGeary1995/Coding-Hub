import { describe, expect, it } from 'vitest';
import type { LinkedComputer, RemoteChannel } from '../../../shared/remote';
import { LinkedAlerts, type LinkedAlert } from './linked-alerts';

const channel = (state: Partial<RemoteChannel>): RemoteChannel => ({ sessionId: 's1', channel: 2, title: 'Claude', engine: 'claude', runId: 'r1', running: true, attention: null, cols: null, rows: null, ...state });
const mac = (channels: RemoteChannel[], connected = true): LinkedComputer => ({ id: 'mac', name: 'MacBook', url: null, linked: true, connected, error: null, channels });

describe('alerts for linked computers\' channels', () => {
  it('tell once when a channel starts waiting or fails, not what was already so when the computer was first seen', () => {
    const alerts: LinkedAlert[] = []; const linked = new LinkedAlerts((alert) => alerts.push(alert));
    linked.update([mac([channel({ attention: 'Allow Bash?' })])]); expect(alerts).toEqual([]);
    linked.update([mac([channel({})])]); linked.update([mac([channel({ attention: 'Allow Edit?' })])]);
    expect(alerts).toEqual([{ id: 'mac', title: 'MacBook · CH2 needs you', body: 'Allow Edit?' }]);
    linked.update([mac([channel({ attention: 'Allow Edit?' })])]); expect(alerts).toHaveLength(1);
    linked.update([mac([channel({ running: false, runId: null, failed: 'Claude Code exited with code 1' })])]);
    expect(alerts.at(-1)).toEqual({ id: 'mac', title: 'MacBook · CH2 stopped with an error', body: 'Claude Code exited with code 1' });
  });
  it('stay quiet while a computer is offline, and after it reconnects with the same state', () => {
    const alerts: LinkedAlert[] = []; const linked = new LinkedAlerts((alert) => alerts.push(alert));
    linked.update([mac([], false)]); linked.update([mac([channel({ attention: 'Allow?' })])]); expect(alerts).toEqual([]);
    linked.update([mac([channel({ attention: 'Allow?' })], false)]); linked.update([mac([channel({ attention: 'Allow?' })])]); expect(alerts).toEqual([]);
  });
});
