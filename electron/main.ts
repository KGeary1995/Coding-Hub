import { redactDiagnostic } from '../shared/productivity';
import { Workflows } from './services/workbench/workflows';
import { Delivery } from './services/workbench/delivery';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { Diagnostics } from './services/workbench/diagnostics';
import { NativeSessions } from './services/workbench/native-sessions';
import { Backups, resolveStorageRoot } from './services/workbench/backups';
import { Verification } from './services/workbench/verification';
import { Tasks } from './services/workbench/tasks';
import { Experiments } from './services/workbench/experiments';
import { LivePreview } from './services/workbench/live-preview';
import { z } from 'zod';
import { CoachingService } from './services/coaching/service';
import { DesignArchive } from './services/design/archive';
import { HandoffImport } from './services/design/handoff';
import type { DesignSnapshot } from '../shared/design';
import { ProjectSetup } from './services/repository/project-setup';
import { AccountLoginManager } from './services/cli/account-login-manager';
import { app, shell, nativeImage, BrowserWindow, dialog, ipcMain, webContents, crashReporter, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { ProjectChecks } from './services/repository/project-checks';
import { WorktreeService } from './services/repository/worktrees';
import { autoUpdater } from 'electron-updater';
import { UpdateService, updatesEnabled } from './services/updates/update-service';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { IPC_CHANNELS, type HostResult } from '../shared/ipc';
import { discoverEngine } from './services/cli/discovery';
import { HubError } from './services/cli/engine-adapter';
import { ClaudeProfiles } from './services/cli/claude-profiles';
import { isWithinDirectory, PtyManager } from './services/cli/pty-manager';
import { AttentionServer, CODEX_ATTENTION_CONFIG, claudeAttentionSettings, supportsHttpHooks, withLoopbackNoProxy } from './services/cli/attention';
import { ModelCatalog } from './services/cli/model-catalog';
import { WorkspaceStorage } from './services/storage/workspace-storage';
import { HostHealth } from './services/storage/host-health';
import { finishWorkspaceFlushSchema } from '../shared/schemas';
import { RepositoryFiles } from './services/repository/filesystem';
import { RepositoryGit } from './services/repository/git';
import { HubService } from './services/hub/service';
import { TelemetryService } from './services/hub/telemetry';
import { AutoMemory } from './services/hub/auto-memory';

const storageBase = process.env.CODING_HUB_STORAGE_DIR ? path.resolve(process.env.CODING_HUB_STORAGE_DIR) : path.join(homedir(), '.coding-hub');
const profileRoot = app.commandLine.getSwitchValue('user-data-dir') || app.getPath('userData');
const storageRoot = resolveStorageRoot(storageBase, profileRoot);
let hostHealth: HostHealth | null = null;
process.on('uncaughtExceptionMonitor', (_error, origin) => hostHealth?.record('host-uncaught-exception', origin));
app.on('child-process-gone', (_event, details) => { if (details.reason !== 'clean-exit') hostHealth?.record('child-process-gone', `${details.type}: ${details.reason}`, details.exitCode); });
let workflows: Workflows | null = null;
let delivery: Delivery | null = null;
let verification: Verification | null = null;
let livePreview: LivePreview | null = null;
let backups: Backups | null = null;
let worktrees: WorktreeService | null = null;
const production = process.argv.includes('--production') || app.isPackaged;
let window: BrowserWindow | null = null;
let quitting = false;
let updateRestart = false;
let lastFlushSucceeded = false;
let updates: UpdateService | null = null;
let projectChecks: ProjectChecks | null = null;
let storage: WorkspaceStorage | null = null;
let hub: HubService | null = null;
let autoMemory: AutoMemory | null = null;
let storageFailure = 'Local storage is unavailable. Check access to ~/.coding-hub.';
let workspaceLoaded = false;
let pendingFlush: { requestId: string; owner: number; resolve: () => void; promise: Promise<void> } | null = null;
const rendererFile = path.join(__dirname, '../../dist/index.html');
const claudeProfiles = new ClaudeProfiles(storageRoot);
const accounts = new AccountLoginManager((owner, event) => sendToRenderer(IPC_CHANNELS.accountEvent, event, owner), { onEventError: () => hostHealth?.record('login-event-delivery-failed'), profiles: claudeProfiles, profileInUse: (id) => manager.usesProfile(id), openGuide: (url) => shell.openExternal(url) });
const nativeSessions = new NativeSessions(claudeProfiles);
const modelCatalog = new ModelCatalog({ clientVersion: app.getVersion() });
const repositoryFiles = new RepositoryFiles();
const repositoryGit = new RepositoryGit(repositoryFiles);
// Claude Code reports permission prompts to this loopback endpoint; see services/cli/attention.ts.
const attention = new AttentionServer((runId, message) => manager.notifyAttention(runId, message));
const manager = new PtyManager((owner, event) => {
  if (event.type === 'started') hostHealth?.record('cli-started', event.engine);
  if (event.type === 'exit') hostHealth?.record('cli-exited', null, event.exitCode);
  try {
    if (event.type === 'data') storage?.append(event.runId, event.data);
    if (event.type === 'exit') storage?.endRun(event.runId, event.exitCode);
  } catch { reportStorageError('Session output could not be saved. Live terminal output remains available.'); }
  if (event.type === 'exit') attention.unregister(event.runId);
  if (event.type === 'exit') {
    // Read the transcript location before telemetry forgets the run.
    const transcript = hub?.telemetry?.transcript(event.runId) ?? null;
    void autoMemory?.finish(event.runId, transcript).catch(() => hostHealth?.record('auto-memory-summary-failed'));
  }
  if (event.type === 'exit') try { hub?.telemetry?.end(event.runId); } catch { hostHealth?.record('telemetry-finalization-failed'); reportStorageError('Usage recording could not finish for this run. The CLI exit is still reported.'); }
  sendToRenderer(IPC_CHANNELS.sessionEvent, event, owner);
}, { onEventError: () => hostHealth?.record('session-event-delivery-failed'), profileEnvironment: (base, id) => claudeProfiles.environment(base, id), prepareLaunch: (run, config, info, launch) => {
  hub?.rules.verifyLaunch(run.cwd);
  if (config.resumeId) { if (hub?.telemetry?.isConversationActive(config.engine, config.resumeId)) throw new HubError('RESUME_BUSY', 'This conversation is still active in another tile. Stop it before resuming.'); const source = nativeSessions.source(config.engine, config.resumeId, config.engine === 'claude' ? config.accountProfileId : undefined); if (!source) throw new HubError('NATIVE_SESSION', 'This native conversation is unavailable. Refresh CLI history before resuming.'); hub?.telemetry?.setResumeSource(run.runId, source, config.engine, config.model); }
  if (config.engine === 'claude' && config.tokenLimits.maxSessionTokens !== null && !hub?.telemetry) throw new HubError('TELEMETRY_UNAVAILABLE', 'Token limits require writable local telemetry storage.');
  hub?.telemetry?.prepare(run, config, info, launch);
  // Let the agent say when it is waiting for the person. Older CLIs run without it.
  if (config.engine === 'claude' && info.supportsSettings && supportsHttpHooks(info.version)) {
    const url = attention.register(run.runId);
    if (url) { launch.args.push('--settings', claudeAttentionSettings(url)); Object.assign(launch.env, withLoopbackNoProxy({ ...process.env, ...launch.env })); }
  }
  if (config.engine === 'codex' && info.supportsConfig) for (const value of CODEX_ATTENTION_CONFIG) launch.args.push('--config', value);
  // Last: Claude's --mcp-config takes a list of values.
  autoMemory?.prepare(run, config.model, info, launch);
}, onStarted: (run, config, owner) => {
  try { storage?.beginRun(run, config); }
  catch { reportStorageError('This run could not be recorded in local history. The CLI session is still available.'); }
  try { hub?.telemetry?.start(run, config, config.engine === 'claude' && config.accountProfileId ? claudeProfiles.directory(config.accountProfileId) : undefined); }
  catch {
    // Without a usage watcher a session token limit would silently go unenforced.
    if (config.engine === 'claude' && config.tokenLimits.maxSessionTokens !== null) {
      reportStorageError('Usage recording is unavailable, so the session token limit cannot be enforced. The session was stopped.');
      setImmediate(() => void manager.stop(owner, { sessionId: run.sessionId, runId: run.runId }).catch(() => hostHealth?.record('token-limit-stop-failed')));
    } else reportStorageError('Usage recording is unavailable for this run.');
  }
} });

function sendToRenderer(channel: string, value: unknown, owner?: number): boolean {
  try {
    const id = owner ?? (window && !window.isDestroyed() ? window.webContents.id : undefined);
    const target = id === undefined ? null : webContents.fromId(id);
    if (!target || target.isDestroyed()) return false;
    target.send(channel, value); return true;
  } catch { hostHealth?.record('renderer-event-delivery-failed', channel); return false; }
}
function reportStorageError(message: string) { sendToRenderer(IPC_CHANNELS.storageError, message); }
function localStorage() {
  if (!storage) throw new HubError('STORAGE_UNAVAILABLE', storageFailure);
  return storage;
}
function flushWorkspace(): Promise<void> {
  if (pendingFlush) return pendingFlush.promise;
  if (!window || window.webContents.isDestroyed() || !workspaceLoaded) return Promise.resolve();
  let resolve!: () => void;
  lastFlushSucceeded = false;
  const promise = new Promise<void>((done) => { resolve = done; });
  const request = { requestId: randomUUID(), owner: window.webContents.id, resolve, promise };
  pendingFlush = request;
  const timer = setTimeout(resolve, 2000);
  if (!sendToRenderer(IPC_CHANNELS.workspaceFlush, request.requestId, request.owner)) resolve();
  void promise.finally(() => { clearTimeout(timer); if (pendingFlush === request) pendingFlush = null; });
  return promise;
}

function assertSender(event: IpcMainInvokeEvent) {
  const expectedURL = production ? pathToFileURL(rendererFile).href : 'http://127.0.0.1:5173/';
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url.split('#')[0] !== expectedURL) {
    throw new HubError('UNTRUSTED_SENDER', 'Untrusted native-host request.');
  }
}

function handle<T>(channel: string, operation: (owner: number, payload: unknown) => T | Promise<T>) {
  ipcMain.handle(channel, async (event, payload): Promise<HostResult<T>> => {
    try {
      assertSender(event);
      if (backups?.busy && [IPC_CHANNELS.startSession, IPC_CHANNELS.accounts, IPC_CHANNELS.projects, IPC_CHANNELS.projectChecks, IPC_CHANNELS.projectTools].includes(channel as never)) throw new HubError('BACKUP_BUSY', 'Finish the backup operation before starting or changing local jobs.');
      if ((delivery?.running || workflows?.running) && [IPC_CHANNELS.startSession, IPC_CHANNELS.projectChecks, IPC_CHANNELS.projectTools].some((item) => item === channel)) throw new HubError('DELIVERY_BUSY', 'Finish Git delivery before starting or changing local jobs.');
      return { ok: true, value: await operation(event.sender.id, payload) };
    } catch (error) {
      return { ok: false, error: error instanceof z.ZodError ? { code: 'INVALID_REQUEST', message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' ').slice(0, 1500) } : error instanceof HubError ? { code: error.code, message: error.message } : { code: 'HOST_ERROR', message: 'The native operation failed. Check file permissions and refresh before retrying.' } };
    }
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#101214',
    title: 'AI Coding Hub',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  // file:// pages never receive response headers, so production also ships this policy as a <meta> tag (vite.config.ts).
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const scripts = production ? "'self'" : "'self' 'unsafe-inline'";
    const connections = production ? "'self'" : "'self' http://127.0.0.1:5173 ws://127.0.0.1:5173";
    callback({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [`default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ${connections}; object-src 'none'; frame-src 'self'; base-uri 'self'`],
    } });
  });
  if (production) void window.loadFile(path.join(__dirname, '../../dist/index.html'));
  else void window.loadURL('http://127.0.0.1:5173');
  const current = window;
  const owner = current.webContents.id;
  current.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    hostHealth?.record('renderer-process-gone', details.reason, details.exitCode);
    void Promise.all([manager.stopOwner(owner), accounts.stopOwner(owner)]).then(async () => {
      if (current.isDestroyed() || quitting) return;
      if (manager.ownedProcessIds(owner).length) throw new HubError('STOP_FAILED', 'A CLI process is still owned by this window.');
      const answer = await dialog.showMessageBox(current, { type: 'error', title: 'Workspace display stopped', message: 'The application display stopped unexpectedly. Coding and login terminals have been stopped.', detail: 'Reload restores the last saved workspace as idle tiles. Local lifecycle diagnostics are available in Settings.', buttons: ['Reload workspace', 'Close'], defaultId: 0, cancelId: 1 });
      if (current.isDestroyed()) return;
      if (answer.response === 0) current.webContents.reload(); else current.close();
    }).catch(() => {
      hostHealth?.record('renderer-recovery-failed');
      if (!quitting && !current.isDestroyed()) dialog.showErrorBox('Workspace recovery could not finish', `A coding or login process could not be confirmed stopped. Check your system process manager before restarting Coding Hub.${manager.ownedProcessIds(owner).length ? '\nOwned coding process IDs: ' + manager.ownedProcessIds(owner).join(', ') : ''}\nLocal lifecycle diagnostics were preserved.`);
    });
  });
  current.webContents.on('render-process-gone', () => repositoryFiles.closeOwner(owner));
  // did-start-navigation fires before will-navigate can cancel, so clean up only once the old page is really replaced.
  let firstDocument = true;
  current.webContents.on('did-navigate', () => {
    if (firstDocument) { firstDocument = false; return; }
    void accounts.stopOwner(owner).catch(() => {}); void manager.stopOwner(owner); repositoryFiles.closeOwner(owner);
  });
  let closing = false;
  current.on('close', (event) => {
    if (closing || quitting) return;
    event.preventDefault();
    if (delivery?.running || workflows?.running || worktrees?.active) { void dialog.showMessageBox(current, { type: 'info', message: 'Wait for the reviewed workflow or worktree operation to finish before closing the app.' }); return; }
    closing = true;
    // The preview is a separate top-level window; left open it would keep the app alive with no main window.
    livePreview?.close();
    void flushWorkspace().then(() => Promise.all([manager.stopOwner(owner), accounts.stopOwner(owner)])).catch(() => hostHealth?.record('shutdown-stop-failed')).finally(() => { repositoryFiles.closeOwner(owner); current.destroy(); });
  });
  window.on('closed', () => { window = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  void attention.start().catch(() => hostHealth?.record('attention-endpoint-unavailable'));
  hostHealth = new HostHealth(storageRoot);
  try { const dumps = path.join(storageRoot, 'crash-dumps'); fs.mkdirSync(dumps, { recursive: true, mode: 0o700 }); app.setPath('crashDumps', dumps); crashReporter.start({ uploadToServer: false, ignoreSystemCrashHandler: false }); }
  catch { hostHealth.record('crash-dump-setup-unavailable'); }
  try { storage = new WorkspaceStorage(storageRoot, reportStorageError); }
  catch (error) { if (error instanceof HubError) storageFailure = error.message; }
  try {
    hub = new HubService(storageRoot);
    hub.telemetry = new TelemetryService(path.join(path.dirname(hub.preferencesPath), 'telemetry'), () => hub!.preferences().prices, (usage) => {
      sendToRenderer(IPC_CHANNELS.usage, usage);
    }, (run) => { if (window) void manager.stop(window.webContents.id, { sessionId: run.sessionId, runId: run.runId }).catch(() => reportStorageError('The reported token limit was reached, but the process could not be stopped.')); });
  } catch { /* Live sessions remain available without optional storage integrations. */ }
  if (hub) {
    const memoryHub = hub;
    autoMemory = new AutoMemory({
      memory: memoryHub.memory,
      enabled: () => { try { return memoryHub.preferences().automaticMemory !== false; } catch { return true; } },
      server: path.join(__dirname, 'services', 'hub', 'memory-server.js'),
      executable: process.execPath,
      scratch: path.join(storageRoot, 'auto-memory'),
      onWrite: (key) => memoryHub.trackProject(key),
      refresh: (key) => memoryHub.trackProject(key),
    });
  }
  const designs = new DesignArchive(storageRoot, async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Save a design preview', properties: ['openFile'], filters: [{ name: 'HTML or screenshots', extensions: ['html', 'htm', 'png', 'jpg', 'jpeg', 'webp'] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }, (bytes) => { const image = nativeImage.createFromBuffer(bytes); const size = image.getSize(); return !image.isEmpty() && size.width <= 8192 && size.height <= 8192 && size.width * size.height <= 40000000; });
  const handoffs = new HandoffImport(path.join(storageRoot, 'handoff-scratch'), async (source) => {
    const result = source === 'zip'
      ? await dialog.showOpenDialog(window!, { title: 'Import a Claude Design handoff bundle', properties: ['openFile'], filters: [{ name: 'ZIP bundle', extensions: ['zip'] }] })
      : await dialog.showOpenDialog(window!, { title: 'Import an extracted Claude Design handoff folder', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }, async (title, notes, projectDirectory, file) => {
    const preview = await designs.execute({ action: 'import', title, notes, projectDirectory }, file);
    return preview && 'snapshot' in preview ? (preview.snapshot as DesignSnapshot) : null;
  });
  handle(IPC_CHANNELS.designs, (_owner, payload) => {
    if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.');
    if (payload && typeof payload === 'object' && 'action' in payload && payload.action === 'handoff-import') return handoffs.execute(payload);
    return designs.execute(payload);
  });
  // A folder is in use while a session runs in it or a saved tile is bound to it.
  const directoryInUse = (directory: string) => {
    if (manager.usesDirectory(directory)) return true;
    const workspace = storage?.load();
    return Boolean(workspace?.sessions.some((session) => {
      const binding = session.binding.mode === 'independent' ? session.binding.cwd : workspace.rootDirectory;
      return Boolean(binding && isWithinDirectory(directory, binding));
    }));
  };
  const coaching = hub ? new CoachingService(storageRoot, hub.rules, directoryInUse) : null;
  handle(IPC_CHANNELS.coaching, (_owner, payload) => { if (!coaching) throw new HubError('COACHING_STORAGE', 'Local coaching storage is unavailable.'); if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); return coaching.execute(payload); });
  const diagnostics = new Diagnostics(claudeProfiles);
  verification = new Verification(storageRoot, async (profile) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Run verification', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Run trusted project commands', message: `${profile.name} — ${profile.directory}`, detail: profile.steps.map((step) => `${step.label}: ${step.tool} ${JSON.stringify(step.args)}`).join('\n') + `\nCommands and package hooks run with your local permissions. Timeout: ${profile.timeoutSeconds}s per step.` })).response === 0 && !updateRestart);
  const tasks = new Tasks(storageRoot, verification);
  const experiments = new Experiments(storageRoot, (id) => Boolean(storage?.history().some((run) => run.runId === id)));
  livePreview = coaching ? new LivePreview(storageRoot, designs, coaching, async (url) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Open isolated preview', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Approve local design preview', message: url, detail: 'This local application can execute browser JavaScript in a separate sandboxed window. It cannot access Coding Hub IPC, local files, permissions, downloads, or other network origins. Start the trusted development server yourself.' })).response === 0 && !updateRestart) : null;
  const readyForBackup = async () => { if (manager.hasSessions || accounts.active || projectSetup.active || worktrees?.active || projectChecks?.running || verification?.running || delivery?.running || workflows?.running) throw new HubError('BACKUP_BUSY', 'Stop all sessions and verification jobs before backing up or restoring.'); if (!storage || !workspaceLoaded) throw new HubError('BACKUP_STORAGE', 'Load a writable workspace before backing up.'); await flushWorkspace(); if (!lastFlushSucceeded) throw new HubError('BACKUP_SAVE', 'Save the workspace successfully before backing up.'); };
  backups = new Backups(storageBase, storageRoot, profileRoot, app.getVersion(), { ready: readyForBackup,
    exportFile: async () => (await dialog.showSaveDialog(window!, { title: 'Export local backup', defaultPath: `Coding-Hub-${app.getVersion()}.hub-backup.gz`, filters: [{ name: 'Coding Hub backup', extensions: ['gz'] }] })).filePath ?? null,
    importFile: async () => { const selected = await dialog.showOpenDialog(window!, { title: 'Import local backup', properties: ['openFile'], filters: [{ name: 'Coding Hub backup', extensions: ['gz'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null; },
    confirmRestore: async (record) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Activate restored copy on restart', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Review verified restore', message: `${record.files} files · ${record.bytes} bytes · version ${record.appVersion}`, detail: 'The backup was checked and copied into a new local restore directory. Current data and project files remain intact. Credentials are excluded, so named profiles may need login again. Restart to activate the restored copy.' })).response === 0 && !updateRestart,
  });
  const confirmWorkflow = async (title: string, detail: string) => (await dialog.showMessageBox(window!, { type: 'question', title, message: title, detail, buttons: ['Confirm reviewed action', 'Cancel'], defaultId: 1, cancelId: 1 })).response === 0 && !updateRestart && !backups?.busy;
  const workflowReady = () => { if (manager.hasSessions || projectChecks?.running || verification?.running || workflows?.running || updateRestart || backups?.busy) throw new HubError('WORKFLOW_BUSY', 'Stop coding sessions and verification before changing repositories or applying templates.'); };
  delivery = new Delivery(confirmWorkflow, workflowReady);
  workflows = hub && storage ? new Workflows(storageRoot, nativeSessions, verification, hub.rules, storage, confirmWorkflow) : null;
  handle(IPC_CHANNELS.workbench, async (_owner, payload) => {
    const action = z.object({ action: z.string().max(60) }).passthrough().parse(payload).action;
    if (action === 'runtime') { z.object({ action: z.literal('runtime') }).strict().parse(payload); return { version: app.getVersion(), rendererVersion: app.getVersion(), edition: !app.isPackaged ? 'source' : process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed', executable: process.execPath, applicationPath: app.getAppPath(), storagePath: storageRoot, platform: process.platform, restartRequired: backups!.restartRequired }; }
    if (action === 'restart') { z.object({ action: z.literal('restart') }).strict().parse(payload); await readyForBackup(); livePreview?.close(); app.relaunch(); app.quit(); return null; }
    if (updateRestart) throw new HubError('HOST_CLOSING', 'The application is restarting.');
    if (action === 'codex-models') return modelCatalog.execute(payload);
    if (action === 'host-health') { z.object({ action: z.literal('host-health') }).strict().parse(payload); return hostHealth!.report(); }
    if ((delivery?.running || workflows?.running) && ['verification-run', 'flow-template-apply', 'restart'].includes(action)) throw new HubError('DELIVERY_BUSY', 'Finish Git delivery before starting another job.');
    if (action.startsWith('flow-')) {
      if (backups?.busy) throw new HubError('BACKUP_BUSY', 'Finish the backup operation first.');
      if (action.startsWith('flow-git-')) return delivery!.execute(payload);
      if (action === 'flow-open-pr') { const request = z.object({ action: z.literal('flow-open-pr'), url: z.string().regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/) }).strict().parse(payload); await shell.openExternal(request.url); return null; }
      if (action === 'flow-preview-size' || action === 'flow-design-diff') { if (!livePreview) throw new HubError('PREVIEW_STORAGE', 'Preview storage is unavailable.'); return livePreview.execute(payload); }
      if (action === 'flow-design-task') {
        const request = z.object({ action: z.literal('flow-design-task'), snapshotId: z.uuid(), annotationId: z.uuid(), directory: z.string().max(4096), scope: z.array(z.string().max(300)).min(1).max(30) }).strict().parse(payload);
        if (!livePreview) throw new HubError('PREVIEW_STORAGE', 'Preview storage is unavailable.');
        const comments = await livePreview.execute({ action: 'annotation-list', snapshotId: request.snapshotId }) as import('../shared/workbench').Annotation[];
        const comment = comments.find((item) => item.id === request.annotationId); if (!comment) throw new HubError('DESIGN_TASK', 'Select an available annotation.');
        return tasks.execute({ action: 'task-save', title: comment.text.slice(0, 150), directory: request.directory, sessionId: null, scope: request.scope, status: 'queued', notes: `Design ${request.snapshotId} at (${comment.x}%, ${comment.y}%): ${comment.text}`, verificationId: null, designRef: { snapshotId: request.snapshotId, annotationId: comment.id } });
      }
      if (action === 'flow-release-status') {
        z.object({ action: z.literal('flow-release-status') }).strict().parse(payload);
        if (!app.isPackaged || process.platform !== 'win32') return { state: app.isPackaged ? 'Platform verification unavailable' : 'Source edition — no installer signature', publisher: null };
        try { const signature = await promisify(execFile)(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-Command', `(Get-AuthenticodeSignature -LiteralPath '${process.execPath.replace(/'/g, "''")}') | Select-Object @{Name='Status';Expression={[string]$_.Status}},@{Name='Publisher';Expression={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress`], { timeout: 10000, maxBuffer: 8192, windowsHide: true }); const info = JSON.parse(signature.stdout); return { state: String(info.Status), publisher: typeof info.Publisher === 'string' ? info.Publisher : null }; } catch { return { state: 'Signature verification failed', publisher: null }; }
      }
      if (action === 'flow-support-export') {
        const request = z.object({ action: z.literal('flow-support-export'), engine: z.enum(['claude','codex']), directory: z.string().max(4096).nullable(), profileId: z.uuid().optional() }).strict().parse(payload);
        const report = await diagnostics.execute({ ...request, action: 'diagnose' });
        const sanitized = redactDiagnostic(report, homedir(), request.directory);
        const result = await dialog.showSaveDialog(window!, { title: 'Export diagnostic report (no session output or credentials)', defaultPath: `Coding-Hub-${app.getVersion()}-diagnostics.json`, filters: [{ name: 'JSON report', extensions: ['json'] }] });
        if (!result.filePath) return { exported: false };
        if (fs.existsSync(result.filePath) && fs.lstatSync(result.filePath).isSymbolicLink()) throw new HubError('REPORT_PATH', 'Choose a regular output file.');
        fs.writeFileSync(result.filePath, JSON.stringify({ appVersion: app.getVersion(), platform: process.platform, packaged: app.isPackaged, report: sanitized, excludes: ['Session output','Prompt text','Environment values','Credentials','Configuration contents'] }, null, 2), { mode: 0o600 }); return { exported: true };
      }
      if (!workflows) throw new HubError('WORKFLOW_STORAGE', 'Writable local workflow storage is unavailable.');
      if (action === 'flow-template-apply') workflowReady();
      return workflows.execute(payload);
    }
    if (action === 'diagnose') return diagnostics.execute(payload);
    if (action.startsWith('native-')) return nativeSessions.execute(payload);
    if (backups?.busy && ['verification-run', 'verification-save', 'task-save', 'experiment-save', 'trial-add', 'preview-capture', 'design-feedback', 'annotation-add'].includes(action)) throw new HubError('BACKUP_BUSY', 'Finish the backup operation before changing local workspace data.');
    if (action.startsWith('verification-')) return verification!.execute(payload);
    if (action.startsWith('task-')) return tasks.execute(payload);
    if (action.startsWith('experiment-') || action.startsWith('trial-')) return experiments.execute(payload);
    if (action.startsWith('backup-')) return backups!.execute(payload);
    if (action.startsWith('preview-') || action.startsWith('annotation-') || action === 'design-feedback') { if (!livePreview) throw new HubError('PREVIEW_STORAGE', 'Preview storage is unavailable.'); return livePreview.execute(payload); }
    throw new HubError('INVALID_REQUEST', 'Unknown workbench operation.');
  });
  const projectSetup = new ProjectSetup();
  handle(IPC_CHANNELS.projects, (_owner, payload) => { if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); return projectSetup.execute(payload); });
  handle(IPC_CHANNELS.accounts, (owner, payload) => { if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is preparing an update.'); return accounts.execute(owner, payload); });
  projectChecks = new ProjectChecks((directory) => { if (!hub) throw new HubError('STORAGE_UNAVAILABLE', 'Shared rules storage is unavailable.'); hub.rules.verifyLaunch(directory); });
  handle(IPC_CHANNELS.projectChecks, (_owner, payload) => { if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); return projectChecks!.execute(payload, async () => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Run project code', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Run project check', message: 'Run this project’s npm script?', detail: 'Tests, typecheck, or lint scripts and their npm pre/post hooks execute project code with your local permissions. Only run checks in projects you trust. Output is capped and the check stops after 60 seconds.' })).response === 0 && !updateRestart); });
  worktrees = new WorktreeService(storageRoot, directoryInUse);
  handle(IPC_CHANNELS.projectTools, (_owner, payload) => { if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); return worktrees!.execute(payload); });
  updates = new UpdateService({
    version: app.getVersion(),
    enabled: updatesEnabled(app.isPackaged, process.platform, process.resourcesPath, Boolean(process.env.PORTABLE_EXECUTABLE_DIR)),
    disabledReason: 'Automatic updates require the installed Windows edition. Source and portable editions are updated manually.',
    storageDirectory: storageRoot,
    updater: autoUpdater,
    publish: (status) => { sendToRenderer(IPC_CHANNELS.updateStatus, status); },
    hasSessions: () => manager.hasSessions || accounts.active || projectSetup.active || Boolean(projectChecks?.running) || Boolean(verification?.running) || Boolean(backups?.busy) || Boolean(delivery?.running) || Boolean(workflows?.running) || Boolean(worktrees?.active),
    installationFailed: () => { updateRestart = false; },
    prepareRestart: async () => {
      const answer = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Restart and install', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Install update', message: 'Save your workspace and restart AI Coding Hub?', detail: 'Local settings, history, rules, and memory remain in ~/.coding-hub. All CLI sessions must be stopped.' });
      if (answer.response !== 0) return false;
      updateRestart = true;
      try {
        if (manager.hasSessions || accounts.active || projectSetup.active || projectChecks?.running || verification?.running || backups?.busy || delivery?.running || workflows?.running || worktrees?.active) throw new HubError('ACTIVE_SESSIONS', 'Stop all CLI sessions before restarting.');
        if (workspaceLoaded) { await flushWorkspace(); if (!lastFlushSucceeded) throw new HubError('UPDATE_SAVE_FAILED', 'The workspace could not be saved. Resolve the storage issue before updating.'); }
        else throw new HubError('UPDATE_SAVE_FAILED', 'Load the local workspace successfully before updating.');
        return true;
      } catch (error) { updateRestart = false; throw error; }
    },
  });
  handle(IPC_CHANNELS.updates, (_owner, payload) => updates!.execute(payload));
  handle(IPC_CHANNELS.hub, (_owner, payload) => { if (!hub) throw new HubError('STORAGE_UNAVAILABLE', 'Local integrations require a writable storage directory.'); return hub.execute(payload); });
  handle(IPC_CHANNELS.openRepository, (owner, payload) => repositoryFiles.open(owner, payload));
  handle(IPC_CHANNELS.closeRepository, (owner, payload) => { repositoryFiles.close(owner, payload); return null; });
  handle(IPC_CHANNELS.listDirectory, (owner, payload) => repositoryFiles.list(owner, payload));
  handle(IPC_CHANNELS.readFile, (owner, payload) => repositoryFiles.read(owner, payload));
  handle(IPC_CHANNELS.gitStatus, (owner, payload) => repositoryGit.status(owner, payload));
  handle(IPC_CHANNELS.gitDiff, (owner, payload) => repositoryGit.diff(owner, payload));
  handle(IPC_CHANNELS.loadWorkspace, () => {
    const database = localStorage();
    const workspace = database.load();
    workspaceLoaded = true;
    return { workspace, info: database.info };
  });
  handle(IPC_CHANNELS.saveWorkspace, (_owner, payload) => {
    if (!workspaceLoaded) throw new HubError('WORKSPACE_NOT_LOADED', 'Load the saved workspace before saving changes.');
    localStorage().save(payload); return null;
  });
  handle(IPC_CHANNELS.listHistory, () => localStorage().history());
  handle(IPC_CHANNELS.readRunLog, (_owner, payload) => localStorage().readLog(payload));
  handle(IPC_CHANNELS.finishWorkspaceFlush, (owner, payload) => {
    const parsed = finishWorkspaceFlushSchema.safeParse(payload);
    if (!parsed.success || !pendingFlush || pendingFlush.owner !== owner || parsed.data.requestId !== pendingFlush.requestId) throw new HubError('INVALID_FLUSH', 'Invalid workspace flush request.');
    try { if (parsed.data.workspace && workspaceLoaded) { localStorage().save(parsed.data.workspace); lastFlushSucceeded = true; } }
    finally { pendingFlush.resolve(); }
    return null;
  });
  ipcMain.handle(IPC_CHANNELS.pickDirectory, async (event) => {
    assertSender(event);
    const result = await dialog.showOpenDialog(window!, { title: 'Choose a local project folder — files are hidden in this view', buttonLabel: 'Use this folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(IPC_CHANNELS.discoverEngines, async () => (await Promise.all([discoverEngine('claude'), discoverEngine('codex')])).map((engine) => engine.info));
  handle(IPC_CHANNELS.startSession, (owner, payload) => {
    if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is preparing to install an update.');
    // The manager validates the complete request. This guard also covers pending
    // login discovery, preventing a session from racing a credential replacement.
    if (payload && typeof payload === 'object' && 'config' in payload) {
      const config = (payload as { config?: { engine?: string; accountProfileId?: string } }).config;
      if (config?.engine === 'claude' && config.accountProfileId && accounts.activeProfileId === config.accountProfileId) throw new HubError('PROFILE_BUSY', 'Finish or cancel this profile’s login before starting a coding session.');
    }
    return manager.start(owner, payload);
  });
  handle(IPC_CHANNELS.writeSession, (owner, payload) => { manager.write(owner, payload); return null; });
  handle(IPC_CHANNELS.resizeSession, (owner, payload) => { manager.resize(owner, payload); return null; });
  handle(IPC_CHANNELS.stopSession, async (owner, payload) => { await manager.stop(owner, payload); return null; });
  createWindow();
  updates.start();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (delivery?.running || workflows?.running || worktrees?.active) { if (window) void dialog.showMessageBox(window, { type: 'info', message: 'Wait for the reviewed workflow or worktree operation to finish before quitting.' }); return; }
  quitting = true;
  void flushWorkspace().then(() => Promise.all([manager.dispose(), accounts.close()]))
    // Stopping sessions starts their memory summaries; let them save before storage closes.
    .then(() => autoMemory?.drain(10000)).catch(() => hostHealth?.record('shutdown-stop-failed')).finally(() => {
    try { attention.close(); modelCatalog.close(); projectChecks?.stop(); verification?.cancel(); livePreview?.close(); updates?.close(); hub?.close(); storage?.close(); hostHealth?.close(); } finally { app.quit(); }
  });
});
