import { create } from 'zustand';
import type { ChatBlock, ChatEnvelope, ChatImage } from '../../shared/chat';

/** What a chat channel's thread holds, in order. Tool results are kept by tool call and shown on its card. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; images: string[]; at: string }
  | { kind: 'assistant'; id: string; blocks: ChatBlock[]; streaming: string }
  | { kind: 'permission'; id: string; toolName: string; description: string; input: Record<string, unknown>; canAllowEdits: boolean; answer: 'allowed' | 'denied' | 'closed' | null }
  | { kind: 'notice'; id: string; text: string; error: boolean };
export interface ToolResult { text: string; isError: boolean; image: boolean }
export interface ChatThread { runId: string | null; items: ChatItem[]; results: Record<string, ToolResult>; busy: boolean; model: string | null }

const EMPTY: ChatThread = { runId: null, items: [], results: {}, busy: false, model: null };
export const useChatStore = create<{ threads: Record<string, ChatThread> }>(() => ({ threads: {} }));
const thread = (sessionId: string) => useChatStore.getState().threads[sessionId] ?? EMPTY;
function update(sessionId: string, change: (current: ChatThread) => ChatThread) {
  useChatStore.setState((state) => ({ threads: { ...state.threads, [sessionId]: change(state.threads[sessionId] ?? EMPTY) } }));
}
let counter = 0; const nextId = () => `chat-${++counter}`;

/**
 * A chat run started. A fresh conversation starts an empty thread; a resumed one keeps what this window showed, with a
 * line saying Claude continues from there (earlier messages from before Trace opened are in Claude's own history).
 */
export function chatStarted(sessionId: string, runId: string, resumed: boolean) {
  update(sessionId, (current) => resumed && current.items.length
    ? { ...current, runId, busy: false, items: [...current.items, { kind: 'notice', id: nextId(), text: 'Restarted. Claude continues this conversation.', error: false }] }
    : { ...EMPTY, runId, items: resumed ? [{ kind: 'notice', id: nextId(), text: 'Resumed a saved conversation. Earlier messages are in Claude’s history; new ones appear here.', error: false }] : [] });
}
export function chatEnded(sessionId: string) { update(sessionId, (current) => ({ ...current, busy: false, items: current.items.map((item) => item.kind === 'permission' && !item.answer ? { ...item, answer: 'closed' } : item) })); }
/** Frees the conversations (with their images) of channels no longer in the workspace. */
export function forgetChatsExcept(sessionIds: Iterable<string>) {
  const kept = new Set(sessionIds); const threads = useChatStore.getState().threads;
  if (Object.keys(threads).every((id) => kept.has(id))) return;
  useChatStore.setState({ threads: Object.fromEntries(Object.entries(threads).filter(([id]) => kept.has(id))) });
}

/** The person's message, shown at once; images as data URLs for the thread. */
export function chatSent(sessionId: string, text: string, images: ChatImage[]) {
  update(sessionId, (current) => ({ ...current, busy: true, items: [...current.items, { kind: 'user', id: nextId(), text, images: images.map((image) => `data:${image.mediaType};base64,${image.data}`), at: new Date().toISOString() }] }));
}
export function chatAnswered(sessionId: string, requestId: string, allow: boolean) {
  update(sessionId, (current) => ({ ...current, items: current.items.map((item) => item.kind === 'permission' && item.id === requestId ? { ...item, answer: allow ? 'allowed' : 'denied' } : item) }));
}
export function chatFailed(sessionId: string, text: string) { update(sessionId, (current) => ({ ...current, busy: false, items: [...current.items, { kind: 'notice', id: nextId(), text, error: true }] })); }

/** Claude's side of the conversation, from the host. */
export function applyChatEvent({ sessionId, runId, event }: ChatEnvelope) {
  if (thread(sessionId).runId !== runId) return;
  update(sessionId, (current) => {
    const items = [...current.items];
    const assistant = (id: string) => {
      const index = items.findIndex((item) => item.kind === 'assistant' && item.id === id);
      if (index >= 0) return index;
      items.push({ kind: 'assistant', id, blocks: [], streaming: '' }); return items.length - 1;
    };
    switch (event.type) {
      case 'ready': return { ...current, model: event.model };
      case 'delta': { const index = assistant(event.messageId); const item = items[index] as Extract<ChatItem, { kind: 'assistant' }>; items[index] = { ...item, streaming: item.streaming + event.text }; return { ...current, items, busy: true };
      }
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
      case 'permission': return { ...current, items: [...items, { kind: 'permission', id: event.requestId, toolName: event.toolName, description: event.description, input: event.input, canAllowEdits: event.canAllowEdits, answer: null }] };
      case 'permission-done': return { ...current, items: items.map((item) => item.kind === 'permission' && item.id === event.requestId && !item.answer ? { ...item, answer: 'closed' } : item) };
      case 'notice': return { ...current, items: [...items, { kind: 'notice', id: nextId(), text: event.text, error: false }] };
      case 'done': {
        // Streamed text that never got its final message (an interruption) stays as it was.
        // An approval still open when its reply ended no longer belongs to anything.
        const settled = items.map((item) => item.kind === 'assistant' && item.streaming ? { ...item, blocks: [...item.blocks, { type: 'text' as const, text: item.streaming }], streaming: '' } : item.kind === 'permission' && !item.answer ? { ...item, answer: 'closed' as const } : item);
        return { ...current, busy: false, items: event.isError && event.error ? [...settled, { kind: 'notice', id: nextId(), text: event.error, error: true }] : settled };
      }
    }
  });
}
