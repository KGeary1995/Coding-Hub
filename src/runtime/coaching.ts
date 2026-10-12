const queued = new Map<string, { prompt: string; label: string }>();
export function queueSessionRequest(sessionId: string, prompt: string, label: string) { queued.set(sessionId, { prompt, label }); }
export function queueCoachingPrompt(sessionId: string, prompt: string) { queueSessionRequest(sessionId, prompt, 'Send coaching request'); }
export function takeCoachingPrompt(sessionId: string): string | undefined { const value = queued.get(sessionId); queued.delete(sessionId); return value?.prompt; }
export function peekCoachingPrompt(sessionId: string) { return queued.get(sessionId); }
