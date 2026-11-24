import { stopProcess, type StopDependencies } from './stop-process';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { IPty, IPtyForkOptions } from 'node-pty';
import type { AgentConfig, ChannelConfig, CLIEngineConfig, CustomChannelConfig, PermissionLevel } from '../../../shared/types';
import type { AgentDefinition } from '../../../shared/agent-definition';
import { CustomStatusReader, type CustomStatusChange } from '../agents/status';
import { isAgentConfig, isBuiltInAgent, isChatEngineConfig, isChatRun } from '../../../shared/types';
import type { AgentRunningSession, BuiltInRunningSession, RunningSession, RunReference, SessionEvent, EngineInfo } from '../../../shared/ipc';
import { isPersonInput } from '../../../shared/terminal-input';
import { MAX_CHANNELS, ackSessionSchema, chatRequestSchema, resizeSessionSchema, runReferenceSchema, startSessionSchema, writeSessionSchema } from '../../../shared/schemas';
import { buildGeminiSeatLaunch, buildLaunch, HubError, launchedLevel } from './engine-adapter';
import { discoverEngine, freshHostEnvironment } from './discovery';
import { AUTH_TIMED_OUT } from './auth-status';
import { geminiConversations } from './gemini-conversations';
import { cleanMessage, codexApproval, GeminiStatusReader, OscNotifications, type GeminiStatus } from './attention';
import { ScreenReader } from './screen-reader';
import { nodePty, ptyProcessEnded } from './native-pty';
import { CHAT_ARGS, ClaudeStream, type ChatStream } from '../chat/claude-stream';
import { CodexStream, type CodexThreadOptions } from '../chat/codex-stream';
import { GeminiStream } from '../chat/gemini-stream';
import { RoundTables, type TableHost } from '../chat/round-table';
import { legacySeats, ReviewChains } from '../chat/review-chain';
import { spawnChatProcess, type ChatProcess } from '../chat/chat-process';
import type { ChatEnvelope, ChatEvent, RoundTableState } from '../../../shared/chat';
import { repositoryState } from '../workbench/repository-state';

/** The runs of a table's seats other than its lead, which have no tile of their own. */
const hiddenRuns = (table: RoundTableState) => (table.seats ?? []).slice(1).map((seat) => seat.runId);

function canonical(directory: string) {
  let resolved = path.resolve(directory); try { resolved = realpathSync(resolved); } catch { /* Missing paths compare as given. */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
/** True when `candidate` is `directory` or any folder below it, after resolving links. */
export function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(canonical(directory), canonical(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/**
 * Windows' own sudo setting: 0 or missing is off, 1 opens a new window, 2 runs without input, 3 runs inline. Read with
 * reg.exe off the main process, each time, so turning sudo on applies to the next Terminal channel.
 */
/** How much of a run's raw output is kept for its exit diagnostic. */
const OUTPUT_TAIL = 8192;
/**
 * A run's last output as the text of its exit diagnostic, at most 2,000 characters. The Windows console repaints by
 * moving the cursor, not with newlines, so those moves become line breaks to keep repainted lines apart. Both cuts (the
 * raw tail kept per run, and the 2,000 characters) can fall inside a line or an escape sequence; the text then starts
 * at the next whole line, so a diagnostic never opens with the end of one ("5x30" of "SIZE:85x30").
 */
export function exitTail(output: string): string {
  const text = stripVTControlCharacters(output.replace(/\x1b\[\d*(?:;\d*)?H/g, '\n')).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  const kept = text.slice(-2000), at = kept.indexOf('\n');
  const cut = output.length >= OUTPUT_TAIL || text.length > 2000;
  return cut && at >= 0 && kept.slice(at + 1).trim() ? kept.slice(at + 1).trim() : kept;
}

export function windowsSudoMode(): Promise<number> {
  return new Promise((resolve) => execFile('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Sudo', '/v', 'Enabled'], { encoding: 'utf8', timeout: 3000, windowsHide: true }, (error, output) => {
    // No key: sudo was never turned on.
    const value = error ? undefined : /Enabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output)?.[1]; resolve(value ? parseInt(value, 16) : 0);
  }));
}
/** Windows' sudo.exe (Windows 11 24H2 and later); without it the sudo setting is never read. */
export function windowsSudoPath(env: Record<string, string>): string { return path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'sudo.exe'); }
/** Shown in a Windows terminal that could not start as administrator, unless PowerShell already is one. */
const NOT_ADMIN = "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Trace: this terminal is not running as administrator. To open terminals as administrator, turn on sudo in Windows Settings > System > Advanced and set it to Inline.' -ForegroundColor Yellow }";
/**
 * The program a Terminal channel runs: PowerShell on Windows, as administrator through Windows' sudo when it runs
 * inline (Windows asks for approval each time), otherwise the person's login shell (as Terminal.app starts it),
 * falling back to zsh on macOS and bash elsewhere. `sudoMode` is windowsSudoMode()'s answer, read beforehand.
 */
export function shellProgram(env: Record<string, string>, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync, sudoMode: () => number = () => 0): { file: string; args: string[]; name: string } {
  if (platform === 'win32') {
    const system = path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32');
    const powershell = path.win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'); const file = exists(powershell) ? powershell : 'powershell.exe';
    const sudo = windowsSudoPath(env);
    if (exists(sudo) && sudoMode() === 3) return { file: sudo, args: ['--inline', file, '-NoLogo'], name: 'PowerShell (administrator)' };
    return { file, args: ['-NoLogo', '-NoExit', '-Command', NOT_ADMIN], name: 'PowerShell' };
  }
  const file = env.SHELL && path.isAbsolute(env.SHELL) && exists(env.SHELL) ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  return { file, args: ['-l'], name: path.basename(file) };
}

type Spawn = (file: string, args: string[], options: IPtyForkOptions) => IPty;

/** What the background runner keeps with a terminal so a Trace that opens again knows its channel (docs/background-runner.md). */
export interface HeldMeta { session: RunningSession; nativeKey?: string; config: ChannelConfig; [extra: string]: unknown }
/** The background runner, for terminal runs: they start there and outlive Trace. */
export interface HeldTerminals {
  spawn(file: string, args: string[], options: IPtyForkOptions, meta: HeldMeta): Promise<IPty>;
  /** The terminal this channel ran before Trace closed, still running there, with its kept output; null when none. */
  take(sessionId: string): Promise<{ pty: IPty; meta: HeldMeta; tail: string } | null>;
}

/**
 * Flow control (xterm.js's flow-control guide): output the window has not yet drawn is counted, and past HIGH_WATER
 * the CLI is paused (it simply waits to write, nothing is lost) until the window's acknowledgements bring it under
 * LOW_WATER. A window that stops acknowledging cannot freeze a channel: after STALL_MS the CLI resumes regardless.
 */
/** A title the CLI gives its terminal (OSC 0 or 2): Claude Code's task summary, for phones. */
const TITLE = /\x1b\](?:0|2);([^\x07\x1b]{0,200})(?:\x07|\x1b\\)/g;
export const HIGH_WATER = 1024 * 1024; export const LOW_WATER = 256 * 1024; const STALL_MS = 5000;
interface ManagedRun {
  owner: number;
  /** Codex reports approval requests as OSC 9 notifications in its output. */
  osc?: OscNotifications;
  /** A Claude Code or Codex terminal's screen, read as a cross-check of its own signals (1.35.3, screen-reader.ts). */
  screen?: ScreenReader;
  /** Gemini CLI reports working, waiting (with the question) and done over OSC 7501; `since` is when the run started. */
  gemini?: { reader: GeminiStatusReader; last: GeminiStatus['state'] | null; asked?: string; since: number; known: Set<string> };
  /** A custom agent's run: Needs you and Done from the signals its definition names (agents/status.ts). */
  custom?: CustomStatusReader;
  session: RunningSession;
  pty: IPty;
  nativeKey?: string;
  outputTail: string;
  pendingData: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  exit: Promise<void>;
  resolveExit: () => void;
  stopping: Promise<void> | null;
  finished: boolean;
  /** Output sent to the window and not yet acknowledged as drawn. */
  unacked: number; paused: boolean; stall?: ReturnType<typeof setTimeout>;
  /** The latest title the CLI gave its terminal (OSC 0/2): Claude Code's task summary, for phones. */
  title?: string;
  /** A chat channel: Claude's structured messages, turned into chat events for the window. */
  chat?: ChatStream;
  /** A chat run was sent a message and has not ended that turn yet (its `done` has not come). */
  turnOpen?: boolean;
  /** Its terminal is in the background runner: quitting Trace leaves it running (docs/background-runner.md). */
  held?: boolean;
}

export class PtyManager {
  private runs = new Map<string, ManagedRun>();
  private pending = new Map<string, { owner: number; cancelled: boolean; cwd: string; nativeKey?: string; profileId?: string }>();
  private closing = false;
  private spawn: Spawn;
  private discover: typeof discoverEngine;
  private environment: () => Record<string, string> | Promise<Record<string, string>>;

  constructor(
    private emit: (owner: number, event: SessionEvent) => void,
    private dependencies: { onEventError?: () => void; onContextWindow?: (runId: string, size: number) => void;stopDependencies?: StopDependencies; spawn?: Spawn; discover?: typeof discoverEngine; environment?: () => Record<string, string> | Promise<Record<string, string>>; profileEnvironment?: (base: Record<string, string>, id?: string) => Record<string, string>; onStarted?: (session: AgentRunningSession, config: AgentConfig, owner: number) => void; prepareLaunch?: (session: BuiltInRunningSession, config: CLIEngineConfig, info: EngineInfo, launch: { args: string[]; env: Record<string, string> }) => void;
      /**
       * Work an agent launch waits for before prepareLaunch (a project's shared memory brought up to date), started with
       * discovery. Its errors are ignored, and a launch waits at most `beforeLaunchMilliseconds` (default 3 s) for it.
       */
      beforeLaunch?: (cwd: string, config: AgentConfig) => Promise<unknown>; beforeLaunchMilliseconds?: number;
      /**
       * A custom agent's launch (docs/custom-agents.md), built by the host from its confirmed definition: the program,
       * arguments and environment, and the status signals to read. Throws a HubError the person can act on.
       */
      customLaunch?: (session: AgentRunningSession, config: CustomChannelConfig, env: Record<string, string>) => Promise<{ file: string; args: string[]; env: Record<string, string>; status: AgentDefinition['status'] }>;
      /** A custom agent's status signals, for a run taken up from the background runner. */
      customStatus?: (agentId: string) => AgentDefinition['status'] | null;
      /** Windows' sudo setting, for Terminal channels (tests replace it). */
      sudoMode?: () => Promise<number>;
      /** A launch that was prepared but did not start: what prepareLaunch set up for it is released. */
      abandonLaunch?: (session: AgentRunningSession) => void;
      /** Runs just seated at a Round Table without a tile of their own (partner, reviewer, planner). */
      onSeated?: (runIds: string[]) => void; onStall?: () => void; stallMilliseconds?: number; spawnChat?: Spawn; onChat?: (owner: number, envelope: ChatEnvelope) => void;
      /** A resumed chat's earlier messages, from the CLI's transcript; null when it cannot be read. */
      chatHistory?: (config: CLIEngineConfig) => Extract<ChatEvent, { type: 'history' }> | null;
      /** The Gemini CLI conversation a run in `cwd` started at `since` (ms) wrote to, when agy did not print it. */
      geminiConversation?: (cwd: string, since: number, known: ReadonlySet<string>) => string | null;
      /** The IDs of the conversations agy already had when a run started: none of them is that run's (tests replace it). */
      geminiKnown?: () => string[];
      held?: HeldTerminals;
      /** A terminal the runner kept while Trace was closed was taken up again: what prepareLaunch set up for it is restored. */
      onAdopted?: (session: RunningSession, meta: HeldMeta, owner: number) => void;
      /** A plugin tile's program (plugins.ts), looked up by the plugin and tile the channel names. */
      pluginTile?: (plugin: { id: string; tile: string }) => { file: string; args: string[]; env: Record<string, string> } } = {},
  ) {
    this.spawn = dependencies.spawn ?? ((file, args, options) => nodePty().spawn(file, args, options));
    this.discover = dependencies.discover ?? discoverEngine;
    this.environment = dependencies.environment ?? freshHostEnvironment;
  }

  /** Waits for beforeLaunch, at most its time limit; never fails the launch. */
  private beforeLaunch(cwd: string, config: AgentConfig): Promise<void> {
    const work = this.dependencies.beforeLaunch; if (!work) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.dependencies.beforeLaunchMilliseconds ?? 3000); });
    let started: Promise<unknown>; try { started = work(cwd, config); } catch { started = Promise.resolve(); }
    return Promise.race([Promise.resolve(started).then(() => {}, () => {}), limit]).finally(() => clearTimeout(timer));
  }

  /** Tells the owning window that a run is waiting for the person, after the output that led to it. */
  notifyAttention(runId: string, message: string) {
    const run = [...this.runs.values()].find((candidate) => candidate.session.runId === runId);
    if (!run || run.finished) return;
    run.screen?.asked();
    this.flush(run);
    this.send(run.owner, { type: 'attention', sessionId: run.session.sessionId, runId, message, at: new Date().toISOString() });
  }

  /** Tells the owning window the CLI carried on, so a waiting prompt clears even if no keystroke came after it. */
  notifyResolved(runId: string, finished = false) {
    const run = [...this.runs.values()].find((candidate) => candidate.session.runId === runId);
    if (!run || run.finished) return;
    this.send(run.owner, { type: 'answered', sessionId: run.session.sessionId, runId, at: new Date().toISOString(), ...(finished ? { finished: true as const } : {}) });
  }

  /**
   * Tells the owning window a terminal run now writes to another conversation, so a restart resumes it and its history
   * shows it. Chat channels learn their conversation from the CLI's own stream instead.
   */
  notifyConversation(runId: string, conversationId: string) {
    const run = [...this.runs.values()].find((candidate) => candidate.session.runId === runId);
    if (!run || run.finished || run.chat || run.session.engine !== 'claude') return;
    this.send(run.owner, { type: 'conversation', sessionId: run.session.sessionId, runId, conversationId });
  }

  /** Runs still going, for the phone remote. */
  running(): (RunningSession & { cols: number; rows: number; title?: string })[] { return [...this.runs.values()].filter((run) => !run.finished).map((run) => ({ ...run.session, cols: run.pty.cols, rows: run.pty.rows, ...(run.title ? { title: run.title } : {}) })); }

  /**
   * Input typed on a paired phone. It reaches the run by its reference rather than through the owning window, and tells
   * that window the person answered, so a waiting prompt clears on the desktop too.
   */
  writeRemote(reference: RunReference, data: string) {
    const run = this.runs.get(reference.sessionId);
    if (!run || run.finished || run.session.runId !== reference.runId) throw new HubError('STALE_SESSION', 'This process has ended or the channel reference is stale.');
    if (run.stopping) throw new HubError('SESSION_STOPPING', 'This channel is stopping.');
    if (run.chat) throw new HubError('CHAT_REMOTE', 'This is a chat channel: send messages and answers through the chat, not as typing.');
    try { run.pty.write(data); }
    catch { throw new HubError('WRITE_FAILED', 'Terminal input could not be delivered.'); }
    run.custom?.input(data);
    if (isPersonInput(data)) this.send(run.owner, { type: 'answered', sessionId: run.session.sessionId, runId: run.session.runId, at: new Date().toISOString() });
  }

  /** A paired phone drawing a channel at its own size; the desktop takes its size back (see RemoteServer phone sizes). */
  resizeRemote(reference: RunReference, cols: number, rows: number) {
    const run = this.runs.get(reference.sessionId);
    if (!run || run.finished || run.session.runId !== reference.runId) throw new HubError('STALE_SESSION', 'This process has ended or the channel reference is stale.');
    if (run.stopping) return;
    this.flush(run);
    this.resizePty(run, Math.min(500, Math.max(2, cols)), Math.min(300, Math.max(1, rows)));
  }

  /** A run whose process just ended cannot be resized; that is not an error, its exit event follows. */
  private resizePty(run: ManagedRun, cols: number, rows: number) {
    try { run.pty.resize(cols, rows); run.screen?.resize(cols, rows); run.custom?.resize(cols, rows); }
    catch { if (!ptyProcessEnded(run.pty)) throw new HubError('RESIZE_FAILED', 'The terminal could not be resized.'); }
  }

  private send(owner: number, event: SessionEvent) {
    try { this.emit(owner, event); }
    catch { try { this.dependencies.onEventError?.(); } catch { /* Reporting must not interrupt process cleanup. */ } }
  }

  /** Includes launches still starting in that folder (their folder is checked as given; it resolves the same way). */
  usesDirectory(directory: string): boolean { return [...this.runs.values()].some((run) => isWithinDirectory(directory, run.session.cwd)) || [...this.pending.values()].some((run) => isWithinDirectory(directory, run.cwd)); }

  usesProfile(id: string): boolean { return [...this.runs.values()].some((run) => run.session.accountProfileId === id) || [...this.pending.values()].some((run) => run.profileId === id); }

  get hasSessions(): boolean { return this.runs.size > 0 || this.pending.size > 0; }
  /** Runs an update would stop: all but those in the background runner, which an update leaves running. */
  get hasLocalSessions(): boolean { return [...this.runs.values()].some((run) => !run.held) || this.pending.size > 0; }
  /** Every process still running, whichever window owns it: what quitting would leave behind. */
  processIds(): number[] { return [...this.runs.values()].map((run) => run.session.pid); }
  /** Undoes dispose() when the person cancels quitting, so channels can start again. */
  reopen() { this.closing = false; }
  ownedProcessIds(owner: number): number[] { return [...this.runs.values()].filter((run) => run.owner === owner).map((run) => run.session.pid); }

  async start(owner: number, payload: unknown): Promise<RunningSession> {
    const parsed = startSessionSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_REQUEST', parsed.error.issues.map((issue) => issue.message).join(' '));
    const request = parsed.data;
    if (this.closing) throw new HubError('HOST_CLOSING', 'The application is shutting down.');
    if (this.runs.has(request.sessionId) || this.pending.has(request.sessionId)) throw new HubError('ALREADY_RUNNING', 'This channel is already starting or running.');
    if (this.runs.size + this.pending.size >= MAX_CHANNELS) throw new HubError('SESSION_LIMIT', `At most ${MAX_CHANNELS} CLI processes can run simultaneously.`);
    const profileId = request.config.engine === 'claude' ? request.config.accountProfileId : undefined;
    const resumeId = isAgentConfig(request.config) ? request.config.resumeId : undefined;
    const nativeKey = resumeId ? `${request.config.engine}:${profileId ?? 'default'}:${resumeId}` : undefined;
    if (nativeKey && ([...this.runs.values()].some((run) => run.nativeKey === nativeKey) || [...this.pending.values()].some((run) => run.nativeKey === nativeKey))) throw new HubError('RESUME_BUSY', 'This conversation is already running or starting in another tile.');
    const reservation = { owner, cancelled: false, cwd: request.cwd, profileId, nativeKey };
    let prepared: AgentRunningSession | null = null;
    this.pending.set(request.sessionId, reservation);
    try {
      // The channel's terminal kept running in the background runner while Trace was closed: it is taken up, not started.
      const kept = !isChatRun(request.config) ? await this.dependencies.held?.take(request.sessionId).catch(() => null) : null;
      if (kept) { if (reservation.cancelled || this.closing) throw new HubError('START_CANCELLED', 'Starting the channel was cancelled.'); return this.adopt(owner, kept); }
      if (!path.isAbsolute(request.cwd)) throw new HubError('INVALID_DIRECTORY', 'Choose an absolute local working folder.');
      let cwd: string;
      try {
        cwd = await realpath(request.cwd);
        if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
      } catch { throw new HubError('INVALID_DIRECTORY', 'The working folder does not exist or is not accessible.'); }
      const baseEnvironment = await this.environment();
      let file: string; let args: string[]; let env: Record<string, string>; let session: RunningSession; let level: PermissionLevel = 'ask'; let customStatus: AgentDefinition['status'] | null = null;
      // A chat run: Claude Code or Codex in structured mode, or a Round Table's Gemini seat (agy's agent protocol server).
      const chat = isChatRun(request.config);
      if (request.config.engine === 'custom') {
        // A custom agent: the host builds its launch from the confirmed definition; no discovery, flags or telemetry of a built-in CLI.
        if (!this.dependencies.customLaunch) throw new HubError('CUSTOM_AGENTS', 'Custom agents are unavailable: Traceâ€™s storage could not be opened.');
        const ready = this.beforeLaunch(cwd, request.config);
        const agent: AgentRunningSession = { sessionId: request.sessionId, runId: randomUUID(), engine: 'custom', pid: 0, cwd };
        await ready; prepared = agent;
        const launch = await this.dependencies.customLaunch(agent, request.config, baseEnvironment);
        if (reservation.cancelled || this.closing) throw new HubError('START_CANCELLED', 'Starting the channel was cancelled.');
        session = agent; customStatus = launch.status; file = launch.file; args = launch.args;
        env = { ...launch.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      } else if (request.config.engine === 'shell') {
        // A plain terminal: no agent discovery, flags, rules, usage or memory, and its output is not recorded.
        const sudo = process.platform === 'win32' && existsSync(windowsSudoPath(baseEnvironment)) ? await (this.dependencies.sudoMode ?? windowsSudoMode)() : 0;
        // A plugin tile runs its plugin's program, looked up here, never named by the window.
        const plugin = request.config.plugin;
        if (plugin && !this.dependencies.pluginTile) throw new HubError('PLUGIN_TILE', 'Plugin tiles are unavailable.');
        const program = plugin ? this.dependencies.pluginTile!(plugin) : shellProgram(baseEnvironment, process.platform, existsSync, () => sudo);
        if (reservation.cancelled || this.closing) throw new HubError('START_CANCELLED', 'Starting the channel was cancelled.');
        session = { sessionId: request.sessionId, runId: randomUUID(), engine: 'shell', pid: 0, cwd };
        ({ file, args } = program); env = { ...('env' in program ? program.env : baseEnvironment), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      } else {
        const profileEnvironment = this.dependencies.profileEnvironment;
        if (profileId && !profileEnvironment) throw new HubError('PROFILE_STORAGE', 'Claude profile storage is unavailable.');
        const discoveryEnvironment = profileEnvironment ? profileEnvironment(baseEnvironment, profileId) : baseEnvironment;
        const ready = this.beforeLaunch(cwd, request.config);
        // The sign-in probes are needed only to refuse a named profile that is not connected.
        const engine = await this.discover(request.config.engine, discoveryEnvironment, { authentication: Boolean(profileId) }); level = launchedLevel(request.config, engine.info);
        if (profileId && engine.info.available && engine.info.authentication?.state !== 'authenticated') throw new HubError('PROFILE_LOGIN_REQUIRED', engine.info.authentication?.message === AUTH_TIMED_OUT ? 'Claude Code did not report this profile’s sign-in in time, so the channel did not start. Start it again; if this keeps happening, run the Claude CLI in a terminal to check it.' : 'Connect this Claude profile in Accounts & connections before starting. If its login status is unverified, update the Claude CLI and reconnect.');
        await ready;
        // A Codex chat is the app server; its model, reasoning and resumed thread go in its protocol, not on the command line.
        const codexChat = chat && request.config.engine === 'codex'; const geminiSeat = chat && request.config.engine === 'gemini';
        const launch = codexChat ? { args: [] as string[], env: {} as Record<string, string> } : geminiSeat ? buildGeminiSeatLaunch(engine.info) : buildLaunch(request.config, engine.info);
        if (!engine.executable) throw new HubError('ENGINE_UNAVAILABLE', 'The CLI executable is unavailable.');
        if (reservation.cancelled || this.closing) throw new HubError('START_CANCELLED', 'Starting the channel was cancelled.');
        const agent: BuiltInRunningSession = { sessionId: request.sessionId, runId: randomUUID(), engine: request.config.engine, pid: 0, cwd, ...(profileId ? { accountProfileId: profileId } : {}) };
        prepared = agent; this.dependencies.prepareLaunch?.(agent, request.config, engine.info, launch); session = agent;
        const mergedEnvironment = { ...discoveryEnvironment, ...engine.executable.extraEnv, ...launch.env };
        env = { ...(profileEnvironment ? profileEnvironment(mergedEnvironment, profileId) : mergedEnvironment), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
        file = engine.executable.file; args = [...engine.executable.prefixArgs, ...(codexChat ? ['app-server'] : geminiSeat ? [] : chat ? CHAT_ARGS : []), ...launch.args];
      }
      let pty: IPty; const options: IPtyForkOptions = { name: 'xterm-256color', cwd, cols: request.cols, rows: request.rows, env };
      // A terminal run starts in the background runner when there is one; without it (it failed to start), here.
      const held = !chat && this.dependencies.held ? await this.dependencies.held.spawn(file, args, options, { session: { ...session }, ...(nativeKey ? { nativeKey } : {}), config: request.config }).catch(() => null) : null;
      if (reservation.cancelled || this.closing) { if (held) try { held.kill(); } catch { /* Gone. */ } throw new HubError('START_CANCELLED', 'Starting the channel was cancelled.'); }
      try {
        pty = held ?? (chat ? this.dependencies.spawnChat ?? spawnChatProcess : this.spawn)(file, args, options);
      } catch (error) { throw new HubError('PTY_START_FAILED', `The terminal process could not start (${String((error as Error).message ?? error).split('\n')[0].slice(0, 200)}). Run npm run rebuild:native, then verify the CLI runs in your system terminal.`); }
      session.pid = pty.pid;
      let resolveExit!: () => void;
      const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
      const run: ManagedRun = { owner, session, pty, nativeKey, outputTail: '', pendingData: '', exit, resolveExit, stopping: null, finished: false, unacked: 0, paused: false, ...(session.engine === 'codex' ? { osc: new OscNotifications() } : {}), ...(session.engine === 'gemini' && !chat ? { gemini: { reader: new GeminiStatusReader(), last: null, since: Date.now(), known: this.geminiKnown() } } : {}) };
      if (held) run.held = true;
      if (request.config.engine === 'custom') run.custom = this.customReader(run, customStatus, request.cols, request.rows);
      this.runs.set(request.sessionId, run); prepared = null;
      if (chat) this.attachChat(run, pty as ChatProcess, request.config.engine === 'codex' ? { codex: { cwd, model: request.config.model, reasoningEffort: request.config.reasoningEffort, ...(request.config.resumeId ? { resumeId: request.config.resumeId } : {}), permissions: level } } : request.config.engine === 'gemini' ? { gemini: { cwd, model: request.config.model, ...(request.config.resumeId ? { resumeId: request.config.resumeId } : {}) } } : {}, level);
      else this.watchTerminal(run);
      pty.onExit(({ exitCode, signal }) => this.finish(run, exitCode, signal));
      if (isAgentConfig(request.config)) this.dependencies.onStarted?.(session as AgentRunningSession, request.config, owner);
      this.send(owner, { type: 'started', ...session });
      if (chat && isBuiltInAgent(request.config) && request.config.resumeId) {
        let history: Extract<ChatEvent, { type: 'history' }> | null = null; try { history = this.dependencies.chatHistory?.(request.config) ?? null; } catch { /* Shown without its earlier messages. */ }
        if (history) try { this.dependencies.onChat?.(owner, { sessionId: session.sessionId, runId: session.runId, event: history }); } catch { this.dependencies.onEventError?.(); }
      }
      return session;
    } catch (error) {
      if (prepared) try { this.dependencies.abandonLaunch?.(prepared); } catch { /* Released at exit or restart. */ }
      throw error;
    } finally {
      if (this.pending.get(request.sessionId) === reservation) this.pending.delete(request.sessionId);
    }
  }

  /**
   * A terminal the background runner kept running while Trace was closed, for the channel now starting: it gets the
   * same watching as a new run, and its tile is drawn from the output the runner kept (sent as a replay, not saved again).
   */
  private adopt(owner: number, held: { pty: IPty; meta: HeldMeta; tail: string }): RunningSession {
    const session: RunningSession = { ...held.meta.session, pid: held.pty.pid };
    let resolveExit!: () => void; const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
    const run: ManagedRun = { owner, session, pty: held.pty, ...(held.meta.nativeKey ? { nativeKey: held.meta.nativeKey } : {}), outputTail: held.tail.slice(-OUTPUT_TAIL), pendingData: '', exit, resolveExit, stopping: null, finished: false, unacked: 0, paused: false, ...(session.engine === 'codex' ? { osc: new OscNotifications() } : {}), ...(session.engine === 'gemini' ? { gemini: { reader: new GeminiStatusReader(), last: null, since: Date.now(), known: this.geminiKnown() } } : {}) };
    run.held = true; this.runs.set(session.sessionId, run);
    if (held.meta.config.engine === 'custom') { let status: AgentDefinition['status'] | null = null; try { status = this.dependencies.customStatus?.(held.meta.config.agentId) ?? null; } catch { /* Read without signals. */ } run.custom = this.customReader(run, status, held.pty.cols, held.pty.rows); }
    this.watchTerminal(run); held.pty.onExit(({ exitCode, signal }) => this.finish(run, exitCode, signal));
    // The screen as it is now, read from the kept output, and its title.
    run.screen?.write(held.tail); for (const match of held.tail.matchAll(TITLE)) run.title = match[1];
    try { this.dependencies.onAdopted?.(session, held.meta, owner); } catch { this.dependencies.onEventError?.(); }
    this.send(owner, { type: 'started', ...session });
    for (let offset = 0; offset < held.tail.length; offset += 16 * 1024) this.send(owner, { type: 'data', sessionId: session.sessionId, runId: session.runId, data: held.tail.slice(offset, offset + 16 * 1024), replay: true });
    return session;
  }

  /** A terminal run's output: to the window in batches, and read for its title, approvals and status. */
  private watchTerminal(run: ManagedRun) {
    const { pty, session } = run;
    pty.onData((data) => {
      if (run.finished) return;
      run.outputTail = (run.outputTail + data).slice(-OUTPUT_TAIL);
      run.screen?.write(data);
      if (data.includes('\x1b]')) for (const match of data.matchAll(TITLE)) run.title = match[1];
      run.pendingData += data;
      if (run.pendingData.length >= 32 * 1024) this.flush(run);
      else if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flush(run), 16);
      if (run.osc) for (const message of run.osc.push(data)) { if (codexApproval(message)) this.notifyAttention(run.session.runId, message); else this.notifyResolved(run.session.runId, true); }
      if (run.gemini) for (const status of run.gemini.reader.push(data)) this.geminiStatus(run, status);
      run.custom?.push(data);
    });
    // Claude Code and Codex terminals: their screen is read too, to catch an approval their own signal missed and to
    // clear a "needs you" once they work again (rules after herdr's).
    if ((session.engine === 'claude' || session.engine === 'codex') && !process.env.CODING_HUB_NO_SCREEN_STATE) run.screen = new ScreenReader(session.engine, pty.cols, pty.rows, () => run.title ?? '', (change, message) => {
      if (run.finished) return;
      if (change === 'resolved') { this.notifyResolved(run.session.runId); return; }
      this.flush(run); this.send(run.owner, { type: 'attention', sessionId: run.session.sessionId, runId: run.session.runId, message: message ?? 'Waiting for your answer', at: new Date().toISOString() });
    });
  }

  /**
   * A chat run: Claude's messages become chat events for the owning window. An approval request also marks the channel
   * as waiting (status bar, notices, phone alerts), and its answer clears that, as for a terminal prompt.
   */
  private attachChat(run: ManagedRun, child: ChatProcess, protocol: { codex?: CodexThreadOptions; gemini?: { cwd: string; model: string; resumeId?: string } }, permissions: PermissionLevel) {
    const { sessionId, runId } = run.session;
    const write = (line: string) => { try { child.write(line); } catch { /* Exited. */ } };
    const emit = (event: import('../../../shared/chat').ChatEvent) => {
      if (run.finished && event.type !== 'permission-done') return;
      // The window size goes with the run's usage (and from there to every view), not into the conversation.
      if (event.type === 'context-window') { try { this.dependencies.onContextWindow?.(runId, event.size); } catch { this.dependencies.onEventError?.(); } return; }
      // A Round Table's reviewer asking to edit is declined at once: a line in the thread instead of an approval card.
      // At Full access its commands are allowed at once ('' : nothing to show), with no card or alert either.
      if (event.type === 'permission') { const handled = this.tables.observe({ sessionId, runId, event }) ?? this.chains.observe({ sessionId, runId, event }); if (handled !== null) { if (handled) emit({ type: 'notice', text: handled }); return; } }
      // Cut where it is made, as for a terminal's prompt: a whole shell command can be kilobytes.
      if (event.type === 'permission') this.notifyAttention(runId, cleanMessage(`Approve ${event.toolName}${event.description ? `: ${event.description}` : ''}`));
      if (event.type === 'permission-done' && !run.finished) this.send(run.owner, { type: 'answered', sessionId, runId, at: new Date().toISOString() });
      if (event.type === 'done') run.turnOpen = false;
      try { this.dependencies.onChat?.(run.owner, { sessionId, runId, event }); } catch { this.dependencies.onEventError?.(); }
      // After the window has it, so a reply that ends a round reaches the window before the next round starts.
      if (event.type !== 'permission') { try { this.tables.observe({ sessionId, runId, event }); } catch { this.dependencies.onEventError?.(); } try { this.chains.observe({ sessionId, runId, event }); } catch { this.dependencies.onEventError?.(); } }
    };
    const stream: ChatStream = protocol.codex ? new CodexStream(write, emit, protocol.codex) : protocol.gemini ? new GeminiStream(write, emit, { ...protocol.gemini, permissions }) : new ClaudeStream(write, emit, permissions);
    run.chat = stream;
    child.onData((data) => { if (!run.finished) stream.push(data); });
    // Claude's own error messages explain a failed start, as a terminal's last lines do.
    child.onStderr((data) => { run.outputTail = (run.outputTail + data).slice(-OUTPUT_TAIL); });
    stream.start();
  }

  /** The window's messages, approvals and interruptions for a chat run. */
  chat(owner: number, payload: unknown) { this.chatRequest(payload, false, (reference) => this.ownedRun(owner, reference)); }
  /**
   * The same from a paired phone or linked computer: the run is reached by its reference rather than through a window,
   * and what it causes goes to the owning window as if sent there. Whether the device may open a Round Table is the
   * remote server's check.
   */
  /** Whether a run leads an open Round Table of either kind, so a message to it goes to the table (`table-send`). */
  leadsTable(runId: string) { return this.tables.leads(runId) || this.chains.has(runId); }
  chatRemote(payload: unknown) {
    this.chatRequest(payload, true, (reference) => {
      const run = this.runs.get(reference.sessionId);
      if (!run || run.session.runId !== reference.runId) throw new HubError('STALE_SESSION', 'This process has ended or the channel reference is stale.');
      return run;
    });
  }
  private seated(runIds: string[]) { try { this.dependencies.onSeated?.(runIds); } catch { this.dependencies.onEventError?.(); } }
  /** A run sits at one table at a time: refused if any of these already sits at a table of the other kind (each kind checks its own). */
  private notSeated(runIds: string[], other: { isSeated(runId: string): boolean }) { if (runIds.some((runId) => other.isSeated(runId))) throw new HubError('TABLE_TAKEN', 'One of these chats is already at a Round Table.'); }
  /** `remote`: from a phone or linked computer, so the person's message is marked for the window to add (it did not send it). */
  private chatRequest(payload: unknown, remote: boolean, find: (reference: { sessionId: string; runId: string }) => ManagedRun) {
    const parsed = chatRequestSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_CHAT', 'Invalid chat request.');
    const run = find(parsed.data); const owner = run.owner;
    if (!run.chat || run.finished) throw new HubError('NOT_CHAT', 'This channel is not a running chat.');
    if (run.stopping) throw new HubError('SESSION_STOPPING', 'This channel is stopping.');
    const request = parsed.data;
    if (request.action === 'send') {
      if (!request.text.trim() && !request.images.length) throw new HubError('EMPTY_MESSAGE', 'Write a message or attach an image.');
      // Before the send: a stream that fails at once emits `done` during send(), which must leave the run not busy.
      run.turnOpen = true; run.chat.send(request.text, request.images);
      try { this.dependencies.onChat?.(owner, { sessionId: request.sessionId, runId: request.runId, event: { type: 'user', text: request.text, images: request.images.length, ...(remote ? { remote: true as const } : {}) } }); } catch { this.dependencies.onEventError?.(); }
    }
    else if (request.action === 'answer') { if (!run.chat.answer(request.requestId, request.allow, request.allowEdits)) throw new HubError('ANSWERED', 'That request was already answered.'); }
    else if (request.action === 'interrupt') run.chat.interrupt();
    else if (request.action === 'permissions') {
      // Only on the computer itself: a phone or linked computer must not be able to give an agent full access.
      if (remote) throw new HubError('PERMISSIONS_LOCAL', 'Change an agent’s permissions on the computer it runs on.');
      run.chat.setPermissions(request.level);
    }
    else if (request.action === 'table-open') {
      // Every seat's run belongs to the window that shows the table; the lead's own entry (if listed) is this chat.
      for (const seat of request.seats ?? [request.partner, ...(request.planner ? [request.planner] : [])]) if (find(seat).owner !== owner) throw new HubError('STALE_SESSION', 'Those chats are not in the same window.');
      const saved = { ...(request.findings ? { findings: request.findings } : {}), ...(request.waiting !== undefined ? { waiting: request.waiting } : {}), ...(request.waitingImages?.length ? { waitingImages: request.waitingImages } : {}) };
      let table: RoundTableState;
      if (request.kind === 'hierarchy') {
        // Without `seats` (before 1.26): the builder (this chat), the reviewer (partner) and the planner.
        if (!request.seats && !request.planner) throw new HubError('TABLE_PLANNER', 'A hierarchy Round Table needs its planner chat.');
        const seats = request.seats ?? legacySeats(request.partner.runId, request.planner!.runId);
        this.notSeated([request.runId, ...seats.map((seat) => seat.runId)], this.tables);
        table = this.chains.open(owner, request.runId, seats, { ...saved, ...(request.chain ? { chain: request.chain } : {}), rounds: request.rounds });
      } else {
        const seats = request.seats ?? [request.partner];
        this.notSeated([request.runId, ...seats.map((seat) => seat.runId)], this.chains);
        table = this.tables.open(owner, request.runId, seats, request.driverSeat ?? request.driver, request.rounds, { ...(request.rejoin ? { rejoin: true } : {}), ...saved });
      }
      this.seated(hiddenRuns(table));
    }
    else if (request.action === 'table-seats') {
      for (const seat of request.seats) if (find(seat).owner !== owner) throw new HubError('STALE_SESSION', 'Those chats are not in the same window.');
      const hierarchy = this.chains.has(request.runId);
      this.notSeated(request.seats.map((seat) => seat.runId).filter((runId) => runId !== request.runId), hierarchy ? this.tables : this.chains);
      this.seated(hiddenRuns(hierarchy ? this.chains.setSeats(request.runId, request.seats) : this.tables.setSeats(request.runId, request.seats, request.driverSeat)));
    }
    else if (request.action === 'table-send') {
      if (!request.text.trim() && !request.images.length) throw new HubError('EMPTY_MESSAGE', 'Write a message or attach an image.');
      if (this.chains.has(request.runId)) this.chains.send(request.runId, request.text, request.images); else this.tables.send(request.runId, request.text, request.images);
      try { this.dependencies.onChat?.(owner, { sessionId: request.sessionId, runId: request.runId, event: { type: 'user', text: request.text, images: request.images.length, ...(remote ? { remote: true as const } : {}) } }); } catch { this.dependencies.onEventError?.(); }
    }
    else if (request.action === 'table-plan') this.chains.plan(request.runId, request.approve, request.note);
    else if (request.action === 'table-continue') this.chains.continue(request.runId, request.skipChallenge === true);
    else if (request.action === 'table-next-drop') { if (!this.chains.has(request.runId)) throw new HubError('TABLE_STEP', 'Only a hierarchy Round Table keeps tasks from Tasks waiting.'); this.chains.dropNext(request.runId, request.index, request.head); }
    else if (this.chains.has(request.runId)) {
      // Only the builder edits at a hierarchy; the rest works as at any table.
      if (request.action === 'table-waiting') this.chains.waiting(request.runId, request.send);
      else if (request.action === 'table-rounds') this.chains.setRounds(request.runId, request.rounds);
      else if (request.action === 'table-stop') this.chains.stop(request.runId);
      else if (request.action === 'table-close') this.chains.close(request.runId);
      else throw new HubError('TABLE_FIXED', 'At a hierarchy Round Table only the builder edits files, and the builder is the channel that shows the table. To have another agent edit, open the table from that agent’s channel.');
    }
    else if (request.action === 'table-waiting') this.tables.waiting(request.runId, request.send);
    else if (request.action === 'table-driver') this.tables.setDriver(request.runId, request.seat ?? request.driver);
    else if (request.action === 'table-rounds') this.tables.setRounds(request.runId, request.rounds);
    else if (request.action === 'table-stop') this.tables.stop(request.runId);
    else this.tables.close(request.runId);
  }

  /** Round Tables, coordinated here so they run whichever window, phone or computer is watching. */
  private readonly tables = new RoundTables(this.tableHost());
  /** Hierarchy Round Tables (plan, build, review, fix, final review), on the same chat runs. */
  private readonly chains = new ReviewChains(this.tableHost());
  private tableHost(): TableHost { return {
    run: (runId) => { const run = this.chatRun(runId); return run ? { sessionId: run.session.sessionId, engine: run.session.engine as 'claude' | 'codex' | 'gemini', cwd: run.session.cwd, owner: run.owner, permissions: run.chat!.permissions(), busy: run.turnOpen === true } : null; },
    send: (runId, text, images) => { const run = this.chatRun(runId); if (!run?.chat) return; run.turnOpen = true; run.chat.send(text, images); },
    setReadOnly: (runId, readOnly) => this.chatRun(runId)?.chat?.setReadOnly(readOnly),
    answer: (runId, requestId, allow) => { this.chatRun(runId)?.chat?.answer(requestId, allow); },
    interrupt: (runId) => this.chatRun(runId)?.chat?.interrupt(),
    emit: (owner, envelope) => { try { this.dependencies.onChat?.(owner, envelope); } catch { this.dependencies.onEventError?.(); } },
    stateOf: (cwd) => repositoryState(cwd),
  }; }
  private chatRun(runId: string) { const run = [...this.runs.values()].find((candidate) => candidate.session.runId === runId); return run && run.chat && !run.finished ? run : null; }

  private flush(run: ManagedRun) {
    if (run.flushTimer) clearTimeout(run.flushTimer);
    run.flushTimer = undefined;
    const data = run.pendingData;
    run.pendingData = '';
    // Keep IPC payloads bounded. Xterm keeps parser state across chunk boundaries.
    for (let offset = 0; offset < data.length; offset += 16 * 1024) {
      this.send(run.owner, { type: 'data', sessionId: run.session.sessionId, runId: run.session.runId, data: data.slice(offset, offset + 16 * 1024) });
    }
    run.unacked += data.length;
    if (!run.paused && !run.finished && run.unacked > HIGH_WATER) {
      run.paused = true; try { run.pty.pause(); } catch { /* Exited. */ }
      run.stall = setTimeout(() => { run.unacked = 0; this.resume(run); this.dependencies.onStall?.(); }, this.dependencies.stallMilliseconds ?? STALL_MS);
    }
  }
  private resume(run: ManagedRun) {
    if (run.stall) clearTimeout(run.stall); run.stall = undefined;
    if (!run.paused) return; run.paused = false;
    if (!run.finished) try { run.pty.resume(); } catch { /* Exited. */ }
  }

  /** The window drew this much of a run's output; a paused CLI resumes once little enough is waiting. */
  ack(owner: number, payload: unknown) {
    const parsed = ackSessionSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_ACK', 'Invalid output acknowledgement.');
    const run = this.runs.get(parsed.data.sessionId);
    // Acknowledgements for a run that ended or was replaced are expected and ignored.
    if (!run || run.owner !== owner || run.session.runId !== parsed.data.runId) return;
    run.unacked = Math.max(0, run.unacked - parsed.data.bytes);
    if (run.paused && run.unacked < LOW_WATER) this.resume(run);
  }

  private ownedRun(owner: number, reference: { sessionId: string; runId: string }): ManagedRun {
    const run = this.runs.get(reference.sessionId);
    if (!run || run.owner !== owner || run.session.runId !== reference.runId) throw new HubError('STALE_SESSION', 'This process has ended or the channel reference is stale.');
    return run;
  }

  write(owner: number, payload: unknown) {
    const parsed = writeSessionSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_INPUT', 'Invalid terminal input.');
    const run = this.ownedRun(owner, parsed.data);
    if (run.stopping) throw new HubError('SESSION_STOPPING', 'This channel is stopping.');
    // A chat run's stdin is its JSON protocol: raw keystrokes (a Ctrl+C byte) would corrupt the next message.
    if (run.chat) throw new HubError('CHAT_INPUT', 'This is a chat channel: send messages and interruptions through the chat.');
    try { run.pty.write(parsed.data.data); }
    catch { throw new HubError('WRITE_FAILED', 'Terminal input could not be delivered.'); }
    run.custom?.input(parsed.data.data);
  }

  resize(owner: number, payload: unknown) {
    const parsed = resizeSessionSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_RESIZE', 'Invalid terminal dimensions.');
    const run = this.ownedRun(owner, parsed.data);
    if (!run.stopping) {
      // Output drawn at the old size goes out first, so every terminal following this run sees it before the resize.
      this.flush(run);
      this.resizePty(run, parsed.data.cols, parsed.data.rows);
    }
  }

  async stop(owner: number, payload: unknown) {
    const parsed = runReferenceSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_REFERENCE', 'Invalid channel reference.');
    // Repeated stops after exit are safe; an existing newer run still rejects the old reference.
    if (!this.runs.has(parsed.data.sessionId)) return;
    const run = this.ownedRun(owner, parsed.data);
    if (!run.stopping) run.stopping = this.terminate(run);
    await run.stopping;
  }

  /**
   * A Gemini CLI status: waiting for the person is a notice; working again after it, the notice is answered; idle, done
   * or failed after work, the turn ended. agy says idle when it opens too, which ends nothing.
   */
  private geminiStatus(run: ManagedRun, status: GeminiStatus) {
    const last = run.gemini!.last; const asked = run.gemini!.asked; run.gemini!.last = status.state; run.gemini!.asked = status.state === 'blocked' ? status.message : undefined;
    // agy may say blocked again while it still waits on the same question: that is one notice, not another.
    if (status.state === 'blocked') { if (last !== 'blocked' || asked !== status.message) this.notifyAttention(run.session.runId, status.message); }
    else if (status.state === 'working') { if (last === 'blocked') this.notifyResolved(run.session.runId); }
    else if (last === 'working' || last === 'blocked') this.notifyResolved(run.session.runId, true);
  }

  /** A custom run's status reader: waiting is a notice, its going away answers it, and a turn's end is `finished`. */
  private customReader(run: ManagedRun, status: AgentDefinition['status'] | null, cols: number, rows: number) {
    return new CustomStatusReader(status ?? undefined, cols, rows, (change: CustomStatusChange) => {
      if (change.kind === 'waiting') this.notifyAttention(run.session.runId, change.message);
      else this.notifyResolved(run.session.runId, change.kind === 'turn-ended');
    });
  }

  private geminiKnown() { try { return new Set((this.dependencies.geminiKnown?.() ?? geminiConversations(undefined, 500).map((conversation) => conversation.id)).map((id) => id.toLowerCase())); } catch { return new Set<string>(); } }

  private finish(run: ManagedRun, exitCode: number, signal?: number) {
    if (run.finished) return;
    run.screen?.dispose(); run.custom?.dispose();
    // Gemini CLI prints the conversation to resume as it quits; stopped by Trace it prints none, so agy's list says.
    if (run.gemini && !run.chat) {
      const printed = [...run.outputTail.matchAll(/agy --conversation=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].at(-1)?.[1];
      let conversationId = printed ?? null; if (!conversationId) try { conversationId = this.dependencies.geminiConversation?.(run.session.cwd, run.gemini.since, run.gemini.known) ?? null; } catch { /* Not resumable. */ }
      // One agy already had when this run started (the person's own, or another channel's) is not what this run wrote.
      if (!printed && conversationId && run.gemini.known.has(conversationId.toLowerCase())) conversationId = null;
      if (conversationId) this.send(run.owner, { type: 'conversation', sessionId: run.session.sessionId, runId: run.session.runId, conversationId: conversationId.toLowerCase() });
    }
    run.finished = true; if (run.stall) clearTimeout(run.stall); run.chat?.close();
    if (run.chat) { try { this.tables.ended(run.session.runId); } catch { /* The table is gone with it. */ } try { this.chains.ended(run.session.runId); } catch { /* The table is gone with it. */ } }
    this.flush(run);
    if (this.runs.get(run.session.sessionId) === run) this.runs.delete(run.session.sessionId);
    const tail = exitTail(run.outputTail);
    // On POSIX a signalled exit reports code 0 plus the signal (OOM kill, crash); that is still a failure.
    const failed = (exitCode !== 0 || Boolean(signal)) && !run.stopping;
    if (failed && exitCode === 0 && signal) exitCode = 128 + signal;
    const diagnostic = failed ? `CLI exited with code ${exitCode}.${tail ? '\n' + tail : ' No terminal error was reported. Try the CLI directly in PowerShell from this project folder.'}` : undefined;
    this.send(run.owner, { type: 'exit', ...(diagnostic ? { diagnostic } : {}), sessionId: run.session.sessionId, runId: run.session.runId, exitCode, signal });
    run.resolveExit();
  }

  private async terminate(run: ManagedRun): Promise<void> {
    try { if (await stopProcess(run.pty, run.exit, this.dependencies.stopDependencies)) this.finish(run, 130); }
    catch (error) { run.stopping = null; throw error; }
  }

  async stopOwner(owner: number) {
    for (const reservation of this.pending.values()) if (reservation.owner === owner) reservation.cancelled = true;
    const runs = [...this.runs.values()].filter((run) => run.owner === owner);
    const results = await Promise.allSettled(runs.map((run) => this.stop(owner, { sessionId: run.session.sessionId, runId: run.session.runId })));
    for (let index = 0; index < results.length; index++) {
      if (results[index].status === 'rejected') this.send(owner, { type: 'error', sessionId: runs[index].session.sessionId, runId: runs[index].session.runId, message: 'A CLI process could not be stopped. Check your system process manager.' });
    }
  }

  /**
   * Trace is quitting. Runs in the background runner are let go of, still running, unless `stopHeld` (the tray's Stop
   * all channels and quit); the next Trace takes them up again. Every other run is stopped.
   */
  async dispose(stopHeld = true) {
    this.closing = true;
    for (const reservation of this.pending.values()) reservation.cancelled = true;
    if (!stopHeld) for (const run of [...this.runs.values()]) if (run.held && !run.finished) {
      run.finished = true; if (run.stall) clearTimeout(run.stall); if (run.flushTimer) clearTimeout(run.flushTimer); run.screen?.dispose(); run.custom?.dispose();
      this.runs.delete(run.session.sessionId); run.resolveExit();
    }
    await Promise.all([...new Set([...this.runs.values()].map((run) => run.owner))].map((owner) => this.stopOwner(owner)));
  }
}
