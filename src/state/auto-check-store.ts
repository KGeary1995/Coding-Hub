import { create } from 'zustand';
import type { AutoCheckStatus } from '../../shared/auto-checks';

/** The latest automatic check (shared/auto-checks.ts) by the channel whose turn started it, shown on its tile. */
export const useAutoCheckStore = create<{ bySession: Record<string, AutoCheckStatus> }>(() => ({ bySession: {} }));
export function receiveAutoCheck(status: AutoCheckStatus) { useAutoCheckStore.setState((state) => ({ bySession: { ...state.bySession, [status.sessionId]: status } })); }
export function dismissAutoCheck(sessionId: string) { useAutoCheckStore.setState((state) => { const { [sessionId]: _gone, ...rest } = state.bySession; return { bySession: rest }; }); }
