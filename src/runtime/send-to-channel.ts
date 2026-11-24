import { isChatRun, type Session } from '../../shared/types';
import { chatFailed, chatSent, useChatStore } from '../state/chat-store';
import { writeTerminal } from './terminals';

/**
 * Types a prompt into a running channel as the person would: a chat channel gets it as a message (one leading a Round
 * Table passes it to the table, as a message typed there does), a terminal gets it as a line ended with Enter. Whether
 * it was sent. Tasks (task-store) and review comments from Changes (1.32.2) send this way.
 */
export async function sendToChannel(session: Session, text: string): Promise<boolean> {
  const runId = session.runId;
  if (!isChatRun(session.config) || !window.codingHub || !runId) return writeTerminal(session.id, text + '\r');
  const table = useChatStore.getState().threads[session.id]?.table;
  // A hierarchy's lead is marked busy by its chain, not by this message.
  chatSent(session.id, text, [], table?.kind !== 'hierarchy');
  const result = await window.codingHub.chat(table ? { action: 'table-send', sessionId: session.id, runId, text, images: [] } : { action: 'send', sessionId: session.id, runId, text, images: [] }).catch(() => null);
  if (!result?.ok) chatFailed(session.id, result && !result.ok ? result.error.message : 'The message could not be sent.');
  return Boolean(result?.ok);
}
