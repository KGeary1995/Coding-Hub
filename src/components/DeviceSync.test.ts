import { describe, expect, it } from 'vitest';
import type { LinkedComputer } from '../../shared/remote';
import { outsideSyncFolder } from './DeviceSync';

const computer = (id: string, name: string, extra: Partial<LinkedComputer> = {}): LinkedComputer => ({ id, name, url: `https://${name}.tail.ts.net/`, linked: false, connected: false, error: null, channels: [], ...extra });
const status = { enabled: true, connected: true, lastSync: '2026-11-07T10:00:00.000Z', machine: { id: 'me', name: 'Desk' }, computers: [{ id: 'mac', name: 'MacBook', updatedAt: '2026-11-07T10:00:00.000Z' }] };

describe('computers outside this sync folder', () => {
  it('names computers reachable over Tailscale that never wrote to this sync folder', () => {
    const linked = [computer('mac', 'MacBook', { linked: true }), computer('pc', 'Obsidian-Halo'), computer('phone-only', 'Old', { url: null }), computer('me', 'Desk')];
    expect(outsideSyncFolder(linked, status).map((item) => item.name)).toEqual(['Obsidian-Halo']);
  });
  it('says nothing until sync is on, the folder works and a sync has run', () => {
    const linked = [computer('pc', 'Obsidian-Halo')];
    expect(outsideSyncFolder(linked, { ...status, enabled: false })).toEqual([]);
    expect(outsideSyncFolder(linked, { ...status, connected: false })).toEqual([]);
    expect(outsideSyncFolder(linked, { ...status, lastSync: null })).toEqual([]);
  });
});
