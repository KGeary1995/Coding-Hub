/** These contracts describe local CLI configuration, never direct API requests. */
export type CLIEngine = 'claude' | 'codex';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ClaudeCLIEngineConfig {
  engine: 'claude';
  model: string;
  thinking: { budget_tokens: number | null };
  tokenLimits: {
    maxOutputTokens: number | null;
    maxSessionTokens: number | null;
  };
}

export interface CodexCLIEngineConfig {
  engine: 'codex';
  model: string;
  reasoningEffort: ReasoningEffort | null;
}

/** A discriminated union keeps one engine's settings out of the other's adapter. */
export type CLIEngineConfig = ClaudeCLIEngineConfig | CodexCLIEngineConfig;

export type SessionStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'exited' | 'error';
export type WorkspaceBinding =
  | { mode: 'workspace' }
  | { mode: 'independent'; cwd: string };

export interface Session {
  id: string;
  title: string;
  config: CLIEngineConfig;
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
  sessions: Pick<Session, 'id' | 'title' | 'config' | 'binding' | 'createdAt'>[];
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
