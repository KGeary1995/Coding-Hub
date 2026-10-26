/**
 * Chat channels: Claude Code driven through its structured mode (`--print --input-format stream-json
 * --output-format stream-json`) instead of its terminal screen, so Trace draws the conversation itself, with images.
 * These are the events the host turns Claude's messages into, and the requests the window sends back.
 */
export interface ChatImage { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> };
/** A message from a resumed conversation's history, read from the CLI's own transcript. */
export type ChatHistoryMessage = { role: 'user'; text: string; images: number } | { role: 'assistant'; messageId: string; blocks: ChatBlock[] };
export type ChatEvent =
  /** The conversation (Claude's session id, kept for resuming) and the model answering. */
  | { type: 'ready'; conversationId: string; model: string | null }
  /** Text streaming into the reply being written (`messageId` groups the pieces). */
  | { type: 'delta'; messageId: string; text: string }
  /** A finished assistant message: its text and the tools it calls. Replaces the streamed text for that message. */
  | { type: 'assistant'; messageId: string; blocks: ChatBlock[] }
  /** What a tool returned, shortened for display. */
  | { type: 'tool-result'; toolUseId: string; text: string; isError: boolean; image: boolean }
  /** Claude asks to use a tool the permission settings do not already allow. */
  | { type: 'permission'; requestId: string; toolName: string; description: string; input: Record<string, unknown>; canAllowEdits: boolean }
  /** The approval was answered (here, from another window, or by the run ending). */
  | { type: 'permission-done'; requestId: string }
  /** The reply finished: whether it ended in an error, and Claude's own error text then. */
  | { type: 'done'; isError: boolean; error: string | null }
  /** Something Claude reported that is worth a line in the thread (a refused tool, an API retry). */
  | { type: 'notice'; text: string }
  /** The person's message as the agent received it (the window shows it already; it is kept in the run's history). */
  | { type: 'user'; text: string; images: number }
  /** A resumed conversation's earlier messages and tool results, sent once as it starts. */
  | { type: 'history'; messages: ChatHistoryMessage[]; results: Record<string, { text: string; isError: boolean; image: boolean }> };
export type ChatEnvelope = { sessionId: string; runId: string; event: ChatEvent };
export type ChatRequest =
  | { action: 'send'; sessionId: string; runId: string; text: string; images: ChatImage[] }
  | { action: 'answer'; sessionId: string; runId: string; requestId: string; allow: boolean; allowEdits?: boolean }
  | { action: 'interrupt'; sessionId: string; runId: string };

/** The longest piece of a tool's output shown in the thread; the rest stays in Claude's own transcript. */
export const TOOL_RESULT_LIMIT = 4000;
