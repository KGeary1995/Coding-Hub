import { stopProcess, type StopDependencies } from './stop-process';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { IPty, IPtyForkOptions } from 'node-pty';
import type { CLIEngine, CLIEngineConfig, PermissionLevel } from '../../../shared/types';
import { isAgentConfig } from '../../../shared/types';
import type { AgentRunningSession, RunningSession, RunReference, SessionEvent, EngineInfo } from '../../../shared/ipc';
import { isPersonInput } from '../../../shared/terminal-input';
import { MAX_CHANNELS, ackSessionSchema, chatRequestSchema, resizeSessionSchema, runReferenceSchema, startSessionSchema, writeSessionSchema } from '../../../shared/schemas';
import { buildGeminiLaunch, buildLaunch, HubError, launchedLevel } from './engine-adapter';
import { discoverEngine, discoverGemini, hostEnvironment, type DiscoveredEngine } from './discovery';
import { OscNotifications } from './attention';
import { nodePty } from './native-pty';
import { CHAT_ARGS, ClaudeStream, type ChatStream } from '../chat/claude-stream';
import { CodexStream, type CodexThreadOptions } from '../chat/codex-stream';
import { RoundTables, type TableHost } from '../chat/round-table';
import { ReviewChains } from '../chat/review-chain';
import { spawnChatProcess, type ChatProcess } from '../chat/chat-process';
import type { ChatEnvelope, ChatEvent } from '../../../shared/chat';
import { repositoryState } from '../workbench/repository-state';

function canonical(directory: string) {
  let resolved = path.resolve(directory); try { resolved = realpathSync(resolved); } catch { /* Missing paths compare as given. */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
/** True when `candidate` is `directory` or any folder below it, after resolving links. */
export function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(canonical(directory), canonical(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/** Windows' own sudo setting: 0 or missing is off, 1 opens a new window, 2 runs without input, 3 runs inline. */
export function windowsSudoMode(): number {
  try {
    const output = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Sudo', '/v', 'Enabled'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const value = /Enabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output)?.[1]; return value ? parseInt(value, 16) : 0;
  } catch { return 0; /* No key: sudo was never turned on. */ }
}
/** Shown in a Windows terminal that could not start as administrator, unless PowerShell already is one. */
const NOT_ADMIN = "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Trace: this terminal is not running as administrator. To open terminals as administrator, turn on sudo in Windows Settings > System > Advanced and set it to Inline.' -ForegroundColor Yellow }";
/**
 * The program a Terminal channel runs: PowerShell on Windows, as administrator through Windows' sudo when it runs
 * inline (Windows asks for approval each time), otherwise the person's login shell (as Terminal.app starts it),
 * falling back to zsh on macOS and bash elsewhere.
 */
export function shellProgram(env: Record<string, string>, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync, sudoMode: () => number = windowsSudoMode): { file: string; args: string[]; name: string } {
  if (platform === 'win32') {
    const system = path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32');
    const powershell = path.win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'); const file = exists(powershell) ? powershell : 'powershell.exe';
    const sudo = path.win32.join(system, 'sudo.exe');
    if (exists(sudo) && sudoMode() === 3) return { file: sudo, args: ['--inline', file, '-NoLogo'], name: 'PowerShell (administrator)' };
    return { file, args: ['-NoLogo', '-NoExit', '-Command', NOT_ADMIN], name: 'PowerShell' };
  }
  const file = env.SHELL && path.isAbsolute(env.SHELL) && exists(env.SHELL) ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  return { file, args: ['-l'], name: path.basename(file) };
}

type Spawn = (file: string, args: string[], options: IPtyForkOptions) => IPty;

/**
 * Flow control (xterm.js's flow-control guide): output the window has not yet drawn is counted, and past HIGH_WATER
 * the CLI is paused (it simply waits to write, nothing is lost) until the window's acknowledgements bring it under
 * LOW_WATER. A window that stops acknowledging cannot freeze a channel: after STALL_MS the CLI resumes regardless.
 */
export const HIGH_WATER = 1024 * 1024; export const LOW_WATER = 256 * 1024; const STALL_MS = 5000;
interface ManagedRun {
  owner: number;
  /** Codex reports approval requests as OSC 9 notifications in its output. */
  osc?: OscNotifications;
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
}

export class PtyManager {
  private runs = new Map<string, ManagedRun>();
  private pending = new Map<string, { owner: number; cancelled: boolean; nativeKey?: string; profileId?: string }>();
  private closing = false;
  private spawn: Spawn;
  private discover: typeof discoverEngine;
  private discoverGemini: typeof discoverGemini;
  private environment: () => Record<string, string>;

  constructor(
    private emit: (owner: number, event: SessionEvent) => void,
    private dependencies: { onEventError?: () => void; onContextWindow?: (runId: string, size: number) => void;stopDependencies?: StopDependencies; spawn?: Spawn; discover?: typeof discoverEngine; discoverGemini?: typeof discoverGemini; environment?: typeof hostEnvironment; profileEnvironment?: (base: Record<string, string>, id?: string) => Record<string, string>; onStarted?: (session: AgentRunningSession, config: CLIEngineConfig, owner: number) => void; prepareLaunch?: (session: AgentRunningSession, config: CLIEngineConfig, info: EngineInfo, launch: { args: string[]; env: Record<string, string> }) => void;
      /** A launch that was prepared but did not start: what prepareLaunch set up for it is released. */
      abandonLaunch?: (session: AgentRunningSession) => void;
      /** Runs just seated at a Round Table without a tile of their own (partner, reviewer, planner). */
      onSeated?: (runIds: string[]) => void; onStall?: () => void; stallMilliseconds?: number; spawnChat?: Spawn; onChat?: (owner: number, envelope: ChatEnvelope) => void;
      /** A resumed chat's earlier messages, from the CLI's transcript; null when it cannot be read. */
      chatHistory?: (config: CLIEngineConfig) => Extract<ChatEvent, { type: 'history' }> | null } = {},
  ) {
    this.spawn = dependencies.spawn ?? ((file, args, options) => nodePty().spawn(file, args, options));
    this.discover = dependencies.discover ?? discoverEngine;
    this.discoverGemini = dependencies.discoverGemini ?? discoverGemini;
    this.environment = dependencies.environment ?? hostEnvironment;
  }

  /** Tells the owning window that a run is waiting for the person, after the output that led to it. */
  notifyAttention(runId: string, message: string) {
    const run = [...this.runs.values()].find((candidate) => candidate.session.runId === runId);
    if (!run || run.finished) return;
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
    if (!run || run.finished || run.session.runId !== reference.runId) throw new HubError('STALE_SESSION', 'This process has ended or the session reference is stale.');
    if (run.stopping) throw new HubError('SESSION_STOPPING', 'This session is stopping.');
    if (run.chat) throw new HubError('CHAT_REMOTE', 'This is a chat channel: send messages and answers through the chat, not as typing.');
    try { run.pty.write(data); }
    catch { throw new HubError('WRITE_FAILED', 'Terminal input could not be delivered.'); }
    if (isPersonInput(data)) this.send(run.owner, { type: 'answered', sessionId: run.session.sessionId, runId: run.session.runId, at: new Date().toISOString() });
  }

  /** A paired phone drawing a channel at its own size; the desktop takes its size back (see RemoteServer phone sizes). */
  resizeRemote(reference: RunReference, cols: number, rows: number) {
    const run = this.runs.get(reference.sessionId);
    if (!run || run.finished || run.session.runId !== reference.runId) throw new HubError('STALE_SESSION', 'This process has ended or the session reference is stale.');
    if (run.stopping) return;
    this.flush(run);
    try { run.pty.resize(Math.min(500, Math.max(2, cols)), Math.min(300, Math.max(1, rows))); }
    catch { throw new HubError('RESIZE_FAILED', 'The terminal could not be resized.'); }
  }

  private send(owner: number, event: SessionEvent) {
    try { this.emit(owner, event); }
    catch { try { this.dependencies.onEventError?.(); } catch { /* Reporting must not interrupt process cleanup. */ } }
  }

  usesDirectory(directory: string): boolean { return [...this.runs.values()].some((run) => isWithinDirectory(directory, run.session.cwd)) || this.pending.size > 0; }

  usesProfile(id: string): boolean { return [...this.runs.values()].some((run) => run.session.accountProfileId === id) || [...this.pending.values()].some((run) => run.profileId === id); }

  get hasSessions(): boolean { return this.runs.size > 0 || this.pending.size > 0; }
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
    if (this.runs.has(request.sessionId) || this.pending.has(request.sessionId)) throw new HubError('ALREADY_RUNNING', 'This session is already starting or running.');
    if (this.runs.size + this.pending.size >= MAX_CHANNELS) throw new HubError('SESSION_LIMIT', `At most ${MAX_CHANNELS} CLI processes can run simultaneously.`);
    const profileId = request.config.engine === 'claude' ? request.config.accountProfileId : undefined;
    const resumeId = isAgentConfig(request.config) ? request.config.resumeId : undefined;
    const nativeKey = resumeId ? `${request.config.engine}:${profileId ?? 'default'}:${resumeId}` : undefined;
    if (nativeKey && ([...this.runs.values()].some((run) => run.nativeKey === nativeKey) || [...this.pending.values()].some((run) => run.nativeKey === nativeKey))) throw new HubError('RESUME_BUSY', 'This conversation is already running or starting in another tile.');
    const reservation = { owner, cancelled: false, profileId, nativeKey };
    let prepared: AgentRunningSession | null = null;
    this.pending.set(request.sessionId, reservation);
    try {
      if (!path.isAbsolute(request.cwd)) throw new HubError('INVALID_DIRECTORY', 'Choose an absolute local working directory.');
      let cwd: string;
      try {
        cwd = await realpath(request.cwd);
        if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
      } catch { throw new HubError('INVALID_DIRECTORY', 'The working directory does not exist or is not accessible.'); }
      const baseEnvironment = this.environment();
      let file: string; let args: string[]; let env: Record<string, string>; let session: RunningSession; let level: PermissionLevel = 'ask';
      const chat = isAgentConfig(request.config) && request.config.chat === true;
      if (request.config.engine === 'shell') {
        // A plain terminal: no agent discovery, flags, rules, usage or memory, and its output is not recorded.
        const program = shellProgram(baseEnvironment);
        if (reservation.cancelled || this.closing) throw new HubError('START_CANCELLED', 'The session launch was cancelled.');
        session = { sessionId: request.sessionId, runId: randomUUID(), engine: 'shell', pid: 0, cwd };
        ({ file, args } = program); env = { ...baseEnvironment, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      } else if (request.config.engine === 'gemini') {
        // Gemini CLI (agy) in a terminal: its fixed model and permission flags only. No rules, telemetry, attention hooks,
        // memory or usage: prepareLaunch and onStarted are for Claude Code and Codex.
        const engine = await this.discoverGemini(baseEnvironment);
        const launch = buildGeminiLaunch(request.config, engine.info);
        if (!engine.executable) throw new HubError('ENGINE_UNAVAILABLE', 'The Gemini CLI executable is unavailable.');
        if (reservation.cancelled || this.closing) throw new HubError('START_CANCELLED', 'The session launch was cancelled.');
        session = { sessionId: request.sessionId, runId: randomUUID(), engine: 'gemini', pid: 0, cwd };
        file = engine.executable.file; args = [...engine.executable.prefixArgs, ...launch];
        env = { ...baseEnvironment, ...engine.executable.extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      } else {
        const profileEnvironment = this.dependencies.profileEnvironment;
        if (profileId && !profileEnvironment) throw new HubError('PROFILE_STORAGE', 'Claude profile storage is unavailable.');
        const discoveryEnvironment = profileEnvironment ? profileEnvironment(baseEnvironment, profileId) : baseEnvironment;
        const engine = await this.discover(request.config.engine, discoveryEnvironment); level = launchedLevel(request.config, engine.info);
        if (profileId && engine.info.available && engine.info.authentication?.state !== 'authenticated') throw new HubError('PROFILE_LOGIN_REQUIRED', 'Connect this Claude profile in Accounts & connections before starting. If its login status is unverified, update the Claude CLI and reconnect.');
        // A Codex chat is the app server; its model, reasoning and resumed thread go in its protocol, not on the command line.
        const codexChat = chat && request.config.engine === 'codex';
        const launch = codexChat ? { args: [] as string[], env: {} as Record<string, string> } : buildLaunch(request.config, engine.info);
        if (!engine.executable) throw new HubError('ENGINE_UNAVAILABLE', 'The CLI executable is unavailable.');
        if (reservation.cancelled || this.closing) throw new HubError('START_CANCELLED', 'The session launch was cancelled.');
        const agent: AgentRunningSession = { sessionId: request.sessionId, runId: randomUUID(), engine: request.config.engine, pid: 0, cwd, ...(profileId ? { accountProfileId: profileId } : {}) };
        prepared = agent; this.dependencies.prepareLaunch?.(agent, request.config, engine.info, launch); session = agent;
        const mergedEnvironment = { ...discoveryEnvironment, ...engine.executable.extraEnv, ...launch.env };
        env = { ...(profileEnvironment ? profileEnvironment(mergedEnvironment, profileId) : mergedEnvironment), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
        file = engine.executable.file; args = [...engine.executable.prefixArgs, ...(codexChat ? ['app-server'] : chat ? CHAT_ARGS : []), ...launch.args];
      }
      let pty: IPty;
      try {
        pty = (chat ? this.dependencies.spawnChat ?? spawnChatProcess : this.spawn)(file, args, { name: 'xterm-256color', cwd, cols: request.cols, rows: request.rows, env });
      } catch (error) { throw new HubError('PTY_START_FAILED', `The terminal process could not start (${String((error as Error).message ?? error).split('\n')[0].slice(0, 200)}). Run npm run rebuild:native, then verify the CLI runs in your system terminal.`); }
      session.pid = pty.pid;
      let resolveExit!: () => void;
      const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
      const run: ManagedRun = { owner, session, pty, nativeKey, outputTail: '', pendingData: '', exit, resolveExit, stopping: null, finished: false, unacked: 0, paused: false, ...(session.engine === 'codex' ? { osc: new OscNotifications() } : {}) };
      this.runs.set(request.sessionId, run); prepared = null;
      if (chat) this.attachChat(run, pty as ChatProcess, request.config.engine === 'codex' ? { cwd, model: request.config.model, reasoningEffort: request.config.reasoningEffort, ...(request.config.resumeId ? { resumeId: request.config.resumeId } : {}), permissions: level } : null, level);
      else pty.onData((data) => {
        if (run.finished) return;
        run.outputTail = (run.outputTail + data).slice(-8192);
        if (data.includes('\x1b]')) for (const match of data.matchAll(/\x1b\](?:0|2);([^\x07\x1b]{0,200})(?:\x07|\x1b\\)/g)) run.title = match[1];
        run.pendingData += data;
        if (run.pendingData.length >= 32 * 1024) this.flush(run);
        else if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flush(run), 16);
        if (run.osc) for (const message of run.osc.push(data)) this.notifyAttention(run.session.runId, message);
      });
      pty.onExit(({ exitCode, signal }) => this.finish(run, exitCode, signal));
      if (isAgentConfig(request.config)) this.dependencies.onStarted?.(session as AgentRunningSession, request.config, owner);
      this.send(owner, { type: 'started', ...session });
      if (chat && isAgentConfig(request.config) && request.config.resumeId) {
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
   * A chat run: Claude's messages become chat events for the owning window. An approval request also marks the channel
   * as waiting (status bar, notices, phone alerts), and its answer clears that, as for a terminal prompt.
   */
  private attachChat(run: ManagedRun, child: ChatProcess, codex: CodexThreadOptions | null, permissions: PermissionLevel) {
    const { sessionId, runId } = run.session;
    const write = (line: string) => { try { child.write(line); } catch { /* Exited. */ } };
    const emit = (event: import('../../../shared/chat').ChatEvent) => {
      if (run.finished && event.type !== 'permission-done') return;
      // The window size goes with the run's usage (and from there to every view), not into the conversation.
      if (event.type === 'context-window') { try { this.dependencies.onContextWindow?.(runId, event.size); } catch { this.dependencies.onEventError?.(); } return; }
      // A Round Table's reviewer asking to edit is declined at once: a line in the thread instead of an approval card.
      if (event.type === 'permission') { const declined = this.tables.observe({ sessionId, runId, event }) ?? this.chains.observe({ sessionId, runId, event }); if (declined) { emit({ type: 'notice', text: declined }); return; } }
      if (event.type === 'permission') this.notifyAttention(runId, `Approve ${event.toolName}${event.description ? `: ${event.description}` : ''}`);
      if (event.type === 'permission-done' && !run.finished) this.send(run.owner, { type: 'answered', sessionId, runId, at: new Date().toISOString() });
      try { this.dependencies.onChat?.(run.owner, { sessionId, runId, event }); } catch { this.dependencies.onEventError?.(); }
      // After the window has it, so a reply that ends a round reaches the window before the next round starts.
      if (event.type !== 'permission') { try { this.tables.observe({ sessionId, runId, event }); } catch { this.dependencies.onEventError?.(); } try { this.chains.observe({ sessionId, runId, event }); } catch { this.dependencies.onEventError?.(); } }
    };
    const stream: ChatStream = codex ? new CodexStream(write, emit, codex) : new ClaudeStream(write, emit, permissions);
    run.chat = stream;
    child.onData((data) => { if (!run.finished) stream.push(data); });
    // Claude's own error messages explain a failed start, as a terminal's last lines do.
    child.onStderr((data) => { run.outputTail = (run.outputTail + data).slice(-8192); });
    stream.start();
  }

  /** The window's messages, approvals and interruptions for a chat run. */
  chat(owner: number, payload: unknown) { this.chatRequest(payload, false, (reference) => this.ownedRun(owner, reference)); }
  /**
   * The same from a paired phone or linked computer: the run is reached by its reference rather than through a window,
   * and what it causes goes to the owning window as if sent there. Whether the device may open a Round Table is the
   * remote server's check.
   */
  chatRemote(payload: unknown) {
    this.chatRequest(payload, true, (reference) => {
      const run = this.runs.get(reference.sessionId);
      if (!run || run.session.runId !== reference.runId) throw new HubError('STALE_SESSION', 'This process has ended or the session reference is stale.');
      return run;
    });
  }
  private seated(runIds: string[]) { try { this.dependencies.onSeated?.(runIds); } catch { this.dependencies.onEventError?.(); } }
  /** `remote`: from a phone or linked computer, so the person's message is marked for the window to add (it did not send it). */
  private chatRequest(payload: unknown, remote: boolean, find: (reference: { sessionId: string; runId: string }) => ManagedRun) {
    const parsed = chatRequestSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_CHAT', 'Invalid chat request.');
    const run = find(parsed.data); const owner = run.owner;
    if (!run.chat || run.finished) throw new HubError('NOT_CHAT', 'This channel is not a running chat.');
    if (run.stopping) throw new HubError('SESSION_STOPPING', 'This session is stopping.');
    const request = parsed.data;
    if (request.action === 'send') {
      if (!request.text.trim() && !request.images.length) throw new HubError('EMPTY_MESSAGE', 'Write a message or attach an image.');
      run.chat.send(request.text, request.images);
      try { this.dependencies.onChat?.(owner, { sessionId: request.sessionId, runId: request.runId, event: { type: 'user', text: request.text, images: request.images.length, ...(remote ? { remote: true as const } : {}) } }); } catch { this.dependencies.onEventError?.(); }
    }
    else if (request.action === 'answer') { if (!run.chat.answer(request.requestId, request.allow, request.allowEdits)) throw new HubError('ANSWERED', 'That request was already answered.'); }
    else if (request.action === 'interrupt') run.chat.interrupt();
    else if (request.action === 'permissions') {
      // Only on the computer itself: a phone or linked computer must not be able to give an agent full access.
      if (remote) throw new HubError('PERMISSIONS_LOCAL', 'Change an agent’s permissions on the computer it runs on.');
      run.chat.setPermissions(request.level);
    }
    else if (request.action === 'table-open' && request.kind === 'hierarchy') {
      // A hierarchy seats three runs of one window: the builder (this chat), the reviewer (partner) and the planner.
      if (!request.planner) throw new HubError('TABLE_PLANNER', 'A hierarchy Round Table needs its planner chat.');
      if (find(request.partner).owner !== owner || find(request.planner).owner !== owner) throw new HubError('STALE_SESSION', 'Those chats are not in the same window.');
      this.chains.open(owner, request.runId, request.partner.runId, request.planner.runId, { ...(request.findings ? { findings: request.findings } : {}), ...(request.waiting !== undefined ? { waiting: request.waiting } : {}), ...(request.waitingImages?.length ? { waitingImages: request.waitingImages } : {}), ...(request.chain ? { chain: request.chain } : {}) });
      this.seated([request.partner.runId, request.planner.runId]);
    }
    else if (request.action === 'table-open') {
      // Both agents' runs belong to the same window, which shows the table.
      if (find(request.partner).owner !== owner) throw new HubError('STALE_SESSION', 'That partner channel is not in the same window.');
      this.tables.open(owner, request.runId, request.partner.runId, request.driver, request.rounds, { ...(request.findings ? { findings: request.findings } : {}), ...(request.waiting !== undefined ? { waiting: request.waiting } : {}), ...(request.waitingImages?.length ? { waitingImages: request.waitingImages } : {}) });
      this.seated([request.partner.runId]);
    }
    else if (request.action === 'table-send') {
      if (!request.text.trim() && !request.images.length) throw new HubError('EMPTY_MESSAGE', 'Write a message or attach an image.');
      if (this.chains.has(request.runId)) this.chains.send(request.runId, request.text, request.images); else this.tables.send(request.runId, request.text, request.images);
      try { this.dependencies.onChat?.(owner, { sessionId: request.sessionId, runId: request.runId, event: { type: 'user', text: request.text, images: request.images.length, ...(remote ? { remote: true as const } : {}) } }); } catch { this.dependencies.onEventError?.(); }
    }
    else if (request.action === 'table-plan') this.chains.plan(request.runId, request.approve, request.note);
    else if (request.action === 'table-continue') this.chains.continue(request.runId);
    else if (this.chains.has(request.runId)) {
      // A hierarchy's roles and rounds are fixed; the rest works as at any table.
      if (request.action === 'table-waiting') this.chains.waiting(request.runId, request.send);
      else if (request.action === 'table-stop') this.chains.stop(request.runId);
      else if (request.action === 'table-close') this.chains.close(request.runId);
      else throw new HubError('TABLE_FIXED', 'A hierarchy Round Table has fixed roles and rounds.');
    }
    else if (request.action === 'table-waiting') this.tables.waiting(request.runId, request.send);
    else if (request.action === 'table-driver') this.tables.setDriver(request.runId, request.driver);
    else if (request.action === 'table-rounds') this.tables.setRounds(request.runId, request.rounds);
    else if (request.action === 'table-stop') this.tables.stop(request.runId);
    else this.tables.close(request.runId);
  }

  /** Round Tables, coordinated here so they run whichever window, phone or computer is watching. */
  private readonly tables = new RoundTables(this.tableHost());
  /** Hierarchy Round Tables (plan, build, review, fix, final review), on the same chat runs. */
  private readonly chains = new ReviewChains(this.tableHost());
  private tableHost(): TableHost { return {
    run: (runId) => { const run = this.chatRun(runId); return run ? { sessionId: run.session.sessionId, engine: run.session.engine as 'claude' | 'codex', cwd: run.session.cwd, owner: run.owner } : null; },
    send: (runId, text, images) => this.chatRun(runId)?.chat?.send(text, images),
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
    if (!run || run.owner !== owner || run.session.runId !== reference.runId) throw new HubError('STALE_SESSION', 'This process has ended or the session reference is stale.');
    return run;
  }

  write(owner: number, payload: unknown) {
    const parsed = writeSessionSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_INPUT', 'Invalid terminal input.');
    const run = this.ownedRun(owner, parsed.data);
    if (run.stopping) throw new HubError('SESSION_STOPPING', 'This session is stopping.');
    // A chat run's stdin is its JSON protocol: raw keystrokes (a Ctrl+C byte) would corrupt the next message.
    if (run.chat) throw new HubError('CHAT_INPUT', 'This is a chat channel: send messages and interruptions through the chat.');
    try { run.pty.write(parsed.data.data); }
    catch { throw new HubError('WRITE_FAILED', 'Terminal input could not be delivered.'); }
  }

  resize(owner: number, payload: unknown) {
    const parsed = resizeSessionSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_RESIZE', 'Invalid terminal dimensions.');
    const run = this.ownedRun(owner, parsed.data);
    if (!run.stopping) {
      // Output drawn at the old size goes out first, so every terminal following this run sees it before the resize.
      this.flush(run);
      try { run.pty.resize(parsed.data.cols, parsed.data.rows); }
      catch { throw new HubError('RESIZE_FAILED', 'The terminal could not be resized.'); }
    }
  }

  async stop(owner: number, payload: unknown) {
    const parsed = runReferenceSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_REFERENCE', 'Invalid session reference.');
    // Repeated stops after exit are safe; an existing newer run still rejects the old reference.
    if (!this.runs.has(parsed.data.sessionId)) return;
    const run = this.ownedRun(owner, parsed.data);
    if (!run.stopping) run.stopping = this.terminate(run);
    await run.stopping;
  }

  private finish(run: ManagedRun, exitCode: number, signal?: number) {
    if (run.finished) return;
    run.finished = true; if (run.stall) clearTimeout(run.stall); run.chat?.close();
    if (run.chat) { try { this.tables.ended(run.session.runId); } catch { /* The table is gone with it. */ } try { this.chains.ended(run.session.runId); } catch { /* The table is gone with it. */ } }
    this.flush(run);
    if (this.runs.get(run.session.sessionId) === run) this.runs.delete(run.session.sessionId);
    // The Windows console repaints by moving the cursor, not with newlines; keep repainted lines apart.
    const tail = stripVTControlCharacters(run.outputTail.replace(/\x1b\[\d*(?:;\d*)?H/g, '\n')).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(-2000);
    // On POSIX a signalled exit reports code 0 plus the signal (OOM kill, crash); that is still a failure.
    const failed = (exitCode !== 0 || Boolean(signal)) && !run.stopping;
    if (failed && exitCode === 0 && signal) exitCode = 128 + signal;
    const diagnostic = failed ? `CLI exited with code ${exitCode}.${tail ? '\n' + tail : ' No terminal error was reported. Try the CLI directly in PowerShell from this project directory.'}` : undefined;
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

  async dispose() {
    this.closing = true;
    for (const reservation of this.pending.values()) reservation.cancelled = true;
    await Promise.all([...new Set([...this.runs.values()].map((run) => run.owner))].map((owner) => this.stopOwner(owner)));
  }
}
