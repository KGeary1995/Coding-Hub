export interface RuntimeInfo { version: string; rendererVersion: string; edition: 'source' | 'installed' | 'portable'; executable: string; applicationPath: string; storagePath: string; platform: string; restartRequired: boolean }
export interface DiagnosticStep { name: string; state: 'passed' | 'failed' | 'unverified'; message: string; recovery: string }
export interface DiagnosticReport { engine: 'claude' | 'codex'; checkedAt: string; steps: DiagnosticStep[] }
export interface CodexModel { model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean; reasoningEfforts: string[] }
export interface CodexModelCatalog { models: CodexModel[]; checkedAt: string; source: 'codex-app-server'; directory: string }
export interface HostHealthReport { previousShutdown: 'clean' | 'unclean' | 'unknown'; events: { time: string; event: string; reason: string | null; exitCode: number | null }[] }
export interface NativeConversation { key: string; id: string; engine: 'claude' | 'codex'; profileId?: string; directory: string | null; title: string; modifiedAt: string }
export interface NativeResume { conversation: NativeConversation; directory: string }
export interface Annotation { id: string; snapshotId: string; x: number; y: number; text: string; createdAt: string }
export interface PreparedRequest { directory: string; prompt: string }
export interface Experiment { id: string; name: string; hypothesis: string; criterion: string; promptA: string; promptB: string; createdAt: string }
export interface Trial { id: string; experimentId: string; variant: 'A' | 'B'; runId: string | null; minutes: number; rework: number; outcome: 'successful' | 'partial' | 'failed'; evidence: string; createdAt: string }
export interface ExperimentsData { experiments: Experiment[]; trials: Trial[] }
export interface BackupRecord { id: string; createdAt: string; appVersion: string; files: number; bytes: number; includesLogs: boolean }
export interface BackupResult { record: BackupRecord; restoredPath?: string; restartRequired?: boolean }
export interface Task { designRef?: { snapshotId: string; annotationId: string }; id: string; title: string; directory: string; sessionId: string | null; scope: string[]; status: 'queued' | 'active' | 'review' | 'done'; notes: string; verificationId: string | null; createdAt: string }
export interface TaskAudit { tasks: Task[]; overlaps: string[]; changes: { directory: string; path: string; tasks: string[]; outsideScope: boolean }[]; warnings: string[] }
export type VerificationTool = 'npm' | 'pnpm' | 'yarn' | 'python' | 'cargo' | 'go' | 'dotnet';
export interface VerificationStep { label: string; tool: VerificationTool; args: string[] }
export interface VerificationProfile { id: string; name: string; directory: string; steps: VerificationStep[]; timeoutSeconds: number; createdAt: string }
export interface VerificationResult { id: string; profileId: string; directory: string; profileName: string; startedAt: string; endedAt: string; passed: boolean; cancelled: boolean; steps: { label: string; exitCode: number | null; output: string; timedOut: boolean; truncated: boolean }[] }
export interface VerificationData { profiles: VerificationProfile[]; results: VerificationResult[]; running: boolean }
export type WorkbenchRequest = import('./remote').RemoteRequest
 | import('./productivity').WorkflowRequest
 | { action: 'runtime' } | { action: 'restart' }
 | { action: 'codex-models'; directory: string | null }
 | { action: 'host-health' }
 | { action: 'diagnose'; engine: 'claude' | 'codex'; directory: string | null; profileId?: string }
 | { action: 'native-list' } | { action: 'native-resume'; key: string; directory?: string }
 | { action: 'preview-open'; url: string } | { action: 'preview-close' }
 | { action: 'preview-capture'; title: string; notes: string; designId?: string; projectDirectory: string | null }
 | { action: 'annotation-list'; snapshotId: string } | { action: 'annotation-add'; snapshotId: string; x: number; y: number; text: string }
 | { action: 'design-feedback'; snapshotId: string }
 | { action: 'experiment-list' } | { action: 'experiment-save'; name: string; hypothesis: string; criterion: string; promptA: string; promptB: string }
 | { action: 'trial-add'; experimentId: string; variant: 'A' | 'B'; runId: string | null; minutes: number; rework: number; outcome: Trial['outcome']; evidence: string }
 | { action: 'backup-list' } | { action: 'backup-create'; includeLogs: boolean } | { action: 'backup-export'; id: string } | { action: 'backup-restore'; id: string } | { action: 'backup-import' }
 | { action: 'task-list' } | { action: 'task-save'; id?: string; title: string; directory: string; sessionId: string | null; scope: string[]; status: Task['status']; notes: string; verificationId: string | null } | { action: 'task-audit' }
 | { action: 'verification-list' } | { action: 'verification-save'; id?: string; name: string; directory: string; steps: VerificationStep[]; timeoutSeconds: number } | { action: 'verification-run'; id: string } | { action: 'verification-cancel' };
export type WorkbenchResponse = import('./remote').RemoteStatus | import('./productivity').WorkflowResponse | RuntimeInfo | DiagnosticReport | CodexModelCatalog | HostHealthReport | NativeConversation[] | NativeResume | Annotation[] | Annotation | PreparedRequest | ExperimentsData | Experiment | Trial | BackupRecord[] | BackupResult | Task[] | Task | TaskAudit | VerificationData | VerificationProfile | VerificationResult | import('./design').DesignPreview | null;
