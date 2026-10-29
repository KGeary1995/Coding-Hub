import { create } from 'zustand';
import type { AccountLabel, AccountLabels, ClaudeAccountProfile } from '../../shared/accounts';
export const useAccountStore = create<{ profiles: ClaudeAccountProfile[]; labels: AccountLabels; error: string; loaded: boolean; setProfiles: (profiles: ClaudeAccountProfile[]) => void }>((set) => ({
  profiles: [], labels: { default: null, profiles: {} }, error: '', loaded: false, setProfiles: (profiles) => set({ profiles, error: '', loaded: true }),
}));
/** Whose account a Claude channel runs on: its profile, or the default sign-in. */
export function accountLabel(labels: AccountLabels, profileId?: string): AccountLabel | null { return profileId ? labels.profiles[profileId] ?? null : labels.default; }
let pending: Promise<void> | null = null;
export function refreshClaudeProfiles(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    try {
      if (!window.codingHub) return;
      const result = await window.codingHub.accounts({ action: 'profile-list' });
      if (!result.ok) throw new Error(result.error.message);
      useAccountStore.getState().setProfiles(result.value as ClaudeAccountProfile[]);
      // Which account each sign-in is; a channel still shows its profile's name without it.
      const labels = await window.codingHub.accounts({ action: 'labels' });
      if (labels.ok) useAccountStore.setState({ labels: labels.value as AccountLabels });
    } catch (error) { useAccountStore.setState({ error: error instanceof Error ? error.message : 'Profile list unavailable.' }); }
  })().finally(() => { pending = null; });
  return pending;
}
