import { create } from 'zustand';
import type { UsageRecord, HubPreferences, HubRequest, HubResponse } from '../../shared/hub';
import { DEFAULT_PREFERENCES, newTokens } from '../../shared/hub';
import { CLAUDE_MODELS } from '../../shared/model-name';
import { PRICES_AS_OF } from '../../shared/model-prices';
export const useHubStore = create<{ /** The price list's date and Claude Code's models in use (built in until the host says otherwise). */ catalog: { asOf: string; claudeModels: string[] }; usage: UsageRecord[]; preferences: HubPreferences; /** The saved preferences have arrived (until then `preferences` are the defaults). */ preferencesLoaded: boolean; setUsage: (usage: UsageRecord[]) => void; upsert: (usage: UsageRecord) => void; setPreferences: (preferences: HubPreferences) => void }>((set) => ({
  catalog: { asOf: PRICES_AS_OF, claudeModels: [...CLAUDE_MODELS] }, usage: [], preferences: DEFAULT_PREFERENCES, preferencesLoaded: false,
  setUsage: (usage) => set({ usage }), upsert: (usage) => set((state) => ({ usage: [usage, ...state.usage.filter((s) => s.runId !== usage.runId)] })), setPreferences: (preferences) => set({ preferences, preferencesLoaded: true }),
}));
export async function hubCall<T extends HubResponse>(request: HubRequest): Promise<T> {
  if (!window.codingHub) throw new Error('This feature requires the desktop host.');
  // The host's error code goes with the message, for a caller that acts on it (MEMORY_PARTIAL, INVALID_HUB_REQUEST).
  const result = await window.codingHub.hub(request); if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code }); return result.value as T;
}
/** New tokens (see newTokens in shared/hub): input outside the cache, plus output. */
export const tokens = (u: UsageRecord) => newTokens(u);
export const formatNumber = (n: number) => new Intl.NumberFormat(undefined, { notation: n > 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
export const dollars = (cost: number | null) => cost === null ? '—' : '$' + cost.toFixed(cost < 0.01 ? 4 : 2);
