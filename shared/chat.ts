/**
 * Chat channels: Claude Code driven through its structured mode (`--print --input-format stream-json
 * --output-format stream-json`) instead of its terminal screen, so Trace draws the conversation itself, with images.
 * These are the events the host turns Claude's messages into, and the requests the window sends back.
 */
import type { PermissionLevel } from './types';
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
  /** The agent refused a permission change: the level still in effect, which the window shows again. */
  | { type: 'permissions'; level: PermissionLevel }
  /** The size of the context window Claude reported with a reply; the host keeps it with the run's usage (never sent on). */
  | { type: 'context-window'; size: number }
  /** The person's message as the agent received it (the window shows it already; it is kept in the run's history). */
  | { type: 'user'; text: string; images: number; remote?: true }
  /** A resumed conversation's earlier messages and tool results, sent once as it starts. */
  | { type: 'history'; messages: ChatHistoryMessage[]; results: Record<string, { text: string; isError: boolean; image: boolean }> }
  /**
   * The Round Table this chat leads changed (sent on the leading channel); null when it ended. `closed`: the person
   * closed it (from any window, phone or computer), so the lead forgets it and its partner is stopped; without it, one
   * of the runs ended and the table is seated again when both run.
   */
  | { type: 'table'; table: RoundTableState | null; closed?: true };
export type ChatEnvelope = { sessionId: string; runId: string; event: ChatEvent };

/**
 * A Round Table: the person, Claude Code and Codex in one conversation. It is led by a chat channel (the one it was
 * started from); the other agent is a partner chat run in the same folder. Every message goes to both; then each sees
 * the other's answer for up to `rounds` rounds, ending sooner when both agree. The driver edits files; the reviewer
 * reads (Claude's plan mode, Codex's read-only sandbox).
 */
export interface RoundTableState {
  partner: { sessionId: string; runId: string; engine: 'claude' | 'codex' };
  driver: 'claude' | 'codex'; rounds: number; round: number;
  /** joining: the leading agent summarizes for the newcomer; answering: both answer the person; discussing: they answer each other. */
  phase: 'joining' | 'answering' | 'discussing' | 'idle';
  /** The last discussion ended with both agents agreeing. */
  agreed: boolean;
  /** The review record: what the reviewer reported and what became of each (shared/findings.ts). Missing from Trace before 1.17. */
  findings?: import('./findings').Finding[];
  /** The text of a message waiting for the agents; after a restart it waits for the person to send or drop it. */
  waiting?: string; waitingKept?: boolean;
}
export const ROUND_TABLE_MAX_ROUNDS = 5;
export type ChatRequest =
  | { action: 'send'; sessionId: string; runId: string; text: string; images: ChatImage[] }
  | { action: 'answer'; sessionId: string; runId: string; requestId: string; allow: boolean; allowEdits?: boolean }
  | { action: 'interrupt'; sessionId: string; runId: string }
  /** What the agent may do without asking, from now on (this computer's window only). */
  | { action: 'permissions'; sessionId: string; runId: string; level: PermissionLevel }
  /** Seats a partner chat run (another engine, same folder) at this chat's Round Table. */
  | { action: 'table-open'; sessionId: string; runId: string; partner: { sessionId: string; runId: string }; driver: 'claude' | 'codex'; rounds: number; findings?: import('./findings').Finding[]; waiting?: string }
  /** A message kept from before a restart: send it now, or drop it. */
  | { action: 'table-waiting'; sessionId: string; runId: string; send: boolean }
  | { action: 'table-send'; sessionId: string; runId: string; text: string; images: ChatImage[] }
  | { action: 'table-driver'; sessionId: string; runId: string; driver: 'claude' | 'codex' }
  | { action: 'table-rounds'; sessionId: string; runId: string; rounds: number }
  /** Stops both agents and the discussion; the table stays open. */
  | { action: 'table-stop'; sessionId: string; runId: string }
  | { action: 'table-close'; sessionId: string; runId: string };

/** The longest piece of a tool's output shown in the thread; the rest stays in Claude's own transcript. */
export const TOOL_RESULT_LIMIT = 4000;
