import { create } from 'zustand';
import type { ChatBlock, ChatEnvelope, ChatImage, RoundTableState } from '../../shared/chat';

/** What a chat channel's thread holds, in order. `order` is when an item was added, counted across every thread, so a
 * Round Table can merge two agents' threads in time. Tool results are kept by tool call and shown on its card. */
export type ChatItem =
  | { kind: 'user'; id: string; order?: number; text: string; images: string[]; at: string }
  | { kind: 'assistant'; id: string; order?: number; blocks: ChatBlock[]; streaming: string }
  | { kind: 'permission'; id: string; order?: number; toolName: string; description: string; input: Record<string, unknown>; canAllowEdits: boolean; answer: 'allowed' | 'denied' | 'closed' | null }
  | { kind: 'notice'; id: string; order?: number; text: string; error: boolean };
export interface ToolResult { text: string; isError: boolean; image: boolean }
/** `table`: the Round Table this chat leads, if any. */
export interface ChatThread { runId: string | null; items: ChatItem[]; results: Record<string, ToolResult>; busy: boolean; model: string | null; table?: RoundTableState | null }

const EMPTY: ChatThread = { runId: null, items: [], results: {}, busy: false, model: null };
export const useChatStore = create<{ threads: Record<string, ChatThread> }>(() => ({ threads: {} }));
const thread = (sessionId: string) => useChatStore.getState().threads[sessionId] ?? EMPTY;
function update(sessionId: string, change: (current: ChatThread) => ChatThread) {
  // Streamed text not drawn yet goes in first, so the thread keeps the order things arrived in.
  if (pendingDeltas.has(sessionId)) flushChatDeltas(sessionId);
  useChatStore.setState((state) => ({ threads: { ...state.threads, [sessionId]: change(state.threads[sessionId] ?? EMPTY) } }));
}
let counter = 0; const nextId = () => `chat-${++counter}`;

/** The index of a reply in a thread, looked up from the end (the reply being streamed is the newest), or -1. */
function assistantAt(items: ChatItem[], id: string) { for (let index = items.length - 1; index >= 0; index--) { const item = items[index]; if (item.kind === 'assistant' && item.id === id) return index; } return -1; }

/**
 * Streamed text arrives in many small pieces, and each one used to replace the thread and draw it all again. Pieces are
 * gathered per thread (and run, and reply) and applied together once a frame; any other change to that thread applies
 * them first. A hidden window draws no frames, so a timer applies them too.
 */
const pendingDeltas = new Map<string, { runId: string | null; texts: Map<string, string> }>();
let flushScheduled = false; let flushFrame = 0; let flushTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleFlush() {
  if (flushScheduled) return; flushScheduled = true;
  const run = () => { if (flushScheduled) flushChatDeltas(); };
  if (typeof requestAnimationFrame === 'function') flushFrame = requestAnimationFrame(run);
  flushTimer = setTimeout(run, 100);
}
/** Applies streamed text not drawn yet: one thread's, or every thread's. Exported for tests. */
export function flushChatDeltas(sessionId?: string) {
  // Whichever of the frame and the timer fires first cancels the other, so a leftover one never flushes a newer batch off-frame.
  if (sessionId === undefined) {
    flushScheduled = false; clearTimeout(flushTimer); flushTimer = undefined;
    if (flushFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flushFrame); flushFrame = 0;
  }
  const ids = sessionId === undefined ? [...pendingDeltas.keys()] : pendingDeltas.has(sessionId) ? [sessionId] : [];
  if (!ids.length) return;
  useChatStore.setState((state) => {
    const threads = { ...state.threads };
    for (const id of ids) {
      const pending = pendingDeltas.get(id)!; pendingDeltas.delete(id);
      const current = threads[id] ?? EMPTY; if (current.runId !== pending.runId) continue;
      const items = [...current.items];
      for (const [messageId, text] of pending.texts) {
        const index = assistantAt(items, messageId);
        if (index < 0) items.push({ kind: 'assistant', order: ++counter, id: messageId, blocks: [], streaming: text });
        else { const item = items[index] as Extract<ChatItem, { kind: 'assistant' }>; items[index] = { ...item, streaming: item.streaming + text }; }
      }
      threads[id] = { ...current, items, busy: true };
    }
    return { threads };
  });
}

/**
 * A chat run started. A fresh conversation starts an empty thread; a resumed one keeps what this window showed, with a
 * line saying Claude continues from there (earlier messages from before Trace opened are in Claude's own history).
 */
export function chatStarted(sessionId: string, runId: string, resumed: boolean) {
  update(sessionId, (current) => resumed && current.items.length
    ? { ...current, runId, busy: false, items: [...current.items, { kind: 'notice', order: ++counter, id: nextId(), text: 'Restarted. Claude continues this conversation.', error: false }] }
    : { ...EMPTY, runId, items: resumed ? [{ kind: 'notice', order: ++counter, id: nextId(), text: 'Resumed a saved conversation. Earlier messages are in Claude’s history; new ones appear here.', error: false }] : [] });
}
export function chatEnded(sessionId: string) { update(sessionId, (current) => ({ ...current, busy: false, items: current.items.map((item) => item.kind === 'permission' && !item.answer ? { ...item, answer: 'closed' } : item) })); }
/**
 * Another computer's chat threads share this store under `computerId:sessionId` keys (linkedChatKey); this computer's
 * session ids never hold a colon.
 */
const isLinked = (key: string) => key.includes(':');
function keepThreads(keep: (key: string) => boolean) {
  const threads = useChatStore.getState().threads; for (const key of pendingDeltas.keys()) if (!keep(key)) pendingDeltas.delete(key);
  if (Object.keys(threads).every(keep)) return;
  useChatStore.setState({ threads: Object.fromEntries(Object.entries(threads).filter(([key]) => keep(key))) });
}
/** Frees the conversations (with their images) of channels no longer in the workspace. Linked computers' threads stay. */
export function forgetChatsExcept(sessionIds: Iterable<string>) { const kept = new Set(sessionIds); keepThreads((key) => isLinked(key) || kept.has(key)); }
/** Frees the threads of linked computers no longer listed; this computer's own threads stay. */
export function forgetLinkedChatsExcept(computerIds: Iterable<string>) { const prefixes = [...computerIds].map((id) => `${id}:`); keepThreads((key) => !isLinked(key) || prefixes.some((prefix) => key.startsWith(prefix))); }

/** The person's message, shown at once; images as data URLs for the thread. */
/** `busy`: the message went to this chat's agent, which now answers (a hierarchy table passes it to another seat). */
export function chatSent(sessionId: string, text: string, images: ChatImage[], busy = true) {
  update(sessionId, (current) => ({ ...current, busy: busy || current.busy, items: [...current.items, { kind: 'user', order: ++counter, id: nextId(), text, images: images.map((image) => `data:${image.mediaType};base64,${image.data}`), at: new Date().toISOString() }] }));
}
export function chatAnswered(sessionId: string, requestId: string, allow: boolean) {
  update(sessionId, (current) => ({ ...current, items: current.items.map((item) => item.kind === 'permission' && item.id === requestId ? { ...item, answer: allow ? 'allowed' : 'denied' } : item) }));
}
/** A line from Trace in a chat's thread that is not an error (a Round Table that could not open again, say). */
export function chatNotice(sessionId: string, text: string) { update(sessionId, (current) => ({ ...current, items: [...current.items, { kind: 'notice', order: ++counter, id: nextId(), text, error: false }] })); }
export function chatFailed(sessionId: string, text: string) { update(sessionId, (current) => ({ ...current, busy: false, items: [...current.items, { kind: 'notice', order: ++counter, id: nextId(), text, error: true }] })); }

/** Claude's side of the conversation, from the host. */
export function applyChatEvent({ sessionId, runId, event }: ChatEnvelope) {
  if (thread(sessionId).runId !== runId) return;
  // Streamed text: gathered and applied once a frame (flushChatDeltas).
  if (event.type === 'delta') {
    const pending = pendingDeltas.get(sessionId) ?? { runId, texts: new Map<string, string>() }; pendingDeltas.set(sessionId, pending);
    pending.texts.set(event.messageId, (pending.texts.get(event.messageId) ?? '') + event.text); scheduleFlush(); return;
  }
  update(sessionId, (current) => {
    const items = [...current.items];
    const assistant = (id: string) => {
      const index = assistantAt(items, id);
      if (index >= 0) return index;
      items.push({ kind: 'assistant', order: ++counter, id, blocks: [], streaming: '' }); return items.length - 1;
    };
    switch (event.type) {
      case 'ready': return { ...current, model: event.model };
      case 'table': return { ...current, table: event.table };
      // The channel's setting, not the thread (handled where chat events arrive).
      case 'permissions': case 'context-window': return current;
      case 'assistant': {
        // Claude sends each block of a reply (thinking, text, a tool call) as its own message with the same id.
        const index = assistant(event.messageId); const item = items[index] as Extract<ChatItem, { kind: 'assistant' }>; const blocks = [...item.blocks];
        for (const block of event.blocks) {
          const duplicate = blocks.some((existing) => existing.type === block.type && (block.type === 'tool' ? (existing as { id: string }).id === block.id : (existing as { text: string }).text === block.text));
          if (!duplicate) blocks.push(block);
        }
        items[index] = { ...item, blocks, streaming: event.blocks.some((block) => block.type === 'text') ? '' : item.streaming };
        return { ...current, items };
      }
      case 'tool-result': return { ...current, results: { ...current.results, [event.toolUseId]: { text: event.text, isError: event.isError, image: event.image } } };
      case 'permission': return { ...current, items: [...items, { kind: 'permission', order: ++counter, id: event.requestId, toolName: event.toolName, description: event.description, input: event.input, canAllowEdits: event.canAllowEdits, answer: null }] };
      case 'permission-done': return { ...current, items: items.map((item) => item.kind === 'permission' && item.id === event.requestId && !item.answer ? { ...item, answer: 'closed' } : item) };
      case 'notice': return { ...current, items: [...items, { kind: 'notice', order: ++counter, id: nextId(), text: event.text, error: false }] };
      // The window adds the person's message itself when it is sent; one sent from a phone or another computer is added here.
      case 'user': return event.remote ? { ...current, busy: true, items: [...items, { kind: 'user', order: ++counter, id: nextId(), text: event.text, images: [], at: new Date().toISOString() }] } : current;
      case 'history': {
        // A resumed conversation's earlier messages, unless this window still shows the conversation itself.
        if (items.some((item) => item.kind === 'user' || item.kind === 'assistant') || !event.messages.length) return current;
        const earlier: ChatItem[] = event.messages.map((message) => message.role === 'user'
          ? { kind: 'user', order: ++counter, id: nextId(), text: message.images ? `${message.text}${message.text ? '\n' : ''}[${message.images} image${message.images === 1 ? '' : 's'}]` : message.text, images: [], at: '' }
          : { kind: 'assistant', order: ++counter, id: nextId(), blocks: message.blocks, streaming: '' });
        return { ...current, results: { ...event.results, ...current.results }, items: [...earlier, { kind: 'notice', order: ++counter, id: nextId(), text: 'Resumed. The messages above are from the saved conversation.', error: false }] };
      }
      // `settled` ends a reply Claude started by itself: the same for what the thread shows, and it carries no error.
      case 'done': case 'settled': {
        // Streamed text that never got its final message (an interruption) stays as it was.
        // An approval still open when its reply ended no longer belongs to anything.
        const settled = items.map((item) => item.kind === 'assistant' && item.streaming ? { ...item, blocks: [...item.blocks, { type: 'text' as const, text: item.streaming }], streaming: '' } : item.kind === 'permission' && !item.answer ? { ...item, answer: 'closed' as const } : item);
        return { ...current, busy: false, items: event.type === 'done' && event.isError && event.error ? [...settled, { kind: 'notice', order: ++counter, id: nextId(), text: event.error, error: true }] : settled };
      }
      // A newer Trace on a linked computer may send events this version does not know: they leave the thread as it is.
      default: return current;
    }
  });
}
