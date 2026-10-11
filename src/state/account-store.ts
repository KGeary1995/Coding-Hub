import { create } from 'zustand';
import type { ClaudeAccountProfile } from '../../shared/accounts';
export const useAccountStore = create<{ profiles: ClaudeAccountProfile[]; error: string; loaded: boolean; setProfiles: (profiles: ClaudeAccountProfile[]) => void }>((set) => ({
  profiles: [], error: '', loaded: false, setProfiles: (profiles) => set({ profiles, error: '', loaded: true }),
}));
let pending: Promise<void> | null = null;
export function refreshClaudeProfiles(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    try {
      if (!window.codingHub) return;
      const result = await window.codingHub.accounts({ action: 'profile-list' });
      if (!result.ok) throw new Error(result.error.message);
      useAccountStore.getState().setProfiles(result.value as ClaudeAccountProfile[]);
    } catch (error) { useAccountStore.setState({ error: error instanceof Error ? error.message : 'Profile list unavailable.' }); }
  })().finally(() => { pending = null; });
  return pending;
}
