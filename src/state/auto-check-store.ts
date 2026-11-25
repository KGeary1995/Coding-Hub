import { create } from 'zustand';
import type { AutoCheckStatus } from '../../shared/auto-checks';

/** The latest automatic check (shared/auto-checks.ts) by the channel whose turn started it, shown on its tile. */
/** `ran`: a check has run since Trace started (Getting started's step), kept when its result is dismissed or hidden. */
export const useAutoCheckStore = create<{ bySession: Record<string, AutoCheckStatus>; ran: boolean }>(() => ({ bySession: {}, ran: false }));
export function receiveAutoCheck(status: AutoCheckStatus) { useAutoCheckStore.setState((state) => ({ bySession: { ...state.bySession, [status.sessionId]: status }, ran: true })); }
/** How long a passed check stays on its tile (a failure stays until dismissed): the tile's room is the terminal's. */
export const PASSED_SHOWN_MS = 8000;
export function dismissAutoCheck(sessionId: string) { useAutoCheckStore.setState((state) => { const { [sessionId]: _gone, ...rest } = state.bySession; return { bySession: rest }; }); }
