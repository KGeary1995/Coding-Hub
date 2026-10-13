import { stopProcess, type StopDependencies } from './stop-process';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IPty, IPtyForkOptions } from 'node-pty';
import type { CLIEngine, CLIEngineConfig } from '../../../shared/types';
import type { RunningSession, SessionEvent, EngineInfo } from '../../../shared/ipc';
import { resizeSessionSchema, runReferenceSchema, startSessionSchema, writeSessionSchema } from '../../../shared/schemas';
import { buildLaunch, HubError } from './engine-adapter';
import { discoverEngine, hostEnvironment, type DiscoveredEngine } from './discovery';

type Spawn = (file: string, args: string[], options: IPtyForkOptions) => IPty;
interface ManagedRun {
  owner: number;
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
}

export class PtyManager {
  private runs = new Map<string, ManagedRun>();
  private pending = new Map<string, { owner: number; cancelled: boolean; nativeKey?: string; profileId?: string }>();
  private closing = false;
  private spawn: Spawn;
  private discover: typeof discoverEngine;
  private environment: () => Record<string, string>;

  constructor(
    private emit: (owner: number, event: SessionEvent) => void,
    private dependencies: { onEventError?: () => void; stopDependencies?: StopDependencies; spawn?: Spawn; discover?: typeof discoverEngine; environment?: typeof hostEnvironment; profileEnvironment?: (base: Record<string, string>, id?: string) => Record<string, string>; onStarted?: (session: RunningSession, config: CLIEngineConfig) => void; prepareLaunch?: (session: RunningSession, config: CLIEngineConfig, info: EngineInfo, launch: { args: string[]; env: Record<string, string> }) => void } = {},
  ) {
    this.spawn = dependencies.spawn ?? ((file, args, options) => (require('node-pty') as typeof import('node-pty')).spawn(file, args, options));
    this.discover = dependencies.discover ?? discoverEngine;
    this.environment = dependencies.environment ?? hostEnvironment;
  }

  private send(owner: number, event: SessionEvent) {
    try { this.emit(owner, event); }
    catch { try { this.dependencies.onEventError?.(); } catch { /* Reporting must not interrupt process cleanup. */ } }
  }

  usesDirectory(directory: string): boolean { return [...this.runs.values()].some((run) => path.resolve(run.session.cwd) === path.resolve(directory)) || this.pending.size > 0; }

  usesProfile(id: string): boolean { return [...this.runs.values()].some((run) => run.session.accountProfileId === id) || [...this.pending.values()].some((run) => run.profileId === id); }

  get hasSessions(): boolean { return this.runs.size > 0 || this.pending.size > 0; }
  ownedProcessIds(owner: number): number[] { return [...this.runs.values()].filter((run) => run.owner === owner).map((run) => run.session.pid); }

  async start(owner: number, payload: unknown): Promise<RunningSession> {
    const parsed = startSessionSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_REQUEST', parsed.error.issues.map((issue) => issue.message).join(' '));
    const request = parsed.data;
    if (this.closing) throw new HubError('HOST_CLOSING', 'The application is shutting down.');
    if (this.runs.has(request.sessionId) || this.pending.has(request.sessionId)) throw new HubError('ALREADY_RUNNING', 'This session is already starting or running.');
    if (this.runs.size + this.pending.size >= 4) throw new HubError('SESSION_LIMIT', 'At most four CLI processes can run simultaneously.');
    const profileId = request.config.engine === 'claude' ? request.config.accountProfileId : undefined;
    const nativeKey = request.config.resumeId ? `${request.config.engine}:${profileId ?? 'default'}:${request.config.resumeId}` : undefined;
    if (nativeKey && ([...this.runs.values()].some((run) => run.nativeKey === nativeKey) || [...this.pending.values()].some((run) => run.nativeKey === nativeKey))) throw new HubError('RESUME_BUSY', 'This conversation is already running or starting in another tile.');
    const reservation = { owner, cancelled: false, profileId, nativeKey };
    this.pending.set(request.sessionId, reservation);
    try {
      if (!path.isAbsolute(request.cwd)) throw new HubError('INVALID_DIRECTORY', 'Choose an absolute local working directory.');
      let cwd: string;
      try {
        cwd = await realpath(request.cwd);
        if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
      } catch { throw new HubError('INVALID_DIRECTORY', 'The working directory does not exist or is not accessible.'); }
      const profileEnvironment = this.dependencies.profileEnvironment;
      if (profileId && !profileEnvironment) throw new HubError('PROFILE_STORAGE', 'Claude profile storage is unavailable.');
      const baseEnvironment = this.environment();
      const discoveryEnvironment = profileEnvironment ? profileEnvironment(baseEnvironment, profileId) : baseEnvironment;
      const engine = await this.discover(request.config.engine, discoveryEnvironment);
      if (profileId && engine.info.available && engine.info.authentication?.state !== 'authenticated') throw new HubError('PROFILE_LOGIN_REQUIRED', 'Connect this Claude profile in Accounts & connections before starting. If its login status is unverified, update the Claude CLI and reconnect.');
      const launch = buildLaunch(request.config, engine.info);
      if (!engine.executable) throw new HubError('ENGINE_UNAVAILABLE', 'The CLI executable is unavailable.');
      if (reservation.cancelled || this.closing) throw new HubError('START_CANCELLED', 'The session launch was cancelled.');
      const session: RunningSession = { sessionId: request.sessionId, runId: randomUUID(), engine: request.config.engine, pid: 0, cwd, ...(profileId ? { accountProfileId: profileId } : {}) };
      this.dependencies.prepareLaunch?.(session, request.config, engine.info, launch);
      const mergedEnvironment = { ...discoveryEnvironment, ...engine.executable.extraEnv, ...launch.env };
      const env = { ...(profileEnvironment ? profileEnvironment(mergedEnvironment, profileId) : mergedEnvironment), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      let pty: IPty;
      try {
        pty = this.spawn(engine.executable.file, [...engine.executable.prefixArgs, ...launch.args], { name: 'xterm-256color', cwd, cols: request.cols, rows: request.rows, env });
      } catch { throw new HubError('PTY_START_FAILED', 'The terminal process could not start. Run npm run rebuild:native, then verify the CLI runs in your system terminal.'); }
      session.pid = pty.pid;
      let resolveExit!: () => void;
      const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
      const run: ManagedRun = { owner, session, pty, nativeKey, outputTail: '', pendingData: '', exit, resolveExit, stopping: null, finished: false };
      this.runs.set(request.sessionId, run);
      pty.onData((data) => {
        if (run.finished) return;
        run.outputTail = (run.outputTail + data).slice(-8192);
        run.pendingData += data;
        if (run.pendingData.length >= 32 * 1024) this.flush(run);
        else if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flush(run), 16);
      });
      pty.onExit(({ exitCode, signal }) => this.finish(run, exitCode, signal));
      this.dependencies.onStarted?.(session, request.config);
      this.send(owner, { type: 'started', ...session });
      return session;
    } finally {
      if (this.pending.get(request.sessionId) === reservation) this.pending.delete(request.sessionId);
    }
  }

  private flush(run: ManagedRun) {
    if (run.flushTimer) clearTimeout(run.flushTimer);
    run.flushTimer = undefined;
    const data = run.pendingData;
    run.pendingData = '';
    // Keep IPC payloads bounded. Xterm keeps parser state across chunk boundaries.
    for (let offset = 0; offset < data.length; offset += 16 * 1024) {
      this.send(run.owner, { type: 'data', sessionId: run.session.sessionId, runId: run.session.runId, data: data.slice(offset, offset + 16 * 1024) });
    }
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
    try { run.pty.write(parsed.data.data); }
    catch { throw new HubError('WRITE_FAILED', 'Terminal input could not be delivered.'); }
  }

  resize(owner: number, payload: unknown) {
    const parsed = resizeSessionSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_RESIZE', 'Invalid terminal dimensions.');
    const run = this.ownedRun(owner, parsed.data);
    if (!run.stopping) {
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
    run.finished = true;
    this.flush(run);
    if (this.runs.get(run.session.sessionId) === run) this.runs.delete(run.session.sessionId);
    const tail = stripVTControlCharacters(run.outputTail).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(-2000);
    const diagnostic = exitCode !== 0 && !run.stopping ? `CLI exited with code ${exitCode}.${tail ? '\n' + tail : ' No terminal error was reported. Try the CLI directly in PowerShell from this project directory.'}` : undefined;
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
