import type { ChatEnvelope, ChatEvent } from '../../../shared/chat';
import type { ChatReplay } from '../../../shared/remote';

/** Per chat channel: its current run's last events, at most this many and this much JSON. */
export const CHAT_REPLAY_EVENTS = 300; export const CHAT_REPLAY_BYTES = 2 * 1024 * 1024;
/** A resumed chat's `history` event is trimmed from its oldest messages to this, so it cannot push out the live run. */
const HISTORY_BYTES = 1024 * 1024;
const CHANNELS = 32;
interface Kept { event: ChatEvent; size: number }

/**
 * Recent chat events per channel, so a phone or another computer opening a chat sees its thread without re-reading the
 * CLI's transcript. Chat events never carry image data (a `user` event counts its images), so nothing large is kept.
 * Streamed text is folded: consecutive pieces of one message join, and the finished message replaces them.
 */
export class ChatReplayBuffer {
  private sessions = new Map<string, { runId: string; events: Kept[]; bytes: number }>();

  record({ sessionId, runId, event }: ChatEnvelope) {
    let entry = this.sessions.get(sessionId);
    // A new run starts a new thread: a restarted chat sends its `history` again.
    if (!entry || entry.runId !== runId) {
      this.sessions.delete(sessionId); entry = { runId, events: [], bytes: 0 }; this.sessions.set(sessionId, entry);
      while (this.sessions.size > CHANNELS) this.sessions.delete(this.sessions.keys().next().value!);
    }
    const last = entry.events.at(-1);
    if (event.type === 'delta' && last?.event.type === 'delta' && last.event.messageId === event.messageId) {
      const joined: ChatEvent = { ...last.event, text: last.event.text + event.text }; this.replace(entry, entry.events.length - 1, joined); this.trim(entry); return;
    }
    if (event.type === 'assistant') this.remove(entry, (kept) => kept.event.type === 'delta' && kept.event.messageId === event.messageId);
    // Only the latest Round Table state matters to a viewer that joins later.
    if (event.type === 'table') this.remove(entry, (kept) => kept.event.type === 'table');
    const kept = event.type === 'history' ? fitHistory(event) : event;
    const size = JSON.stringify(kept).length; entry.events.push({ event: kept, size }); entry.bytes += size; this.trim(entry);
  }
  take(sessionId: string): ChatReplay {
    const entry = this.sessions.get(sessionId);
    return { sessionId, runId: entry?.runId ?? null, events: entry ? entry.events.map((kept) => kept.event) : [] };
  }
  sessionIds() { return [...this.sessions.keys()]; }
  forget(sessionId: string) { this.sessions.delete(sessionId); }
  clear() { this.sessions.clear(); }

  private replace(entry: { events: Kept[]; bytes: number }, index: number, event: ChatEvent) {
    const size = JSON.stringify(event).length; entry.bytes += size - entry.events[index].size; entry.events[index] = { event, size };
  }
  private remove(entry: { events: Kept[]; bytes: number }, match: (kept: Kept) => boolean) {
    entry.events = entry.events.filter((kept) => { if (!match(kept)) return true; entry.bytes -= kept.size; return false; });
  }
  /** Oldest first out, always keeping the newest event. */
  private trim(entry: { events: Kept[]; bytes: number }) {
    while (entry.events.length > 1 && (entry.events.length > CHAT_REPLAY_EVENTS || entry.bytes > CHAT_REPLAY_BYTES)) entry.bytes -= entry.events.shift()!.size;
  }
}

/** Drops a resumed chat's oldest earlier messages until its history fits HISTORY_BYTES. */
function fitHistory(event: Extract<ChatEvent, { type: 'history' }>): ChatEvent {
  if (JSON.stringify(event).length <= HISTORY_BYTES) return event;
  const messages = [...event.messages]; let size = JSON.stringify(event).length;
  while (messages.length && size > HISTORY_BYTES) size -= JSON.stringify(messages.shift()).length + 1;
  // Tool results for messages no longer kept go too.
  const ids = new Set(messages.flatMap((message) => message.role === 'assistant' ? message.blocks.flatMap((block) => block.type === 'tool' ? [block.id] : []) : []));
  const results = Object.fromEntries(Object.entries(event.results).filter(([id]) => ids.has(id)));
  return { type: 'history', messages, results };
}
