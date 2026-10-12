// Delivery requires a separate user click in the running coaching terminal.
const queued = new Map<string, string>();
export function queueCoachingPrompt(sessionId: string, prompt: string) { queued.set(sessionId, prompt); }
export function takeCoachingPrompt(sessionId: string): string | undefined { const value = queued.get(sessionId); queued.delete(sessionId); return value; }

export function peekCoachingPrompt(sessionId: string): string | undefined { return queued.get(sessionId); }
