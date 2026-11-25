import { redactDiagnostic } from '../shared/productivity';
import { Workflows } from './services/workbench/workflows';
import { Delivery } from './services/workbench/delivery';
import { TaskPullRequests } from './services/workbench/task-pr';
import { inspectAccount } from './services/cli/account-connections';
import { ChildProcess, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { Diagnostics } from './services/workbench/diagnostics';
import { NativeSessions } from './services/workbench/native-sessions';
import { Backups, resolveStorageRoot } from './services/workbench/backups';
import { Verification } from './services/workbench/verification';
import { Tasks } from './services/workbench/tasks';
import { ScheduledJobs } from './services/workbench/scheduled-jobs';
import { Experiments } from './services/workbench/experiments';
import { z } from 'zod';
import { CoachingService } from './services/coaching/service';
import { LiveCoach } from './services/coaching/live';
import { HandoffImport } from './services/design/handoff';
import type { AccountLabel, AccountLabels } from '../shared/accounts';
import type { ChannelEngine, CustomChannelConfig } from '../shared/types';
import { REMOTE_PORT, type ChannelControl, type ChannelTranscript, type RemoteChannelChange, type RemoteChannelSettings, type RemoteResumeRequest, type ScheduledRunRequest } from '../shared/remote';
import { CLAUDE_MODELS, modelLabel } from '../shared/model-name';
import type { NativeResume, Task } from '../shared/workbench';
import { ProjectSetup } from './services/repository/project-setup';
import { AccountLoginManager } from './services/cli/account-login-manager';
import { app, shell, nativeImage, clipboard, ClipboardItem, BrowserWindow, dialog, ipcMain, Menu, Tray, webContents, crashReporter, powerMonitor, safeStorage, Notification, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { ProjectChecks } from './services/repository/project-checks';
import { WorktreeService } from './services/repository/worktrees';
import { autoUpdater } from 'electron-updater';
import { UpdateService, updatesEnabled } from './services/updates/update-service';
import { pathToFileURL } from 'node:url';
import os, { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chatHistory, chatText, taskHistory } from './services/chat/transcript';
import { macScreenLock } from './services/remote/screen-lock';
import { clipboardPreviewType, COPY_LIMIT, IPC_CHANNELS, type AgentRunningSession, type HostResult, type SessionEvent } from '../shared/ipc';
import { adoptLoginShellPath, discoverEngine, findExecutable, freshHostEnvironment, hostEnvironment } from './services/cli/discovery';
import { geminiConversationSince, geminiHome } from './services/cli/gemini-conversations';
import { HubError } from './services/cli/engine-adapter';
import { ClaudeProfiles } from './services/cli/claude-profiles';
import { isWithinDirectory, PtyManager } from './services/cli/pty-manager';
import { AttentionServer, CODEX_ATTENTION_CONFIG, claudeAttentionSettings, ownStatusLine, supportsHttpHooks, supportsSessionHook, systemCurl, withLoopbackNoProxy } from './services/cli/attention';
import { geminiModels, ModelCatalog } from './services/cli/model-catalog';
import { WorkspaceStorage } from './services/storage/workspace-storage';
import { saveResume, takeResume } from './services/storage/resume-list';
import { BackgroundRunner } from './services/runner/background';
import { readPorts, runnerPlace, writePorts } from './services/runner/kit';
import { ChannelTools } from './services/cli/channel-tools';
import { EventHooks } from './services/workbench/event-hooks';
import { AutoChecks } from './services/workbench/auto-checks';
import { geminiSafeSettings, safeActionRules } from '../shared/safe-actions';
import { TurnSnapshots } from './services/repository/turn-snapshots';
import { PreviewOffers } from './services/workbench/preview-offers';
import { AppPreview } from './services/workbench/app-preview';
import { EditorBridge, installVSCodeExtension, vscodeStatus } from './services/editor/editor-bridge';
import { Plugins, type PluginContext } from './services/plugins/plugins';
import { PluginApi } from './services/plugins/plugin-api';
import type { PluginEventName } from '../shared/plugins';
import { gpuCrashWindows, HostHealth, mainStalls, pruneCrashDumps, timed } from './services/storage/host-health';
import { chatRequestSchema, finishWorkspaceFlushSchema, MAX_CHANNELS, openLinkSchema, permissionLevel, resizeSessionSchema, webLink, windowHealthSchema } from '../shared/schemas';
import { DOWNLOADS_URL } from '../shared/updates';
import { RepositoryFiles } from './services/repository/filesystem';
import { RepositoryGit } from './services/repository/git';
import { HubService } from './services/hub/service';
import { RemoteServer } from './services/remote/remote-server';
import { serveFailure, serveRemote, stopServing, tailscalePeers, tailscaleRunner, tailscaleState, type TailscaleError } from './services/remote/tailscale';
import { INPUT_TIMEOUT, LinkedComputers, linkableAddress, tailnetOf } from './services/remote/linked-computers';
import { openTraceScreen, ScreenSharing, screenHost } from './services/remote/screen-sharing';
import { localScreenToken, shareEnabled } from './services/remote/screen-service-server';
import { ScreenShare } from './services/remote/screen-share';
import { MAX_DISPLAYS, SCREEN_PORT, SCREEN_SERVICE_PORT } from '../shared/screen';
import { PlanLimitsService } from './services/hub/plan-limits';
import { DayUsage } from './services/hub/day-usage';
import { load, save } from './services/workbench/local-store';
import { isNewerVersion, latestMacRelease, startMacUpdate } from './services/updates/mac-script-update';
import { LinkedAlerts } from './services/remote/linked-alerts';
import { usageAlerts, type DesktopAlert } from './services/alerts';
import { channelName, DEFAULT_TITLES } from '../shared/channel-name';
import { hiddenSeatIds } from '../shared/table-seats';
import { TelemetryService } from './services/hub/telemetry';
import { AutoMemory, projectMemoryKey } from './services/hub/auto-memory';
import { GEMINI_PLUGIN, GEMINI_TOOL_RULES, geminiConfigRoot, geminiPluginOff, installGeminiPlugin } from './services/hub/gemini-plugin';
import { setBackupRoot } from './services/hub/file-backups';
import { isAgentConfig, isBuiltInAgent, isChatEngineConfig, isChatRun } from '../shared/types';
import { CustomAgents } from './services/agents/agents';
import { buildAcpLaunch, buildCustomLaunch, takesTools, type McpServer } from './services/agents/launch';
import { AGENT_ID } from '../shared/agent-definition';
import { isBuiltInRun } from '../shared/ipc';

const storageBase = process.env.CODING_HUB_STORAGE_DIR ? path.resolve(process.env.CODING_HUB_STORAGE_DIR) : path.join(homedir(), '.coding-hub');
// The app installed as "AI Coding Hub" before it was renamed Trace; its Electron profile (window and display settings,
// a restored data folder) stays in the folder that name gave it, so the rename loses nothing.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'AI Coding Hub'));
const profileRoot = app.commandLine.getSwitchValue('user-data-dir') || app.getPath('userData');
const storageRoot = resolveStorageRoot(storageBase, profileRoot);
// Backups of configuration and instruction files Trace edits go here, never beside the file.
setBackupRoot(storageRoot);
let hostHealth: HostHealth | null = null;
process.on('uncaughtExceptionMonitor', (_error, origin) => hostHealth?.record('host-uncaught-exception', origin));
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit') return;
  hostHealth?.record('child-process-gone', `${details.type}: ${details.reason}`, details.exitCode);
  // With a GPU crash, each window's state, to tell a black window from one that was hidden, minimized or behind another.
  if (details.type === 'GPU') hostHealth?.record('gpu-crash-windows', gpuCrashWindows(BrowserWindow.getAllWindows()));
  // Also in the stall list, which channel starts cannot push out: a GPU restart can look like a short freeze.
  if (details.type === 'GPU') hostHealth?.stall('gpu', 'gpu-gone', null, details.reason);
});
let workflows: Workflows | null = null;
let delivery: Delivery | null = null;
/** Pull requests for tasks ready for review (1.39.0): built with Delivery, below. */
let taskPullRequests: TaskPullRequests | null = null;
let verification: Verification | null = null;
let backups: Backups | null = null;
let worktrees: WorktreeService | null = null;
const production = process.argv.includes('--production') || app.isPackaged;
let window: BrowserWindow | null = null;
let quitting = false;
let updateRestart = false;
/** A linked computer started the Mac install script here: it quits Trace once its download checks out. */
let scriptUpdate = false;
/** Jobs the install script would cut off do not start while it downloads; everything else keeps working. */
function refuseDuringScriptUpdate() { if (scriptUpdate) throw new HubError('UPDATE_RUNNING', 'Trace is installing an update another computer started. It restarts in a minute or two; try again then.'); }
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
/** The window that owns each run, so a token limit stops the run even when that window is not the current one. */
const runOwners = new Map<string, number>();
/** Whether anything an update or backup would cut off is running: channels, sign-ins and the other long jobs (set once they exist). */
let busyJobs = () => manager.hasSessions;
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
const dayUsage = new DayUsage(() => [{ engine: 'claude' as const, root: process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude') }, { engine: 'codex' as const, root: process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex') }, ...(() => { try { return claudeProfiles.list().map((profile) => ({ engine: 'claude' as const, root: claudeProfiles.directory(profile.id) })); } catch { return []; } })()], () => hub?.preferences().prices ?? [], undefined, path.join(storageRoot, 'day-usage.json'),
  // Gemini CLI's own conversation files: its terminal channels' and Round Table seats' usage.
  () => geminiHome());
const planLimits = new PlanLimitsService(() => claudeProfiles.list(), (base, id) => claudeProfiles.environment(base, id), undefined, undefined, () => claudeProfiles.labels().default?.name ?? null);
const accounts = new AccountLoginManager((owner, event) => sendToRenderer(IPC_CHANNELS.accountEvent, event, owner), { onEventError: () => hostHealth?.record('login-event-delivery-failed'), profiles: claudeProfiles, profileInUse: (id) => manager.usesProfile(id), openGuide: (url) => shell.openExternal(url) });
// Live coaching's reviews run in its coaching folder; their sessions are kept so their usage counts, but are not history.
const nativeSessions = new NativeSessions(claudeProfiles, [path.join(storageRoot, 'coaching')]);
const modelCatalog = new ModelCatalog({ clientVersion: app.getVersion() });
const repositoryFiles = new RepositoryFiles();
const repositoryGit = new RepositoryGit(repositoryFiles);
// Claude Code reports permission prompts to this loopback endpoint; see services/cli/attention.ts.
// SessionStart says which conversation a run is in: telemetry follows it there, then tells the window (see onConversation).
/**
 * Channel tools (1.33.0): agents may list, read, message and wait for other channels, only while the person has turned
 * that on. A Round Table counts as its lead's channel, and a message to it goes to the table; to a chat it goes in as a chat
 * message, to a terminal as a line.
 */
/** This computer's channels in order, a Round Table counted as its lead's (for the channel tools and plugins). */
function channelList() { const running = new Map(manager.running().map((run) => [run.sessionId, run])); return workspaceChannels().filter((session) => !session.seatedAt).map((session, index) => ({ channel: index + 1, sessionId: session.id, name: session.title, engine: session.engine, running: running.has(session.id), waiting: null, folder: running.get(session.id)?.cwd ?? null })); }
/** The agent a channel runs, by name: a custom agent's own (docs/custom-agents.md), else the engine's. */
function agentName(sessionId: string, engine: ChannelEngine): string { return (engine === 'custom' ? workspaceChannels().find((session) => session.id === sessionId)?.agent?.name : undefined) ?? DEFAULT_TITLES[engine] ?? engine; }
/** A channel's last `count` replies, from its CLI's own conversation, as text. */
function channelReplies(sessionId: string, count: number) { return (channelTranscript(sessionId)?.messages ?? []).flatMap((message) => message.role === 'assistant' ? [message.blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n').trim()] : []).filter(Boolean).slice(-count).map((text) => text.slice(-8000)); }
/** Types a message into a running channel: a chat gets it as a message (a Round Table's lead passes it to the table), a terminal as a line. */
async function sendToChannel(sessionId: string, text: string) {
  const run = manager.running().find((item) => item.sessionId === sessionId); if (!run) throw new HubError('CHANNEL_TOOLS_STOPPED', 'That channel is not running.');
  // A Round Table's lead passes it to the table, as a message typed there does (1.33.2; before, the lead alone got it).
  if (workspaceChannels().find((session) => session.id === sessionId)?.chat) manager.chatRemote({ action: manager.leadsTable(run.runId) ? 'table-send' : 'send', sessionId, runId: run.runId, text, images: [] }); else manager.writeRemote({ sessionId, runId: run.runId }, text + '\r');
}
/** What a plugin action is about (docs/plugins.md, section 3): the project, the channel it was asked on, its folder and branch. */
function pluginContext(sessionId?: string, repository?: string): PluginContext {
  const channel = sessionId ? channelList().find((item) => item.sessionId === sessionId) : undefined; const folder = repository ?? channel?.folder ?? storage?.load()?.rootDirectory ?? null;
  let branch: string | null = null; if (folder) try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder, encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* Not a Git folder. */ }
  return { project: storage?.load()?.rootDirectory ?? null, channel: channel?.channel ?? null, channelName: channel?.name ?? null, folder, branch };
}
/**
 * The `trace` helper's launcher (TRACE_CLI): a small script that runs trace-cli.js with Trace's own runtime, so a plugin
 * written as a shell or PowerShell script can call the plugin API in one line. Written again at each start.
 */
function writeTraceCli(folder: string) {
  const cli = path.join(__dirname, 'services', 'plugins', 'trace-cli.js');
  const file = path.join(folder, process.platform === 'win32' ? 'trace.cmd' : 'trace');
  const text = process.platform === 'win32' ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cli}" %*\r\n` : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cli}" "$@"\n`;
  // Storage that cannot be written (Trace then runs without it) leaves plugins without the helper, not Trace unstarted.
  try { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o755 }); } catch { hostHealth?.record('trace-cli-unwritable'); }
  return file;
}
const channelTools = new ChannelTools({
  enabled: () => { try { return hub?.preferences().channelTools === true; } catch { return false; } },
  channels: () => channelList(),
  sessionOf: (runId) => manager.running().find((run) => run.runId === runId)?.sessionId ?? null,
  replies: (sessionId, count) => channelReplies(sessionId, count),
  send: (sessionId, text) => sendToChannel(sessionId, text),
});
/** Automatic project checks (1.38.0): the project's own checks after an agent's turn changes files; a failure goes back to that agent. */
const autoChecks = new AutoChecks({
  enabled: () => { try { return hub?.preferences().autoChecks !== false; } catch { return false; } },
  canMessage: (sessionId) => { const channel = channelList().find((item) => item.sessionId === sessionId); return Boolean(channel?.running && !channelTools.waitingOf(sessionId)); },
  send: (sessionId, text) => sendToChannel(sessionId, text),
  publish: (status) => { sendToRenderer(IPC_CHANNELS.autoCheckEvent, status); },
});
/**
 * App preview (1.39.0): dev-server addresses any channel prints (Claude Code, Codex, Gemini or a terminal), and the page
 * that shows one beside the channels. The window may show only what is offered here.
 */
const previewOffers = new PreviewOffers();
const appPreview = new AppPreview(() => window, (sessionId, port, status) => { sendToRenderer(IPC_CHANNELS.previewEvent, { type: 'status', sessionId, port, status }); });
/** A run's output and end, for the app preview: a new address is offered to the window and phones, an ended run's taken back. */
function previewEvent(event: SessionEvent) {
  if (event.type === 'data') {
    const found = previewOffers.data(event.sessionId, event.runId, event.data); if (!found.length) return;
    for (const { address, fresh } of found) sendToRenderer(IPC_CHANNELS.previewEvent, { type: 'found', offer: { sessionId: event.sessionId, port: address.port, url: address.url }, fresh });
    remote?.channelsChanged();
  } else if (event.type === 'exit') { appPreview.ended(event.sessionId); if (previewOffers.exit(event.sessionId, event.runId)) { sendToRenderer(IPC_CHANNELS.previewEvent, { type: 'gone', sessionId: event.sessionId }); remote?.channelsChanged(); } }
}
/** The VS Code extension's way in (1.38.0): it lists the running agent channels and sends one the code selected there. */
const editorBridge = new EditorBridge({
  channels: () => channelList().filter((channel) => channel.running && channel.engine !== 'shell').map((channel) => ({ channel: channel.channel, sessionId: channel.sessionId, name: channel.name, engine: agentName(channel.sessionId, channel.engine as ChannelEngine), waiting: Boolean(channelTools.waitingOf(channel.sessionId)) })),
  send: (sessionId, text) => sendToChannel(sessionId, text),
});
/** Undo last turn (1.39.0): hidden snapshots of each agent channel's files before its turns, put back from its tile. */
const turnSnapshots = new TurnSnapshots({ publish: (status) => { sendToRenderer(IPC_CHANNELS.undoEvent, status); } });
/** Passes an agent channel's start and turn ends to the automatic checks and Undo last turn, by its folder; a seat's turn counts only as its table's. */
function checkEvent(event: 'started' | 'turn-ended', sessionId: string) {
  try {
    const channels = workspaceChannels(); const own = channels.find((session) => session.id === sessionId); if (!own || own.seatedAt || own.engine === 'shell') return;
    const folder = manager.running().find((run) => run.sessionId === sessionId)?.cwd; if (!folder) return;
    void (event === 'started' ? turnSnapshots.started(own, folder) : turnSnapshots.turnEnded(own, folder)).catch(() => hostHealth?.record('turn-snapshot-failed'));
    if (event === 'started') void autoChecks.started(folder); else autoChecks.turnEnded(sessionId, folder);
  } catch { hostHealth?.record('auto-checks-failed'); }
}
/** Event hooks (1.33.1): built once storage is known, below; until then events run none. */
let eventHooks: EventHooks | null = null;
/** Trace plugins (1.35.0, docs/plugins.md) and their API: built once storage is known, below. */
let plugins: Plugins | null = null; let pluginApi: PluginApi | null = null;
/** Runs the person's event hooks for a channel's event, named as the window names it. Seats count as their table's channel. */
function hookEvent(event: 'needs-you' | 'turn-ended' | 'failed' | 'started' | 'stopped', sessionId: string, message: string) {
  if (!eventHooks && !plugins) return;
  try {
    const channels = workspaceChannels(); const own = channels.find((session) => session.id === sessionId); const lead = own?.seatedAt ? channels.find((session) => session.id === own.seatedAt) : own;
    const shown = channels.filter((session) => !session.seatedAt); const index = lead ? shown.indexOf(lead) : -1; if (index < 0) return;
    // A seat's turn ending says nothing about the table's work: only its lead's (or an approval or failure) is passed on.
    if (event === 'turn-ended' && own?.seatedAt) return;
    const folder = manager.running().find((run) => run.sessionId === lead!.id)?.cwd ?? null;
    if (event === 'needs-you' || event === 'turn-ended' || event === 'failed') eventHooks?.fire(event, lead!.id, { channel: index + 1, name: lead!.title, message, folder });
    // A seat starting or stopping is its table's business: only the lead's is passed on to plugins.
    if ((event === 'started' || event === 'stopped') && own?.seatedAt) return;
    plugins?.fire(`channel.${event}` as PluginEventName, lead!.id, { project: storage?.load()?.rootDirectory ?? null, channel: index + 1, channelName: lead!.title, folder, message });
  } catch { hostHealth?.record('event-hook-failed'); }
}
/**
 * The background runner (docs/background-runner.md): terminal channels run in it, so they keep running after Trace quits
 * or fails, and Trace takes them up again when it opens. On in the installed app unless turned off in Settings;
 * CODING_HUB_RUNNER=1 turns it on for a source run or a smoke test, CODING_HUB_NO_RUNNER=1 off.
 */
let background: BackgroundRunner | null = null;
function runnerOn() { if (process.env.CODING_HUB_NO_RUNNER) return false; return process.env.CODING_HUB_RUNNER === '1' || (app.isPackaged && hub?.preferences().backgroundRunner !== false); }
function runner() { if (!runnerOn()) return null; if (!background) { background = new BackgroundRunner(storageRoot, app.getAppPath(), process.execPath); background.meta = (meta) => ({ attention: attention.token(meta.session.runId), tools: channelTools.token(meta.session.runId) }); background.onProblem = (message) => reportStorageError(message); } return background; }
const savedPorts = () => readPorts(runnerPlace(storageRoot));
function savePorts() { try { writePorts(runnerPlace(storageRoot), { attention: attention.listening, tools: channelTools.listening }); } catch { hostHealth?.record('runner-ports-unsaved'); } }
/** The tray's Stop all channels and quit: the runner's channels stop too, instead of running on. */
let stopChannelsOnQuit = false;
/** The channel-tools MCP server's settings file for each Claude run, removed when the run ends. */
const channelToolFiles = new Map<string, string>();
/**
 * Trace's agy plugin (gemini-plugin.ts), written or pointed at this Trace before each Gemini launch. False when it could
 * not be, or the person turned it off in agy: the channel then starts without shared memory and channel tools, said once.
 */
const geminiNoticed = new Set<string>();
function geminiPluginReady(): boolean {
  const say = (id: string, message: string) => { if (geminiNoticed.has(id)) return; geminiNoticed.add(id); reportStorageError(message); };
  try { installGeminiPlugin({ executable: process.execPath, memoryServer: path.join(__dirname, 'services', 'hub', 'memory-server.js'), channelServer: path.join(__dirname, 'services', 'hub', 'channel-server.js') }); }
  catch (error) { hostHealth?.record('gemini-plugin-failed'); say('failed', `Gemini channels start without shared memory and channel tools: Trace could not write its plugin for Gemini in ${path.join(geminiConfigRoot(), 'plugins', GEMINI_PLUGIN)}${error instanceof HubError ? ` (${error.message})` : ''}. Check that this folder can be written, then start the channel again.`); return false; }
  if (geminiPluginOff()) { say('off', 'Gemini channels start without shared memory and channel tools, because Trace’s plugin is turned off in Gemini. Run agy plugin enable trace to turn it back on.'); return false; }
  return true;
}
const attention = new AttentionServer((runId, message) => manager.notifyAttention(runId, message), (runId, finished) => manager.notifyResolved(runId, finished), (runId, conversationId) => hub?.telemetry?.follow(runId, conversationId), (runId, size) => hub?.telemetry?.setContextWindow(runId, size));
// Each session event is labelled for the stall record (host-health.ts): saving output and ending runs happen here.
const manager = new PtyManager((owner, event) => timed(`session-${event.type}`, () => {
  if (event.type === 'started') hostHealth?.record('cli-started', event.engine);
  if (event.type === 'exit') hostHealth?.record('cli-exited', null, event.exitCode);
  try {
    // A replay is what the background runner kept for a channel taken up again: its log has it, or it ran while Trace was closed.
    if (event.type === 'data' && !event.replay) storage?.append(event.runId, event.data);
    if (event.type === 'exit') storage?.endRun(event.runId, event.exitCode);
  } catch { reportStorageError('Session output could not be saved. Live terminal output remains available.'); }
  if (event.type === 'exit') { attention.unregister(event.runId); runOwners.delete(event.runId); const file = channelToolFiles.get(event.runId); if (file) { channelToolFiles.delete(event.runId); fs.rm(file, { force: true }, () => {}); } }
  try { channelTools.onSessionEvent(event); } catch { hostHealth?.record('channel-tools-event-failed'); }
  turnSnapshots.activity(event);
  if (event.type === 'started' || event.type === 'exit') try { updateTray(); } catch { hostHealth?.record('tray-unavailable'); }
  if (event.type === 'attention') hookEvent('needs-you', event.sessionId, event.message);
  else if (event.type === 'answered' && event.finished) { hookEvent('turn-ended', event.sessionId, 'The agent ended its turn.'); checkEvent('turn-ended', event.sessionId); }
  else if (event.type === 'exit' && event.diagnostic) hookEvent('failed', event.sessionId, event.diagnostic);
  if (event.type === 'started') { hookEvent('started', event.sessionId, 'The channel started.'); checkEvent('started', event.sessionId); }
  else if (event.type === 'exit') hookEvent('stopped', event.sessionId, event.diagnostic ?? 'The channel stopped.');
  // A Gemini CLI terminal names its conversation as it quits (pty-manager): its usage is read from that conversation's
  // file, before the run is ended below. For any other run this is nothing new to telemetry.
  if (event.type === 'conversation') try { hub?.telemetry?.setGeminiConversation(event.runId, event.conversationId); } catch { hostHealth?.record('telemetry-read-failed'); }
  if (event.type === 'exit') {
    // Telemetry's last read of the run can be what finds a short run's transcript, so the summary waits for it.
    const transcript = hub?.telemetry?.transcript(event.runId) ?? null;
    const ended = hub?.telemetry ? hub.telemetry.end(event.runId).catch(() => { hostHealth?.record('telemetry-finalization-failed'); reportStorageError('Usage recording could not finish for this run. The CLI exit is still reported.'); return transcript; }) : Promise.resolve(null);
    void autoMemory?.finish(event.runId, ended).catch(() => hostHealth?.record('auto-memory-summary-failed'));
  }
  try { remote?.onSessionEvent(event); } catch { hostHealth?.record('remote-event-failed'); }
  sendToRenderer(IPC_CHANNELS.sessionEvent, event, owner);
  try { previewEvent(event); } catch { hostHealth?.record('app-preview-failed'); }
  // After the window has the event: naming the channel reads the saved workspace, which can fail, and a failed alert
  // must not leave a stopped channel showing as running.
  try {
    if (event.type === 'attention') desktopAlert({ title: `${channelLabel(event.sessionId)} needs you`, body: event.message, target: { sessionId: event.sessionId } });
    if (event.type === 'exit' && event.exitCode !== 0 && event.diagnostic) desktopAlert({ title: `${channelLabel(event.sessionId)} stopped with an error`, body: event.diagnostic.split('\n')[0], target: { sessionId: event.sessionId } });
  } catch { hostHealth?.record('desktop-alert-failed'); }
}), {
  held: { spawn: (file, args, options, meta) => runner()?.spawn(file, args, options, meta) ?? Promise.reject(new Error('The background runner is off.')), take: (sessionId) => runner()?.take(sessionId) ?? Promise.resolve(null) },
  // A channel taken up after a restart: its agent's hooks and channel tools call with the tokens it was started with.
  // Its usage is not followed again (Usage would count what the run had already read).
  onAdopted: (session, meta, owner) => { runOwners.set(session.runId, owner); attention.restore(session.runId, meta.attention); channelTools.restore(session.runId, meta.tools); },
  pluginTile: (plugin) => { if (!plugins) throw new HubError('PLUGIN_TILE', 'Plugins are unavailable: Trace\'s storage could not be opened.'); return plugins.tile(plugin.id, plugin.tile); },
  onChat: (owner, envelope) => {
  // A chat run's conversation is kept in its saved output as text, so it can be searched and exported like a terminal's.
  const text = chatText(envelope.event); if (text) try { storage?.append(envelope.runId, text); } catch { reportStorageError('Session output could not be saved. Live terminal output remains available.'); }
  // A Gemini CLI seat says which conversation it writes to as soon as it is ready: its tokens are counted from that file.
  if (envelope.event.type === 'ready') try { hub?.telemetry?.setGeminiConversation(envelope.runId, envelope.event.conversationId); } catch { hostHealth?.record('telemetry-read-failed'); }
  sendToRenderer(IPC_CHANNELS.chatEvent, envelope, owner);
  try { channelTools.onChat(envelope); } catch { hostHealth?.record('channel-tools-event-failed'); }
  turnSnapshots.chatActivity(envelope.sessionId, envelope.event.type);
  if (envelope.event.type === 'done' && !envelope.event.isError) checkEvent('turn-ended', envelope.sessionId);
  if (envelope.event.type === 'done') hookEvent(envelope.event.isError ? 'failed' : 'turn-ended', envelope.sessionId, envelope.event.isError ? envelope.event.error ?? 'The turn ended with an error.' : 'The agent ended its turn.');
  // Phones and linked computers following the channel get it too.
  try { remote?.onChat(envelope); } catch { hostHealth?.record('remote-event-failed'); }
}, geminiConversation: (cwd, since, known) => geminiConversationSince(cwd, since, known), chatHistory: (config) => { if (!config.resumeId || config.engine === 'gemini') return null; const file = nativeSessions.source(config.engine, config.resumeId, config.engine === 'claude' ? config.accountProfileId : undefined); return file ? chatHistory(config.engine, file) : null; }, onEventError: () => hostHealth?.record('session-event-delivery-failed'), onContextWindow: (runId, size) => hub?.telemetry?.setContextWindow(runId, size), onStall: () => hostHealth?.record('output-acknowledgement-stalled'), profileEnvironment: (base, id) => claudeProfiles.environment(base, id),
  // Other computers' notes are brought over and read before prepareLaunch builds the memory context (at most 1.5 s).
  beforeLaunch: (cwd, config) => autoMemory ? autoMemory.ready(cwd, config.engine === 'gemini' || config.engine === 'custom' ? undefined : config.memoryKey) : Promise.resolve(),
  customLaunch: (run, config, base, prompt) => customLaunch(run, config, base, prompt), customStatus: (agentId) => customAgents?.status(agentId) ?? null, prepareLaunch: (run, config, info, launch) => timed('launch-prepare', () => {
  hub?.rules.verifyLaunch(run.cwd);
  // Gemini CLI resumes agy's own conversation. Its usage is read from that conversation's file once the run has started
  // (telemetry.startGemini). Shared memory and the channel tools come from Trace's agy plugin (gemini-plugin.ts), told
  // this run's notes and channel through agy's environment; the memory key is always the folder's own.
  if (config.engine === 'gemini') {
    if (config.resumeId) {
      const saved = new Map((storage?.load()?.sessions ?? []).map((session) => [session.id, session.config]));
      if (manager.running().some((other) => other.runId !== run.runId && other.engine === 'gemini' && (saved.get(other.sessionId) as { resumeId?: string } | undefined)?.resumeId === config.resumeId)) throw new HubError('RESUME_BUSY', 'This conversation is still active in another tile. Stop it before resuming.');
      if (!nativeSessions.source('gemini', config.resumeId)) throw new HubError('NATIVE_SESSION', 'Gemini no longer has this conversation. Clear the resume, or pick another from Session history.');
    }
    const plugin = geminiPluginReady();
    if (plugin) { autoMemory?.prepare(run, config.model, info, launch); const toolsUrl = channelTools.register(run.runId); if (toolsUrl) launch.env.CODING_HUB_CHANNEL_TOOLS_URL = toolsUrl; }
    // At Allow edits (shared/safe-actions.ts): the safe commands, as agy matches them exactly, and Trace's own tools that
    // Codex runs without asking, beside the person's own rules.
    const safe = hub?.preferences().safeActions !== false;
    if (permissionLevel(config) === 'edits' && info.supportsSettings && (safe || plugin)) {
      let own: unknown = {}; try { own = (JSON.parse(fs.readFileSync(path.join(geminiHome(), 'settings.json'), 'utf8')) as { permissions?: unknown }).permissions; } catch { /* None saved. */ }
      launch.args.push('--settings', geminiSafeSettings(own, plugin ? GEMINI_TOOL_RULES : [], safe));
    }
    return;
  }
  if (config.resumeId) { if (hub?.telemetry?.isConversationActive(config.engine, config.resumeId)) throw new HubError('RESUME_BUSY', 'This conversation is still active in another tile. Stop it before resuming.'); const source = nativeSessions.source(config.engine, config.resumeId, config.engine === 'claude' ? config.accountProfileId : undefined); if (!source) throw new HubError('NATIVE_SESSION', 'This native conversation is unavailable. Refresh CLI history before resuming.'); hub?.telemetry?.setResumeSource(run.runId, source, config.engine, config.model); }
  if (config.engine === 'claude' && config.tokenLimits.maxSessionTokens !== null && !hub?.telemetry) throw new HubError('TELEMETRY_UNAVAILABLE', 'Token limits require writable local telemetry storage.');
  hub?.telemetry?.prepare(run, config, info, launch);
  // Let the agent say when it is waiting for the person. Older CLIs run without it.
  if (config.engine === 'claude' && info.supportsSettings && supportsHttpHooks(info.version)) {
    const url = attention.register(run.runId);
    // A terminal reports its context window through Trace's status line, unless the person has their own (chats report it with each reply).
    const claudeHome = config.accountProfileId ? claudeProfiles.directory(config.accountProfileId) : process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    const statusLine = !config.chat && !ownStatusLine(claudeHome, run.cwd);
    // At Allow edits, the safe commands run without asking unless the person turned that off (shared/safe-actions.ts).
    const allow = permissionLevel(config) === 'edits' && hub?.preferences().safeActions !== false ? safeActionRules() : [];
    if (url) { launch.args.push('--settings', claudeAttentionSettings(url, supportsSessionHook(info.version) ? systemCurl() : null, statusLine, allow)); Object.assign(launch.env, withLoopbackNoProxy({ ...process.env, ...launch.env })); }
  }
  if (config.engine === 'codex' && info.supportsConfig) for (const value of CODEX_ATTENTION_CONFIG) launch.args.push('--config', value);
  // Last: Claude's --mcp-config takes a list of values.
  autoMemory?.prepare(run, config.model, info, launch, config.memoryKey);
  // Then the channel tools, when turned on, join that list (or start it). Codex takes the three that only look (list,
  // read, wait) without asking, so a Codex chat, which has no prompt for it, can use them too (1.33.2; checked with
  // codex-cli 0.171.0); sending a message still asks, and a chat therefore still refuses it. The task tools ride the same
  // server when their own setting is on (either one adds it); list_tasks only looks, adding or updating a task asks.
  const toolsUrl = channelTools.register(run.runId);
  if (toolsUrl) {
    const server = { command: process.execPath, args: [path.join(__dirname, 'services', 'hub', 'channel-server.js')], env: { ELECTRON_RUN_AS_NODE: '1', CODING_HUB_CHANNEL_TOOLS_URL: toolsUrl } };
    if (config.engine === 'claude' && info.supportsMcpConfig) {
      try {
        const folder = path.join(storageRoot, 'channel-tools'); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        const file = path.join(folder, `${run.runId}.mcp.json`); fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'trace-channels': server } }), { mode: 0o600 }); channelToolFiles.set(run.runId, file);
        if (launch.args.at(-2) === '--mcp-config') launch.args.push(file); else launch.args.push('--mcp-config', file);
      } catch { channelTools.unregister(run.runId); }
    } else if (config.engine === 'codex' && info.supportsConfig) launch.args.push('--config', `mcp_servers.trace-channels.command=${JSON.stringify(server.command)}`, '--config', `mcp_servers.trace-channels.args=${JSON.stringify(server.args)}`, '--config', `mcp_servers.trace-channels.env={ELECTRON_RUN_AS_NODE="1",CODING_HUB_CHANNEL_TOOLS_URL=${JSON.stringify(toolsUrl)}}`, ...['list_channels', 'read_channel', 'wait_for_channel', 'list_tasks'].flatMap((tool) => ['--config', `mcp_servers.trace-channels.tools.${tool}.approval_mode="approve"`]));
    else channelTools.unregister(run.runId);
  }
}), abandonLaunch: (run) => { attention.unregister(run.runId); channelTools.unregister(run.runId); const file = channelToolFiles.get(run.runId); if (file) { channelToolFiles.delete(run.runId); fs.rm(file, { force: true }, () => {}); } hub?.telemetry?.abandon(run.runId); autoMemory?.abandon(run.runId); }, onSeated: (runIds) => autoMemory?.seated(runIds), onStarted: (run, config, owner) => {
  runOwners.set(run.runId, owner);
  try { storage?.beginRun(run, config); }
  catch { reportStorageError('This run could not be recorded in local history. The CLI session is still available.'); }
  // A custom agent has no usage files Trace reads (docs/custom-agents.md).
  if (!isBuiltInRun(run) || !isBuiltInAgent(config)) return;
  if (config.engine === 'gemini') { try { hub?.telemetry?.startGemini(run, config); } catch { reportStorageError('Usage recording is unavailable for this run.'); } return; }
  try { hub?.telemetry?.start(run, config, config.engine === 'claude' && config.accountProfileId ? claudeProfiles.directory(config.accountProfileId) : undefined); }
  catch {
    // Without a usage watcher a session token limit would silently go unenforced.
    if (config.engine === 'claude' && config.tokenLimits.maxSessionTokens !== null) {
      reportStorageError('Usage recording is unavailable, so the session token limit cannot be enforced. The channel was stopped.');
      setImmediate(() => void manager.stop(owner, { sessionId: run.sessionId, runId: run.runId }).catch(() => hostHealth?.record('token-limit-stop-failed')));
    } else reportStorageError('Usage recording is unavailable for this run.');
  }
} });

/** Custom agents (1.40.0, docs/custom-agents.md): built once storage is known, below. */
let customAgents: CustomAgents | null = null;
/**
 * A custom agent's launch: its confirmed definition and program, the shared rules check, and, when the definition says
 * how the program takes MCP servers, shared memory (with its notes as instructions) and the channel tools. A claude-json
 * file goes where the channel tools' files go, and is removed with them when the run ends or does not start.
 */
async function customLaunch(run: AgentRunningSession, config: CustomChannelConfig, base: Record<string, string>, prompt?: string) {
  if (!customAgents) throw new HubError('CUSTOM_AGENTS', 'Custom agents are unavailable: Trace’s storage could not be opened.');
  const { definition, executable } = await customAgents.launchable(config.agentId, base);
  return timed('launch-prepare', () => {
    hub?.rules.verifyLaunch(run.cwd);
    const servers: Record<string, McpServer> = {}; let instructions: string | null = null;
    // An ACP chat takes MCP servers in its protocol (every ACP agent must take stdio servers), whatever its terminal takes.
    if (takesTools(definition) || config.chat) {
      const memory = autoMemory?.customMemory(run.cwd) ?? null; if (memory) { servers['coding-hub-memory'] = memory.server; instructions = memory.context; }
      const toolsUrl = channelTools.register(run.runId);
      if (toolsUrl) servers['trace-channels'] = { command: process.execPath, args: [path.join(__dirname, 'services', 'hub', 'channel-server.js')], env: { ELECTRON_RUN_AS_NODE: '1', CODING_HUB_CHANNEL_TOOLS_URL: toolsUrl } };
    }
    const common = { file: executable.file, name: definition.name, status: definition.status };
    // A chat (phase 2): the program as an ACP server; its level is Trace's to keep (modes and answers), so the channel's own.
    if (config.chat) { const launch = buildAcpLaunch({ definition, config, servers, instructions }); return { ...common, level: permissionLevel(config), args: [...executable.prefixArgs, ...launch.args], env: { ...base, ...executable.extraEnv, ...launch.env }, chat: launch.agent }; }
    const folder = path.join(storageRoot, 'channel-tools'); const mcpFile = path.join(folder, `${run.runId}.mcp.json`);
    const launch = buildCustomLaunch({ definition, config, servers, instructions, mcpFile, ...(prompt ? { prompt } : {}) });
    if (launch.mcpConfig) { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); fs.writeFileSync(mcpFile, launch.mcpConfig, { mode: 0o600 }); channelToolFiles.set(run.runId, mcpFile); }
    return { ...common, args: [...executable.prefixArgs, ...launch.args], env: { ...base, ...executable.extraEnv, ...launch.env }, prompted: launch.prompted };
  });
}

/** This computer's channels in tile order, named as their tiles name them (for phones, linked computers and alerts). */
function workspaceChannels() {
  const saved = storage?.load(); const running = new Map(manager.running().map((run) => [run.sessionId, run.cwd]));
  // A Round Table's hidden seats (every seat but the lead's, as the window hides them) are marked, not listed as channels.
  const seats = new Map<string, string>(); for (const session of saved?.sessions ?? []) for (const seat of session.roundTable ? hiddenSeatIds(session.roundTable, session.id) : []) if (saved!.sessions.some((item) => item.id === seat)) seats.set(seat, session.id);
  return (saved?.sessions ?? []).map((session) => ({ id: session.id, engine: session.config.engine, ...(isChatRun(session.config) ? { chat: true as const } : {}), ...(seats.has(session.id) ? { seatedAt: seats.get(session.id)! } : {}),
    ...(channelAccount(session.config) ? { account: channelAccount(session.config)! } : {}), ...(session.config.engine === 'custom' && customAgents?.look(session.config.agentId) ? { agent: customAgents.look(session.config.agentId)! } : {}), title: channelName({ engine: session.config.engine, title: session.title, cwd: running.get(session.id) ?? (session.binding.mode === 'independent' ? session.binding.cwd : saved?.rootDirectory ?? null) }) }));
}
/** A channel's folder: where it runs, else where it would start (Undo last turn works on a stopped channel too). */
function channelFolder(sessionId: string) { const saved = storage?.load(); const session = saved?.sessions.find((item) => item.id === sessionId); return manager.running().find((run) => run.sessionId === sessionId)?.cwd ?? (!session ? null : session.binding.mode === 'independent' ? session.binding.cwd : saved?.rootDirectory ?? null); }
/** Undo last turn's requests from a tile: its state, what it would change, and Undo or Redo itself (refused while that agent works). */
async function undoRequest(payload: unknown) {
  const request = z.object({ action: z.enum(['undo-status', 'undo-preview', 'undo-turn', 'redo-turn']), sessionId: z.string().min(1).max(100), redo: z.boolean().optional() }).strict().parse(payload);
  const channel = workspaceChannels().find((item) => item.id === request.sessionId); const folder = channelFolder(request.sessionId);
  if (!channel || !folder) throw new HubError('UNDO_NO_FOLDER', 'This channel has no project folder yet. Choose one in its settings first.');
  if (request.action === 'undo-status') return turnSnapshots.status(channel, folder);
  if (request.action === 'undo-preview') {
    const preview = await turnSnapshots.preview(channel, folder, request.redo === true); const inside = (other: string) => { const relative = path.relative(preview.root, other); return !relative.startsWith('..') && !path.isAbsolute(relative); };
    // Other agents in the same project: their changes since the last turn go back too, so the question names them.
    return { files: preview.files, others: channelList().filter((item) => item.sessionId !== request.sessionId && item.running && item.engine !== 'shell' && item.folder && inside(item.folder)).map((item) => `CH${item.channel}`) };
  }
  if (turnSnapshots.busy(request.sessionId)) throw new HubError('UNDO_BUSY', `${channelLabel(request.sessionId).split(' · ')[0]} is still working. Wait until its turn ends, then try again.`);
  if (backups?.busy) throw new HubError('BACKUP_BUSY', 'Finish the backup operation first.');
  return turnSnapshots.restore(channel, folder, request.action === 'redo-turn');
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
  z.object({ action: z.literal('linked-add'), id: z.uuid(), engine: z.enum(['claude', 'codex', 'gemini', 'custom', 'shell']), chat: z.boolean().optional(), agent: z.string().regex(AGENT_ID).optional() }).strict().refine((value) => !(value.chat && (value.engine === 'shell' || value.engine === 'gemini' || value.engine === 'custom')), 'Only Claude Code and Codex channels can be chats.').refine((value) => (value.engine === 'custom') === Boolean(value.agent), 'A custom agent channel names its agent.'),
  z.object({ action: z.literal('linked-agents'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-chat'), id: z.uuid(), request: chatRequestSchema }).strict(),
  z.object({ action: z.literal('linked-chat-history'), id: z.uuid(), sessionId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('linked-history'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-history-resume'), id: z.uuid(), key: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('linked-update'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-coach-review'), id: z.uuid(), tip: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-paste-image'), id: z.uuid(), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100), image: z.string().min(8).max(21 * 1024 * 1024) }).strict(),
  z.object({ action: z.literal('linked-watch'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-unwatch'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-screen-state'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('linked-transcript'), id: z.uuid(), sessionId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('linked-fit'), id: z.uuid(), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100), cols: z.number().int().min(20).max(300).optional(), rows: z.number().int().min(6).max(200).optional() }).strict(),
]);
const previewBounds = z.object({ x: z.number().finite().min(0).max(32000), y: z.number().finite().min(0).max(32000), width: z.number().finite().min(0).max(32000), height: z.number().finite().min(0).max(32000) }).strict();
const previewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview-list') }).strict(),
  z.object({ action: z.literal('preview-show'), sessionId: z.string().min(1).max(100), port: z.number().int().min(1024).max(65535) }).strict(),
  z.object({ action: z.literal('preview-bounds'), bounds: previewBounds.nullable() }).strict(),
  z.object({ action: z.literal('preview-reload') }).strict(), z.object({ action: z.literal('preview-browser') }).strict(), z.object({ action: z.literal('preview-close') }).strict(),
]);
/** The app preview's requests from the window: it names a channel and a port, and the address is the one that channel printed. */
async function previewRequest(payload: unknown) {
  const request = previewSchema.parse(payload);
  if (request.action === 'preview-show') appPreview.show(request.sessionId, previewOffers.allowed(request.sessionId, request.port));
  else if (request.action === 'preview-bounds') { appPreview.place(request.bounds); return null; }
  else if (request.action === 'preview-reload') { const shown = appPreview.current(); if (!shown) throw new HubError('PREVIEW_CLOSED', 'No app preview is open.'); appPreview.show(shown.sessionId, previewOffers.allowed(shown.sessionId, shown.port)); }
  else if (request.action === 'preview-browser') { await appPreview.openInBrowser(); return null; }
  else if (request.action === 'preview-close') { appPreview.close(); return null; }
  return { offers: previewOffers.list(), shown: appPreview.current() };
}
const screenSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('screen-open'), id: z.uuid(), streamId: z.uuid(), display: z.number().int().min(0).max(MAX_DISPLAYS).optional() }).strict(),
  z.object({ action: z.literal('screen-send'), streamId: z.uuid(), data: z.instanceof(Uint8Array).refine((data) => data.byteLength > 0 && data.byteLength <= 1024 * 1024) }).strict(),
  z.object({ action: z.literal('screen-close'), streamId: z.uuid() }).strict(),
  z.object({ action: z.literal('screen-credentials'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('screen-save-credentials'), id: z.uuid(), username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }).strict(),
  z.object({ action: z.literal('screen-forget-credentials'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('screen-share-status') }).strict(),
  z.object({ action: z.literal('screen-share-set'), enabled: z.boolean(), elevated: z.boolean().optional() }).strict(),
]);
async function screenRequest(owner: number, payload: unknown) {
  const request = screenSchema.parse(payload);
  if (request.action === 'screen-share-status' || request.action === 'screen-share-set') {
    if (!screenShare) throw new HubError('SCREEN_UNAVAILABLE', 'Sharing this screen needs writable local storage.');
    return request.action === 'screen-share-set' ? screenShare.set(request.enabled, request.elevated) : screenShare.status();
  }
  if (!screens) throw new HubError('SCREEN_UNAVAILABLE', 'Screen sharing needs linked computers, which need writable local storage.');
  if (request.action === 'screen-open') return screens.open(owner, request.id, request.streamId, request.display ?? 0);
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
  const release = await latestMacRelease(); if (!release) throw new HubError('UPDATE_FAILED', 'Trace there could not read the latest version. Check its connection.');
  const { version } = release;
  if (!isNewerVersion(version, app.getVersion())) return `Trace ${app.getVersion()} there is already the latest version (the downloads page has ${version}).`;
  // The script quits Trace without asking again, so nothing may be running, and nothing may start while it downloads.
  if (updateRestart || scriptUpdate) throw new HubError('UPDATE_RUNNING', 'Trace there is already installing an update.');
  if (busyJobs()) throw new HubError('ACTIVE_SESSIONS', 'Stop the channels, sign-ins and other jobs running there first, then try again.');
  if (workspaceLoaded) { await flushWorkspace(); if (!lastFlushSucceeded) throw new HubError('UPDATE_SAVE_FAILED', 'Trace there could not save its workspace. Resolve the storage issue there before updating.'); }
  if (updateRestart || scriptUpdate || busyJobs()) throw new HubError('ACTIVE_SESSIONS', 'Something started there while Trace was saving its workspace. Stop it, then try again.');
  // Only new jobs are refused while the script downloads: Settings, usage and the status bar keep working.
  scriptUpdate = true; let script: unknown;
  try { script = startMacUpdate(storageRoot, version, REMOTE_PORT, release.sha512); } catch (error) { scriptUpdate = false; throw error; }
  // A script that gives up (download or checksum failed) leaves Trace running: jobs can start again once it exits, or
  // after 15 minutes when Trace cannot see it exit.
  let ended = false; const end = () => { if (!ended) { ended = true; scriptUpdate = false; } };
  if (script instanceof ChildProcess) script.once('exit', end); setTimeout(end, 15 * 60000).unref();
  return `Installing Trace ${version} there. It quits, restarts and is back in about a minute; if the new version does not start, the old one is put back.`;
}
async function linkedRequest(payload: unknown) {
  if (!linked) throw new HubError('LINK_UNAVAILABLE', 'Linking computers needs writable local storage.');
  const request = linkedSchema.parse(payload);
  if (request.action === 'linked-link') return linked.link(request.id, request.code);
  if (request.action === 'linked-unlink') return linked.unlink(request.id);
  if (request.action === 'linked-input') { await linked.input(request.id, request.sessionId, request.runId, request.data, AbortSignal.timeout(INPUT_TIMEOUT)); return null; }
  if (request.action === 'linked-control') { await linked.control(request.id, request.sessionId, request.control); return null; }
  if (request.action === 'linked-add') { await linked.add(request.id, request.engine, request.chat === true && (request.engine === 'claude' || request.engine === 'codex'), request.agent); return null; }
  if (request.action === 'linked-agents') return linked.agents(request.id);
  if (request.action === 'linked-chat') { await linked.chat(request.id, request.request); return null; }
  if (request.action === 'linked-chat-history') return linked.chatHistory(request.id, request.sessionId);
  if (request.action === 'linked-history') return linked.history(request.id);
  if (request.action === 'linked-history-resume') { await linked.resumeHistory(request.id, request.key); return null; }
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
function channelTranscript(sessionId: string): ChannelTranscript { const source = transcriptSource(sessionId); return source ? chatHistory(source.engine, source.file) : null; }
/** One task's part of a channel's conversation (its prompt to the next task's prompt); null when it cannot be found there, and for Gemini (its tasks are read from the screen). */
async function taskTranscript(sessionId: string, mark: string): Promise<ChannelTranscript> { const source = transcriptSource(sessionId); return source && source.engine !== 'gemini' ? taskHistory(source.engine, source.file, mark) : null; }
/** The CLI's own transcript file for a channel; null for terminals and channels never run. */
function transcriptSource(sessionId: string) {
  const config = storage?.load()?.sessions.find((session) => session.id === sessionId)?.config;
  if (!config || !isBuiltInAgent(config) || !config.resumeId) return null;
  const file = nativeSessions.source(config.engine, config.resumeId, config.engine === 'claude' ? config.accountProfileId : undefined);
  return file ? { engine: config.engine, file } : null;
}
/** A linked computer asked to start, stop, restart or close one of this computer's channels; the desktop window does it. */
function controlChannel(sessionId: string, control: ChannelControl): Promise<void> { return askWindow({ sessionId, control }); }
/**
 * A channel's settings for a phone: what is saved for it, and the models to choose from by name. Codex and Gemini CLI
 * list their own (each starts that CLI for a moment, so a slow one is not waited for past 8 s); none listed leaves the
 * phone the model as it is.
 */
async function channelSettings(sessionId: string): Promise<RemoteChannelSettings | null> {
  const saved = storage?.load(); const session = saved?.sessions.find((item) => item.id === sessionId); if (!saved || !session) return null;
  const config = session.config; const running = manager.running().find((run) => run.sessionId === sessionId);
  const title = workspaceChannels().find((channel) => channel.id === sessionId)?.title ?? session.title;
  const base = { sessionId, title, engine: config.engine, chat: isChatRun(config), running: Boolean(running) };
  if (!isAgentConfig(config)) return { ...base, models: [] };
  const within = <T>(work: Promise<T>): Promise<T | null> => Promise.race([work.catch(() => null), new Promise<null>((resolve) => { setTimeout(() => resolve(null), 8000).unref(); })]);
  let models: RemoteChannelSettings['models'] = [];
  if (config.engine === 'claude') models = (hub?.catalog.current().claudeModels ?? [...CLAUDE_MODELS]).map((id) => ({ id, name: modelLabel(id) }));
  // A custom agent: the models its definition lists, and those its program listed when the computer last asked (it is
  // not run for a phone).
  else if (config.engine === 'custom') models = (customAgents?.choices(config.agentId) ?? []).map((id) => ({ id, name: id }));
  else if (config.engine === 'codex') {
    const cwd = running?.cwd ?? (session.binding.mode === 'independent' ? session.binding.cwd : saved.rootDirectory);
    const catalog = await within(Promise.resolve().then(() => modelCatalog.execute({ action: 'codex-models', directory: cwd ?? null })));
    models = (catalog?.models ?? []).filter((item) => !item.hidden || item.model === config.model).map((item) => ({ id: item.model, name: item.displayName || modelLabel(item.model), ...(item.reasoningEfforts.length ? { efforts: item.reasoningEfforts } : {}) }));
  } else models = ((await within(geminiModels()))?.models ?? []).map((item) => ({ id: item.model, name: item.displayName }));
  const agent = config.engine === 'custom' ? { name: customAgents?.look(config.agentId)?.name ?? config.agentId, ...customAgents?.settings(config.agentId) ?? { models: false, permissions: false } } : null;
  return { ...base, permissions: permissionLevel(config), model: config.model, ...(config.engine === 'codex' ? { effort: config.reasoningEffort } : {}), models, ...(agent ? { agent } : {}) };
}
/** A linked computer (or a phone allowed to) adds a channel here: the window adds it to this computer's workspace, as + Channel does. */
function addChannel(engine: ChannelEngine, chat = false, like?: string, agent?: string): Promise<void> { return askWindow({ add: engine, ...(chat && engine !== 'shell' ? { chat: true as const } : {}), ...(like ? { like } : {}), ...(engine === 'custom' && agent ? { agent } : {}) }); }
/**
 * A phone resumes a conversation from Session history here: the window adds the channel, as Resume there does. The key
 * must be one the history lists, and the conversation's own folder is used (a phone cannot choose another).
 */
async function resumeConversation(key: string): Promise<void> {
  const { conversation, directory } = await nativeSessions.execute({ action: 'native-resume', key }) as NativeResume;
  const label = workflows?.labels().find((item) => item.key === conversation.key)?.name;
  return askWindow({ engine: conversation.engine, id: conversation.id, ...(conversation.profileId ? { profileId: conversation.profileId } : {}), directory, title: label || `${({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini' } as const)[conversation.engine]} · resumed` }, IPC_CHANNELS.remoteResume);
}
function askWindow(request: { sessionId: string; control: ChannelControl } | { add: ChannelEngine; chat?: true; agent?: string } | { settings: RemoteChannelChange } | Omit<RemoteResumeRequest, 'requestId'> | Omit<ScheduledRunRequest, 'requestId'>, channel: string = IPC_CHANNELS.remoteControl): Promise<void> {
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

/** A request's name for the stall record: its channel and action, never what it carries. */
function jobLabel(channel: string, payload: unknown) {
  const action = payload && typeof payload === 'object' && 'action' in payload && typeof payload.action === 'string' && /^[\w-]{1,40}$/.test(payload.action) ? ` ${payload.action}` : '';
  return channel.replace(/^coding-hub:/, '') + action;
}
function handle<T>(channel: string, operation: (owner: number, payload: unknown) => T | Promise<T>) {
  ipcMain.handle(channel, async (event, payload): Promise<HostResult<T>> => {
    try {
      assertSender(event);
      if (backups?.busy && [IPC_CHANNELS.startSession, IPC_CHANNELS.accounts, IPC_CHANNELS.projects, IPC_CHANNELS.projectChecks, IPC_CHANNELS.projectTools].includes(channel as never)) throw new HubError('BACKUP_BUSY', 'Finish the backup operation before starting or changing local jobs.');
      if ((delivery?.running || workflows?.running) && [IPC_CHANNELS.startSession, IPC_CHANNELS.projectChecks, IPC_CHANNELS.projectTools].some((item) => item === channel)) throw new HubError('DELIVERY_BUSY', 'Finish Git delivery before starting or changing local jobs.');
      return { ok: true, value: await timed(jobLabel(channel, payload), () => operation(event.sender.id, payload)) };
    } catch (error) {
      return { ok: false, error: error instanceof z.ZodError ? { code: 'INVALID_REQUEST', message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' ').slice(0, 1500) } : error instanceof HubError ? { code: error.code, message: error.message } : { code: 'HOST_ERROR', message: 'The native operation failed. Check file permissions and refresh before retrying.' } };
    }
  });
}

/**
 * Close to the tray (1.34.0): closing the window hides Trace, and its channels, the phone and alerts keep running until
 * Quit in the tray (Windows) or menu bar (Mac) menu, or the app menu's Quit on a Mac. Before, closing the window stopped
 * every channel. Settings → Preferences → "Keep running when the window is closed" turns it off.
 */
let tray: Tray | null = null; let toldAboutTray = false;
const closeToTray = () => { try { return hub?.preferences().closeToTray !== false; } catch { return true; } };
function showWindow() { if (quitting) return; if (!window || window.isDestroyed()) { createWindow(); return; } if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
/** The tray's icon: the app's, at tray size (a source checkout has no built phone app, so its own assets folder). */
function trayImage() {
  for (const file of [path.join(__dirname, '../../dist/phone/icon-192.png'), path.join(__dirname, '../../assets/icon.png')]) { const image = nativeImage.createFromPath(file); if (!image.isEmpty()) return image.resize({ width: 16, height: 16, quality: 'best' }); }
  return nativeImage.createEmpty();
}
/** The tray icon and its menu, which says how many channels run (kept current as they start and stop). */
function updateTray() {
  if (!closeToTray()) { tray?.destroy(); tray = null; return; }
  if (!tray) { try { tray = new Tray(trayImage()); } catch { hostHealth?.record('tray-unavailable'); return; } tray.on('click', showWindow); tray.on('double-click', showWindow); }
  const running = manager.running().length;
  const words = running ? `${running} ${running === 1 ? 'channel' : 'channels'} running` : 'No channels running';
  tray.setToolTip(`Trace · ${words}`);
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show Trace', click: showWindow }, { label: words, enabled: false }, { type: 'separator' }, ...(background && running ? [{ label: 'Stop all channels and quit', click: () => { stopChannelsOnQuit = true; app.quit(); } }] : []), { label: background && running ? 'Quit Trace (channels keep running)' : 'Quit Trace', click: () => app.quit() }]));
}
function createWindow() {
  window = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#060a14',
    title: 'Trace',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Terminals keep reading and acknowledging output, and tasks keep moving, while Trace is minimized or covered.
      backgroundThrottling: false,
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
  // A crashed or reloaded window never says it stopped watching other computers' active channels.
  current.webContents.on('render-process-gone', () => { repositoryFiles.closeOwner(owner); screens?.closeAll(owner); linked?.unwatchAll(); });
  // did-start-navigation fires before will-navigate can cancel, so clean up only once the old page is really replaced.
  let firstDocument = true;
  current.webContents.on('did-navigate', () => {
    if (firstDocument) { firstDocument = false; return; }
    void accounts.stopOwner(owner).catch(() => {}); void manager.stopOwner(owner); repositoryFiles.closeOwner(owner); screens?.closeAll(owner); linked?.unwatchAll(); appPreview.close();
  });
  let closing = false;
  current.on('close', (event) => {
    if (closing || quitting) return;
    event.preventDefault();
    // Hidden, not closed: its channels keep running. The first time, a notice says where Trace went.
    if (closeToTray()) {
      updateTray(); if (!tray) { hostHealth?.record('tray-unavailable'); } else {
        current.hide();
        if (!toldAboutTray && Notification.isSupported()) { toldAboutTray = true; const notice = new Notification({ title: 'Trace is still running', body: `Your channels keep going. Open Trace from its icon in the ${process.platform === 'darwin' ? 'menu bar' : 'tray'}, or quit it there.` }); notice.on('click', showWindow); notice.show(); }
        return;
      }
    }
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
  window.on('closed', () => { window = null; linked?.unwatchAll(); appPreview.close(); });
  // Chromium says so only after several seconds; shorter stalls come from the window itself (window-health.ts).
  current.on('unresponsive', () => hostHealth?.stall('window', 'unresponsive'));
  current.on('responsive', () => hostHealth?.stall('window', 'responsive'));
}
/**
 * Electron's default menu reloads (Ctrl+R, Ctrl+Shift+R) and closes (Ctrl+W) the window, which stops every channel
 * without asking, and opens DevTools in the installed app. Trace's menu keeps only editing, zoom, full screen and
 * quitting (DevTools in source runs); it stays hidden on Windows and Linux, as before, until Alt is pressed.
 */
function applicationMenu(): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions = { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const])] };
  if (process.platform !== 'darwin') return [{ role: 'editMenu' }, view];
  // No Close Window (Cmd+W); the window's own close button and Quit (Cmd+Q) stay.
  return [{ role: 'appMenu' }, { role: 'editMenu' }, view, { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }];
}

// Opened from Finder or the Dock, the Mac app lacks the shell's PATH, where the CLIs and Node.js usually are.
if (process.platform === 'darwin' && app.isPackaged) adoptLoginShellPath();
/** Trace was opened again while this one was quitting: it starts again once this one has finished. */
let reopenAfterQuit = false;
/** app.relaunch() was already called (Restart); a second call would start two copies. */
let relaunching = false;
// Opening Trace again (Start menu, shortcut, Dock) while it runs shows the window it already has, instead of nothing.
// While it is quitting (saving memory summaries can take seconds after the window is gone), it opens again afterwards.
app.on('second-instance', () => {
  if (quitting) { if (!updateRestart && !scriptUpdate) reopenAfterQuit = true; return; }
  if (!window || window.isDestroyed()) return; showWindow();
});
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  void offerToRemoveOldApp().catch(() => {});
  // On the ports they had last time, so agents the background runner kept running still reach them.
  const ports = savedPorts();
  void attention.start(ports.attention).then(() => savePorts()).catch(() => hostHealth?.record('attention-endpoint-unavailable'));
  void channelTools.start(ports.tools).then(() => savePorts()).catch(() => hostHealth?.record('channel-tools-unavailable'));
  void editorBridge.start().catch(() => hostHealth?.record('editor-bridge-unavailable'));
  // The tray icon from the start, so Quit is always within reach, once the preferences can be read.
  setTimeout(() => { try { updateTray(); } catch { hostHealth?.record('tray-unavailable'); } }, 1500);
  hostHealth = new HostHealth(storageRoot);
  // About once a second: a main process blocked 250 ms or more is recorded with the job that ran (see timed()).
  mainStalls.start((ms, job) => hostHealth?.stall('main', 'main-stall', ms, job));
  powerMonitor.on('suspend', () => mainStalls.skip()); powerMonitor.on('resume', () => { mainStalls.skip(); linked?.resumed(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu()));
  try { const dumps = path.join(storageRoot, 'crash-dumps'); fs.mkdirSync(dumps, { recursive: true, mode: 0o700 }); app.setPath('crashDumps', dumps); crashReporter.start({ uploadToServer: false, ignoreSystemCrashHandler: false }); void pruneCrashDumps(dumps).catch(() => {}); }
  catch { hostHealth.record('crash-dump-setup-unavailable'); }
  try { storage = new WorkspaceStorage(storageRoot, reportStorageError); }
  catch (error) { if (error instanceof HubError) storageFailure = error.message; }
  try {
    hub = new HubService(storageRoot);
    // A newer price list and model names from the downloads page, once a day (an installed Trace only: tests and source runs keep what they were built with).
    if (app.isPackaged) { const catalog = hub.catalog; void catalog.refresh(); setInterval(() => void catalog.refresh(), 6 * 60 * 60 * 1000).unref(); }
    hub.telemetry = new TelemetryService(path.join(path.dirname(hub.preferencesPath), 'telemetry'), () => hub!.preferences().prices, (usage) => {
      sendToRenderer(IPC_CHANNELS.usage, usage);
    }, (run) => {
      // Called once per run, so it must act: through the window that started the run, whichever window is current.
      const owner = runOwners.get(run.runId) ?? (window && !window.isDestroyed() ? window.webContents.id : undefined);
      if (owner === undefined) { hostHealth?.record('token-limit-stop-failed', 'no owner'); return; }
      void manager.stop(owner, { sessionId: run.sessionId, runId: run.runId }).catch(() => { hostHealth?.record('token-limit-stop-failed'); reportStorageError('The reported token limit was reached, but the process could not be stopped.'); });
    });
    hub.telemetry.onError = (_run, message) => { hostHealth?.record('telemetry-read-failed'); reportStorageError(message); };
    hub.telemetry.onConversation = (run, conversationId) => manager.notifyConversation(run.runId, conversationId);
    hub.telemetry.geminiHome = () => geminiHome(); hub.telemetry.findGeminiConversation = (cwd, since, known) => geminiConversationSince(cwd, since, known);
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
      sync: (key) => memoryHub.syncProject(key),
      // Shown in the window's banner, which the person can dismiss (only a saving failure stays until a save works).
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
    const env = await freshHostEnvironment(); const executable = await findExecutable(engine, env).catch(() => null);
    return executable ? { executable, env: engine === 'claude' && profileId ? claudeProfiles.environment(env, profileId) : env } : null;
  });
  if (hub?.telemetry) hub.telemetry.onLine = (run, config, raw) => liveCoach.observe(run, config, raw);
  const coaching = hub ? new CoachingService(storageRoot, hub.rules, directoryInUse, liveCoach) : null;
  handle(IPC_CHANNELS.coaching, (_owner, payload) => { if (!coaching) throw new HubError('COACHING_STORAGE', 'Local coaching storage is unavailable.'); if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); return coaching.execute(payload); });
  const diagnostics = new Diagnostics(claudeProfiles);
  verification = new Verification(storageRoot, async (profile) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Run verification', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Run trusted project commands', message: `${profile.name} — ${profile.directory}`, detail: profile.steps.map((step) => `${step.label}: ${step.tool} ${JSON.stringify(step.args)}`).join('\n') + `\nCommands and package hooks run with your local permissions. Timeout: ${profile.timeoutSeconds}s per step.` })).response === 0 && !updateRestart);
  const tasks = new Tasks(storageRoot, verification);
  /** The board changed outside the window (an agent's task tools, a plugin): it reads it again at once, not at its next 30 s look. */
  const tasksChanged = () => { sendToRenderer(IPC_CHANNELS.tasksChanged, null); };
  /** A task's status, however it is set (the window, an agent's task tools, the phone): one newly ready for review gets its pull request (task-pr.ts). */
  const setTaskStatus = async (payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id; const before = tasks.list().find((task) => task.id === id)?.status;
    const result = await tasks.execute(payload) as Task | null; if (result?.status === 'review' && before !== 'review') void taskPullRequests?.ready(result.id);
    return result;
  };
  channelTools.tasks = {
    enabled: () => { try { return hub?.preferences().taskTools !== false; } catch { return false; } },
    folderOf: (runId) => manager.running().find((run) => run.runId === runId)?.cwd ?? null,
    list: () => tasks.list(), changed: tasksChanged, notes: (id, notes) => tasks.setNotes(id, notes),
    add: async (fields) => await tasks.execute({ action: 'task-save', ...fields, sessionId: null, scope: ['**'], status: 'queued', verificationId: null }) as Task,
    status: async (id, status) => await setTaskStatus({ action: 'task-status', id, status }) as Task,
  };
  /** Scheduled jobs (1.39.0): the clock is here, so runs happen while the window is hidden; the window opens each run's channel. */
  const scheduledJobs = new ScheduledJobs(storageRoot, {
    ready: () => workspaceLoaded && Boolean(window && !window.isDestroyed()),
    held: () => updateRestart || scriptUpdate ? 'Trace is installing an update. Try again once it has restarted.' : backups?.busy ? 'A backup or restore is running. Try again once it is done.' : null,
    // As the window counts them (channelsFullNote): every saved channel, a Round Table's hidden seats too.
    channelsFull: (replace) => (storage?.load()?.sessions ?? []).filter((session) => session.id !== replace).length >= MAX_CHANNELS,
    channelRunning: (sessionId) => manager.running().some((run) => run.sessionId === sessionId),
    task: (id) => tasks.list().find((task) => task.id === id),
    addTask: async (fields) => await tasks.execute({ action: 'task-save', ...fields, scope: ['**'], status: 'queued', verificationId: null }) as Task,
    noteTask: (id, note) => { const task = tasks.list().find((item) => item.id === id); if (task) tasks.setNotes(id, [task.notes, note].filter(Boolean).join('\n').slice(-2000)); },
    open: (request) => askWindow(request, IPC_CHANNELS.scheduledRun),
    changed: tasksChanged,
  });
  scheduledJobs.start();
  // Plugins: the API they call back on, and the service that runs them (docs/plugins.md).
  pluginApi = new PluginApi({
    plugin: (id, token) => plugins?.pluginOfToken(id, token) ?? null,
    channels: () => channelList(), replies: (sessionId, count) => channelReplies(sessionId, count), waiting: (sessionId) => channelTools.waitingOf(sessionId), wait: (sessionId, timeout) => channelTools.waitFor(sessionId, timeout),
    send: (sessionId, text) => sendToChannel(sessionId, text), control: (sessionId, control) => controlChannel(sessionId, control), add: (engine, chat) => addChannel(engine, chat),
    tasks: () => { const shown = channelList(); return (tasks.list()).map((task) => ({ id: task.id, title: task.title, status: task.status, channel: shown.find((item) => item.sessionId === task.sessionId)?.channel ?? null })); },
    addTask: async (title, details, sessionId) => { const directory = storage?.load()?.rootDirectory; if (!directory) throw new HubError('PLUGIN_API_PROJECT', 'Open a project in Trace first: a task belongs to one.'); const saved = await tasks.execute({ action: 'task-save', title, ...(details ? { details } : {}), directory, sessionId, scope: ['**'], status: 'queued', notes: '', verificationId: null }) as { id: string }; tasksChanged(); return { id: saved.id }; },
    notify: (title, body) => desktopAlert({ title, body, target: { view: 'skills' } }, true),
  });
  void pluginApi.start().catch(() => hostHealth?.record('plugin-api-unavailable'));
  const traceCli = writeTraceCli(path.join(storageRoot, 'plugins', 'bin'));
  plugins = new Plugins(storageRoot, {
    version: app.getVersion(), environment: () => hostEnvironment(),
    api: (id, token) => ({ url: pluginApi?.url(id, token) ?? '', cli: traceCli }),
    confirm: async (preview) => (await dialog.showMessageBox(window!, { type: 'warning', buttons: [preview.title.split(' ')[0] === 'Link' ? 'Add plugin' : `${preview.title.split(' ')[0]} plugin`, 'Cancel'], defaultId: 1, cancelId: 1, title: preview.title, message: `${preview.title}? It runs as you, on this computer, and nobody has reviewed it.`,
      detail: [`${preview.title.startsWith('Link') ? 'Folder' : 'From'}: ${preview.folder}`, `Version ${preview.manifest.version}${preview.manifest.description ? ` · ${preview.manifest.description}` : ''}`, `It may use Trace to: ${preview.manifest.permissions.length ? preview.manifest.permissions.join(', ') : 'nothing'}`, '', 'Every command it may run:', ...preview.commands.map((item) => `  ${item.what}: ${item.command.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ')}`)].join('\n') })).response === 0,
    context: (sessionId, repository) => pluginContext(sessionId, repository),
    failed: (name, what, why) => desktopAlert({ title: `${name} failed`, body: `${what}: ${why}`, target: { view: 'skills' } }),
  // Smoke tests fetch "GitHub" plugins from local repositories (<folder>/<owner>/<repo>); never set in use.
  }, process.env.CODING_HUB_TEST_PLUGIN_GIT ? { url: (owner, name) => path.join(process.env.CODING_HUB_TEST_PLUGIN_GIT!, owner, name) } : {});
  setTimeout(() => plugins?.fire('trace.started', 'trace', { project: storage?.load()?.rootDirectory ?? null }), 3000);
  // Once a day, where each GitHub plugin's branch or tag is now: the Plugins page offers Update; nothing installs by itself.
  const checkPlugins = () => void plugins?.checkUpdates().catch(() => hostHealth?.record('plugin-update-check-failed'));
  setTimeout(checkPlugins, 60_000).unref?.(); setInterval(checkPlugins, 24 * 60 * 60_000).unref?.();
  eventHooks = new EventHooks(storageRoot, async (item) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Save event hook', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Run a program on an event', message: `When a channel ${item.event === 'needs-you' ? 'needs you' : item.event === 'turn-ended' ? 'ends its turn' : 'fails'}, Trace will run:`, detail: [item.program, ...item.args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ') + '\n\nIt runs as you, without a shell, with the channel\'s number, name, folder and message in TRACE_* environment variables. Save it only if you trust this program.' })).response === 0);
  customAgents = new CustomAgents(storageRoot, {
    confirmSave: async (agent) => (await dialog.showMessageBox(window!, { type: 'warning', buttons: [agent.activate ? 'Turn on agent' : 'Save agent', 'Cancel'], defaultId: 1, cancelId: 1, title: agent.activate ? 'Turn on a custom agent' : 'Add a custom agent', message: `${agent.activate ? 'Turn on' : 'Save'} ${agent.name}? Trace will run this program as you, in the folders of the channels you start with it:`, detail: `${agent.detail}

It runs without a shell. Save it only if you trust this program.` })).response === 0,
    confirmRun: async (run) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Run', 'Cancel'], defaultId: 1, cancelId: 1, title: run.title, message: run.message, detail: run.detail })).response === 0,
  // "From a list" fetches from local repositories in smoke tests, as plugins do; never set in use.
  }, process.env.CODING_HUB_TEST_PLUGIN_GIT ? { github: { url: (owner, name) => path.join(process.env.CODING_HUB_TEST_PLUGIN_GIT!, owner, name) } } : {});
  const experiments = new Experiments(storageRoot, (id) => Boolean(storage?.history().some((run) => run.runId === id)));
  const readyForBackup = async () => { if (manager.hasSessions || scheduledJobs.running || accounts.active || projectSetup.active || worktrees?.active || projectChecks?.running || verification?.running || delivery?.running || workflows?.running) throw new HubError('BACKUP_BUSY', 'Stop all channels and verification jobs before backing up or restoring.'); if (!storage || !workspaceLoaded) throw new HubError('BACKUP_STORAGE', 'Load a writable workspace before backing up.'); await flushWorkspace(); if (!lastFlushSucceeded) throw new HubError('BACKUP_SAVE', 'Save the workspace successfully before backing up.'); };
  backups = new Backups(storageBase, storageRoot, profileRoot, app.getVersion(), { ready: readyForBackup,
    exportFile: async () => (await dialog.showSaveDialog(window!, { title: 'Export local backup', defaultPath: `Trace-${app.getVersion()}.hub-backup.gz`, filters: [{ name: 'Trace backup', extensions: ['gz'] }] })).filePath ?? null,
    importFile: async () => { const selected = await dialog.showOpenDialog(window!, { title: 'Import local backup', properties: ['openFile'], filters: [{ name: 'Trace backup', extensions: ['gz'] }] }); return selected.canceled ? null : selected.filePaths[0] ?? null; },
    confirmRestore: async (record) => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Activate restored copy on restart', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Review verified restore', message: `${record.files} files · ${record.bytes} bytes · version ${record.appVersion}`, detail: 'The backup was checked and copied into a new local restore folder. Current data and project files remain intact. Credentials are excluded, so named profiles may need login again. This computer’s identity, paired phones and linked computers are kept as they are now. After the restart, sync between computers compares rules and settings with your other computers and asks you to choose where both sides changed. Restart to activate the restored copy.' })).response === 0 && !updateRestart,
    // The host asks, never the window: deleting a backup cannot be undone.
    confirmDelete: async (record) => (await dialog.showMessageBox(window!, { type: 'warning', buttons: ['Delete backup', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Delete local backup', message: `${new Date(record.createdAt).toLocaleString()} · ${record.files} files`, detail: 'The backup file is removed from this computer. Exported copies are not affected.' })).response === 0,
  });
  const confirmWorkflow = async (title: string, detail: string) => (await dialog.showMessageBox(window!, { type: 'question', title, message: title, detail, buttons: ['Confirm reviewed action', 'Cancel'], defaultId: 1, cancelId: 1 })).response === 0 && !updateRestart && !backups?.busy;
  const workflowReady = () => { if (manager.hasSessions || projectChecks?.running || verification?.running || workflows?.running || updateRestart || scriptUpdate || backups?.busy) throw new HubError('WORKFLOW_BUSY', 'Stop running channels and verification before changing repositories or applying templates.'); };
  delivery = new Delivery(confirmWorkflow, workflowReady);
  // The person turned this on in Settings (on by default): it stands in for Ship's confirmations, for this flow only.
  taskPullRequests = new TaskPullRequests({ tasks, delivery, changed: tasksChanged,
    enabled: () => { try { return hub?.preferences().taskPullRequests !== false; } catch { return false; } },
    checks: (folder, sessionId) => autoChecks.settled(folder, sessionId),
    // A reply is null when Trace cannot read the channel's conversation (transcriptSource), and the pull request says so.
    agent: (sessionId) => { const engine = sessionId ? workspaceChannels().find((session) => session.id === sessionId)?.engine : undefined; return { name: sessionId && engine && engine !== 'shell' ? agentName(sessionId, engine as ChannelEngine) : null, reply: sessionId ? channelReplies(sessionId, 1)[0] ?? null : null }; },
    github: async () => { const { connection } = await inspectAccount('github'); return !connection.installed ? 'missing' : connection.state === 'authenticated' ? 'signed-in' : connection.state === 'not-authenticated' ? 'signed-out' : 'unknown'; },
  });
  workflows = hub && storage ? new Workflows(storageRoot, nativeSessions, verification, hub.rules, storage, confirmWorkflow) : null;
  // CODING_HUB_TEST_SCREEN_SERVICE_PORT (source runs only): the phone Screen smoke test's own screen service, so it never reaches an installed Trace's.
  const testServicePort = !app.isPackaged && process.env.CODING_HUB_TEST_SCREEN_SERVICE_PORT ? Number(process.env.CODING_HUB_TEST_SCREEN_SERVICE_PORT) : null;
  // Phone remote: off until turned on in Settings. It listens on loopback only; Tailscale carries it to the phone.
  remote = new RemoteServer(storageRoot, {
    // Channels still called by their engine's name are named after their folder, as on the desktop.
    sessions: () => workspaceChannels(),
    running: () => manager.running(),
    write: (reference, data) => manager.writeRemote(reference, data),
    control: (sessionId, control) => controlChannel(sessionId, control),
    channelSettings, changeChannel: (change) => askWindow({ settings: change }),
    add: (engine, chat, like, agent) => addChannel(engine, chat, like, agent), agents: () => customAgents?.looks() ?? [],
    chat: (request) => manager.chatRemote(request),
    // Claude Code and Codex take an image from this computer's clipboard when they get their image key (Alt+V on
    // Windows, Ctrl+V on a Mac), so the pasted image is put there first, as a paste here would.
    pasteImage: async (reference, data) => {
      const run = manager.running().find((item) => item.sessionId === reference.sessionId && item.runId === reference.runId);
      if (!run) throw new HubError('STALE_SESSION', 'That channel is no longer running here.');
      if (run.engine === 'shell' || run.engine === 'gemini' || run.engine === 'custom') throw new HubError('PASTE_SHELL', 'Images paste into Claude Code and Codex channels, not terminals, Gemini or agents you added.');
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
    // A Mac asks the system: Electron's idle state says active when Trace started while the Mac was already locked.
    transcript: channelTranscript,
    // A phone's Screen reaches this Mac's own Screen Sharing on loopback, or, on Windows, Trace's screen service (when
    // Share this screen is on), signed in with Trace's own key and named as the phone.
    ...(process.platform === 'darwin' ? { screenTarget: () => ({ host: '127.0.0.1', port: 5900 }) } : {}),
    ...(process.platform === 'win32' ? {
      screenService: () => shareEnabled(storageRoot),
      openScreenService: (viewer: string, display = 0) => { const token = localScreenToken(storageRoot); if (!token) throw new HubError('SCREEN_SERVICE', 'The screen service has not started yet.'); return openTraceScreen('This computer', `http://127.0.0.1:${testServicePort ?? SCREEN_SERVICE_PORT}/`, token, undefined, display, { 'X-Trace-Viewer': viewer }); },
    } : {}),
    screenLocked: process.platform === 'darwin' ? macScreenLock() : () => { const state = powerMonitor.getSystemIdleState(1); return state === 'unknown' ? null : state === 'locked'; },
    // Usage as the status bar shows it. Plan limits are what was last read; reading them starts the CLIs, so a phone only
    // asks for a fresh read in the background, at most every five minutes like Usage (PlanLimitsService.refresh).
    // A phone asks once per load, so it waits (at most 2 s) for the logs' latest growth instead of getting the last read.
    usage: async () => {
      void planLimits.refresh().catch(() => {});
      let budget: { dailyTokens?: number | null; dailyCost?: number | null; limitWarning?: number } | null = null; try { budget = hub?.preferences() ?? null; } catch { /* Unreadable preferences: no budget shown. */ }
      await dayUsage.settled(); return { today: dayUsage.totals(), limits: planLimits.current(), budget };
    },
    tasks: () => tasks.list(),
    taskStatus: async (id, status) => { await setTaskStatus({ action: 'task-status', id, status }); },
    history: async () => { const labels = workflows?.labels() ?? []; return (await nativeSessions.list()).map((item) => { const label = labels.find((entry) => entry.key === item.key)?.name; return label ? { ...item, label } : item; }); },
    resume: (key) => resumeConversation(key),
    memoryProjects: () => channelProjects(),
    memoryNotes: (project) => { if (!hub) throw new HubError('HUB_STORAGE', 'Memory storage is unavailable on this computer.'); return hub.memory.listLater(project); },
    writeMemory: (project, title, content) => { if (!hub) throw new HubError('HUB_STORAGE', 'Memory storage is unavailable on this computer.'); hub.execute({ action: 'memory-write', project, title, content, author: 'human' }); },
    // The app a channel printed the address of (1.39.0): its address for the channel list, and pictures of it.
    preview: (sessionId) => previewOffers.list().find((offer) => offer.sessionId === sessionId)?.url ?? null,
    previewPicture: (sessionId) => { const offer = previewOffers.list().find((item) => item.sessionId === sessionId); if (!offer) throw new HubError('PREVIEW_UNKNOWN', 'This channel is not running an app Trace can show.'); return appPreview.picture(sessionId, previewOffers.allowed(sessionId, offer.port)); },
  // CODING_HUB_TEST_REMOTE_PORT (source runs only): smoke tests listen elsewhere, so they run while an installed Trace is open.
  }, !app.isPackaged && process.env.CODING_HUB_TEST_REMOTE_PORT ? Number(process.env.CODING_HUB_TEST_REMOTE_PORT) : undefined, path.join(__dirname, '../../dist/phone'));
  remote.version = app.getVersion();
  const runTailscale = tailscaleRunner(); const phone = remote; let serveConsent = false;
  // This Windows computer's screen, for linked computers, from a service that also runs while Trace is closed.
  screenShare = new ScreenShare(storageRoot, () => hub?.devices.machine.name ?? os.hostname(), runTailscale, testServicePort ?? undefined);
  // The smoke test starts its own service: this copy must not add a sign-in entry or a Tailscale path for it.
  // A service that runs but cannot capture is said at once, here and as a notification: nothing else would show it until someone tried Screen.
  screenShare.onProblem = (message) => { hostHealth?.record('screen-capture-failed'); reportStorageError(message); desktopAlert({ title: 'Screen sharing is not working', body: message, target: { view: 'settings' } }, true); };
  if (!testServicePort) { void screenShare.ensure().catch(() => hostHealth?.record('screen-service-start-failed')); screenShare.watch(); }
  // Other computers: each advertises its remote's tailnet address through the Drive sync folder, and links with a code.
  if (hub) {
    const devices = hub.devices; phone.identity = devices.machine;
    // Custom agent definitions sync too; one from another computer stays Off here until confirmed (docs/custom-agents.md).
    devices.agents = customAgents;
    // This computer's Drive folder was moved to the one its other computers use: said here and as a notification.
    devices.onJoined = (moved) => { hostHealth?.record('sync-folder-joined'); desktopAlert({ title: 'Trace now syncs with your other computers', body: `This computer’s Drive folder was changed to ${moved.to}, which ${moved.computers.join(', ')} ${moved.computers.length === 1 ? 'uses' : 'use'}. Settings → Sync between computers can move it back.`, target: { view: 'settings' } }, true); };
    // Auto-link needs no code, so the person is always told, even with Trace in front; clicking opens that computer's tab.
    // The window's banner shows it too, and host health records it, so it is not lost when desktop alerts are off.
    phone.onAutoLinked = (name, machineId) => {
      const body = `${name.slice(0, 80)} linked itself through your Tailscale login. If it isn't yours, remove it under Settings → Other computers.`;
      hostHealth?.record('computer-auto-linked'); reportStorageError(`A computer linked to Trace here: ${body}`);
      desktopAlert({ title: 'A computer linked to Trace here', body, target: { computerId: machineId } }, true);
    };
    /** This computer's own tailnet (`tail1234.ts.net`), from its Tailscale name; null until that is known. */
    const ownTailnet = () => phone.tailscale.host ? tailnetOf('https://' + phone.tailscale.host) : null;
    devices.advertise = () => phone.enabled && phone.tailscale.serving ? phone.status().url : null;
    // Another computer's channel that needs the person is told here while this window is not in front; clicking opens its tab.
    const linkedAlerts = new LinkedAlerts((alert) => desktopAlert({ title: alert.title, body: alert.body, target: { computerId: alert.id } }));
    linked = new LinkedComputers(storageRoot, () => devices.machine, () => devices.advertised(), (event) => { if (event.type === 'computers') linkedAlerts.update(event.computers); sendToRenderer(IPC_CHANNELS.linkedEvent, event); },
      { output: (sessionId, runId, data) => phone.relayOutput(sessionId, runId, data), resize: (sessionId, runId, cols, rows) => phone.relayResize(sessionId, runId, cols, rows), changed: () => phone.relayChanged(), chat: (envelope) => phone.relayChat(envelope) }, fetch, () => powerMonitor.getSystemIdleTime());
    linked.chatEvents = (event) => sendToRenderer(IPC_CHANNELS.linkedChatEvent, event);
    // A smoke test (an unpackaged run on its own remote port) must never find or link the owner's real computers on
    // the tailnet: it would leave links to a throwaway copy on them. CODING_HUB_TEST_TAILNET=1 opts a test back in.
    const isolatedTest = !app.isPackaged && Boolean(process.env.CODING_HUB_TEST_REMOTE_PORT) && process.env.CODING_HUB_TEST_TAILNET !== '1';
    phone.setRelay(linked); linked.peers = () => isolatedTest ? Promise.resolve([]) : tailscalePeers(runTailscale); linked.tailnet = ownTailnet;
    // An unreadable linked-computers.json must not keep the window from opening.
    try { linked.start(); } catch { hostHealth?.record('linked-computers-unreadable'); }
    // After this computer updated, its linked computers are asked to update too (the person's choice, 2026-11-22;
    // before: Update on each computer's tab). Each one refuses while anything runs there, so it is asked again every
    // half hour, for six hours. A copy that never ran before, or was not updated, asks nobody.
    if (app.isPackaged && !isolatedTest) {
      const versionFile = 'last-version.json'; const versionSchema = z.object({ version: z.string().max(40) }).strict().nullable();
      let before: string | null = null; try { before = load(storageRoot, versionFile, versionSchema, null)?.version ?? null; } catch { /* Unreadable: as if never run. */ }
      try { if (before !== app.getVersion()) save(storageRoot, versionFile, { version: app.getVersion() }); } catch { hostHealth?.record('last-version-unsaved'); }
      if (before && isNewerVersion(app.getVersion(), before)) {
        const updated = new Set<string>(); let tries = 0; const computers = linked;
        const ask = () => {
          for (const computer of computers.status()) if (computer.linked && computer.connected && !updated.has(computer.id)) void computers.update(computer.id).then(() => { updated.add(computer.id); }, () => { /* Busy, older than 1.15 or unreachable: asked again. */ });
          if (++tries < 12) setTimeout(ask, 30 * 60000).unref();
        };
        setTimeout(ask, 90000).unref();
      }
    }
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
    // Only addresses on this computer's own tailnet: a Drive writer could list another tailnet's (Funnel) name.
    // Linked computers count too: one linked over the tailnet may not share this computer's Drive folder.
    const linkedAddresses = () => { try { return linked?.status().filter((computer) => computer.linked).map((computer) => computer.url) ?? []; } catch { return []; } };
    phone.allowedOrigins = () => { const own = ownTailnet(); return [...new Set([...devices.advertised().map((computer) => computer.url), ...linkedAddresses()].flatMap((address) => { const url = linkableAddress(address); const net = url ? tailnetOf(url) : null; return url && (!own || !net || net === own) ? [url.replace(/\/$/, '').toLowerCase()] : []; }))]; };
  }
  // Phones are accepted only on this computer's tailnet name: one failed `tailscale status` (a timeout, say) must not
  // forget it, or every phone request gets "Unknown host" until the next check.
  let checkedTailscale = 0; let autoLinked = 0; let checkingTailscale: Promise<void> | null = null;
  // One check at a time: Settings asking again while one runs waits for it instead of starting more tailscale processes.
  const refreshTailscale = (): Promise<void> => checkingTailscale ??= (async () => {
    if (!phone.enabled) return; const started = checkedTailscale = Date.now(); const next = await tailscaleState(runTailscale, phone.port);
    phone.tailscale = !next.host && next.error && phone.tailscale.host ? { ...next, host: phone.tailscale.host } : next;
    if (phone.tailscale.serving) { phone.serveProblem = null; phone.serveLink = null; }
    // The person's other computers on the tailnet are found and linked at most once a minute, however often Settings asks.
    // Timed from the check's start, as the timer is, so a quicker check a minute later is not skipped by a few milliseconds.
    if (phone.autoLink && phone.tailscale.running && started - autoLinked >= 60000 && !(!app.isPackaged && process.env.CODING_HUB_TEST_REMOTE_PORT && process.env.CODING_HUB_TEST_TAILNET !== '1')) { autoLinked = started; void linked?.autoLink().catch(() => {}); }
  })().finally(() => { checkingTailscale = null; });
  void phone.start().then(refreshTailscale).catch(() => hostHealth?.record('remote-start-failed'));
  // Every minute, and every ten seconds while the tailnet name is not known yet.
  setInterval(() => { if (Date.now() - checkedTailscale >= 60000 || (phone.enabled && !phone.tailscale.host)) void timed('tailscale-check', refreshTailscale).catch(() => {}); }, 10000).unref();
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
    if (request.action === 'remote-auto-link') { phone.setAutoLink(request.enabled); autoLinked = 0; }
    if (request.action === 'remote-enable') { autoLinked = 0; await phone.setEnabled(request.enabled); if (!request.enabled) { serveConsent = false; await stopServing(runTailscale, phone.port).catch(() => hostHealth?.record('tailscale-serve-off-failed')); } }
    if (request.action === 'remote-cancel-pairing') return phone.cancelPairing();
    if (request.action === 'remote-revoke') return phone.revoke(request.id);
    if (request.action === 'remote-can-run') return phone.setCanRun(request.id, request.canRun);
    if (request.action === 'remote-test-alert') return phone.testAlert(request.id);
    if (request.action === 'remote-open-tailscale') { if (phone.serveLink) await shell.openExternal(phone.serveLink); return phone.status(); }
    if (request.action === 'remote-serve') {
      // Once agreed, a retry runs the same command: after fixing Tailscale's settings the person is not asked again.
      // An automatic retry never asks and never opens a page, so returning to Trace cannot bounce back to the browser.
      const confirmed = serveConsent || !request.automatic && (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Set up Tailscale HTTPS', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Reach Trace from your phone',
        message: 'Let devices on your tailnet reach Trace?', detail: `This runs "tailscale serve --bg --https=443 http://127.0.0.1:${phone.port}". Devices signed in to your Tailscale network can then open Trace's phone page; each phone still has to be paired here before it can see or type into channels. With Link my computers automatically on, your other computers signed in to the same Tailscale account link without a code; Trace tells you when one does. It is not exposed to the internet. It stays set until you remove it with "tailscale serve reset".` })).response === 0;
      if (confirmed) {
        serveConsent = true;
        // An older Trace's "phone access off" removed /api/screen from Tailscale's settings; the screen service puts it back.
        try { await serveRemote(runTailscale, phone.port); phone.serveProblem = null; phone.serveLink = null; void screenShare?.ensure().catch(() => hostHealth?.record('screen-service-start-failed')); }
        catch (error) {
          const { url, ...problem } = serveFailure(error as TailscaleError);
          phone.serveProblem = problem; phone.serveLink = url;
          if (url && !request.automatic) void shell.openExternal(url);
        }
      }
    }
    // A check already running may have read Tailscale before this change: the answer comes from one started after it.
    if (request.action === 'remote-serve' || request.action === 'remote-enable' || request.action === 'remote-auto-link') await checkingTailscale?.catch(() => {});
    // Settings polls remote-status every few seconds while a code shows: it gets the last check unless that is 10 s old.
    if (request.action !== 'remote-status' || Date.now() - checkedTailscale >= 10000) await refreshTailscale().catch(() => {});
    return request.action === 'remote-pair' ? phone.pair(request.kind) : phone.status();
  };
  handle(IPC_CHANNELS.workbench, async (_owner, payload) => {
    const action = z.object({ action: z.string().max(60) }).passthrough().parse(payload).action;
    if (action === 'runtime') { z.object({ action: z.literal('runtime') }).strict().parse(payload); return { version: app.getVersion(), rendererVersion: app.getVersion(), edition: !app.isPackaged ? 'source' : process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed', executable: process.execPath, applicationPath: app.getAppPath(), storagePath: storageRoot, platform: process.platform, restartRequired: backups!.restartRequired }; }
    if (action === 'restart') { z.object({ action: z.literal('restart') }).strict().parse(payload); await readyForBackup(); relaunching = true; app.relaunch(); app.quit(); return null; }
    if (updateRestart) throw new HubError('HOST_CLOSING', 'The application is restarting.');
    if (action === 'codex-models') return modelCatalog.execute(payload);
    if (action === 'gemini-models') { z.object({ action: z.literal('gemini-models') }).strict().parse(payload); return geminiModels(); }
    if (action === 'host-health') { z.object({ action: z.literal('host-health') }).strict().parse(payload); return hostHealth!.report(); }
    if (action.startsWith('remote-')) return remoteControl(payload);
    if (action.startsWith('linked-')) return linkedRequest(payload);
    if (action === 'channel-transcript') return channelTranscript(z.object({ action: z.literal('channel-transcript'), sessionId: z.string().min(1).max(100) }).strict().parse(payload).sessionId);
    if (action === 'channel-task-transcript') { const request = z.object({ action: z.literal('channel-task-transcript'), sessionId: z.string().min(1).max(100), mark: z.string().regex(/^Task t-[0-9a-f]{8}:$/) }).strict().parse(payload); return taskTranscript(request.sessionId, request.mark); }
    // Waiting (at most 2 s) for the logs' latest growth answers with current numbers in one ask.
    if (action === 'usage-today') { z.object({ action: z.literal('usage-today') }).strict().parse(payload); await dayUsage.settled(); return dayUsage.totals(); }
    if (action === 'usage-days') { z.object({ action: z.literal('usage-days') }).strict().parse(payload); await dayUsage.settled(); return dayUsage.days(); }
    // A link in a chat reply: before the busy checks below, since opening a page changes nothing here. The window is
    // untrusted, so the host itself allows only web addresses.
    if (action === 'flow-open-link') {
      const link = webLink(openLinkSchema.parse(payload).url);
      if ('refused' in link) throw link.refused === 'scheme' ? new HubError('LINK_SCHEME', 'Only web links (http or https) open in the browser. Use Copy address for others.') : new HubError('LINK_INVALID', 'That link is not a web address Trace can open.');
      await shell.openExternal(link.href); return null;
    }
    if (action.startsWith('preview-')) return previewRequest(payload);
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
        fs.writeFileSync(result.filePath, JSON.stringify({ appVersion: app.getVersion(), platform: process.platform, packaged: app.isPackaged, report: sanitized, hostHealth: hostHealth?.report() ?? null, excludes: ['Session output','Prompt text','Environment values','Credentials','Configuration contents'] }, null, 2), { mode: 0o600 }); return { exported: true };
      }
      if (!workflows) throw new HubError('WORKFLOW_STORAGE', 'Writable local workflow storage is unavailable.');
      if (action === 'flow-template-apply') workflowReady();
      return workflows.execute(payload);
    }
    if (action === 'diagnose') return diagnostics.execute(payload);
    if (action.startsWith('native-')) return nativeSessions.execute(payload);
    if (backups?.busy && ['verification-run', 'verification-save', 'verification-delete', 'hook-save', 'hook-delete', 'task-save', 'experiment-save', 'trial-add', 'experiment-delete', 'trial-delete'].includes(action)) throw new HubError('BACKUP_BUSY', 'Finish the backup operation before changing local workspace data.');
    // Jobs that run or rewrite local data wait out a Mac script update, as channel starts do (it restarts Trace once it is done).
    if (['verification-run', 'backup-create', 'backup-restore', 'backup-import'].includes(action)) refuseDuringScriptUpdate();
    if (action.startsWith('verification-')) return verification!.execute(payload);
    if (action.startsWith('hook-')) return eventHooks!.execute(payload);
    if (action.startsWith('agent-')) { if (!customAgents) throw new HubError('CUSTOM_AGENTS', 'Custom agents are unavailable: Trace’s storage could not be opened.'); return customAgents.execute(payload); }
    if (action.startsWith('undo-') || action === 'redo-turn') return undoRequest(payload);
    if (action === 'editor-status') return vscodeStatus();
    if (action === 'editor-connect') { await installVSCodeExtension(app.getVersion(), path.join(app.getPath('temp'), 'trace-vscode')); return vscodeStatus(); }
    if (action.startsWith('plugin-')) return plugins!.execute(payload);
    // A task the agent says is done: plugins hear it (task.ready-for-review).
    if (action === 'task-status') { const result = await setTaskStatus(payload); const value = result as { status?: string; id?: string; title?: string } | null; if (value?.status === 'review') plugins?.fire('task.ready-for-review', value.id ?? '', { project: storage?.load()?.rootDirectory ?? null, message: value.title ?? '' }); return result; }
    if (action.startsWith('task-')) return tasks.execute(payload);
    if (action.startsWith('job-')) return scheduledJobs.execute(payload);
    if (action.startsWith('experiment-') || action.startsWith('trial-')) return experiments.execute(payload);
    if (action.startsWith('backup-')) return backups!.execute(payload);
    throw new HubError('INVALID_REQUEST', 'Unknown workbench operation.');
  });
  const projectSetup = new ProjectSetup();
  handle(IPC_CHANNELS.projects, (_owner, payload) => { if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); refuseDuringScriptUpdate(); return projectSetup.execute(payload); });
  handle(IPC_CHANNELS.accounts, (owner, payload) => { if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is preparing an update.'); refuseDuringScriptUpdate(); return accounts.execute(owner, payload); });
  projectChecks = new ProjectChecks((directory) => { if (!hub) throw new HubError('STORAGE_UNAVAILABLE', 'Shared rules storage is unavailable.'); hub.rules.verifyLaunch(directory); });
  handle(IPC_CHANNELS.projectChecks, (_owner, payload) => { if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); refuseDuringScriptUpdate(); return projectChecks!.execute(payload, async () => (await dialog.showMessageBox(window!, { type: 'question', buttons: ['Run project code', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Run project check', message: 'Run this project’s npm script?', detail: 'Tests, typecheck, or lint scripts and their npm pre/post hooks execute project code with your local permissions. Only run checks in projects you trust. Output is capped and the check stops after 60 seconds.' })).response === 0 && !updateRestart); });
  worktrees = new WorktreeService(storageRoot, directoryInUse);
  handle(IPC_CHANNELS.projectTools, async (_owner, payload) => {
    if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is restarting.'); refuseDuringScriptUpdate();
    const result = await worktrees!.execute(payload);
    // A new worktree: plugins hear it (worktree.created), with its folder and branch.
    const made = result as { directory?: string; branch?: string } | null; if ((payload as { action?: string })?.action === 'worktree-create' && made?.directory) plugins?.fire('worktree.created', made.directory, { project: storage?.load()?.rootDirectory ?? null, folder: made.directory, branch: made.branch ?? null });
    return result;
  });
  // On Windows an update leaves the background runner's channels running (it runs outside the install folder), so they do
  // not hold an update back. A Mac's runner still runs from the app an update replaces.
  busyJobs = () => (background && process.platform === 'win32' ? manager.hasLocalSessions : manager.hasSessions) || autoChecks.running || turnSnapshots.running || scheduledJobs.running || accounts.active || projectSetup.active || Boolean(projectChecks?.running) || Boolean(verification?.running) || Boolean(backups?.busy) || Boolean(delivery?.running) || Boolean(taskPullRequests?.running) || Boolean(workflows?.running) || Boolean(worktrees?.active);
  updates = new UpdateService({
    version: app.getVersion(),
    enabled: updatesEnabled(app.isPackaged, process.platform, process.resourcesPath, Boolean(process.env.PORTABLE_EXECUTABLE_DIR), macUpdates()),
    disabledReason: process.platform === 'darwin' && app.isPackaged ? 'This Mac copy is not signed with Trace\'s Developer ID, so it cannot update itself. Install the latest version from the downloads page once; later versions then update themselves.' : 'Automatic updates require the installed Windows edition. Source and portable editions are updated manually.',
    openDownloads: () => shell.openExternal(DOWNLOADS_URL),
    storageDirectory: storageRoot,
    updater: autoUpdater,
    publish: (status) => { sendToRenderer(IPC_CHANNELS.updateStatus, status); },
    hasSessions: () => busyJobs(),
    installationFailed: () => { updateRestart = false; },
    prepareRestart: async (remote) => {
      const answer = remote ? { response: 0 } : await dialog.showMessageBox(window!, { type: 'question', buttons: ['Restart and install', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Install update', message: 'Save your workspace and restart Trace?', detail: 'Local settings, history, rules, and memory remain in ~/.coding-hub. All channels must be stopped.' });
      if (answer.response !== 0) return false;
      updateRestart = true;
      try {
        if (busyJobs()) throw new HubError('ACTIVE_SESSIONS', 'Stop all channels before restarting.');
        if (workspaceLoaded) { await flushWorkspace(); if (!lastFlushSucceeded) throw new HubError('UPDATE_SAVE_FAILED', 'The workspace could not be saved. Resolve the storage issue before updating.'); }
        else throw new HubError('UPDATE_SAVE_FAILED', 'Load the local workspace successfully before updating.');
        // The installer closes Trace about two seconds after it starts and then ends it by force, so nothing slow may be
        // left for quitting: memory summaries of sessions that just ended are saved now, while Trace is still running.
        await autoMemory?.drain(10000)?.catch(() => hostHealth?.record('shutdown-stop-failed'));
        // Then those summaries (and other notes still on their way) reach Drive for the other computers.
        await hub?.drain(5000)?.catch(() => hostHealth?.record('shutdown-stop-failed'));
        return true;
      } catch (error) { updateRestart = false; throw error; }
    },
  });
  handle(IPC_CHANNELS.updates, (_owner, payload) => updates!.execute(payload));
  handle(IPC_CHANNELS.hub, (_owner, payload) => { if (!hub) throw new HubError('STORAGE_UNAVAILABLE', 'Local integrations require a writable storage folder.'); return hub.executeAsync(payload); });
  handle(IPC_CHANNELS.openRepository, (owner, payload) => repositoryFiles.open(owner, payload));
  handle(IPC_CHANNELS.closeRepository, (owner, payload) => { repositoryFiles.close(owner, payload); return null; });
  handle(IPC_CHANNELS.listDirectory, (owner, payload) => repositoryFiles.list(owner, payload));
  handle(IPC_CHANNELS.readFile, (owner, payload) => repositoryFiles.read(owner, payload));
  handle(IPC_CHANNELS.gitStatus, (owner, payload) => repositoryGit.status(owner, payload));
  handle(IPC_CHANNELS.gitDiff, (owner, payload) => repositoryGit.diff(owner, payload));
  handle(IPC_CHANNELS.gitLog, (owner, payload) => repositoryGit.log(owner, payload));
  handle(IPC_CHANNELS.gitCommit, (owner, payload) => repositoryGit.commit(owner, payload));
  handle(IPC_CHANNELS.loadWorkspace, async () => {
    const database = localStorage();
    const { workspace, removedChannels, rootDirectory } = database.loadMigrated();
    // Only on the first load: a reload of the window has no quit before it, so starts nothing. Channels whose terminals
    // the background runner kept running are taken up again whatever that setting says: they never stopped.
    const kept = workspaceLoaded || !workspace ? [] : await runner()?.kept().catch(() => []) ?? [];
    const resume = workspaceLoaded || !workspace ? [] : takeResume(storageRoot).filter((id) => !kept.includes(id));
    workspaceLoaded = true;
    // Only Gemini channels were saved: no workspace is left, but its project folder is kept.
    return { workspace, info: database.info, ...(removedChannels ? { removedChannels } : {}), ...(!workspace && rootDirectory ? { rootDirectory } : {}), ...(resume.length ? { resume } : {}), ...(kept.length ? { kept } : {}) };
  });
  handle(IPC_CHANNELS.saveWorkspace, (_owner, payload) => {
    if (!workspaceLoaded) throw new HubError('WORKSPACE_NOT_LOADED', 'Load the saved workspace before saving changes.');
    localStorage().save(payload); remote?.channelsChanged(); return null;
  });
  handle(IPC_CHANNELS.listHistory, () => localStorage().history());
  handle(IPC_CHANNELS.readRunLog, (_owner, payload) => localStorage().readLog(payload));
  handle(IPC_CHANNELS.finishWorkspaceFlush, (owner, payload) => {
    const request = z.object({ requestId: z.string().uuid() }).passthrough().safeParse(payload);
    if (!request.success || !pendingFlush || pendingFlush.owner !== owner || request.data.requestId !== pendingFlush.requestId) throw new HubError('INVALID_FLUSH', 'Invalid workspace flush request.');
    const flush = pendingFlush;
    // A workspace that fails the schema still ends the wait now (not after 2 s), and the window is told what is wrong.
    try {
      const parsed = finishWorkspaceFlushSchema.safeParse(payload);
      if (!parsed.success) { hostHealth?.record('workspace-flush-invalid'); throw new HubError('INVALID_WORKSPACE', `The workspace could not be saved: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' ').slice(0, 1000)}`); }
      if (parsed.data.workspace && workspaceLoaded) { localStorage().save(parsed.data.workspace); lastFlushSucceeded = true; }
    } finally { flush.resolve(); }
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
    const bytes = Buffer.from(await (await type.item.getType(type.name) as Blob).arrayBuffer());
    const image = nativeImage.createFromBuffer(bytes); if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    // Encoding a large image as PNG blocks the main process (0.1-0.5 s for a screenshot), so a PNG or JPEG is shown as
    // it was copied; only the small thumbnail is encoded here, and a huge or unusual image is scaled down first.
    const original = clipboardPreviewType(type.name, bytes.length);
    const full = original ? `data:${original};base64,${bytes.toString('base64')}` : (Math.max(width, height) > 2000 ? image.resize(width >= height ? { width: 2000 } : { height: 2000 }) : image).toDataURL();
    return { thumbnail: image.resize({ height: Math.min(height, 160) }).toDataURL(), full, width, height, hasText: (await clipboard.readText()).length > 0 };
  });
  // Electron 44's clipboard is asynchronous: wait for the write, so a failure reaches the window instead of vanishing.
  handle(IPC_CHANNELS.screen, screenRequest);
  handle(IPC_CHANNELS.copyText, async (_owner, text) => { await clipboard.writeText(z.string().max(COPY_LIMIT).parse(text)); return null; });
  // The window's own trouble (a lost WebGL context, a stall), so a freeze leaves a record; limited, as the window is untrusted.
  handle(IPC_CHANNELS.windowHealth, (_owner, payload) => {
    const report = windowHealthSchema.parse(payload);
    hostHealth?.recordFromWindow(report.kind, report.ms ?? null, report.detail ?? null); return null;
  });
  handle(IPC_CHANNELS.discoverEngines, async () => (await Promise.all([discoverEngine('claude'), discoverEngine('codex'), discoverEngine('gemini')])).map((engine) => engine.info));
  handle(IPC_CHANNELS.startSession, (owner, payload) => {
    if (updateRestart) throw new HubError('HOST_CLOSING', 'The app is preparing to install an update.'); refuseDuringScriptUpdate();
    // The manager validates the complete request. This guard also covers pending
    // login discovery, preventing a session from racing a credential replacement.
    if (payload && typeof payload === 'object' && 'config' in payload) {
      const config = (payload as { config?: { engine?: string; accountProfileId?: string } }).config;
      if (config?.engine === 'claude' && config.accountProfileId && accounts.activeProfileId === config.accountProfileId) throw new HubError('PROFILE_BUSY', 'Finish or cancel this profile’s login before starting a channel.');
    }
    return manager.start(owner, payload);
  });
  handle(IPC_CHANNELS.writeSession, (owner, payload) => {
    manager.write(owner, payload);
    const input = payload as { sessionId?: unknown; data?: unknown }; if (typeof input.sessionId === 'string' && typeof input.data === 'string') remote?.personInput(input.sessionId, input.data);
    return null;
  });
  handle(IPC_CHANNELS.ackSession, (owner, payload) => { manager.ack(owner, payload); return null; });
  handle(IPC_CHANNELS.focusChannel, (_owner, payload) => { remote?.desktopFocus(z.object({ sessionId: z.string().min(1).max(100) }).strict().parse(payload).sessionId); return null; });
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
  // After the logs' latest growth is read (at most 2 s), so an alert is not a minute late.
  setInterval(() => { if (!hub) return; void dayUsage.settled().then(() => timed('usage-alerts', () => {
    if (!hub) return;
    try {
      const before = warned.size; const alerts = usageAlerts(dayUsage.totals(), planLimits.current(), hub.preferences(), warned);
      for (const alert of alerts) desktopAlert(alert, true);
      if (warned.size !== before) fs.writeFileSync(warnedFile, JSON.stringify([...warned].slice(-300)), { mode: 0o600 });
    } catch { hostHealth?.record('usage-alerts-failed'); }
  })); }, 60000);
  // On a Mac, opening Trace from the Dock or Finder while it quits raises this, not second-instance: it opens afterwards.
  app.on('activate', () => { if (quitting) { if (!updateRestart && !scriptUpdate) reopenAfterQuit = true; return; } if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow(); });
}).catch(() => {
  // Without this, a failure while starting left Trace running with no window, and opening it again showed nothing.
  hostHealth?.record('host-start-failed');
  if (!window) { dialog.showErrorBox('Trace could not start', 'Something stopped Trace from opening its window. Open Trace again; if this keeps happening, the lifecycle record in ~/.coding-hub/host-health.json can help find out why.'); app.quit(); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (delivery?.running || workflows?.running || worktrees?.active) { if (window) void dialog.showMessageBox(window, { type: 'info', message: 'Wait for the reviewed workflow or worktree operation to finish before quitting.' }); return; }
  quitting = true; editorBridge.stop();
  // The channels running now start again on their conversations when Trace next opens, unless that is turned off.
  try { saveResume(storageRoot, hub?.preferences().resumeOnStart === false ? [] : manager.running().map((run) => run.sessionId)); } catch { hostHealth?.record('resume-list-failed'); }
  // Where today's usage was read to, so the next start reads only what the logs gain (never rejects).
  const savingUsage = dayUsage.save();
  // Channels in the background runner keep running (Trace takes them up when it opens), unless the tray's Stop all
  // channels and quit was chosen.
  void flushWorkspace().then(() => Promise.all([manager.dispose(stopChannelsOnQuit || !background), accounts.close()])).then(() => background?.close()).catch(() => hostHealth?.record('shutdown-stop-failed'))
    .then(async () => {
      // Quitting would leave these running with nothing to control them; let the person decide.
      const left = [...manager.processIds(), ...accounts.processIds()];
      if (!left.length) return true;
      hostHealth?.record('shutdown-processes-left', String(left.length));
      const choice = await leftRunningChoice(window && !window.isDestroyed() ? window : null, left, 'Quit anyway', 'Keep Trace open');
      if (choice === 'quit') return true;
      quitting = false; manager.reopen(); accounts.reopen();
      // Trying again keeps a request to reopen, so the relaunch after that quit still happens.
      if (choice === 'retry') { app.quit(); return false; }
      // Kept open after being opened again while this was asking: show a window rather than start another copy later.
      if (reopenAfterQuit && (!window || window.isDestroyed())) createWindow(); reopenAfterQuit = false;
      return false;
    })
    .then(async (quit) => {
    if (!quit) return;
    // Stopping sessions starts their memory summaries; let them save before storage closes.
    await autoMemory?.drain(10000)?.catch(() => hostHealth?.record('shutdown-stop-failed'));
    // Then those summaries reach Drive, or another computer starts without them.
    await hub?.drain(5000)?.catch(() => hostHealth?.record('shutdown-stop-failed')); await savingUsage;
    try { mainStalls.stop(); screens?.closeAll(); linked?.stop(); void remote?.stop(); attention.close(); channelTools.close(); appPreview.dispose(); plugins?.close(); pluginApi?.close(); tray?.destroy(); tray = null; modelCatalog.close(); projectChecks?.stop(); verification?.cancel(); updates?.close(); hub?.close(); storage?.close(); hostHealth?.close(); }
    finally { if (reopenAfterQuit && !relaunching && !updateRestart && !scriptUpdate) app.relaunch(); app.quit(); }
  });
});
