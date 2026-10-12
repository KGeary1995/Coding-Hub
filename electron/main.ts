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
import { ProjectSetup } from './services/repository/project-setup';
import { AccountLoginManager } from './services/cli/account-login-manager';
import { app, shell, nativeImage, BrowserWindow, dialog, ipcMain, webContents, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { realpathSync } from 'node:fs';
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
import { PtyManager } from './services/cli/pty-manager';
import { WorkspaceStorage } from './services/storage/workspace-storage';
import { finishWorkspaceFlushSchema } from '../shared/schemas';
import { RepositoryFiles } from './services/repository/filesystem';
import { RepositoryGit } from './services/repository/git';
import { HubService } from './services/hub/service';
import { TelemetryService } from './services/hub/telemetry';

const storageBase = process.env.CODING_HUB_STORAGE_DIR ?? path.join(homedir(), '.coding-hub');
const profileRoot = app.commandLine.getSwitchValue('user-data-dir') || app.getPath('userData');
const storageRoot = resolveStorageRoot(storageBase, profileRoot);
let verification: Verification | null = null;
let livePreview: LivePreview | null = null;
let backups: Backups | null = null;
const production = process.argv.includes('--production') || app.isPackaged;
let window: BrowserWindow | null = null;
let quitting = false;
let updateRestart = false;
let lastFlushSucceeded = false;
let updates: UpdateService | null = null;
let projectChecks: ProjectChecks | null = null;
let storage: WorkspaceStorage | null = null;
let hub: HubService | null = null;
let storageFailure = 'Local storage is unavailable. Check access to ~/.coding-hub.';
let workspaceLoaded = false;
let pendingFlush: { requestId: string; owner: number; resolve: () => void; promise: Promise<void> } | null = null;
const rendererFile = path.join(__dirname, '../../dist/index.html');
const claudeProfiles = new ClaudeProfiles(storageRoot);
const accounts = new AccountLoginManager((owner, event) => { const target = webContents.fromId(owner); if (target && !target.isDestroyed()) target.send(IPC_CHANNELS.accountEvent, event); }, { profiles: claudeProfiles, profileInUse: (id) => manager.usesProfile(id), openGuide: (url) => shell.openExternal(url) });
const nativeSessions = new NativeSessions(claudeProfiles);
const repositoryFiles = new RepositoryFiles();
const repositoryGit = new RepositoryGit(repositoryFiles);
const manager = new PtyManager((owner, event) => {
  try {
    if (event.type === 'data') storage?.append(event.runId, event.data);
    if (event.type === 'exit') storage?.endRun(event.runId, event.exitCode);
  } catch { reportStorageError('Session output could not be saved. Live terminal output remains available.'); }
  if (event.type === 'exit') hub?.telemetry?.end(event.runId);
  const target = webContents.fromId(owner);
  if (target && !target.isDestroyed()) target.send(IPC_CHANNELS.sessionEvent, event);
}, { profileEnvironment: (base, id) => claudeProfiles.environment(base, id), prepareLaunch: (run, config, info, launch) => {
  hub?.rules.verifyLaunch(run.cwd);
  if (config.resumeId) { if (hub?.telemetry?.isConversationActive(config.engine, config.resumeId)) throw new HubError('RESUME_BUSY', 'This conversation is still active in another tile. Stop it before resuming.'); const source = nativeSessions.source(config.engine, config.resumeId, config.engine === 'claude' ? config.accountProfileId : undefined); if (!source) throw new HubError('NATIVE_SESSION', 'This native conversation is unavailable. Refresh CLI history before resuming.'); hub?.telemetry?.setResumeSource(run.runId, source, config.engine, config.model); }
  if (config.engine === 'claude' && config.tokenLimits.maxSessionTokens !== null && !hub?.telemetry) throw new HubError('TELEMETRY_UNAVAILABLE', 'Token limits require writable local telemetry storage.');
  hub?.telemetry?.prepare(run, config, info, launch);
}, onStarted: (run, config) => {
  try { storage?.beginRun(run, config); }
  catch { reportStorageError('This run could not be recorded in local history. The CLI session is still available.'); }
  try { hub?.telemetry?.start(run, config, config.engine === 'claude' && config.accountProfileId ? claudeProfiles.directory(config.accountProfileId) : undefined); } catch { reportStorageError('Usage recording is unavailable for this run.'); }
} });

function reportStorageError(message: string) {
  if (window && !window.webContents.isDestroyed()) window.webContents.send(IPC_CHANNELS.storageError, message);
}
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
  window.webContents.send(IPC_CHANNELS.workspaceFlush, request.requestId);
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
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const scripts = production ? "'self'" : "'self' 'unsafe-inline'";
    const connections = production ? "'self'" : "'self' http://127.0.0.1:5173 ws://127.0.0.1:5173";
    callback({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [`default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${connections}; object-src 'none'; frame-src 'self'; base-uri 'self'`],
    } });
  });
  if (production) void window.loadFile(path.join(__dirname, '../../dist/index.html'));
  else void window.loadURL('http://127.0.0.1:5173');
  const current = window;
  current.webContents.on('render-process-gone', () => { void manager.stopOwner(current.webContents.id); void accounts.stopOwner(current.webContents.id).catch(() => {}); });
  current.webContents.on('render-process-gone', () => repositoryFiles.closeOwner(current.webContents.id));
  current.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) { void accounts.stopOwner(current.webContents.id).catch(() => {}); void manager.stopOwner(current.webContents.id); repositoryFiles.closeOwner(current.webContents.id); }
  });
  let closing = false;
  current.on('close', (event) => {
    if (closing || quitting) return;
    event.preventDefault();
    closing = true;
    void flushWorkspace().then(() => Promise.all([manager.stopOwner(current.webContents.id), accounts.stopOwner(current.webContents.id)])).finally(() => { repositoryFiles.closeOwner(current.webContents.id); current.destroy(); });
  });
  window.on('closed', () => { window = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  try { storage = new WorkspaceStorage(storageRoot, reportStorageError); }
  catch (error) { if (error instanceof HubError) storageFailure = error.message; }
  try {
    hub = new HubService(storageRoot);
    hub.telemetry = new TelemetryService(path.join(path.dirname(hub.preferencesPath), 'telemetry'), () => hub!.preferences().prices, (usage) => {
      if (window && !window.webContents.isDestroyed()) window.webContents.send(IPC_CHANNELS.usage, usage);
    }, (run) => { if (window) void manager.stop(window.webContents.id, { sessionId: run.sessionId, runId: run.runId }).catch(() => reportStorageError('The reported token limit was reached, but the process could not be stopped.')); });
  } catch { /* Live sessions remain available without optional storage integrations. */ }
  const designs = new DesignArchive(storageRoot, async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Save a design preview', properties: ['openFile'], filters: [{ name: 'HTML or screenshots', extensions: ['html', 'htm', 'png', 'jpg', 'jpeg', 'webp'] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }, (bytes) => { const image = nativeImage.createFromBuffer(bytes); const size = image.getSize(); return !image.isEmpty() && size.width <= 8192 && size.height <= 8192 && size.width * size.height <= 40000000; });
  handle(IPC_CHANNELS.designs, (_owner, payload) => { if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); return designs.execute(payload); });
  const coaching = hub ? new CoachingService(storageRoot, hub.rules) : null;
  handle(IPC_CHANNELS.coaching, (_owner, payload) => { if (!coaching) throw new HubError('COACHING_STORAGE', 'Local coaching storage is unavailable.'); if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); return coaching.execute(payload); });
  const diagnostics = new Diagnostics(claudeProfiles);
  verification = new Verification(storageRoot, async (profile) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Run verification', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Run trusted project commands', message: `${profile.name} — ${profile.directory}`, detail: profile.steps.map((step) => `${step.label}: ${step.tool} ${JSON.stringify(step.args)}`).join('\n') + `\nCommands and package hooks run with your local permissions. Timeout: ${profile.timeoutSeconds}s per step.` })).response === 0 && !updateRestart);
  const tasks = new Tasks(storageRoot, verification);
  const experiments = new Experiments(storageRoot, (id) => Boolean(storage?.history().some((run) => run.runId === id)));
  livePreview = coaching ? new LivePreview(storageRoot, designs, coaching, async (url) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Open isolated preview', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Approve local design preview', message: url, detail: 'This local application can execute browser JavaScript in a separate sandboxed window. It cannot access Coding Hub IPC, local files, permissions, downloads, or other network origins. Start the trusted development server yourself.' })).response === 0 && !updateRestart) : null;
  const readyForBackup = async () => { if (manager.hasSessions || accounts.active || projectSetup.active || projectChecks?.running || verification?.running) throw new HubError('BACKUP_BUSY', 'Stop all sessions and verification jobs before backing up or restoring.'); if (!storage || !workspaceLoaded) throw new HubError('BACKUP_STORAGE', 'Load a writable workspace before backing up.'); await flushWorkspace(); if (!lastFlushSucceeded) throw new HubError('BACKUP_SAVE', 'Save the workspace successfully before backing up.'); };
  backups = new Backups(storageBase, storageRoot, profileRoot, app.getVersion(), { ready: readyForBackup,
    exportFile: async () => (await dialog.showSaveDialog(window!, { title: 'Export local backup', defaultPath: `Coding-Hub-${app.getVersion()}.hub-backup.gz`, filters: [{ name: 'Coding Hub backup', extensions: ['gz'] }] })).filePath ?? null,
    importFile: async () => { const selected = await dialog.showOpenDialog(window!, { title: 'Import local backup', properties: ['openFile'], filters: [{ name: 'Coding Hub backup', extensions: ['gz'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null; },
    confirmRestore: async (record) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Activate restored copy on restart', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Review verified restore', message: `${record.files} files · ${record.bytes} bytes · version ${record.appVersion}`, detail: 'The backup was checked and copied into a new local restore directory. Current data and project files remain intact. Credentials are excluded, so named profiles may need login again. Restart to activate the restored copy.' })).response === 0 && !updateRestart,
  });
  handle(IPC_CHANNELS.workbench, async (_owner, payload) => {
    const action = z.object({ action: z.string().max(60) }).passthrough().parse(payload).action;
    if (action === 'runtime') { z.object({ action: z.literal('runtime') }).strict().parse(payload); return { version: app.getVersion(), rendererVersion: app.getVersion(), edition: !app.isPackaged ? 'source' : process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed', executable: process.execPath, applicationPath: app.getAppPath(), storagePath: storageRoot, platform: process.platform, restartRequired: backups!.restartRequired }; }
    if (action === 'restart') { z.object({ action: z.literal('restart') }).strict().parse(payload); await readyForBackup(); livePreview?.close(); app.relaunch(); app.quit(); return null; }
    if (updateRestart) throw new HubError('HOST_CLOSING', 'The application is restarting.');
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
  const worktrees = new WorktreeService(storageRoot, (directory) => {
    if (manager.usesDirectory(directory)) return true;
    const workspace = storage?.load();
    return Boolean(workspace?.sessions.some((session) => {
      const binding = session.binding.mode === 'independent' ? session.binding.cwd : workspace.rootDirectory;
      try { return Boolean(binding && realpathSync(binding) === realpathSync(directory)); } catch { return false; }
    }));
  });
  handle(IPC_CHANNELS.projectTools, (_owner, payload) => worktrees.execute(payload));
  updates = new UpdateService({
    version: app.getVersion(),
    enabled: updatesEnabled(app.isPackaged, process.platform, process.resourcesPath, Boolean(process.env.PORTABLE_EXECUTABLE_DIR)),
    disabledReason: 'Automatic updates require the installed Windows edition. Source and portable editions are updated manually.',
    storageDirectory: storageRoot,
    updater: autoUpdater,
    publish: (status) => { if (window && !window.webContents.isDestroyed()) window.webContents.send(IPC_CHANNELS.updateStatus, status); },
    hasSessions: () => manager.hasSessions || accounts.active || projectSetup.active || Boolean(projectChecks?.running) || Boolean(verification?.running) || Boolean(backups?.busy),
    installationFailed: () => { updateRestart = false; },
    prepareRestart: async () => {
      const answer = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Restart and install', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Install update', message: 'Save your workspace and restart AI Coding Hub?', detail: 'Local settings, history, rules, and memory remain in ~/.coding-hub. All CLI sessions must be stopped.' });
      if (answer.response !== 0) return false;
      updateRestart = true;
      try {
        if (manager.hasSessions || accounts.active || projectSetup.active || projectChecks?.running || verification?.running || backups?.busy) throw new HubError('ACTIVE_SESSIONS', 'Stop all CLI sessions before restarting.');
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
  quitting = true;
  void flushWorkspace().then(() => Promise.all([manager.dispose(), accounts.close()])).finally(() => {
    try { projectChecks?.stop(); verification?.cancel(); livePreview?.close(); updates?.close(); hub?.close(); storage?.close(); } finally { app.quit(); }
  });
});
