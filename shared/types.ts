/** These contracts describe local CLI configuration, never direct API requests. */
export type CLIEngine = 'claude' | 'codex';
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

/** A discriminated union keeps one engine's settings out of the other's adapter. */
export type CLIEngineConfig = ClaudeCLIEngineConfig | CodexCLIEngineConfig;

/** A plain terminal: the login shell (zsh, bash) or PowerShell in the channel's folder. No agent, model or usage. */
export interface ShellChannelConfig { engine: 'shell' }
/**
 * Gemini CLI (`agy`) running in a terminal tile. Kept apart from CLIEngine on purpose: code written for Claude and Codex
 * often says `engine === 'claude' ? … : …` and would treat a third agent as Codex. A Gemini channel has no chat, resume,
 * usage, memory or Round Table seat; it is the real CLI in a terminal. The model is always GEMINI_MODEL (shared/gemini.ts).
 */
export interface GeminiChannelConfig { engine: 'gemini'; model: string; permissions?: PermissionLevel }
export type ChannelEngine = CLIEngine | 'gemini' | 'shell';
export type ChannelConfig = CLIEngineConfig | GeminiChannelConfig | ShellChannelConfig;
/** Claude Code or Codex: the channels with chat, resume, usage, memory, tasks and Round Table seats. */
export const isAgentConfig = (config: ChannelConfig): config is CLIEngineConfig => config.engine === 'claude' || config.engine === 'codex';

export type SessionStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'exited' | 'error';
export type WorkspaceBinding =
  | { mode: 'workspace' }
  | { mode: 'independent'; cwd: string };

/** A Round Table this chat channel leads, kept with the workspace so it is opened again when both chats run after a restart. */
export interface SavedRoundTable { partner: string; driver: 'claude' | 'codex'; rounds: number; /** A hierarchy table: its planner session, and where its work stands. */ kind?: 'hierarchy'; planner?: string; chain?: import('./chat').SavedChain; /** Kept across restarts: the review record, and a message that was waiting for the agents (its text only). */ findings?: import('./findings').Finding[]; waiting?: string; waitingImages?: import('./chat').ChatImage[] }
export interface Session {
  roundTable?: SavedRoundTable;
  budget?: import('./productivity').SessionBudget;
  preparedRequest?: import('./productivity').PreparedSessionRequest;
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
  sessions: Pick<Session, 'id' | 'title' | 'config' | 'binding' | 'createdAt' | 'budget' | 'preparedRequest' | 'roundTable'>[];
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
  engine: CLIEngine;
  config: CLIEngineConfig;
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
