/**
 * How an agent says a task is done: its reply ends with the line TASK COMPLETE, or TASK BLOCKED: <what it needs>. A
 * turn that ends without either is not taken as done: it may have asked a question, or stopped part way.
 */
export type TaskSignal = { kind: 'complete' } | { kind: 'blocked'; reason: string } | null;
export const COMPLETE_LINE = 'TASK COMPLETE';
export const BLOCKED_LINE = 'TASK BLOCKED:';
/** The instruction added to every task sent to an agent. */
export const SIGNAL_INSTRUCTION = `When you are done, list the files you changed and how you checked the result, then end your reply with the line ${COMPLETE_LINE}. If you need me first (a question, an approval, a choice), end with the line ${BLOCKED_LINE} and what you need. Until one of those lines, the task stays open.`;

/** The signal in the last lines of a reply (markdown emphasis and code ticks allowed around it), or null. */
export function taskSignal(reply: string): TaskSignal {
  const lines = reply.split(/\r?\n/).map((line) => line.trim().replace(/^[*_`>\s-]+|[*_`\s]+$/g, '')).filter(Boolean).slice(-3).reverse();
  for (const line of lines) {
    if (/^TASK COMPLETE\.?$/i.test(line)) return { kind: 'complete' };
    const blocked = /^TASK BLOCKED:\s*(.*)$/i.exec(line); if (blocked) return { kind: 'blocked', reason: blocked[1].trim().slice(0, 500) || 'The agent needs you.' };
  }
  return null;
}
