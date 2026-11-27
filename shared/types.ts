/** These contracts describe local CLI configuration, never direct API requests. */
export type CLIEngine = 'claude' | 'codex' | 'gemini';
export type ReasoningEffort = string;
/**
 * What an agent may do without asking (absent: DEFAULT_PERMISSIONS, edits). ask: the CLI's own settings. edits: Claude's acceptEdits;
 * Codex asks only when it needs to (on-request) and writes in the workspace. full: no prompts at all (Claude's
 * bypassPermissions; Codex never asks, full access).
 */
export type PermissionLevel = 'ask' | 'edits' | 'full';

export interface ClaudeCLIEngineConfig {
  engine: 'claude';
  resumeId?: string;
  /** A chat channel: Claude Code in structured mode, drawn by Trace as a conversation (with images) instead of a terminal. */
  chat?: boolean;
  /** Absent selects the existing host CLI login; named profiles are host-owned IDs. */
  accountProfileId?: string;
  permissions?: PermissionLevel;
  /** Claude in Chrome (`--chrome`): the browser extension's tools, acting in the person's own Chrome with its sign-ins. */
  chrome?: boolean;
  /** The shared memory project this channel reads and writes, chosen by the person; absent uses the folder's automatic key. */
  memoryKey?: string;
  model: string;
  thinking: { budget_tokens: number | null };
  tokenLimits: {
    maxOutputTokens: number | null;
    maxSessionTokens: number | null;
  };
}

export interface CodexCLIEngineConfig {
  engine: 'codex';
  resumeId?: string;
  /** A chat channel: Codex's app server, drawn by Trace as a conversation (with images) instead of a terminal. */
  chat?: boolean;
  permissions?: PermissionLevel;
  /** The shared memory project this channel reads and writes, chosen by the person; absent uses the folder's automatic key. */
  memoryKey?: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
}

/**
 * Gemini (`agy`): a terminal channel, or from 1.39 a chat channel that leads a Round Table. Shared memory and the
 * channel tools come from Trace's agy plugin (gemini-plugin.ts; the person's decision of 2026-11-24), always with the
 * folder's own memory key (no `memoryKey`). From 1.28 it can also sit at a Round Table (`chat`), as the person asked on
 * 2026-11-22 (1.20 had a fixed Gemini seat, removed in 1.21); from 1.39 it can lead a table and be the seat that edits
 * (the person's decision of 2026-11-24).
 * `model` is an agy model ID, which names its effort too (gemini-4-neon-high); empty uses agy's own default.
 */
export interface GeminiCLIEngineConfig {
  engine: 'gemini';
  /**
   * A chat run: Gemini's agent protocol server (`agy acp`) instead of its terminal (GeminiStream). A Round Table seat
   * (from 1.28), or from 1.39 the chat channel that leads a table (it stays a chat channel once the table closes). Plan
   * mode while it is read-only at a table, else the mode of its permission level. Its memory tools come from Trace's agy
   * plugin; as a chat it takes tasks, read from its chat thread (isChatEngineConfig stays false for it); + Channel does not offer it.
   */
  chat?: boolean;
  /** agy's conversation ID (`--conversation`). */
  resumeId?: string;
  permissions?: PermissionLevel;
  model: string;
}

/** A discriminated union keeps one engine's settings out of the other's adapter. */
export type CLIEngineConfig = ClaudeCLIEngineConfig | CodexCLIEngineConfig | GeminiCLIEngineConfig;
/** The engines with chat channels, shared memory, tasks and Round Table seats. */
export type ChatEngine = 'claude' | 'codex';
/** The agents that can sit at a Round Table, in any seat: the chat engines, Gemini CLI, and custom agents that speak ACP (phase 2). */
export type SeatEngine = ChatEngine | 'gemini' | 'custom';
/** The seat engine of a channel's config (a terminal reads as Claude, as the table code always took it). */
export const seatEngineOf = (config: ChannelConfig): SeatEngine => config.engine === 'codex' ? 'codex' : config.engine === 'gemini' ? 'gemini' : config.engine === 'custom' ? 'custom' : 'claude';
/** A run driven through its structured protocol and drawn (or seated) by Trace, not a terminal: a chat channel, or a Gemini or custom agent's ACP chat. */
export const isChatRun = (config: ChannelConfig): boolean => isAgentConfig(config) && config.chat === true;
export type ChatEngineConfig = ClaudeCLIEngineConfig | CodexCLIEngineConfig;

/**
 * A custom agent (docs/custom-agents.md, 1.40.0): a terminal running a CLI the person added as a definition
 * (~/.coding-hub/agents/<agentId>.json). The window names only the agent; the host reads its definition and builds the
 * launch. `model` is '' for the program's own default; `resumeId` is the conversation its resume arguments take.
 */
export interface CustomChannelConfig { engine: 'custom'; agentId: string; model: string; permissions?: PermissionLevel; resumeId?: string;
  /** Phase 2: a chat run, the program started as an Agent Client Protocol server (`acp` in its definition; AcpStream), as a chat channel or a Round Table seat. `resumeId` is then its ACP session. */
  chat?: boolean }
/** Every agent a channel can run: the built-in CLIs and custom agents. */
export type AgentConfig = CLIEngineConfig | CustomChannelConfig;

/** A plain terminal: the login shell (zsh, bash) or PowerShell in the channel's folder. No agent, model or usage. */
/** `plugin`: a plugin tile (docs/plugins.md), which runs that plugin's tile program instead of a shell. The window names
 * only the plugin and the tile; the main process finds the command in the installed manifest. */
export interface ShellChannelConfig { engine: 'shell'; plugin?: { id: string; tile: string } }
export type ChannelEngine = CLIEngine | 'custom' | 'shell';
export type ChannelConfig = AgentConfig | ShellChannelConfig;
/** An agent (Claude Code, Codex, Gemini CLI or a custom agent): model, permissions, resume and notices. */
export const isAgentConfig = (config: ChannelConfig): config is AgentConfig => config.engine !== 'shell';
/** One of the built-in agent CLIs, whose launch, usage and conversation files Trace knows. */
export const isBuiltInAgent = (config: ChannelConfig): config is CLIEngineConfig => config.engine === 'claude' || config.engine === 'codex' || config.engine === 'gemini';
/** Claude Code or Codex: an agent that also has chat, shared memory, tasks and Round Table seats. */
export const isChatEngineConfig = (config: ChannelConfig): config is ChatEngineConfig => config.engine === 'claude' || config.engine === 'codex';
export const isChatEngine = (engine: string): engine is ChatEngine => engine === 'claude' || engine === 'codex';
/** An agent terminal whose conversation Trace can't read (Gemini CLI, a custom agent): a task's outcome is read from its screen. */
export const readsFromScreen = (engine: ChannelEngine) => engine === 'gemini' || engine === 'custom';

export type SessionStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'exited' | 'error';
export type WorkspaceBinding =
  | { mode: 'workspace' }
  | { mode: 'independent'; cwd: string };

/** A Round Table this chat channel leads, kept with the workspace so it is opened again when both chats run after a restart. */
export interface SavedRoundTable { partner: string; driver: SeatEngine; rounds: number;
  /** From 1.26: every seat (the lead too) with its name, instructions and duties, and the discussion seat that edits; absent in a table saved before (shared/table-seats.ts savedSeats). `partner` stays the first other seat. */
  seats?: import('./table-seats').SavedSeat[]; driverSeat?: string;
  /** A hierarchy table: its planner session, and where its work stands. */ kind?: 'hierarchy'; planner?: string; chain?: import('./chat').SavedChain; /** Kept across restarts: the review record, and a message that was waiting for the agents (its text only). */ findings?: import('./findings').Finding[]; waiting?: string; waitingImages?: import('./chat').ChatImage[] }
export interface Session {
  roundTable?: SavedRoundTable;
  budget?: import('./productivity').SessionBudget;
  preparedRequest?: import('./productivity').PreparedSessionRequest;
  /** Its step in Start in order (shared/start-order.ts). */
  startup?: import('./start-order').StartStep;
  id: string;
  title: string;
  config: ChannelConfig;
  binding: WorkspaceBinding;
  status: SessionStatus;
  pid: number | null;
  runId: string | null;
  runningCwd: string | null;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
  exitCode: number | null;
  logFile: string | null;
  /** Set while the CLI waits for the person (for example a permission prompt); cleared by their next input. Never saved. */
  attention?: { message: string; at: string } | null;
  /** Its agent finished a turn while the person was not looking at it, and they have not looked since (1.32.1). Never saved. */
  unseen?: boolean;
}

export interface GridTile {
  /** react-grid-layout uses the session ID as its item key. */
  sessionId: Session['id'];
  x: number;
  y: number;
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export type MCPTransport =
  | { type: 'stdio'; command: string; args: string[]; envVariableNames: string[] }
  | { type: 'http' | 'sse'; url: string; headerSecretNames: string[] };

export interface MCPConfig {
  id: string;
  name: string;
  engine: CLIEngine;
  enabled: boolean;
  transport: MCPTransport;
  source: {
    path: string;
    scope: 'user' | 'project';
    format: 'json' | 'toml';
  };
  status: 'unknown' | 'connected' | 'disconnected' | 'error';
  /** Discovery must retain unknown fields when a later adapter edits the file. */
  extra?: Record<string, unknown>;
}

export interface UsageTelemetry {
  id: string;
  sessionId: Session['id'];
  timestamp: string;
  engine: CLIEngine;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Thinking/reasoning can be included in output; do not blindly sum both. */
  reasoningTokens: number | null;
  reasoningIncludedInOutput: boolean | null;
  context: { usedTokens: number; limitTokens: number } | null;
  estimatedCostUSD: number | null;
  pricingVersion: string | null;
  source: 'cli-structured-event' | 'cli-stream-parser';
}

export interface Workspace {
  id: string;
  name: string;
  rootDirectory: string | null;
  sessions: Session[];
  tiles: GridTile[];
}

export interface LocalExtension {
  id: string;
  engine: CLIEngine;
  name: string;
  path: string;
  kind: 'memory' | 'skill' | 'plugin' | 'hook';
  scope: 'user' | 'project';
}

/** Settings only: process references are never trusted across application restarts. */
export interface SavedWorkspace {
  version: 1;
  rootDirectory: string | null;
  sessions: Pick<Session, 'id' | 'title' | 'config' | 'binding' | 'createdAt' | 'budget' | 'preparedRequest' | 'roundTable' | 'startup'>[];
  tiles: GridTile[];
  layoutMode: 'columns' | 'rows' | 'grid';
  focusedSessionId: string | null;
}

export interface StorageInfo {
  databasePath: string;
  logsDirectory: string;
  maxLogBytes: number;
  maxCompletedRuns: number;
  retentionDays: number;
}

export interface SessionHistoryRun {
  runId: string;
  sessionId: string;
  /** From 1.40 also a custom agent's run (docs/custom-agents.md). */
  engine: CLIEngine | 'custom';
  config: AgentConfig;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'interrupted';
  exitCode: number | null;
  recordedBytes: number;
  logTruncated: boolean;
}

export interface RunLog {
  runId: string;
  text: string;
  tailOnly: boolean;
  logTruncated: boolean;
}

export interface RepositoryContext {
  id: string;
  directory: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  limited: boolean;
}

export interface FilePreview {
  path: string;
  text: string | null;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | null;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export interface GitChange {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
  conflicted: boolean;
  submodule: boolean;
}

export interface GitStatus {
  root: string;
  branch: string | null;
  head: string | null;
  /** The branch it pushes to and how far apart they are (Git's own count, as of the last fetch); absent with no upstream (1.31.3). */
  upstream?: string; ahead?: number; behind?: number;
  changes: GitChange[];
  limited: boolean;
}

export type DiffArea = 'working' | 'staged' | 'untracked';
export interface GitFileDiff {
  path: string;
  area: DiffArea;
  patch: string;
  binary: boolean;
  truncated: boolean;
  conflicted: boolean;
}

/** A branch, remote-tracking branch or tag pointing at a commit in the history; `current` marks the checked-out branch. */
export interface GitRef { name: string; kind: 'branch' | 'remote' | 'tag'; current?: true }
export interface GitCommit { sha: string; parents: string[]; author: string; date: string; subject: string; refs: GitRef[] }
/** Changes → History: HEAD, the local branches and their upstreams, newest first; `limited` when more commits exist than were read. */
export interface GitLog { head: string | null; branch: string | null; commits: GitCommit[]; limited: boolean }
export interface GitCommitFile { path: string; originalPath: string | null; additions: number | null; deletions: number | null }
/** One commit's full message and its files against its first parent (a merge's own changes onto the branch it joined). */
export interface GitCommitDetail { sha: string; parents: string[]; author: string; date: string; message: string; files: GitCommitFile[]; limited: boolean }
/**
 * How long after a request typed into an agent's terminal its Enter is sent, on its own. Claude Code takes a burst of
 * input as a paste, in which Enter is a new line: a request written with its Enter in one write was left in its prompt
 * unsent 3 times in 5 (2.1.332, 2026-11-25), and every time sent once the Enter came 200 ms later.
 */
export const SUBMIT_DELAY_MS = 200;
/**
 * A request as it is typed into an agent's terminal: a bracketed paste when the program asked for one (mode 2004), so it
 * knows where the paste ends and the Enter after it sends, however long the text. A paste end inside the text is
 * dropped, so the text cannot end the paste early and type the rest as keys.
 */
export const typedRequest = (text: string, bracketed: boolean) => bracketed ? `\x1b[200~${text.replace(/\x1b\[20[01]~/g, '')}\x1b[201~` : text;
/**
 * How long its Enter waits. Typed as keys, a long request is taken in as one paste burst for longer: 4,000 characters
 * sent to a Codex terminal (2026-11-27) were still being taken in after 200 ms, so their Enter became a new line.
 */
export const submitDelay = (text: string, bracketed: boolean) => bracketed ? SUBMIT_DELAY_MS : Math.min(2000, SUBMIT_DELAY_MS + Math.ceil(text.length / 4));
