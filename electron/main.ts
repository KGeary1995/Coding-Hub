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
import { z } from 'zod';
import { CoachingService } from './services/coaching/service';
import { LiveCoach } from './services/coaching/live';
import { HandoffImport } from './services/design/handoff';
import type { AccountLabel, AccountLabels } from '../shared/accounts';
import type { ChannelEngine } from '../shared/types';
import { REMOTE_PORT, type ChannelControl, type ChannelTranscript, type RemoteResumeRequest } from '../shared/remote';
import type { NativeResume } from '../shared/workbench';
import { ProjectSetup } from './services/repository/project-setup';
import { AccountLoginManager } from './services/cli/account-login-manager';
import { app, shell, nativeImage, clipboard, ClipboardItem, BrowserWindow, dialog, ipcMain, webContents, crashReporter, powerMonitor, safeStorage, Notification, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { ProjectChecks } from './services/repository/project-checks';
import { WorktreeService } from './services/repository/worktrees';
import { autoUpdater } from 'electron-updater';
import { UpdateService, updatesEnabled } from './services/updates/update-service';
import { pathToFileURL } from 'node:url';
import os, { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chatHistory, chatText } from './services/chat/transcript';
import { macScreenLock } from './services/remote/screen-lock';
import { COPY_LIMIT, IPC_CHANNELS, type HostResult } from '../shared/ipc';
import { adoptLoginShellPath, discoverEngine, findExecutable, hostEnvironment } from './services/cli/discovery';
import { HubError } from './services/cli/engine-adapter';
import { ClaudeProfiles } from './services/cli/claude-profiles';
import { isWithinDirectory, PtyManager } from './services/cli/pty-manager';
import { AttentionServer, CODEX_ATTENTION_CONFIG, claudeAttentionSettings, ownStatusLine, supportsHttpHooks, supportsSessionHook, systemCurl, withLoopbackNoProxy } from './services/cli/attention';
import { ModelCatalog } from './services/cli/model-catalog';
import { WorkspaceStorage } from './services/storage/workspace-storage';
import { HostHealth } from './services/storage/host-health';
import { chatRequestSchema, finishWorkspaceFlushSchema, resizeSessionSchema } from '../shared/schemas';
import { DOWNLOADS_URL } from '../shared/updates';
import { RepositoryFiles } from './services/repository/filesystem';
import { RepositoryGit } from './services/repository/git';
import { HubService } from './services/hub/service';
import { RemoteServer } from './services/remote/remote-server';
import { serveFailure, serveRemote, stopServing, tailscalePeers, tailscaleRunner, tailscaleState, type TailscaleError } from './services/remote/tailscale';
import { LinkedComputers, linkableAddress } from './services/remote/linked-computers';
import { ScreenSharing, screenHost } from './services/remote/screen-sharing';
import { ScreenShare } from './services/remote/screen-share';
import { SCREEN_PORT } from '../shared/screen';
import { PlanLimitsService } from './services/hub/plan-limits';
import { DayUsage } from './services/hub/day-usage';
import { latestMacVersion, startMacUpdate } from './services/updates/mac-script-update';
import { LinkedAlerts } from './services/remote/linked-alerts';
import { usageAlerts, type DesktopAlert } from './services/alerts';
import { channelName } from '../shared/channel-name';
import { TelemetryService } from './services/hub/telemetry';
import { AutoMemory, projectMemoryKey } from './services/hub/auto-memory';

const storageBase = process.env.CODING_HUB_STORAGE_DIR ? path.resolve(process.env.CODING_HUB_STORAGE_DIR) : path.join(homedir(), '.coding-hub');
// The app installed as "AI Coding Hub" before it was renamed Trace; its Electron profile (window and display settings,
// a restored data folder) stays in the folder that name gave it, so the rename loses nothing.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'AI Coding Hub'));
const profileRoot = app.commandLine.getSwitchValue('user-data-dir') || app.getPath('userData');
const storageRoot = resolveStorageRoot(storageBase, profileRoot);
let hostHealth: HostHealth | null = null;
process.on('uncaughtExceptionMonitor', (_error, origin) => hostHealth?.record('host-uncaught-exception', origin));
app.on('child-process-gone', (_event, details) => { if (details.reason !== 'clean-exit') hostHealth?.record('child-process-gone', `${details.type}: ${details.reason}`, details.exitCode); });
let workflows: Workflows | null = null;
let delivery: Delivery | null = null;
let verification: Verification | null = null;
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
let remote: RemoteServer | null = null;
let linked: LinkedComputers | null = null;
let screens: ScreenSharing | null = null;
let screenShare: ScreenShare | null = null;
/** Start/stop requests from linked computers, waiting for the desktop window to carry them out. */
const pendingControls = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let autoMemory: AutoMemory | null = null;
let storageFailure = 'Local storage is unavailable. Check access to ~/.coding-hub.';
let workspaceLoaded = false;
let pendingFlush: { requestId: string; owner: number; resolve: () => void; promise: Promise<void> } | null = null;
const rendererFile = path.join(__dirname, '../../dist/index.html');
const claudeProfiles = new ClaudeProfiles(storageRoot);
/** Whether this Mac build was signed with a Developer ID, so it may update itself (`traceMacUpdates`, electron-builder.cjs). */
const macUpdates = () => { try { return (JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { traceMacUpdates?: unknown }).traceMacUpdates === true; } catch { return false; } };
/** Whose account each Claude channel runs on, for phones and linked computers. Read again at most every 30 s. */
let labelCache: { at: number; value: AccountLabels } | null = null;
const channelAccount = (config: { engine: string; accountProfileId?: string }): AccountLabel | undefined => {
  if (config.engine !== 'claude') return undefined;
  if (!labelCache || Date.now() - labelCache.at > 30000) { let value: AccountLabels = { default: null, profiles: {} }; try { value = claudeProfiles.labels(); } catch { /* No profile registry: no names. */ } labelCache = { at: Date.now(), value }; }
  return (config.accountProfileId ? labelCache.value.profiles[config.accountProfileId] : labelCache.value.default) ?? undefined;
};
/** Session and weekly usage limits for the Claude accounts and Codex, read from the CLIs without model requests. */
/** Today's usage from the CLIs' own logs: the default homes and every Claude profile's. */
const dayUsage = new DayUsage(() => [{ engine: 'claude' as const, root: process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude') }, { engine: 'codex' as const, root: process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex') }, ...(() => { try { return claudeProfiles.list().map((profile) => ({ engine: 'claude' as const, root: claudeProfiles.directory(profile.id) })); } catch { return []; } })()], () => hub?.preferences().prices ?? []);
const planLimits = new PlanLimitsService(() => claudeProfiles.list(), (base, id) => claudeProfiles.environment(base, id), undefined, undefined, () => claudeProfiles.labels().default?.name ?? null);
const accounts = new AccountLoginManager((owner, event) => sendToRenderer(IPC_CHANNELS.accountEvent, event, owner), { onEventError: () => hostHealth?.record('login-event-delivery-failed'), profiles: claudeProfiles, profileInUse: (id) => manager.usesProfile(id), openGuide: (url) => shell.openExternal(url) });
// Live coaching's reviews run in its coaching folder; their sessions are kept so their usage counts, but are not history.
const nativeSessions = new NativeSessions(claudeProfiles, [path.join(storageRoot, 'coaching')]);
const modelCatalog = new ModelCatalog({ clientVersion: app.getVersion() });
const repositoryFiles = new RepositoryFiles();
const repositoryGit = new RepositoryGit(repositoryFiles);
// Claude Code reports permission prompts to this loopback endpoint; see services/cli/attention.ts.
// SessionStart says which conversation a run is in: telemetry follows it there, then tells the window (see onConversation).
const attention = new AttentionServer((runId, message) => manager.notifyAttention(runId, message), (runId, finished) => manager.notifyResolved(runId, finished), (runId, conversationId) => hub?.telemetry?.follow(runId, conversationId), (runId, size) => hub?.telemetry?.setContextWindow(runId, size));
const manager = new PtyManager((owner, event) => {
  if (event.type === 'started') hostHealth?.record('cli-started', event.engine);
  if (event.type === 'exit') hostHealth?.record('cli-exited', null, event.exitCode);
  try {
    if (event.type === 'data') storage?.append(event.runId, event.data);
    if (event.type === 'exit') storage?.endRun(event.runId, event.exitCode);
  } catch { reportStorageError('Session output could not be saved. Live terminal output remains available.'); }
  if (event.type === 'exit') attention.unregister(event.runId);
  if (event.type === 'exit') {
    // Telemetry's last read of the run can be what finds a short run's transcript, so the summary waits for it.
    const transcript = hub?.telemetry?.transcript(event.runId) ?? null;
    const ended = hub?.telemetry ? hub.telemetry.end(event.runId).catch(() => { hostHealth?.record('telemetry-finalization-failed'); reportStorageError('Usage recording could not finish for this run. The CLI exit is still reported.'); return transcript; }) : Promise.resolve(null);
    void autoMemory?.finish(event.runId, ended).catch(() => hostHealth?.record('auto-memory-summary-failed'));
  }
  if (event.type === 'attention') desktopAlert({ title: `${channelLabel(event.sessionId)} needs you`, body: event.message, target: { sessionId: event.sessionId } });
  if (event.type === 'exit' && event.exitCode !== 0 && event.diagnostic) desktopAlert({ title: `${channelLabel(event.sessionId)} stopped with an error`, body: event.diagnostic.split('\n')[0], target: { sessionId: event.sessionId } });
  try { remote?.onSessionEvent(event); } catch { hostHealth?.record('remote-event-failed'); }
  sendToRenderer(IPC_CHANNELS.sessionEvent, event, owner);
}, { onChat: (owner, envelope) => {
  // A chat run's conversation is kept in its saved output as text, so it can be searched and exported like a terminal's.
  const text = chatText(envelope.event); if (text) try { storage?.append(envelope.runId, text); } catch { reportStorageError('Session output could not be saved. Live terminal output remains available.'); }
  sendToRenderer(IPC_CHANNELS.chatEvent, envelope, owner);
  // Phones and linked computers following the channel get it too.
  try { remote?.onChat(envelope); } catch { hostHealth?.record('remote-event-failed'); }
}, chatHistory: (config) => { if (!config.resumeId) return null; const file = nativeSessions.source(config.engine, config.resumeId, config.engine === 'claude' ? config.accountProfileId : undefined); return file ? chatHistory(config.engine, file) : null; }, onEventError: () => hostHealth?.record('session-event-delivery-failed'), onContextWindow: (runId, size) => hub?.telemetry?.setContextWindow(runId, size), onStall: () => hostHealth?.record('output-acknowledgement-stalled'), profileEnvironment: (base, id) => claudeProfiles.environment(base, id), prepareLaunch: (run, config, info, launch) => {
  hub?.rules.verifyLaunch(run.cwd);
  if (config.resumeId) { if (hub?.telemetry?.isConversationActive(config.engine, config.resumeId)) throw new HubError('RESUME_BUSY', 'This conversation is still active in another tile. Stop it before resuming.'); const source = nativeSessions.source(config.engine, config.resumeId, config.engine === 'claude' ? config.accountProfileId : undefined); if (!source) throw new HubError('NATIVE_SESSION', 'This native conversation is unavailable. Refresh CLI history before resuming.'); hub?.telemetry?.setResumeSource(run.runId, source, config.engine, config.model); }
  if (config.engine === 'claude' && config.tokenLimits.maxSessionTokens !== null && !hub?.telemetry) throw new HubError('TELEMETRY_UNAVAILABLE', 'Token limits require writable local telemetry storage.');
  hub?.telemetry?.prepare(run, config, info, launch);
  // Let the agent say when it is waiting for the person. Older CLIs run without it.
  if (config.engine === 'claude' && info.supportsSettings && supportsHttpHooks(info.version)) {
    const url = attention.register(run.runId);
    // A terminal reports its context window through Trace's status line, unless the person has their own (chats report it with each reply).
    const claudeHome = config.accountProfileId ? claudeProfiles.directory(config.accountProfileId) : process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    const statusLine = !config.chat && !ownStatusLine(claudeHome, run.cwd);
    if (url) { launch.args.push('--settings', claudeAttentionSettings(url, supportsSessionHook(info.version) ? systemCurl() : null, statusLine)); Object.assign(launch.env, withLoopbackNoProxy({ ...process.env, ...launch.env })); }
  }
  if (config.engine === 'codex' && info.supportsConfig) for (const value of CODEX_ATTENTION_CONFIG) launch.args.push('--config', value);
  // Last: Claude's --mcp-config takes a list of values.
  autoMemory?.prepare(run, config.model, info, launch);
}, abandonLaunch: (run) => { attention.unregister(run.runId); hub?.telemetry?.abandon(run.runId); autoMemory?.abandon(run.runId); }, onStarted: (run, config, owner) => {
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

/** This computer's channels in tile order, named as their tiles name them (for phones, linked computers and alerts). */
function workspaceChannels() {
  const saved = storage?.load(); const running = new Map(manager.running().map((run) => [run.sessionId, run.cwd]));
  // A Round Table's partner (the lead's saved roundTable.partner, as the window hides it) is marked, not listed as a channel.
  const seats = new Map<string, string>(); for (const session of saved?.sessions ?? []) if (session.roundTable && session.roundTable.partner !== session.id && saved!.sessions.some((item) => item.id === session.roundTable!.partner)) seats.set(session.roundTable.partner, session.id);
  return (saved?.sessions ?? []).map((session) => ({ id: session.id, engine: session.config.engine, ...(session.config.engine !== 'shell' && session.config.chat ? { chat: true as const } : {}), ...(seats.has(session.id) ? { seatedAt: seats.get(session.id)! } : {}),
    ...(channelAccount(session.config) ? { account: channelAccount(session.config)! } : {}), title: channelName({ engine: session.config.engine, title: session.title, cwd: running.get(session.id) ?? (session.binding.mode === 'independent' ? session.binding.cwd : saved?.rootDirectory ?? null) }) }));
}
/** The memory project (projectMemoryKey) of each of this computer's channels' folders, in tile order, each once. */
function channelProjects(): { project: string; directory: string }[] {
  const saved = storage?.load(); const running = new Map(manager.running().map((run) => [run.sessionId, run.cwd])); const found = new Map<string, string>();
  for (const session of saved?.sessions ?? []) {
    const cwd = running.get(session.id) ?? (session.binding.mode === 'independent' ? session.binding.cwd : saved?.rootDirectory ?? null); if (!cwd) continue;
    try { const project = projectMemoryKey(cwd); if (!found.has(project)) found.set(project, cwd); } catch { /* An unreadable folder has no notes to show. */ }
  }
  return [...found].map(([project, directory]) => ({ project, directory }));
}
/**
 * A desktop notification, unless they are turned off in Settings. A channel's alert is shown only while Trace is not in
 * front (the window shows it then); budget and plan-limit warnings always are. Clicking brings Trace forward on it.
 */
function desktopAlert(alert: DesktopAlert, always = false) {
  try { if (hub?.preferences().alerts === false) return; } catch { /* Unreadable preferences: alerts stay on. */ }
  if (!Notification.isSupported() || (!always && window && !window.isDestroyed() && window.isFocused())) return;
  const notice = new Notification({ title: alert.title, body: alert.body.slice(0, 200) });
  notice.on('click', () => { if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); sendToRenderer(IPC_CHANNELS.alertClick, alert.target); });
  notice.show();
}
/** This computer's channel, by number and name as its tile shows it, for alerts. */
function channelLabel(sessionId: string) {
  const all = workspaceChannels(); const seat = all.find((channel) => channel.id === sessionId && channel.seatedAt);
  // A Round Table's partner is named after the channel it sits in, with its agent.
  const channels = all.filter((channel) => !channel.seatedAt); const index = channels.findIndex((channel) => channel.id === (seat?.seatedAt ?? sessionId));
  return index >= 0 ? `CH${index + 1} · ${channels[index].title}${seat ? ` (${seat.engine === 'codex' ? 'Codex' : 'Claude'})` : ''}` : 'A channel';
}
function sendToRenderer(channel: string, value: unknown, owner?: number): boolean {
  try {
    const id = owner ?? (window && !window.isDestroyed() ? window.webContents.id : undefined);
    const target = id === undefined ? null : webContents.fromId(id);
    if (!target || target.isDestroyed()) return false;
    target.send(channel, value); return true;
  } catch { hostHealth?.record('renderer-event-delivery-failed', channel); return false; }
}
function reportStorageError(message: string) { sendToRenderer(IPC_CHANNELS.storageError, message); }
/**
 * On a Mac, installing Trace.app does not replace the copy named AI Coding Hub.app from before the rename (Windows'
 * installer does, by the shared app ID). Once, Trace offers to move that old copy to the Trash.
 */
async function offerToRemoveOldApp() {
  // Never from a copy with its own profile (tests, or a second setup): only the person's own Trace asks.
  if (process.platform !== 'darwin' || !app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return;
  // As a sheet on Trace's window once it is up, so it is clearly this app asking.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const parent = window && !window.isDestroyed() ? window : null; if (!parent) return;
  const old = '/Applications/AI Coding Hub.app'; const asked = path.join(app.getPath('userData'), 'old-app-offered');
  if (!fs.existsSync(old) || fs.existsSync(asked) || app.getPath('exe').startsWith(old + '/')) return;
  // Nothing is moved unless the person clicks Move to Trash: Return, Escape or closing the question keeps the old copy.
  const { response } = await dialog.showMessageBox(parent, { type: 'question', buttons: ['Keep it', 'Move to Trash'], defaultId: 0, cancelId: 0, title: 'Remove the old copy?', message: 'An older copy of this app, named AI Coding Hub, is still in Applications.', detail: 'Trace replaces it and keeps all your settings, channels and history. If AI Coding Hub is in your Dock, remove it and add Trace instead.' });
  fs.writeFileSync(asked, new Date().toISOString());
  if (response === 1) await shell.trashItem(old);
}
const linkedSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('linked-status') }).strict(),
  z.object({ action: z.literal('linked-link'), id: z.uuid(), code: z.string().min(1).max(40) }).strict(),
  z.object({ action: z.literal('linked-unlink'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-input'), id: z.uuid(), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100), data: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('linked-control'), id: z.uuid(), sessionId: z.string().min(1).max(100), control: z.enum(['start', 'stop', 'restart', 'close']) }).strict(),
  z.object({ action: z.literal('linked-add'), id: z.uuid(), engine: z.enum(['claude', 'codex', 'shell']), chat: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('linked-chat'), id: z.uuid(), request: chatRequestSchema }).strict(),
  z.object({ action: z.literal('linked-chat-history'), id: z.uuid(), sessionId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('linked-update'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-coach-review'), id: z.uuid(), tip: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-paste-image'), id: z.uuid(), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100), image: z.string().min(8).max(21 * 1024 * 1024) }).strict(),
  z.object({ action: z.literal('linked-watch'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-unwatch'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-screen-state'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-transcript'), id: z.uuid(), sessionId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('linked-fit'), id: z.uuid(), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100), cols: z.number().int().min(20).max(300).optional(), rows: z.number().int().min(6).max(200).optional() }).strict(),
]);
const screenSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('screen-open'), id: z.uuid(), streamId: z.uuid() }).strict(),
  z.object({ action: z.literal('screen-send'), streamId: z.uuid(), data: z.instanceof(Uint8Array).refine((data) => data.byteLength > 0 && data.byteLength <= 1024 * 1024) }).strict(),
  z.object({ action: z.literal('screen-close'), streamId: z.uuid() }).strict(),
  z.object({ action: z.literal('screen-credentials'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('screen-save-credentials'), id: z.uuid(), username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }).strict(),
  z.object({ action: z.literal('screen-forget-credentials'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('screen-share-status') }).strict(),
  z.object({ action: z.literal('screen-share-set'), enabled: z.boolean() }).strict(),
]);
async function screenRequest(owner: number, payload: unknown) {
  const request = screenSchema.parse(payload);
  if (request.action === 'screen-share-status' || request.action === 'screen-share-set') {
    if (!screenShare) throw new HubError('SCREEN_UNAVAILABLE', 'Sharing this screen needs writable local storage.');
    return request.action === 'screen-share-set' ? screenShare.set(request.enabled) : screenShare.status();
  }
  if (!screens) throw new HubError('SCREEN_UNAVAILABLE', 'Screen sharing needs linked computers, which need writable local storage.');
  if (request.action === 'screen-open') return screens.open(owner, request.id, request.streamId);
  if (request.action === 'screen-send') return screens.send(owner, request.streamId, request.data);
  if (request.action === 'screen-close') return screens.close(owner, request.streamId);
  if (request.action === 'screen-save-credentials') return screens.saveCredentials(request.id, { username: request.username, password: request.password });
  if (request.action === 'screen-forget-credentials') return screens.forgetCredentials(request.id);
  return screens.credentials(request.id);
}
/**
 * Restart and install, asked for by a linked computer. An edition that updates itself does so; a Mac copy that cannot
 * (not signed with Trace's Developer ID) runs the install script, which puts the old version back if the new one does
 * not answer. Either way the workspace is saved first and running channels must be stopped.
 */
async function remoteUpdate(): Promise<string> {
  if (updates && updates.status().phase !== 'disabled') return updates.remoteInstall();
  if (process.platform !== 'darwin' || !app.isPackaged) throw new HubError('UPDATES_DISABLED', 'This copy of Trace is updated by hand (a portable or source copy).');
  const version = await latestMacVersion(); if (!version) throw new HubError('UPDATE_FAILED', 'Trace there could not read the latest version. Check its connection.');
  if (version === app.getVersion()) return `Trace ${version} there is already the latest version.`;
  if (manager.hasSessions) throw new HubError('ACTIVE_SESSIONS', 'Stop the channels running there first, then try again.');
  if (workspaceLoaded) await flushWorkspace();
  startMacUpdate(storageRoot, version, REMOTE_PORT);
  return `Installing Trace ${version} there. It quits, restarts and is back in about a minute; if the new version does not start, the old one is put back.`;
}
async function linkedRequest(payload: unknown) {
  if (!linked) throw new HubError('LINK_UNAVAILABLE', 'Linking computers needs writable local storage.');
  const request = linkedSchema.parse(payload);
  if (request.action === 'linked-link') return linked.link(request.id, request.code);
  if (request.action === 'linked-unlink') return linked.unlink(request.id);
  if (request.action === 'linked-input') { await linked.input(request.id, request.sessionId, request.runId, request.data); return null; }
  if (request.action === 'linked-control') { await linked.control(request.id, request.sessionId, request.control); return null; }
  if (request.action === 'linked-add') { await linked.add(request.id, request.engine, request.chat === true && request.engine !== 'shell'); return null; }
  if (request.action === 'linked-chat') { await linked.chat(request.id, request.request); return null; }
  if (request.action === 'linked-chat-history') return linked.chatHistory(request.id, request.sessionId);
  if (request.action === 'linked-update') return linked.update(request.id);
  if (request.action === 'linked-coach-review') { await linked.coachReview(request.id, request.tip); return null; }
  if (request.action === 'linked-paste-image') { await linked.pasteImage(request.id, request.sessionId, request.runId, request.image); return null; }
  if (request.action === 'linked-screen-state') return linked.screenState(request.id);
  if (request.action === 'linked-transcript') return linked.transcript(request.id, request.sessionId);
  if (request.action === 'linked-watch') { linked.watch(request.id); return null; }
  if (request.action === 'linked-unwatch') { linked.unwatch(request.id); return null; }
  if (request.action === 'linked-fit') { await linked.fit(request.id, request.sessionId, request.runId, request.cols && request.rows ? { cols: request.cols, rows: request.rows } : null); return null; }
  return linked.status();
}
/**
 * A channel's whole conversation, read from its CLI's own transcript: every restart resumes the same conversation, so
 * this covers them all, while the terminal shows only the current run. Null for terminals and channels never run.
 */
function channelTranscript(sessionId: string): ChannelTranscript {
  const config = storage?.load()?.sessions.find((session) => session.id === sessionId)?.config;
  if (!config || config.engine === 'shell' || !config.resumeId) return null;
  const file = nativeSessions.source(config.engine, config.resumeId, config.engine === 'claude' ? config.accountProfileId : undefined);
  return file ? chatHistory(config.engine, file) : null;
}
/** A linked computer asked to start, stop, restart or close one of this computer's channels; the desktop window does it. */
function controlChannel(sessionId: string, control: ChannelControl): Promise<void> { return askWindow({ sessionId, control }); }
/** A linked computer (or a phone allowed to) adds a channel here: the window adds it to this computer's workspace, as + Channel does. */
function addChannel(engine: ChannelEngine, chat = false, like?: string): Promise<void> { return askWindow({ add: engine, ...(chat && engine !== 'shell' ? { chat: true as const } : {}), ...(like ? { like } : {}) }); }
/**
 * A phone resumes a conversation from Session history here: the window adds the channel, as Resume there does. The key
 * must be one the history lists, and the conversation's own folder is used (a phone cannot choose another).
 */
async function resumeConversation(key: string): Promise<void> {
  const { conversation, directory } = await nativeSessions.execute({ action: 'native-resume', key }) as NativeResume;
  const label = workflows?.labels().find((item) => item.key === conversation.key)?.name;
  return askWindow({ engine: conversation.engine, id: conversation.id, ...(conversation.profileId ? { profileId: conversation.profileId } : {}), directory, title: label || (conversation.engine === 'claude' ? 'Claude · resumed' : 'Codex · resumed') }, IPC_CHANNELS.remoteResume);
}
function askWindow(request: { sessionId: string; control: ChannelControl } | { add: ChannelEngine; chat?: true } | Omit<RemoteResumeRequest, 'requestId'>, channel: string = IPC_CHANNELS.remoteControl): Promise<void> {
  if (!window || window.isDestroyed()) return Promise.reject(new HubError('REMOTE_NO_WINDOW', 'Trace’s window is closed on this computer, so its channels cannot be started or stopped from elsewhere.'));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingControls.delete(requestId); reject(new HubError('REMOTE_CONTROL_TIMEOUT', 'This computer did not finish in time. Check the channel there.')); }, 45000);
    pendingControls.set(requestId, { resolve, reject, timer });
    if (!sendToRenderer(channel, { requestId, ...request })) { clearTimeout(timer); pendingControls.delete(requestId); reject(new HubError('REMOTE_NO_WINDOW', 'Trace’s window on this computer is not available.')); }
  });
}
/**
 * Asks what to do when channels could not be stopped. Closing or quitting anyway leaves them running with no Trace
 * controls, so that is a choice the person makes with the process IDs in front of them, never a silent default.
 */
async function leftRunningChoice(parent: BrowserWindow | null, pids: number[], leave: string, keep: string): Promise<'retry' | 'quit' | 'keep'> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning', title: 'Some channels are still running', buttons: ['Try stopping again', leave, keep], defaultId: 0, cancelId: 2,
    message: pids.length === 1 ? 'A channel or sign-in terminal could not be stopped.' : `${pids.length} channels or sign-in terminals could not be stopped.`,
    detail: `Process ${pids.length === 1 ? 'ID' : 'IDs'}: ${pids.join(', ')}. If you ${leave.toLowerCase()}, ${pids.length === 1 ? 'it keeps' : 'they keep'} running without Trace; end ${pids.length === 1 ? 'it' : 'them'} in ${process.platform === 'win32' ? 'Task Manager' : 'Activity Monitor'} later.`,
  };
  try { const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options); return response === 0 ? 'retry' : response === 1 ? 'quit' : 'keep'; }
  catch { return 'keep'; }
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
    title: 'Trace',
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
  // Checks (navigator.permissions.query, HID, serial, USB) are refused too, not left to Chromium's defaults.
  window.webContents.session.setPermissionCheckHandler(() => false); window.webContents.session.setDevicePermissionHandler(() => false);
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
      if (manager.ownedProcessIds(owner).length || accounts.processIds(owner).length) throw new HubError('STOP_FAILED', 'A CLI or sign-in process is still owned by this window.');
      const answer = await dialog.showMessageBox(current, { type: 'error', title: 'Workspace display stopped', message: 'The application display stopped unexpectedly. Coding and login terminals have been stopped.', detail: 'Reload restores the last saved workspace as idle tiles. Local lifecycle diagnostics are available in Settings.', buttons: ['Reload workspace', 'Close'], defaultId: 0, cancelId: 1 });
      if (current.isDestroyed()) return;
      if (answer.response === 0) current.webContents.reload(); else current.close();
    }).catch(() => {
      hostHealth?.record('renderer-recovery-failed');
      if (!quitting && !current.isDestroyed()) dialog.showErrorBox('Workspace recovery could not finish', `A coding or login process could not be confirmed stopped. Check your system process manager before restarting Trace.${manager.ownedProcessIds(owner).length ? '\nOwned coding process IDs: ' + manager.ownedProcessIds(owner).join(', ') : ''}\nLocal lifecycle diagnostics were preserved.`);
    });
  });
  current.webContents.on('render-process-gone', () => { repositoryFiles.closeOwner(owner); screens?.closeAll(owner); });
  // did-start-navigation fires before will-navigate can cancel, so clean up only once the old page is really replaced.
  let firstDocument = true;
  current.webContents.on('did-navigate', () => {
    if (firstDocument) { firstDocument = false; return; }
    void accounts.stopOwner(owner).catch(() => {}); void manager.stopOwner(owner); repositoryFiles.closeOwner(owner); screens?.closeAll(owner);
  });
  let closing = false;
  current.on('close', (event) => {
    if (closing || quitting) return;
    event.preventDefault();
    if (delivery?.running || workflows?.running || worktrees?.active) { void dialog.showMessageBox(current, { type: 'info', message: 'Wait for the reviewed workflow or worktree operation to finish before closing the app.' }); return; }
    closing = true;
    void flushWorkspace().then(() => Promise.all([manager.stopOwner(owner), accounts.stopOwner(owner)])).catch(() => hostHealth?.record('shutdown-stop-failed')).then(async () => {
      // Closing the window takes away every control for a channel, so never do that silently while one still runs.
      const left = [...manager.ownedProcessIds(owner), ...accounts.processIds(owner)];
      if (left.length && !current.isDestroyed()) {
        hostHealth?.record('shutdown-processes-left', String(left.length));
        const choice = await leftRunningChoice(current, left, 'Close anyway', 'Keep the window open');
        closing = false;
        if (choice === 'retry') { current.close(); return; }
        if (choice === 'keep') return;
      }
      repositoryFiles.closeOwner(owner); if (!current.isDestroyed()) current.destroy();
    });
  });
  window.on('closed', () => { window = null; });
}

// Opened from Finder or the Dock, the Mac app lacks the shell's PATH, where the CLIs and Node.js usually are.
if (process.platform === 'darwin' && app.isPackaged) adoptLoginShellPath();
// Opening Trace again (Start menu, shortcut, Dock) while it runs shows the window it already has, instead of nothing.
app.on('second-instance', () => { if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); });
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  void offerToRemoveOldApp().catch(() => {});
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
    hub.telemetry.onError = (_run, message) => { hostHealth?.record('telemetry-read-failed'); reportStorageError(message); };
    hub.telemetry.onConversation = (run, conversationId) => manager.notifyConversation(run.runId, conversationId);
    // Once, two minutes after starting (it reads Claude Code's older transcripts): each older reply's day.
    const telemetry = hub.telemetry; setTimeout(() => { try { telemetry.backfillDays([process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), ...claudeProfiles.list().map((profile) => claudeProfiles.directory(profile.id))]); } catch { hostHealth?.record('usage-days-backfill-failed'); } }, 120000).unref();
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
      onNotice: (message) => { hostHealth?.record('auto-memory-notice'); reportStorageError(message); },
    });
    // Once startup settles: repair stale memory entries in the folders this computer has run agents in (issue #19).
    const sweeping = autoMemory; setTimeout(() => { try { sweeping.sweep([...new Set((memoryHub.telemetry?.list() ?? []).map((record) => record.cwd))]); } catch { hostHealth?.record('auto-memory-sweep-failed'); } }, 90000).unref();
  }
  /** Claude Design handoff import only (the Design workspace was removed). No window calls it yet; the planned Claude tab will. */
  const handoffs = new HandoffImport(async (source) => {
    const result = source === 'zip'
      ? await dialog.showOpenDialog(window!, { title: 'Import a Claude Design handoff bundle', properties: ['openFile'], filters: [{ name: 'ZIP bundle', extensions: ['zip'] }] })
      : await dialog.showOpenDialog(window!, { title: 'Import an extracted Claude Design handoff folder', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(IPC_CHANNELS.designs, (_owner, payload) => {
    if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.');
    return handoffs.execute(payload);
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
  const liveCoach = new LiveCoach(path.join(storageRoot, 'coaching'), (tip) => { sendToRenderer(IPC_CHANNELS.coachingEvent, tip); remote?.channelsChanged(); }, async (engine, profileId) => {
    const env = hostEnvironment(); const executable = await findExecutable(engine, env).catch(() => null);
    return executable ? { executable, env: engine === 'claude' && profileId ? claudeProfiles.environment(env, profileId) : env } : null;
  });
  if (hub?.telemetry) hub.telemetry.onLine = (run, config, raw) => liveCoach.observe(run, config, raw);
  const coaching = hub ? new CoachingService(storageRoot, hub.rules, directoryInUse, liveCoach) : null;
  handle(IPC_CHANNELS.coaching, (_owner, payload) => { if (!coaching) throw new HubError('COACHING_STORAGE', 'Local coaching storage is unavailable.'); if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); return coaching.execute(payload); });
  const diagnostics = new Diagnostics(claudeProfiles);
  verification = new Verification(storageRoot, async (profile) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Run verification', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Run trusted project commands', message: `${profile.name} — ${profile.directory}`, detail: profile.steps.map((step) => `${step.label}: ${step.tool} ${JSON.stringify(step.args)}`).join('\n') + `\nCommands and package hooks run with your local permissions. Timeout: ${profile.timeoutSeconds}s per step.` })).response === 0 && !updateRestart);
  const tasks = new Tasks(storageRoot, verification);
  const experiments = new Experiments(storageRoot, (id) => Boolean(storage?.history().some((run) => run.runId === id)));
  const readyForBackup = async () => { if (manager.hasSessions || accounts.active || projectSetup.active || worktrees?.active || projectChecks?.running || verification?.running || delivery?.running || workflows?.running) throw new HubError('BACKUP_BUSY', 'Stop all sessions and verification jobs before backing up or restoring.'); if (!storage || !workspaceLoaded) throw new HubError('BACKUP_STORAGE', 'Load a writable workspace before backing up.'); await flushWorkspace(); if (!lastFlushSucceeded) throw new HubError('BACKUP_SAVE', 'Save the workspace successfully before backing up.'); };
  backups = new Backups(storageBase, storageRoot, profileRoot, app.getVersion(), { ready: readyForBackup,
    exportFile: async () => (await dialog.showSaveDialog(window!, { title: 'Export local backup', defaultPath: `Trace-${app.getVersion()}.hub-backup.gz`, filters: [{ name: 'Trace backup', extensions: ['gz'] }] })).filePath ?? null,
    importFile: async () => { const selected = await dialog.showOpenDialog(window!, { title: 'Import local backup', properties: ['openFile'], filters: [{ name: 'Trace backup', extensions: ['gz'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null; },
    confirmRestore: async (record) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Activate restored copy on restart', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Review verified restore', message: `${record.files} files · ${record.bytes} bytes · version ${record.appVersion}`, detail: 'The backup was checked and copied into a new local restore directory. Current data and project files remain intact. Credentials are excluded, so named profiles may need login again. Restart to activate the restored copy.' })).response === 0 && !updateRestart,
  });
  const confirmWorkflow = async (title: string, detail: string) => (await dialog.showMessageBox(window!, { type: 'question', title, message: title, detail, buttons: ['Confirm reviewed action', 'Cancel'], defaultId: 1, cancelId: 1 })).response === 0 && !updateRestart && !backups?.busy;
  const workflowReady = () => { if (manager.hasSessions || projectChecks?.running || verification?.running || workflows?.running || updateRestart || backups?.busy) throw new HubError('WORKFLOW_BUSY', 'Stop coding sessions and verification before changing repositories or applying templates.'); };
  delivery = new Delivery(confirmWorkflow, workflowReady);
  workflows = hub && storage ? new Workflows(storageRoot, nativeSessions, verification, hub.rules, storage, confirmWorkflow) : null;
  // Phone remote: off until turned on in Settings. It listens on loopback only; Tailscale carries it to the phone.
  remote = new RemoteServer(storageRoot, {
    // Channels still called by their engine's name are named after their folder, as on the desktop.
    sessions: () => workspaceChannels(),
    running: () => manager.running(),
    write: (reference, data) => manager.writeRemote(reference, data),
    control: (sessionId, control) => controlChannel(sessionId, control),
    add: (engine, chat, like) => addChannel(engine, chat, like),
    chat: (request) => manager.chatRemote(request),
    // Claude Code and Codex take an image from this computer's clipboard when they get their image key (Alt+V on
    // Windows, Ctrl+V on a Mac), so the pasted image is put there first, as a paste here would.
    pasteImage: async (reference, data) => {
      const run = manager.running().find((item) => item.sessionId === reference.sessionId && item.runId === reference.runId);
      if (!run) throw new HubError('STALE_SESSION', 'That channel is no longer running here.');
      if (run.engine === 'shell') throw new HubError('PASTE_SHELL', 'Images paste into Claude Code and Codex channels, not terminals.');
      const image = nativeImage.createFromBuffer(data); if (image.isEmpty()) throw new HubError('PASTE_IMAGE', 'That image could not be read.');
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
      manager.writeRemote(reference, process.platform === 'win32' ? '\x1bv' : '\x16');
    },
    resize: (reference, cols, rows) => manager.resizeRemote(reference, cols, rows),
    update: () => remoteUpdate(),
    coaching: (sessionId) => liveCoach.latest(sessionId),
    askCoach: (id) => liveCoach.ask(id),
    // Keyboard and mouse use of this computer, so a phone does not shrink channels while the person is here.
    // CODING_HUB_TEST_DESKTOP_IDLE (test-only): smoke tests say how long the computer has been idle; CI machines never are.
    idleSeconds: () => process.env.CODING_HUB_TEST_DESKTOP_IDLE ? Number(process.env.CODING_HUB_TEST_DESKTOP_IDLE) : powerMonitor.getSystemIdleTime(),
    // A Mac asks the system: Electron's idle state says active when Trace started while the Mac was already locked.
    transcript: channelTranscript,
    // A phone's Screen reaches this Mac's own Screen Sharing on loopback; Windows has no system server for it yet.
    ...(process.platform === 'darwin' ? { screenTarget: () => ({ host: '127.0.0.1', port: 5900 }) } : {}),
    screenLocked: process.platform === 'darwin' ? macScreenLock() : () => { const state = powerMonitor.getSystemIdleState(1); return state === 'unknown' ? null : state === 'locked'; },
    // Usage as the status bar shows it. Plan limits are what was last read; reading them starts the CLIs, so a phone only
    // asks for a fresh read in the background, at most every five minutes like Usage (PlanLimitsService.refresh).
    usage: () => {
      void planLimits.refresh().catch(() => {});
      let budget: { dailyTokens?: number | null; dailyCost?: number | null; limitWarning?: number } | null = null; try { budget = hub?.preferences() ?? null; } catch { /* Unreadable preferences: no budget shown. */ }
      return { today: dayUsage.totals(), limits: planLimits.current(), budget };
    },
    tasks: () => tasks.list(),
    taskStatus: async (id, status) => { await tasks.execute({ action: 'task-status', id, status }); },
    history: async () => { const labels = workflows?.labels() ?? []; return (await nativeSessions.list()).map((item) => { const label = labels.find((entry) => entry.key === item.key)?.name; return label ? { ...item, label } : item; }); },
    resume: (key) => resumeConversation(key),
    memoryProjects: () => channelProjects(),
    memoryNotes: (project) => { if (!hub) throw new HubError('HUB_STORAGE', 'Memory storage is unavailable on this computer.'); return hub.memory.list(project); },
    writeMemory: (project, title, content) => { if (!hub) throw new HubError('HUB_STORAGE', 'Memory storage is unavailable on this computer.'); hub.execute({ action: 'memory-write', project, title, content, author: 'human' }); },
  // CODING_HUB_TEST_REMOTE_PORT (source runs only): smoke tests listen elsewhere, so they run while an installed Trace is open.
  }, !app.isPackaged && process.env.CODING_HUB_TEST_REMOTE_PORT ? Number(process.env.CODING_HUB_TEST_REMOTE_PORT) : undefined, path.join(__dirname, '../../dist/phone'));
  const runTailscale = tailscaleRunner(); const phone = remote; let serveConsent = false;
  // This Windows computer's screen, for linked computers, from a service that also runs while Trace is closed.
  screenShare = new ScreenShare(storageRoot, () => hub?.devices.machine.name ?? os.hostname(), runTailscale);
  void screenShare.ensure().catch(() => hostHealth?.record('screen-service-start-failed'));
  // Other computers: each advertises its remote's tailnet address through the Drive sync folder, and links with a code.
  if (hub) {
    const devices = hub.devices; phone.identity = devices.machine;
    devices.advertise = () => phone.enabled && phone.tailscale.serving ? phone.status().url : null;
    // Another computer's channel that needs the person is told here while this window is not in front; clicking opens its tab.
    const linkedAlerts = new LinkedAlerts((alert) => desktopAlert({ title: alert.title, body: alert.body, target: { computerId: alert.id } }));
    linked = new LinkedComputers(storageRoot, () => devices.machine, () => devices.advertised(), (event) => { if (event.type === 'computers') linkedAlerts.update(event.computers); sendToRenderer(IPC_CHANNELS.linkedEvent, event); },
      { output: (sessionId, runId, data) => phone.relayOutput(sessionId, runId, data), resize: (sessionId, runId, cols, rows) => phone.relayResize(sessionId, runId, cols, rows), changed: () => phone.relayChanged(), chat: (envelope) => phone.relayChat(envelope) }, fetch, () => powerMonitor.getSystemIdleTime());
    linked.chatEvents = (event) => sendToRenderer(IPC_CHANNELS.linkedChatEvent, event);
    // A smoke test (an unpackaged run on its own remote port) must never find or link the owner's real computers on
    // the tailnet: it would leave links to a throwaway copy on them. CODING_HUB_TEST_TAILNET=1 opts a test back in.
    const isolatedTest = !app.isPackaged && Boolean(process.env.CODING_HUB_TEST_REMOTE_PORT) && process.env.CODING_HUB_TEST_TAILNET !== '1';
    phone.setRelay(linked); linked.peers = () => isolatedTest ? Promise.resolve([]) : tailscalePeers(runTailscale); linked.start();
    // Only a linked computer's Tailscale name is ever connected to; the window names the computer, never the address.
    // The screen smoke test serves a stand-in screen on loopback (source runs only).
    const testScreen = !app.isPackaged && process.env.CODING_HUB_TEST_SCREEN_PORT ? Number(process.env.CODING_HUB_TEST_SCREEN_PORT) : null;
    // A Windows computer's Trace screen service is tried first, with the link key; then a Mac's own Screen Sharing.
    screens = new ScreenSharing(storageRoot, (id) => {
      const access = linked?.access(id); if (!access) return null; const host = testScreen ? '127.0.0.1' : screenHost(access.url);
      return { name: access.name, trace: testScreen ? null : { url: access.url, token: access.token }, system: host ? { host, port: testScreen ?? SCREEN_PORT } : null };
    }, (owner, event) => sendToRenderer(IPC_CHANNELS.screenEvent, event, owner),
    { available: () => safeStorage.isEncryptionAvailable(), encrypt: (text) => safeStorage.encryptString(text).toString('base64'), decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')) });
    // The phone app the other computer served may call this one directly while that one is off.
    phone.allowedOrigins = () => devices.advertised().flatMap((computer) => { const url = linkableAddress(computer.url); return url ? [url.replace(/\/$/, '').toLowerCase()] : []; });
  }
  // Phones are accepted only on this computer's tailnet name: one failed `tailscale status` (a timeout, say) must not
  // forget it, or every phone request gets "Unknown host" until the next check.
  let checkedTailscale = 0;
  const refreshTailscale = async () => {
    if (!phone.enabled) return; checkedTailscale = Date.now(); const next = await tailscaleState(runTailscale, phone.port);
    phone.tailscale = !next.host && next.error && phone.tailscale.host ? { ...next, host: phone.tailscale.host } : next;
    if (phone.tailscale.serving) { phone.serveProblem = null; phone.serveLink = null; }
    // The person's other computers on the tailnet are found and linked with each check (a minute apart).
    if (phone.autoLink && phone.tailscale.running && !(!app.isPackaged && process.env.CODING_HUB_TEST_REMOTE_PORT && process.env.CODING_HUB_TEST_TAILNET !== '1')) void linked?.autoLink().catch(() => {});
  };
  void phone.start().then(refreshTailscale).catch(() => hostHealth?.record('remote-start-failed'));
  // Every minute, and every ten seconds while the tailnet name is not known yet.
  setInterval(() => { if (Date.now() - checkedTailscale >= 60000 || (phone.enabled && !phone.tailscale.host)) void refreshTailscale().catch(() => {}); }, 10000).unref();
  const remoteControl = async (payload: unknown) => {
    const request = z.discriminatedUnion('action', [
      z.object({ action: z.literal('remote-status') }).strict(), z.object({ action: z.literal('remote-enable'), enabled: z.boolean() }).strict(),
      z.object({ action: z.literal('remote-pair'), kind: z.enum(['phone', 'computer']).optional() }).strict(), z.object({ action: z.literal('remote-cancel-pairing') }).strict(),
      z.object({ action: z.literal('remote-revoke'), id: z.uuid() }).strict(), z.object({ action: z.literal('remote-serve'), automatic: z.boolean().optional() }).strict(),
      z.object({ action: z.literal('remote-open-tailscale') }).strict(),
      z.object({ action: z.literal('remote-test-alert'), id: z.uuid() }).strict(),
      z.object({ action: z.literal('remote-auto-link'), enabled: z.boolean() }).strict(),
      z.object({ action: z.literal('remote-can-run'), id: z.uuid(), canRun: z.boolean() }).strict(),
    ]).parse(payload);
    if (request.action === 'remote-auto-link') phone.setAutoLink(request.enabled);
    if (request.action === 'remote-enable') { await phone.setEnabled(request.enabled); if (!request.enabled) { serveConsent = false; await stopServing(runTailscale, phone.port).catch(() => hostHealth?.record('tailscale-serve-off-failed')); } }
    if (request.action === 'remote-cancel-pairing') return phone.cancelPairing();
    if (request.action === 'remote-revoke') return phone.revoke(request.id);
    if (request.action === 'remote-can-run') return phone.setCanRun(request.id, request.canRun);
    if (request.action === 'remote-test-alert') return phone.testAlert(request.id);
    if (request.action === 'remote-open-tailscale') { if (phone.serveLink) await shell.openExternal(phone.serveLink); return phone.status(); }
    if (request.action === 'remote-serve') {
      // Once agreed, a retry runs the same command: after fixing Tailscale's settings the person is not asked again.
      // An automatic retry never asks and never opens a page, so returning to Trace cannot bounce back to the browser.
      const confirmed = serveConsent || !request.automatic && (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Set up Tailscale HTTPS', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Reach Trace from your phone',
        message: 'Let devices on your tailnet reach Trace?', detail: `This runs "tailscale serve --bg --https=443 http://127.0.0.1:${phone.port}". Devices signed in to your Tailscale network can then open Trace's phone page; each phone still has to be paired here before it can see or type into channels. It is not exposed to the internet. It stays set until you remove it with "tailscale serve reset".` })).response === 0;
      if (confirmed) {
        serveConsent = true;
        try { await serveRemote(runTailscale, phone.port); phone.serveProblem = null; phone.serveLink = null; }
        catch (error) {
          const { url, ...problem } = serveFailure(error as TailscaleError);
          phone.serveProblem = problem; phone.serveLink = url;
          if (url && !request.automatic) void shell.openExternal(url);
        }
      }
    }
    await refreshTailscale().catch(() => {});
    return request.action === 'remote-pair' ? phone.pair(request.kind) : phone.status();
  };
  handle(IPC_CHANNELS.workbench, async (_owner, payload) => {
    const action = z.object({ action: z.string().max(60) }).passthrough().parse(payload).action;
    if (action === 'runtime') { z.object({ action: z.literal('runtime') }).strict().parse(payload); return { version: app.getVersion(), rendererVersion: app.getVersion(), edition: !app.isPackaged ? 'source' : process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed', executable: process.execPath, applicationPath: app.getAppPath(), storagePath: storageRoot, platform: process.platform, restartRequired: backups!.restartRequired }; }
    if (action === 'restart') { z.object({ action: z.literal('restart') }).strict().parse(payload); await readyForBackup(); app.relaunch(); app.quit(); return null; }
    if (updateRestart) throw new HubError('HOST_CLOSING', 'The application is restarting.');
    if (action === 'codex-models') return modelCatalog.execute(payload);
    if (action === 'host-health') { z.object({ action: z.literal('host-health') }).strict().parse(payload); return hostHealth!.report(); }
    if (action.startsWith('remote-')) return remoteControl(payload);
    if (action.startsWith('linked-')) return linkedRequest(payload);
    if (action === 'channel-transcript') return channelTranscript(z.object({ action: z.literal('channel-transcript'), sessionId: z.string().min(1).max(100) }).strict().parse(payload).sessionId);
    if (action === 'usage-today') { z.object({ action: z.literal('usage-today') }).strict().parse(payload); return dayUsage.totals(); }
    if (action === 'usage-days') { z.object({ action: z.literal('usage-days') }).strict().parse(payload); return dayUsage.days(); }
    if (action === 'plan-limits') { const request = z.object({ action: z.literal('plan-limits'), force: z.boolean().optional() }).strict().parse(payload); return planLimits.refresh(request.force); }
    if ((delivery?.running || workflows?.running) && ['verification-run', 'flow-template-apply', 'restart'].includes(action)) throw new HubError('DELIVERY_BUSY', 'Finish Git delivery before starting another job.');
    if (action.startsWith('flow-')) {
      if (backups?.busy) throw new HubError('BACKUP_BUSY', 'Finish the backup operation first.');
      if (action.startsWith('flow-git-')) return delivery!.execute(payload);
      if (action === 'flow-open-pr') { const request = z.object({ action: z.literal('flow-open-pr'), url: z.string().regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/) }).strict().parse(payload); await shell.openExternal(request.url); return null; }
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
    if (backups?.busy && ['verification-run', 'verification-save', 'task-save', 'experiment-save', 'trial-add'].includes(action)) throw new HubError('BACKUP_BUSY', 'Finish the backup operation before changing local workspace data.');
    if (action.startsWith('verification-')) return verification!.execute(payload);
    if (action.startsWith('task-')) return tasks.execute(payload);
    if (action.startsWith('experiment-') || action.startsWith('trial-')) return experiments.execute(payload);
    if (action.startsWith('backup-')) return backups!.execute(payload);
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
    enabled: updatesEnabled(app.isPackaged, process.platform, process.resourcesPath, Boolean(process.env.PORTABLE_EXECUTABLE_DIR), macUpdates()),
    disabledReason: process.platform === 'darwin' && app.isPackaged ? 'This Mac copy is not signed with Trace\'s Developer ID, so it cannot update itself. Install the latest version from the downloads page once; later versions then update themselves.' : 'Automatic updates require the installed Windows edition. Source and portable editions are updated manually.',
    openDownloads: () => shell.openExternal(DOWNLOADS_URL),
    storageDirectory: storageRoot,
    updater: autoUpdater,
    publish: (status) => { sendToRenderer(IPC_CHANNELS.updateStatus, status); },
    hasSessions: () => manager.hasSessions || accounts.active || projectSetup.active || Boolean(projectChecks?.running) || Boolean(verification?.running) || Boolean(backups?.busy) || Boolean(delivery?.running) || Boolean(workflows?.running) || Boolean(worktrees?.active),
    installationFailed: () => { updateRestart = false; },
    prepareRestart: async (remote) => {
      const answer = remote ? { response: 0 } : await dialog.showMessageBox(window!, { type: 'question', buttons: ['Restart and install', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Install update', message: 'Save your workspace and restart Trace?', detail: 'Local settings, history, rules, and memory remain in ~/.coding-hub. All CLI sessions must be stopped.' });
      if (answer.response !== 0) return false;
      updateRestart = true;
      try {
        if (manager.hasSessions || accounts.active || projectSetup.active || projectChecks?.running || verification?.running || backups?.busy || delivery?.running || workflows?.running || worktrees?.active) throw new HubError('ACTIVE_SESSIONS', 'Stop all CLI sessions before restarting.');
        if (workspaceLoaded) { await flushWorkspace(); if (!lastFlushSucceeded) throw new HubError('UPDATE_SAVE_FAILED', 'The workspace could not be saved. Resolve the storage issue before updating.'); }
        else throw new HubError('UPDATE_SAVE_FAILED', 'Load the local workspace successfully before updating.');
        // The installer closes Trace about two seconds after it starts and then ends it by force, so nothing slow may be
        // left for quitting: memory summaries of sessions that just ended are saved now, while Trace is still running.
        await autoMemory?.drain(10000)?.catch(() => hostHealth?.record('shutdown-stop-failed'));
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
    localStorage().save(payload); remote?.channelsChanged(); return null;
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
  handle(IPC_CHANNELS.finishRemoteControl, (_owner, payload) => {
    const result = z.object({ requestId: z.uuid(), error: z.string().max(500).optional() }).strict().parse(payload);
    const pending = pendingControls.get(result.requestId); if (!pending) return null;
    pendingControls.delete(result.requestId); clearTimeout(pending.timer);
    if (result.error) pending.reject(new HubError('REMOTE_CONTROL', result.error)); else pending.resolve();
    return null;
  });
  ipcMain.handle(IPC_CHANNELS.pickDirectory, async (event) => {
    assertSender(event);
    const result = await dialog.showOpenDialog(window!, { title: 'Choose a local project folder — files are hidden in this view', buttonLabel: 'Use this folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  // Read only to show the person what they pasted; the CLI reads the clipboard itself to attach the image.
  handle(IPC_CHANNELS.clipboardImage, async () => {
    const items = await clipboard.read();
    const type = items.flatMap((item) => item.types.map((name) => ({ item, name }))).sort((a, b) => Number(b.name === 'image/png') - Number(a.name === 'image/png')).find(({ name }) => name.startsWith('image/'));
    if (!type) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await (await type.item.getType(type.name) as Blob).arrayBuffer())); if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    const full = Math.max(width, height) > 2000 ? image.resize(width >= height ? { width: 2000 } : { height: 2000 }) : image;
    return { thumbnail: image.resize({ height: Math.min(height, 160) }).toDataURL(), full: full.toDataURL(), width, height, hasText: (await clipboard.readText()).length > 0 };
  });
  // Electron 44's clipboard is asynchronous: wait for the write, so a failure reaches the window instead of vanishing.
  handle(IPC_CHANNELS.screen, screenRequest);
  handle(IPC_CHANNELS.copyText, async (_owner, text) => { await clipboard.writeText(z.string().max(COPY_LIMIT).parse(text)); return null; });
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
  handle(IPC_CHANNELS.writeSession, (owner, payload) => {
    manager.write(owner, payload);
    const input = payload as { sessionId?: unknown; data?: unknown }; if (typeof input.sessionId === 'string' && typeof input.data === 'string') remote?.personInput(input.sessionId, input.data);
    return null;
  });
  handle(IPC_CHANNELS.ackSession, (owner, payload) => { manager.ack(owner, payload); return null; });
  handle(IPC_CHANNELS.chat, (owner, payload) => { manager.chat(owner, payload); return null; });
  handle(IPC_CHANNELS.resizeSession, (owner, payload) => {
    const parsed = resizeSessionSchema.safeParse(payload);
    // A channel a phone is showing keeps the phone's size; the desktop's new size is applied when the phone lets go.
    if (parsed.success && remote?.desktopResize(parsed.data.sessionId, parsed.data.runId, parsed.data.cols, parsed.data.rows)) return null;
    manager.resize(owner, payload);
    if (parsed.success) remote?.resized(parsed.data.sessionId);
    return null;
  });
  handle(IPC_CHANNELS.stopSession, async (owner, payload) => { await manager.stop(owner, payload); return null; });
  createWindow();
  updates.start();
  // Today's usage against the budgets set in Settings, and the plan limits the CLIs last reported (Usage and the status
  // bar read them every 5 minutes): checked every minute. What was said is kept for the day, so a restart does not repeat it.
  const warnedFile = path.join(storageRoot, 'usage-alerts.json'); let warned = new Set<string>();
  try { warned = new Set(z.array(z.string().max(300)).max(500).parse(JSON.parse(fs.readFileSync(warnedFile, 'utf8')))); } catch { /* None yet. */ }
  setInterval(() => {
    if (!hub) return;
    try {
      const before = warned.size; const alerts = usageAlerts(dayUsage.totals(), planLimits.current(), hub.preferences(), warned);
      for (const alert of alerts) desktopAlert(alert, true);
      if (warned.size !== before) fs.writeFileSync(warnedFile, JSON.stringify([...warned].slice(-300)), { mode: 0o600 });
    } catch { hostHealth?.record('usage-alerts-failed'); }
  }, 60000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (delivery?.running || workflows?.running || worktrees?.active) { if (window) void dialog.showMessageBox(window, { type: 'info', message: 'Wait for the reviewed workflow or worktree operation to finish before quitting.' }); return; }
  quitting = true;
  void flushWorkspace().then(() => Promise.all([manager.dispose(), accounts.close()])).catch(() => hostHealth?.record('shutdown-stop-failed'))
    .then(async () => {
      // Quitting would leave these running with nothing to control them; let the person decide.
      const left = [...manager.processIds(), ...accounts.processIds()];
      if (!left.length) return true;
      hostHealth?.record('shutdown-processes-left', String(left.length));
      const choice = await leftRunningChoice(window && !window.isDestroyed() ? window : null, left, 'Quit anyway', 'Keep Trace open');
      if (choice === 'quit') return true;
      quitting = false; manager.reopen(); accounts.reopen();
      if (choice === 'retry') app.quit();
      return false;
    })
    .then(async (quit) => {
    if (!quit) return;
    // Stopping sessions starts their memory summaries; let them save before storage closes.
    await autoMemory?.drain(10000)?.catch(() => hostHealth?.record('shutdown-stop-failed'));
    try { screens?.closeAll(); linked?.stop(); void remote?.stop(); attention.close(); modelCatalog.close(); projectChecks?.stop(); verification?.cancel(); updates?.close(); hub?.close(); storage?.close(); hostHealth?.close(); } finally { app.quit(); }
  });
});
