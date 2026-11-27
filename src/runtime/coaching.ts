import { useWorkspaceStore } from '../state/workspace-store';
export function peekCoachingPrompt(sessionId: string) { return useWorkspaceStore.getState().sessions.find((session) => session.id === sessionId)?.preparedRequest; }
export function takeCoachingPrompt(sessionId: string): string | undefined {
  const request = peekCoachingPrompt(sessionId);
  useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => { if (session.id !== sessionId) return session; const { preparedRequest: _request, ...rest } = session; return rest; }) }));
  return request?.prompt;
}

/** The reason each channel's Send first request for a scheduled task last showed on its tile (scheduled-run.ts sendPreparedTask). */
const reasons = new Map<string, string>(); const REASON_SHOWN_MS = 10_000;
/**
 * Shows why a task's Send first request did not send on its tile, or takes the last reason away (null). `fleeting`: the
 * offer went with it, so nothing would take the reason away later; it goes by itself after a few seconds.
 */
export function showPreparedReason(sessionId: string, why: string | null, fleeting = false) {
  const shown = reasons.get(sessionId); if (why) reasons.set(sessionId, why); else reasons.delete(sessionId);
  useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => item.id !== sessionId ? item : why ? { ...item, error: why } : shown && item.error === shown ? { ...item, error: null } : item) }));
  if (why && fleeting) setTimeout(() => { if (reasons.get(sessionId) === why) showPreparedReason(sessionId, null); }, REASON_SHOWN_MS);
  return why;
}
/** A scheduled task's Send first request on this channel, once the task was sent another way: it and its reason go. */
export function dropPreparedTask(sessionId: string, taskId: string) {
  if (peekCoachingPrompt(sessionId)?.taskId !== taskId) return;
  takeCoachingPrompt(sessionId); showPreparedReason(sessionId, null);
}
