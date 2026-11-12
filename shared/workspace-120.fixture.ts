/** For tests only. */
/** A workspace as Trace 1.20 saved it: a Gemini terminal channel, and a hierarchy table with a Gemini seat stopped at Gemini's comparison. */
export function workspace120() {
  const tile = (sessionId: string, x: number) => ({ sessionId, x, y: 0, w: 4, h: 12, minW: 3, minH: 10 });
  const at = '2026-11-10T10:00:00.000Z';
  const chat = (engine: 'claude' | 'codex') => engine === 'claude' ? { engine, chat: true, model: 'claude-opus-5-5', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } : { engine, chat: true, model: 'gpt-6-astra', reasoningEffort: null };
  const finding = (id: string, extra: Record<string, unknown>) => ({ id, severity: 'medium', evidence: 'a.ts:1', text: 'a problem', status: 'open', response: '', check: '', reviewedAt: null, changedAt: null, round: 1, at, ...extra });
  return {
    version: 1, rootDirectory: '/p', layoutMode: 'columns', focusedSessionId: 'gem',
    sessions: [
      { id: 'lead', title: 'Claude Code', config: chat('claude'), binding: { mode: 'workspace' }, createdAt: at, roundTable: { partner: 'rev', planner: 'plan', challenger: 'seat', kind: 'hierarchy', driver: 'claude', rounds: 2,
        chain: { step: 'stopped', stoppedAt: 'comparing', blocked: 'challenger', task: 'T', plan: 'P', report: 'R', reviewRound: 1, finalRound: 0, verdict: null, note: '', challenged: true, geminiReviewed: true, compared: true, firstFinding: 0 },
        findings: [finding('F1', { source: 'gemini' }), finding('F2', { gemini: 'dispute', geminiNote: 'no' }), finding('F3', { duplicateOf: 'F1', status: 'verified' })] } },
      { id: 'rev', title: 'Codex', config: chat('codex'), binding: { mode: 'independent', cwd: '/p' }, createdAt: at },
      { id: 'plan', title: 'Claude Code', config: chat('claude'), binding: { mode: 'independent', cwd: '/p' }, createdAt: at },
      { id: 'seat', title: 'Gemini', config: { engine: 'gemini', model: 'gemini-4-argon-high', chat: true, permissions: 'full' }, binding: { mode: 'independent', cwd: '/p' }, createdAt: at },
      { id: 'gem', title: 'Gemini', config: { engine: 'gemini', model: 'gemini-4-argon-high' }, binding: { mode: 'workspace' }, createdAt: at },
    ],
    tiles: [tile('lead', 0), tile('gem', 4)],
  };
}
