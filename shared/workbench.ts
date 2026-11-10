export interface RuntimeInfo { version: string; rendererVersion: string; edition: 'source' | 'installed' | 'portable'; executable: string; applicationPath: string; storagePath: string; platform: string; restartRequired: boolean }
export interface DiagnosticStep { name: string; state: 'passed' | 'failed' | 'unverified'; message: string; recovery: string }
export interface DiagnosticReport { engine: 'claude' | 'codex'; checkedAt: string; steps: DiagnosticStep[] }
export interface CodexModel { model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean; reasoningEfforts: string[] }
export interface CodexModelCatalog { models: CodexModel[]; checkedAt: string; source: 'codex-app-server'; directory: string }
export interface HostHealthReport { previousShutdown: 'clean' | 'unclean' | 'unknown'; events: { time: string; event: string; reason: string | null; exitCode: number | null }[] }
export interface NativeConversation { key: string; id: string; engine: 'claude' | 'codex'; profileId?: string; directory: string | null; title: string; modifiedAt: string }
export interface NativeResume { conversation: NativeConversation; directory: string }
export interface Experiment { id: string; name: string; hypothesis: string; criterion: string; promptA: string; promptB: string; createdAt: string }
export interface Trial { id: string; experimentId: string; variant: 'A' | 'B'; runId: string | null; minutes: number; rework: number; outcome: 'successful' | 'partial' | 'failed'; evidence: string; createdAt: string }
export interface ExperimentsData { experiments: Experiment[]; trials: Trial[] }
export interface BackupRecord { id: string; createdAt: string; appVersion: string; files: number; bytes: number; includesLogs: boolean }
export interface BackupResult { record: BackupRecord; restoredPath?: string; restartRequired?: boolean }
/** `sentAt` and `baseline` (the project's changed files then) are set when the task is sent to its channel. `designRef` linked a task to an annotation in the removed Design workspace; older saved tasks may still carry it. */
export interface Task { designRef?: { snapshotId: string; annotationId: string }; id: string; title: string; details?: string; directory: string; sessionId: string | null; scope: string[]; status: 'queued' | 'active' | 'review' | 'done'; notes: string; verificationId: string | null; createdAt: string; sentAt?: string; baseline?: Record<string, string>; /** Why Trace moved or flagged it on its own; cleared when it is sent again or moved by hand. */ outcome?: TaskOutcome; /** What a blocked agent said it needs (TASK BLOCKED: …). */ outcomeNote?: string; /** This send's id (t-xxxxxxxx), in its prompt: replies after it are this send's. */ sendId?: string; /** The pull request Trace opened from this task's folder while it was open (Changes → Delivery). */ pullRequest?: string }
/** A task's folder as Git has it now: branch and commit (task-detail). */
export interface TaskDetail { branch: string | null; head: string | null }
/** finished: the agent ended its turn. quiet: a CLI that does not report turns drew nothing for 45 s. stopped / failed: the channel ended while the task was being worked on. */
export type TaskOutcome = 'finished' | 'quiet' | 'stopped' | 'failed' | 'blocked' | 'unconfirmed';
export interface TaskSent { task: Task; prompt: string }
export interface TaskWarning { taskIds: string[]; text: string }
/** Each open task's changed files since it was sent, and what needs the person. */
export interface TaskWatch { changed: Record<string, string[]>; warnings: TaskWarning[] }
export interface TaskAudit { tasks: Task[]; overlaps: string[]; changes: { directory: string; path: string; tasks: string[]; outsideScope: boolean }[]; warnings: string[] }
export type VerificationTool = 'npm' | 'pnpm' | 'yarn' | 'python' | 'cargo' | 'go' | 'dotnet';
export interface VerificationStep { label: string; tool: VerificationTool; args: string[] }
export interface VerificationProfile { id: string; name: string; directory: string; steps: VerificationStep[]; timeoutSeconds: number; createdAt: string }
export interface VerificationResult { id: string; profileId: string; directory: string; profileName: string; startedAt: string; endedAt: string; passed: boolean; cancelled: boolean; steps: { label: string; exitCode: number | null; output: string; timedOut: boolean; truncated: boolean }[]; /** The files the check ran on (repositoryState), and whether they changed while it ran. Missing for results recorded before 1.17 and outside Git. */ tested?: { state: string; changedDuring: boolean } }
/** Whether each recorded result still describes the project's files: current, changed since, or unknown (no record, or not a Git repository). */
export type VerificationFreshness = Record<string, 'current' | 'changed' | 'unknown'>
export interface VerificationData { profiles: VerificationProfile[]; results: VerificationResult[]; running: boolean }
export type WorkbenchRequest = import('./remote').RemoteRequest | import('./remote').LinkedComputerRequest | { action: 'plan-limits'; force?: boolean } | { action: 'usage-today' } | { action: 'usage-days' }
  /** A channel's whole conversation across restarts (ChannelTranscript). */
  | { action: 'channel-transcript'; sessionId: string }
 | import('./productivity').WorkflowRequest
 | { action: 'runtime' } | { action: 'restart' }
 | { action: 'codex-models'; directory: string | null }
 | { action: 'host-health' }
 | { action: 'diagnose'; engine: 'claude' | 'codex'; directory: string | null; profileId?: string }
 | { action: 'native-list' } | { action: 'native-resume'; key: string; directory?: string }
 | { action: 'experiment-list' } | { action: 'experiment-save'; name: string; hypothesis: string; criterion: string; promptA: string; promptB: string }
 | { action: 'trial-add'; experimentId: string; variant: 'A' | 'B'; runId: string | null; minutes: number; rework: number; outcome: Trial['outcome']; evidence: string }
 | { action: 'backup-list' } | { action: 'backup-create'; includeLogs: boolean } | { action: 'backup-export'; id: string } | { action: 'backup-restore'; id: string } | { action: 'backup-import' }
 | { action: 'task-list' } | { action: 'task-save'; id?: string; title: string; details?: string; directory: string; sessionId: string | null; scope: string[]; status: Task['status']; notes: string; verificationId: string | null } | { action: 'task-audit' } | { action: 'task-watch' } | { action: 'task-send'; id: string } | { action: 'task-remove'; id: string } | { action: 'task-status'; id: string; status: Task['status']; outcome?: TaskOutcome; outcomeNote?: string } | { action: 'task-detail'; id: string } | { action: 'task-pr'; id: string; url: string }
 | { action: 'verification-list' } | { action: 'verification-save'; id?: string; name: string; directory: string; steps: VerificationStep[]; timeoutSeconds: number } | { action: 'verification-run'; id: string } | { action: 'verification-cancel' } | { action: 'verification-fresh' };
export type WorkbenchResponse = import('./remote').ChatReplay | import('./remote').RemoteStatus | import('./remote').LinkedComputer[] | import('./remote').LinkedScreenState | import('./remote').ChannelTranscript | import('./plan-limits').PlanLimits[] | import('./hub').DayUsage | TaskSent | TaskWatch | TaskDetail | { message: string } | import('./hub').LogUsage | import('./productivity').WorkflowResponse | RuntimeInfo | DiagnosticReport | CodexModelCatalog | HostHealthReport | NativeConversation[] | NativeResume | ExperimentsData | Experiment | Trial | BackupRecord[] | BackupResult | Task[] | Task | TaskAudit | VerificationFreshness | VerificationData | VerificationProfile | VerificationResult | null;
