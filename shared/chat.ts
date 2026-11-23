/**
 * Chat channels: Claude Code driven through its structured mode (`--print --input-format stream-json
 * --output-format stream-json`) instead of its terminal screen, so Trace draws the conversation itself, with images.
 * These are the events the host turns Claude's messages into, and the requests the window sends back.
 */
import type { PermissionLevel } from './types';
import type { SeatReference, TableSeatState } from './table-seats';
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
  | { type: 'permission'; requestId: string; toolName: string; description: string; input: Record<string, unknown>; canAllowEdits: boolean;
    /** The tool's own name when the name shown (Claude's display name) differs: a Round Table declines edits by either. */
    tool?: string }
  /** The approval was answered (here, from another window, or by the run ending). */
  | { type: 'permission-done'; requestId: string }
  /** The reply finished: whether it ended in an error, and Claude's own error text then. */
  | { type: 'done'; isError: boolean; error: string | null }
  /**
   * A reply Trace did not ask for has ended: one Claude Code started by itself, when a background task of its own
   * finished and told it so. For the conversation's display only: it closes that reply and its "is working" line as
   * `done` does. It is no turn's end, so a Round Table does not move on it, no task is marked and no handoff is asked for.
   * A Trace that does not know it leaves the thread as it is.
   */
  | { type: 'settled' }
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
  | { type: 'table'; table: RoundTableState | null; closed?: true;
    /** Tasks from Tasks the host just removed from a hierarchy table without starting them (dropped, or the table closed): the window puts them back in To do. */
    discarded?: string[] };
export type ChatEnvelope = { sessionId: string; runId: string; event: ChatEvent };

/**
 * A Round Table: the person, Claude Code and Codex in one conversation. It is led by a chat channel (the one it was
 * started from); the other agent is a partner chat run in the same folder. Every message goes to both; then each sees
 * the other's answer for up to `rounds` rounds, ending sooner when both agree. The driver edits files; the reviewer
 * reads (Claude's plan mode, Codex's read-only sandbox).
 */
/** The default models of a hierarchy table's Claude seats (the person can change them on its bar). */
/** Each seat's model when it starts, unless changed under Models: the reviewer's too, so it does not inherit whatever Codex's own settings default to. */
export const HIERARCHY_MODELS = { planner: 'claude-fable-5-2', builder: 'claude-opus-5-5', reviewer: 'gpt-6.1-sol' } as const;
/** Reviewer models a hierarchy no longer uses: a reviewer saved with one starts on HIERARCHY_MODELS.reviewer instead. */
export const RETIRED_REVIEWER_MODELS: readonly string[] = ['gpt-6-astra'];
/**
 * A hierarchy Round Table's step (electron/services/chat/review-chain.ts): challenging (the reviewer, Codex, challenges
 * the plan before the person sees it) and plan-responding (the planner answers the challenges) come between planning
 * and plan-review.
 */
export type ChainStep = 'idle' | 'planning' | 'challenging' | 'plan-responding' | 'plan-review' | 'implementing' | 'reviewing' | 'fixing' | 'final' | 'final-fixing' | 'done' | 'needs-you' | 'stopped';
/**
 * Whether a hierarchy step comes at or after the final review: the final review itself, or a fix or review it sent back.
 * What the person writes then is a follow-up, which the planner plans again, never straight to the builder.
 */
export function late(chain: { finalRound: number }, step: ChainStep | null | undefined): boolean {
  return step === 'final' || step === 'final-fixing' || ((step === 'fixing' || step === 'reviewing') && chain.finalRound > 0);
}
/** One of the reviewer's challenges to a plan, and the planner's answer to it. */
export interface PlanChallenge { id: string; severity: 'high' | 'medium' | 'low'; text: string; answer?: 'accepted' | 'rejected'; reason?: string }
/** Where a hierarchy table's work stands, kept with the table so a restart can pick it up. */
export interface SavedChain { step: ChainStep; stoppedAt?: ChainStep; /** The seat that said TASK BLOCKED: the person's answer goes back to it, also after a restart. */ blocked?: 'planner' | 'builder' | 'reviewer';
  /** From 1.26, by session id: the seat that said TASK BLOCKED (`blocked` still names its kind, for a Trace before 1.26), and the seat whose turn the step is (or was, when stopped): with several challengers or reviewers they take the step one after another. */
  blockedSeat?: string; turnSeat?: string; task: string; plan: string; report: string; reviewRound: number; finalRound: number; verdict: 'approved' | 'changes' | null; note: string;
  /** The reviewer's challenges to this task's plan, with the planner's answers; and whether this task's plan was already challenged (once per task). */
  challenges?: PlanChallenge[]; challenged?: true;
  /** Present while the planner writes the plan again after the final review (the person wrote meanwhile): the final review's request, '' when it had none. */
  replan?: string;
  /** Present while the planner revises a plan the person sent back: what the person asked for (with their later replies). */
  revision?: string;
  /** Why the message waiting could not join the task when the planner would have planned again (too long, too many images); it waits until dropped. */
  held?: string;
  /** Tasks from Tasks that arrived while the table worked, in order: each starts once the task before it is approved. */
  nextTasks?: string[];
  /** The task's images, up to KEEP_IMAGES of base64, so a step continued after a restart still has them. */
  images?: ChatImage[] }
export interface RoundTableState {
  /** hierarchy: planner, builder and reviewer in fixed steps (from 1.17); absent: the discussion table. */
  kind?: 'hierarchy';
  /**
   * Every seat, the lead first, with its name, instructions and (hierarchy) duties (shared/table-seats.ts; from 1.26).
   * `partner` and `planner` stay filled for a phone or linked computer on an older Trace: the first other seat, and the
   * hierarchy's planner. `driverSeat`: the session of the discussion seat that edits files (`driver` is its engine).
   * At a hierarchy `rounds` is its review rounds.
   */
  seats?: TableSeatState[]; driverSeat?: string;
  /** The hierarchy's planner and final reviewer (a Claude chat); `partner` is its reviewer (Codex), who also challenges the plan. */
  planner?: { sessionId: string; runId: string; engine: 'claude' };
  chain?: SavedChain;
  /** A hierarchy table was stopped and a seat's interrupted turn has not ended yet: Continue waits for it. */
  stopping?: boolean;
  /** `gemini` from 1.28: a Gemini CLI seat can be the first other seat. */
  partner: { sessionId: string; runId: string; engine: 'claude' | 'codex' | 'gemini' };
  driver: 'claude' | 'codex'; rounds: number; round: number;
  /** joining: the leading agent summarizes for the newcomer; answering: both answer the person; discussing: they answer each other. */
  /** `acting`: the discussion is over and the driver is carrying out what the person asked (from 1.29). */
  phase: 'joining' | 'answering' | 'discussing' | 'acting' | 'idle';
  /** The last discussion ended with both agents agreeing. */
  agreed: boolean;
  /** The review record: what the reviewer reported and what became of each (shared/findings.ts). Missing from Trace before 1.17. */
  findings?: import('./findings').Finding[];
  /** The text of a message waiting for the agents; after a restart it waits for the person to send or drop it. */
  waiting?: string; waitingKept?: boolean;
  /** Its images, when small enough to keep through a restart; otherwise how many would be lost. */
  waitingImages?: ChatImage[]; waitingImagesDropped?: number;
  /** What phones and linked computers get instead of waitingImages (forFollowers): how many there are, not their data. */
  waitingImageCount?: number;
}
/** How many images a waiting message has: their data on the owning computer, only the count on a phone or linked computer. */
export const waitingImageCount = (table: Pick<RoundTableState, 'waitingImages' | 'waitingImageCount'> | undefined) => table?.waitingImages?.length ?? table?.waitingImageCount ?? 0;
export const ROUND_TABLE_MAX_ROUNDS = 5;
export type ChatRequest =
  | { action: 'send'; sessionId: string; runId: string; text: string; images: ChatImage[] }
  | { action: 'answer'; sessionId: string; runId: string; requestId: string; allow: boolean; allowEdits?: boolean }
  | { action: 'interrupt'; sessionId: string; runId: string }
  /** What the agent may do without asking, from now on (this computer's window only). */
  | { action: 'permissions'; sessionId: string; runId: string; level: PermissionLevel }
  /** Seats a partner chat run (another engine, same folder) at this chat's Round Table. */
  | { action: 'table-open'; sessionId: string; runId: string; partner: { sessionId: string; runId: string }; driver: 'claude' | 'codex'; rounds: number; findings?: import('./findings').Finding[]; waiting?: string; waitingImages?: ChatImage[]; kind?: 'hierarchy'; planner?: { sessionId: string; runId: string }; chain?: SavedChain;
    /** From 1.26: every seat, the lead's own entry included (in any place), with what the person set for each; `partner` and `planner` are then not read. Absent: Claude Code with Codex, or planner, builder and reviewer, as before 1.26. */
    seats?: SeatReference[]; driverSeat?: string;
    /** A saved table seated again (after a restart, or a seat started again): both conversations resumed, so no joining summary. */
    rejoin?: true }
  /** A hierarchy table's plan: approve it (the builder starts), or send it back with what to change. */
  | { action: 'table-plan'; sessionId: string; runId: string; approve: boolean; note: string }
  /** Picks a stopped hierarchy table up at its step; `skipChallenge`: a stopped challenge is left out instead. */
  | { action: 'table-continue'; sessionId: string; runId: string; skipChallenge?: boolean }
  /** A message kept from before a restart: send it now, or drop it. */
  | { action: 'table-waiting'; sessionId: string; runId: string; send: boolean }
  /** Removes a task from Tasks waiting at a hierarchy table: the one at `index`, only if it still starts with `head`. */
  | { action: 'table-next-drop'; sessionId: string; runId: string; index: number; head: string }
  | { action: 'table-send'; sessionId: string; runId: string; text: string; images: ChatImage[] }
  /** `seat`: the session of the seat that edits from now on (from 1.26; `driver`, its engine, is read only without it). */
  | { action: 'table-driver'; sessionId: string; runId: string; driver: 'claude' | 'codex'; seat?: string }
  /**
   * The table's seats from now on (from 1.26): seats added (running chats in the same folder and window) or removed,
   * and each one's name, instructions and duties. Refused while the table works: a discussion table must be idle, a
   * hierarchy between tasks (idle or done) to add, remove or change duties, and at rest to change names or instructions.
   * The lead stays. Every seat is told about the table again with its next message.
   */
  | { action: 'table-seats'; sessionId: string; runId: string; seats: SeatReference[]; driverSeat?: string }
  | { action: 'table-rounds'; sessionId: string; runId: string; rounds: number }
  /** Stops both agents and the discussion; the table stays open. */
  | { action: 'table-stop'; sessionId: string; runId: string }
  | { action: 'table-close'; sessionId: string; runId: string };

/** The longest piece of a tool's output shown in the thread; the rest stays in Claude's own transcript. */
export const TOOL_RESULT_LIMIT = 4000;

/** Starts of the prompts Trace itself sends a hierarchy Round Table's builder (review-chain.ts, round-table.ts); a person's own "[WIP] …" message is not one. */
const TRACE_PROMPT = /^\[(Step: |Trace Round Table|The person answers\])/;
export function isTracePrompt(text: string): boolean { return TRACE_PROMPT.test(text); }
