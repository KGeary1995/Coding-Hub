import type { ChannelControl, LinkedComputerEvent } from './remote';
import type { WorkbenchRequest, WorkbenchResponse } from './workbench';
import type { CoachingRequest, CoachingResponse } from './coaching';
import type { DesignRequest, DesignResponse } from './design';
import type { ProjectRequest, ProjectResponse } from './projects';
import type { AccountRequest, AccountResponse, AccountEvent } from './accounts';
import type { ChannelConfig, ChannelEngine, CLIEngine, SavedWorkspace, StorageInfo, SessionHistoryRun, RunLog, RepositoryContext, DirectoryListing, FilePreview, GitStatus, GitFileDiff, DiffArea } from './types';
import type { ProjectCheckRequest, ProjectAudit, CheckResult } from './project-checks';
import type { ProjectToolsRequest, ProjectToolsResponse } from './project-tools';
import type { UpdateRequest, UpdateStatus } from './updates';
import type { HubRequest, HubResponse, UsageRecord } from './hub';

export interface HostError { code: string; message: string }
export type HostResult<T> = { ok: true; value: T } | { ok: false; error: HostError };
export interface EngineInfo {
  engine: CLIEngine;
  available: boolean;
  executable: string | null;
  version: string | null;
  supportsResume?: boolean;
  supportsModel: boolean;
  supportsConfig: boolean;
  supportsNoDaemon: boolean;
  supportsSessionId?: boolean;
  supportsAppendSystemPrompt?: boolean;
  supportsMcpConfig?: boolean;
  supportsSettings?: boolean;
  authentication?: { state: 'authenticated' | 'not-authenticated' | 'unknown'; checkedAt: string; message: string };
  checkedAt?: string;
  error: string | null;
}
export interface StartSessionRequest {
  sessionId: string;
  cwd: string;
  config: ChannelConfig;
  cols: number;
  rows: number;
}
export interface RunReference { sessionId: string; runId: string }
export interface RunningSession extends RunReference { accountProfileId?: string; pid: number; cwd: string; engine: ChannelEngine }
/** A run of Claude Code or Codex, which usage, memory and history follow; Terminal channels never reach them. */
export type AgentRunningSession = RunningSession & { engine: CLIEngine };
export type SessionEvent =
  | ({ type: 'started' } & RunningSession)
  | ({ type: 'data'; data: string } & RunReference)
  | ({ type: 'exit'; diagnostic?: string; exitCode: number; signal?: number } & RunReference)
  | ({ type: 'error'; message: string } & RunReference)
  /** The CLI is waiting for the person (for example a permission prompt). Cleared by their next input. */
  /** `at` is when the host saw the request, so a later answer from a phone can be ordered against it. */
  | ({ type: 'attention'; message: string; at: string } & RunReference)
  /** The person typed into the CLI from a paired phone; clears a waiting prompt raised before `at`. */
  | ({ type: 'answered'; at: string } & RunReference);

/** Launch known engines, never renderer-supplied executables or shell commands. */
export interface CodingHubHost {
  workbench(request: WorkbenchRequest): Promise<HostResult<WorkbenchResponse>>;
  coaching(request: CoachingRequest): Promise<HostResult<CoachingResponse>>;
  designs(request: DesignRequest): Promise<HostResult<DesignResponse>>;
  projects(request: ProjectRequest): Promise<HostResult<ProjectResponse>>;
  accounts(request: AccountRequest): Promise<HostResult<AccountResponse>>;
  onAccountEvent(listener: (event: AccountEvent) => void): () => void;
  projectChecks(request: ProjectCheckRequest): Promise<HostResult<ProjectAudit | CheckResult>>;
  projectTools(request: ProjectToolsRequest): Promise<HostResult<ProjectToolsResponse>>;
  updates(request: UpdateRequest): Promise<HostResult<UpdateStatus>>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  hub(request: HubRequest): Promise<HostResult<HubResponse>>;
  onUsage(listener: (usage: UsageRecord) => void): () => void;
  openRepository(request: { directory: string }): Promise<HostResult<RepositoryContext>>;
  closeRepository(request: { repositoryId: string }): Promise<HostResult<null>>;
  listDirectory(request: { repositoryId: string; path: string }): Promise<HostResult<DirectoryListing>>;
  readFile(request: { repositoryId: string; path: string }): Promise<HostResult<FilePreview>>;
  gitStatus(request: { repositoryId: string }): Promise<HostResult<GitStatus>>;
  gitDiff(request: { repositoryId: string; path: string; area: DiffArea }): Promise<HostResult<GitFileDiff>>;
  loadWorkspace(): Promise<HostResult<{ workspace: SavedWorkspace | null; info: StorageInfo }>>;
  saveWorkspace(workspace: SavedWorkspace): Promise<HostResult<null>>;
  listHistory(): Promise<HostResult<SessionHistoryRun[]>>;
  readRunLog(request: { runId: string }): Promise<HostResult<RunLog>>;
  onStorageError(listener: (message: string) => void): () => void;
  onWorkspaceFlush(listener: (requestId: string) => void): () => void;
  finishWorkspaceFlush(request: { requestId: string; workspace?: SavedWorkspace }): Promise<HostResult<null>>;
  pickDirectory(): Promise<string | null>;
  discoverEngines(): Promise<HostResult<EngineInfo[]>>;
  startSession(request: StartSessionRequest): Promise<HostResult<RunningSession>>;
  writeSession(request: RunReference & { data: string }): Promise<HostResult<null>>;
  resizeSession(request: RunReference & { cols: number; rows: number }): Promise<HostResult<null>>;
  /** The window drew this much of a run's output (flow control). */
  ackSession(request: RunReference & { bytes: number }): Promise<HostResult<null>>;
  stopSession(request: RunReference): Promise<HostResult<null>>;
  onSessionEvent(listener: (event: SessionEvent) => void): () => void;
  clipboardImage(): Promise<HostResult<ClipboardImage | null>>;
  onLinkedEvent(listener: (event: LinkedComputerEvent) => void): () => void;
  /** A linked computer asks this window to start, stop or restart a channel; answer with finishRemoteControl. */
  onRemoteControl(listener: (request: { requestId: string; sessionId: string; control: ChannelControl }) => void): () => void;
  finishRemoteControl(result: { requestId: string; error?: string }): Promise<HostResult<null>>;
  /** The local path of a file dropped on the page, or '' when it has none. */
  pathForFile(file: File): string;
}
/** An image on the system clipboard, as PNG data URLs: a small one for the strip and one capped at 2000px to enlarge. */
export interface ClipboardImage { thumbnail: string; full: string; width: number; height: number; hasText: boolean }
export const IPC_CHANNELS = {
  workbench: 'coding-hub:workbench',
  coaching: 'coding-hub:coaching',
  designs: 'coding-hub:designs',
  projects: 'coding-hub:projects',
  accounts: 'coding-hub:accounts',
  accountEvent: 'coding-hub:account-event',
  projectChecks: 'coding-hub:project-checks',
  projectTools: 'coding-hub:project-tools',
  updates: 'coding-hub:updates',
  updateStatus: 'coding-hub:update-status',
  hub: 'coding-hub:hub',
  usage: 'coding-hub:usage',
  openRepository: 'coding-hub:open-repository',
  closeRepository: 'coding-hub:close-repository',
  listDirectory: 'coding-hub:list-directory',
  readFile: 'coding-hub:read-file',
  gitStatus: 'coding-hub:git-status',
  gitDiff: 'coding-hub:git-diff',
  loadWorkspace: 'coding-hub:load-workspace',
  saveWorkspace: 'coding-hub:save-workspace',
  listHistory: 'coding-hub:list-history',
  readRunLog: 'coding-hub:read-run-log',
  storageError: 'coding-hub:storage-error',
  workspaceFlush: 'coding-hub:workspace-flush',
  finishWorkspaceFlush: 'coding-hub:finish-workspace-flush',
  pickDirectory: 'coding-hub:pick-directory',
  discoverEngines: 'coding-hub:discover-engines',
  startSession: 'coding-hub:start-session',
  writeSession: 'coding-hub:write-session',
  resizeSession: 'coding-hub:resize-session',
  ackSession: 'coding-hub:ack-session',
  stopSession: 'coding-hub:stop-session',
  sessionEvent: 'coding-hub:session-event',
  clipboardImage: 'coding-hub:clipboard-image',
  linkedEvent: 'coding-hub:linked-event',
  remoteControl: 'coding-hub:remote-control',
  finishRemoteControl: 'coding-hub:finish-remote-control',
} as const;
