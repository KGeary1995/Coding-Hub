/**
 * How an agent says a task is done: its reply ends with the line TASK COMPLETE, or TASK BLOCKED: <what it needs>. A
 * turn that ends without either is not taken as done: it may have asked a question, or stopped part way.
 */
export type TaskSignal = { kind: 'complete' } | { kind: 'blocked'; reason: string } | null;
export const COMPLETE_LINE = 'TASK COMPLETE';
export const BLOCKED_LINE = 'TASK BLOCKED:';
/** The instruction added to every task sent to an agent. */
export const SIGNAL_INSTRUCTION = `When you are done, list the files you changed and how you checked the result, then end your reply with the line ${COMPLETE_LINE}. If you need me first (a question, an approval, a choice), end with the line ${BLOCKED_LINE} and what you need. Until one of those lines, the task stays open.`;

/**
 * How a task's prompt starts (taskPrompt), which Trace finds it by in a conversation: with the send's own id (a new one
 * each time it is sent), so a task with the same title, or an earlier send of this one, never counts. Tasks sent before
 * ids existed are found by title.
 */
export const promptMark = (task: { title: string; sendId?: string }) => { const line = task.title.trim().replace(/\s*\n\s*/g, ' '); return `Task${task.sendId ? ` ${task.sendId}` : ''}: ${line}${/[.!?]$/.test(line) ? '' : '.'}`; };
export const isSendId = (value: unknown): value is string => typeof value === 'string' && /^t-[0-9a-f]{8}$/.test(value);
/**
 * The newest reply to this task: only what the agent said after the task's own prompt was sent (its latest copy, if it
 * was sent again). An earlier task's TASK COMPLETE never counts for this one; with no prompt found, there is no reply.
 */
export function replyToTask(messages: { role: 'user' | 'assistant'; text: string }[], task: { title: string; sendId?: string }): string | null {
  const mark = promptMark(task); let start = -1;
  messages.forEach((message, index) => { if (message.role === 'user' && message.text.includes(mark)) start = index; });
  if (start < 0) return null;
  const after = messages.slice(start + 1).filter((message) => message.role === 'assistant' && message.text.trim());
  return after.length ? after[after.length - 1].text : null;
}

/** The signal on the last non-empty line of a reply (markdown emphasis and code ticks allowed around it), or null: anything after it, such as a question, means it is not the signal. */
export function taskSignal(reply: string): TaskSignal {
  const lines = reply.split(/\r?\n/).map((line) => line.trim().replace(/^[*_`>\s-]+|[*_`\s]+$/g, '')).filter(Boolean).slice(-1);
  for (const line of lines) {
    if (/^TASK COMPLETE\.?$/i.test(line)) return { kind: 'complete' };
    const blocked = /^TASK BLOCKED:\s*(.*)$/i.exec(line); if (blocked) return { kind: 'blocked', reason: blocked[1].trim().slice(0, 500) || 'The agent needs you.' };
  }
  return null;
}
