import { useWorkspaceStore } from '../state/workspace-store';
export function peekCoachingPrompt(sessionId: string) { return useWorkspaceStore.getState().sessions.find((session) => session.id === sessionId)?.preparedRequest; }
export function takeCoachingPrompt(sessionId: string): string | undefined {
  const request = peekCoachingPrompt(sessionId);
  useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => { if (session.id !== sessionId) return session; const { preparedRequest: _request, ...rest } = session; return rest; }) }));
  return request?.prompt;
}
