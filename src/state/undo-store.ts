import { create } from 'zustand';
import type { UndoStatus } from '../../shared/undo';

/** Undo last turn by channel (shared/undo.ts), and what the last undo or redo left to say on its tile. */
export const useUndoStore = create<{ bySession: Record<string, UndoStatus>; notices: Record<string, { text: string; failed: boolean }> }>(() => ({ bySession: {}, notices: {} }));
export function receiveUndo(status: UndoStatus) { useUndoStore.setState((state) => ({ bySession: { ...state.bySession, [status.sessionId]: status } })); }
export function setUndoNotice(sessionId: string, notice: { text: string; failed: boolean } | null) { useUndoStore.setState((state) => { const { [sessionId]: _gone, ...rest } = state.notices; return { notices: notice ? { ...rest, [sessionId]: notice } : rest }; }); }
