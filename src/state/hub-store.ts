import { create } from 'zustand';
import type { UsageRecord, HubPreferences, HubRequest, HubResponse } from '../../shared/hub';
import { DEFAULT_PREFERENCES, newTokens } from '../../shared/hub';
export const useHubStore = create<{ usage: UsageRecord[]; preferences: HubPreferences; setUsage: (usage: UsageRecord[]) => void; upsert: (usage: UsageRecord) => void; setPreferences: (preferences: HubPreferences) => void }>((set) => ({
  usage: [], preferences: DEFAULT_PREFERENCES,
  setUsage: (usage) => set({ usage }), upsert: (usage) => set((state) => ({ usage: [usage, ...state.usage.filter((s) => s.runId !== usage.runId)] })), setPreferences: (preferences) => set({ preferences }),
}));
export async function hubCall<T extends HubResponse>(request: HubRequest): Promise<T> {
  if (!window.codingHub) throw new Error('This feature requires the desktop host.');
  const result = await window.codingHub.hub(request); if (!result.ok) throw new Error(result.error.message); return result.value as T;
}
/** New tokens (see newTokens in shared/hub): input outside the cache, plus output. */
export const tokens = (u: UsageRecord) => newTokens(u);
export const formatNumber = (n: number) => new Intl.NumberFormat(undefined, { notation: n > 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
export const dollars = (cost: number | null) => cost === null ? '—' : '$' + cost.toFixed(cost < 0.01 ? 4 : 2);
