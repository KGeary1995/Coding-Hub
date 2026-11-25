import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { SessionEvent } from '../../../shared/ipc';
import type { ChatEnvelope } from '../../../shared/chat';
import type { CLIEngine } from '../../../shared/types';
import { spawnChatProcess } from '../chat/chat-process';
import { MAX_CHANNELS } from '../../../shared/schemas';
import { exitTail, HIGH_WATER, isWithinDirectory, LOW_WATER, PtyManager, shellProgram } from './pty-manager';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveredEngine } from './discovery';
import { AUTH_TIMED_OUT } from './auth-status';
import { canSymlink } from '../hub/symlink.fixture';

class FakePty {
  pid = 99999999;
  data: (value: string) => void = () => {};
  exit: (value: { exitCode: number; signal?: number }) => void = () => {};
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn(() => { queueMicrotask(() => this.exit({ exitCode: 0 })); });
  pause = vi.fn(); resume = vi.fn();
  onData = (listener: typeof this.data) => { this.data = listener; return { dispose() {} }; };
  onExit = (listener: typeof this.exit) => { this.exit = listener; return { dispose() {} }; };
}

const engines = (engine: CLIEngine): DiscoveredEngine => ({ info: { engine, available: true, executable: '/fixture', version: '2.1.296', supportsModel: true, supportsConfig: true, supportsNoDaemon: false, error: null }, executable: { file: '/fixture', prefixArgs: [], extraEnv: {}, displayPath: '/fixture' } });
const request = (sessionId = 'session-one') => ({ sessionId, cwd: process.cwd(), config: { engine: 'codex' as const, model: '', reasoningEffort: null }, cols: 80, rows: 24 });
const managers: PtyManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.dispose())); });
function fixture(discover = async (engine: CLIEngine) => engines(engine)) {
  const processes: FakePty[] = [];
  const events: SessionEvent[] = [];
  const spawn = vi.fn(() => { const pty = new FakePty(); processes.push(pty); return pty as unknown as IPty; });
  const manager = new PtyManager((_owner, event) => events.push(event), { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn, discover, environment: () => ({ PATH: '/bin', HUB_FIXTURE: 'inherited' }) });
  managers.push(manager);
  return { manager, processes, events, spawn };
}

describe('PTY lifecycle and IPC ownership', () => {
  it('never runs one conversation in two tiles at once, also while the first is still starting', async () => {
    const { manager } = fixture(async (engine) => { const found = engines(engine); found.info.supportsResume = true; return found; }); const resumeId = '44444444-4444-4444-8444-444444444444';
    const resumed = (sessionId: string) => ({ ...request(sessionId), config: { ...request(sessionId).config, resumeId } });
    const first = manager.start(1, resumed('tile-a'));
    // Still starting: the second tile is refused at once.
    await expect(manager.start(1, resumed('tile-b'))).rejects.toMatchObject({ code: 'RESUME_BUSY' });
    const started = await first.then(() => true, () => false);
    // Running: still refused.
    if (started) await expect(manager.start(1, resumed('tile-c'))).rejects.toMatchObject({ code: 'RESUME_BUSY' });
    expect(started).toBe(true);
  });
  it('binds concurrent Claude sessions to their selected profile environments before discovery and spawning', async () => {
    const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => new FakePty() as unknown as IPty);
    const discover = vi.fn(async (engine: CLIEngine, _env?: Record<string, string>) => { const result = engines(engine); result.info.authentication = { state: 'authenticated', checkedAt: new Date().toISOString(), message: 'Profile authenticated.' }; return result; });
    const profileEnvironment = vi.fn((base: Record<string, string>, id?: string) => id ? { PATH: base.PATH, CLAUDE_CONFIG_DIR: '/profiles/' + id } : base);
    const manager = new PtyManager(() => {}, { spawn, discover, profileEnvironment, environment: () => ({ PATH: '/bin', ANTHROPIC_API_KEY: 'inherited' }), stopDependencies: { platform: 'linux', signalGroup: () => {} } });
    managers.push(manager);
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    await Promise.all(ids.map((id, index) => manager.start(7, { ...request('profile-' + index), config: { engine: 'claude', accountProfileId: id, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } })));
    expect(manager.usesProfile(ids[0])).toBe(true); expect(manager.usesProfile(ids[1])).toBe(true);
    expect(discover.mock.calls.map((call) => call[1]?.CLAUDE_CONFIG_DIR).sort()).toEqual(ids.map((id) => '/profiles/' + id).sort());
    expect(spawn.mock.calls.map((call) => (call[2] as { env: Record<string, string> }).env.CLAUDE_CONFIG_DIR).sort()).toEqual(ids.map((id) => '/profiles/' + id).sort());
    for (const call of spawn.mock.calls) expect((call[2] as { env: Record<string, string> }).env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
  it('requires a verified profile login before starting so sign-in output cannot enter coding history', async () => {
    const spawn = vi.fn();
    const manager = new PtyManager(() => {}, { spawn, discover: async (engine) => engines(engine), profileEnvironment: (base) => base });
    managers.push(manager);
    await expect(manager.start(7, { ...request(), config: { engine: 'claude', accountProfileId: '11111111-1111-4111-8111-111111111111', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } })).rejects.toMatchObject({ code: 'PROFILE_LOGIN_REQUIRED' });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('asks for the sign-in probes only for a named profile, and says so when they timed out', async () => {
    const options: unknown[] = [];
    const discover = vi.fn(async (engine: CLIEngine, _env?: Record<string, string>, option?: { authentication?: boolean }) => { options.push(option); const result = engines(engine); result.info.authentication = { state: 'unknown', checkedAt: new Date().toISOString(), message: AUTH_TIMED_OUT }; return result; });
    const manager = new PtyManager(() => {}, { spawn: () => new FakePty() as unknown as IPty, discover, profileEnvironment: (base) => base, environment: () => ({ PATH: '/bin' }), stopDependencies: { platform: 'linux', signalGroup: () => {} } }); managers.push(manager);
    await manager.start(7, request());
    await expect(manager.start(7, { ...request('profiled'), config: { engine: 'claude', accountProfileId: '11111111-1111-4111-8111-111111111111', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } })).rejects.toMatchObject({ code: 'PROFILE_LOGIN_REQUIRED', message: expect.stringContaining('in time') });
    expect(options).toEqual([{ authentication: false }, { authentication: true }]);
  });
  it('waits for beforeLaunch before preparing an agent launch, but never fails or hangs a start for it', async () => {
    const order: string[] = []; let finish!: () => void;
    const prepareLaunch = vi.fn(() => { order.push('prepare'); });
    const make = (beforeLaunch: (cwd: string) => Promise<unknown>, beforeLaunchMilliseconds?: number) => { const manager = new PtyManager(() => {}, { spawn: () => new FakePty() as unknown as IPty, discover: async (engine) => engines(engine), environment: () => ({ PATH: '/bin' }), stopDependencies: { platform: 'linux', signalGroup: () => {} }, prepareLaunch, beforeLaunch, beforeLaunchMilliseconds }); managers.push(manager); return manager; };
    const waiting = make(async (cwd) => { order.push('before ' + (cwd === fs.realpathSync(process.cwd()))); await new Promise<void>((resolve) => { finish = resolve; }); order.push('synced'); });
    const started = waiting.start(1, request('waits'));
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(order).toEqual(['before true']);
    finish(); await started; expect(order).toEqual(['before true', 'synced', 'prepare']);
    await expect(make(async () => { throw new Error('Drive offline'); }).start(1, request('fails'))).resolves.toMatchObject({ sessionId: 'fails' });
    await expect(make(() => new Promise(() => {}), 10).start(1, request('hangs'))).resolves.toMatchObject({ sessionId: 'hangs' });
  });
  it('reads Windows\' sudo setting without blocking, for Terminal channels only, and only where sudo.exe exists', async () => {
    const withSudo = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-sudo-')); const withoutSudo = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-nosudo-'));
    fs.mkdirSync(path.join(withSudo, 'System32')); fs.writeFileSync(path.join(withSudo, 'System32', 'sudo.exe'), '');
    try {
      let systemRoot = withSudo; const sudoMode = vi.fn(async () => 3); const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => new FakePty() as unknown as IPty);
      const manager = new PtyManager(() => {}, { spawn, sudoMode, discover: async (engine) => engines(engine), environment: async () => ({ PATH: '/bin', SystemRoot: systemRoot }), stopDependencies: { platform: 'linux', signalGroup: () => {} } }); managers.push(manager);
      await manager.start(1, request('agent')); expect(sudoMode).not.toHaveBeenCalled();
      await manager.start(1, { sessionId: 'shell', cwd: process.cwd(), config: { engine: 'shell' }, cols: 80, rows: 24 });
      expect(sudoMode).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 0);
      if (process.platform === 'win32') expect(spawn.mock.calls.at(-1)?.[0]).toBe(path.win32.join(withSudo, 'System32', 'sudo.exe'));
      // Windows 10 and older Windows 11 have no sudo.exe: no reg.exe run for a setting that cannot apply.
      systemRoot = withoutSudo; sudoMode.mockClear();
      await manager.start(1, { sessionId: 'shell-two', cwd: process.cwd(), config: { engine: 'shell' }, cols: 80, rows: 24 });
      expect(sudoMode).not.toHaveBeenCalled();
    } finally { fs.rmSync(withSudo, { recursive: true, force: true }); fs.rmSync(withoutSudo, { recursive: true, force: true }); }
  });
  it('rejects named profiles when host profile storage is unavailable instead of using the default account', async () => {
    const { manager, spawn } = fixture();
    await expect(manager.start(7, { ...request(), config: { engine: 'claude', accountProfileId: '11111111-1111-4111-8111-111111111111', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } })).rejects.toMatchObject({ code: 'PROFILE_STORAGE' });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('tells the owner a Claude terminal run moved to another conversation, and nothing for Codex, unknown or ended runs', async () => {
    const { manager, processes, events } = fixture();
    const claude = await manager.start(7, { ...request('claude-one'), config: { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } });
    const codex = await manager.start(7, request('codex-one')); const id = 'c4ea72c5-0000-4000-8000-000000000000';
    manager.notifyConversation(claude.runId, id); manager.notifyConversation(codex.runId, id); manager.notifyConversation('missing', id);
    expect(events.filter((event) => event.type === 'conversation')).toEqual([{ type: 'conversation', sessionId: 'claude-one', runId: claude.runId, conversationId: id }]);
    processes[0].exit({ exitCode: 0 });
    manager.notifyConversation(claude.runId, id); expect(events.filter((event) => event.type === 'conversation')).toHaveLength(1);
  });
  it('starts a cut exit diagnostic at a whole line', () => {
    // Short output is kept whole.
    expect(exitTail('SIZE:85x30\r\nError: invalid model\r\n')).toBe('SIZE:85x30\r\nError: invalid model');
    // What Codex sends as it exits, before its error: nothing of it is left in front of the error.
    expect(exitTail('\x1b[<1u\x1b[<1u\x1b[<u\x1b[>4;0m\x1b[0 qError: account/read failed (code -32603)\r\n\x1b[0 q')).toBe('Error: account/read failed (code -32603)');
    // The raw tail (8,192 characters) was cut inside "SIZE:85x30": the fragment before the first line break goes.
    const raw = '5x30\r\n' + '\x1b[0m'.repeat(2038) + 'SIZE:85x13\r\nError: invalid model\r\n';
    expect(raw).toHaveLength(8192); expect(exitTail(raw)).toBe('SIZE:85x13\r\nError: invalid model');
    // The 2,000-character cut falls inside a line: the text starts at the next one and stays within the limit.
    const long = exitTail('a line of output 123\n'.repeat(150) + 'Error: invalid model');
    expect(long.length).toBeLessThanOrEqual(2000); expect(long.startsWith('a line of output 123\n')).toBe(true); expect(long.endsWith('Error: invalid model')).toBe(true);
    // One long line without a break is kept: there is no whole line to start at.
    expect(exitTail('x'.repeat(9000))).toHaveLength(2000);
  });
  it('retains a bounded ANSI-free failure diagnostic even when the CLI clears its alternate screen', async () => {
    const { manager, processes, events } = fixture(); const run = await manager.start(7, request());
    processes[0].data('\x1b[?1049hError: invalid model\x1b[?1049l'); processes[0].exit({ exitCode: 1 });
    expect(events.find((event) => event.type === 'exit')).toMatchObject({ runId: run.runId, exitCode: 1, diagnostic: 'CLI exited with code 1.\nError: invalid model' });
  });
  it('routes input/resize and flushes the last output before exit', async () => {
    const { manager, processes, events, spawn } = fixture();
    const run = await manager.start(7, request());
    expect(spawn.mock.calls[0]).toBeDefined();
    manager.write(7, { ...runReference(run), data: 'hello\r' });
    manager.resize(7, { ...runReference(run), cols: 120, rows: 40 });
    expect(processes[0].write).toHaveBeenCalledWith('hello\r');
    expect(processes[0].resize).toHaveBeenCalledWith(120, 40);
    processes[0].data('last-output');
    await manager.stop(7, runReference(run));
    expect(events.map((event) => event.type)).toEqual(['started', 'data', 'exit']);
    expect(events[1]).toMatchObject({ data: 'last-output', runId: run.runId });
  });
  it('sends output drawn at the old size before resizing, so every follower sees it first', async () => {
    const { manager, processes, events } = fixture();
    const run = await manager.start(7, request());
    processes[0].data('drawn-at-80');
    expect(events.map((event) => event.type)).toEqual(['started']);
    manager.resize(7, { ...runReference(run), cols: 120, rows: 40 });
    expect(events.at(-1)).toMatchObject({ type: 'data', data: 'drawn-at-80' });
  });

  it('treats a resize in the moment between a CLI ending and node-pty reporting it as harmless', async () => {
    const { manager, processes } = fixture(); const run = await manager.start(7, request());
    processes[0].resize.mockImplementation(() => { throw new Error('Cannot resize a pty that has already exited'); });
    expect(() => manager.resize(7, { ...runReference(run), cols: 100, rows: 30 })).toThrow('could not be resized');
    Object.assign(processes[0], { _agent: { exitCode: 0 } });
    expect(() => manager.resize(7, { ...runReference(run), cols: 100, rows: 30 })).not.toThrow();
    expect(() => manager.resizeRemote(runReference(run), 50, 20)).not.toThrow();
  });
  it('counts a folder as in use only for launches starting in it', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager } = fixture(async (engine) => { await gate; return engines(engine); });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pending-')); const inside = path.join(root, 'project'); fs.mkdirSync(inside);
    try {
      const start = manager.start(7, { ...request(), cwd: inside });
      expect(manager.usesDirectory(root)).toBe(true); expect(manager.usesDirectory(path.join(os.tmpdir(), 'hub-elsewhere'))).toBe(false);
      release(); await start;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects input from another owner and stale references after restart', async () => {
    const { manager } = fixture();
    const first = await manager.start(7, request());
    expect(() => manager.write(8, { ...runReference(first), data: 'bad' })).toThrow('stale');
    await manager.stop(7, runReference(first));
    const second = await manager.start(7, request());
    expect(second.runId).not.toBe(first.runId);
    expect(() => manager.write(7, { ...runReference(first), data: 'bad' })).toThrow('stale');
    await expect(manager.stop(7, runReference(first))).rejects.toThrow('stale');
  });
  it('reserves pending launches and enforces the process limit under concurrency', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager } = fixture(async (engine) => { await gate; return engines(engine); });
    const starts = Array.from({ length: MAX_CHANNELS }, (_, index) => manager.start(7, request(`session-${index}`)));
    await expect(manager.start(7, request('one-more'))).rejects.toThrow(`At most ${MAX_CHANNELS}`);
    await expect(manager.start(7, request('session-0'))).rejects.toThrow('already');
    release();
    await Promise.all(starts);
  });
  it('cancels a pending launch when its renderer closes, before spawning anything', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, spawn } = fixture(async (engine) => { await gate; return engines(engine); });
    const start = manager.start(7, request());
    const rejected = expect(start).rejects.toThrow('cancelled');
    await manager.stopOwner(7);
    release();
    await rejected;
    expect(spawn).not.toHaveBeenCalled();
  });
  it('does not spawn for bad directories or invalid input payloads', async () => {
    const { manager, spawn } = fixture();
    await expect(manager.start(7, { ...request(), cwd: 'relative' })).rejects.toThrow('absolute');
    await expect(manager.start(7, { ...request(), cwd: process.cwd() + '/does-not-exist' })).rejects.toThrow('accessible');
    expect(spawn).not.toHaveBeenCalled();
    const run = await manager.start(7, request());
    expect(() => manager.write(7, { ...runReference(run), data: 'x'.repeat(65537) })).toThrow('Invalid');
  });
});
function runReference(run: { sessionId: string; runId: string }) { return { sessionId: run.sessionId, runId: run.runId }; }

it('keeps Claude lifecycle owned and resolves exit even if native event delivery throws', async () => {
 const pty=new FakePty(); const failures=vi.fn();
 const manager=new PtyManager(()=>{throw new Error('Destroyed renderer fixture');},{spawn:()=>pty as unknown as IPty,discover:async engine=>engines(engine),onEventError:failures,stopDependencies:{platform:'linux',signalGroup:()=>{}}});managers.push(manager);
 const config={engine:'claude' as const,model:'',thinking:{budget_tokens:null},tokenLimits:{maxOutputTokens:null,maxSessionTokens:null}};
 await expect(manager.start(7,{...request(),config})).resolves.toMatchObject({engine:'claude'});
 expect(()=>{pty.data('last output');pty.exit({exitCode:0});}).not.toThrow();expect(manager.hasSessions).toBe(false);expect(failures).toHaveBeenCalled();await manager.dispose();
});

describe('worktree in-use detection', () => {
  it('treats sessions in subfolders as inside the directory, and its parent or a sibling as outside', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-within-')); const tree = path.join(root, 'tree');
    try {
      fs.mkdirSync(path.join(tree, 'packages', 'web'), { recursive: true });
      expect(isWithinDirectory(tree, tree)).toBe(true); expect(isWithinDirectory(tree, path.join(tree, 'packages', 'web'))).toBe(true);
      expect(isWithinDirectory(tree, root)).toBe(false); expect(isWithinDirectory(tree, tree + '-sibling')).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  // Creating the link needs Developer Mode (or an elevated session) on Windows.
  it.skipIf(!canSymlink)('treats sessions reached through a symbolic link as inside the directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-within-')); const tree = path.join(root, 'tree');
    try {
      fs.mkdirSync(path.join(tree, 'packages'), { recursive: true }); fs.symlinkSync(tree, path.join(root, 'link'));
      expect(isWithinDirectory(tree, path.join(root, 'link', 'packages'))).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('signalled exits', () => {
  it('reports a CLI killed by a signal as a failure', async () => {
    const { manager, processes, events } = fixture(); const run = await manager.start(1, request());
    processes[0].exit({ exitCode: 0, signal: 9 });
    expect(events.find((event) => event.type === 'exit')).toMatchObject({ runId: run.runId, exitCode: 137, signal: 9 });
    expect((events.find((event) => event.type === 'exit') as { diagnostic?: string }).diagnostic).toContain('code 137');
  });
});

describe('launches that fail to start', () => {
  it('release what was prepared for them, and nothing for a run that started', async () => {
    const abandonLaunch = vi.fn(); const prepareLaunch = vi.fn();
    const spawn = vi.fn(() => { throw new Error('spawn failed'); });
    const manager = new PtyManager(() => {}, { spawn: spawn as never, discover: async (engine) => engines(engine), prepareLaunch, abandonLaunch, environment: () => ({ PATH: '/bin' }) }); managers.push(manager);
    await expect(manager.start(1, request())).rejects.toMatchObject({ code: 'PTY_START_FAILED' });
    expect(abandonLaunch).toHaveBeenCalledTimes(1); expect(abandonLaunch.mock.calls[0][0]).toBe(prepareLaunch.mock.calls[0][0]);
    const working = fixture(); const release = vi.fn(); (working.manager as unknown as { dependencies: { abandonLaunch: () => void } }).dependencies.abandonLaunch = release;
    await working.manager.start(1, request('session-two')); expect(release).not.toHaveBeenCalled();
  });
});

describe('Terminal channels', () => {
  it('run the login shell in the channel folder without agent discovery, usage, rules or memory', async () => {
    const discover = vi.fn(async (engine: CLIEngine) => engines(engine));
    const prepareLaunch = vi.fn(); const onStarted = vi.fn();
    const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => new FakePty() as unknown as IPty);
    const events: SessionEvent[] = [];
    const manager = new PtyManager((_owner, event) => events.push(event), { spawn, discover, prepareLaunch, onStarted, environment: () => ({ PATH: '/bin', SHELL: process.execPath }), stopDependencies: { platform: 'linux', signalGroup: () => {} } });
    managers.push(manager);
    const session = await manager.start(1, { sessionId: 'shell-one', cwd: process.cwd(), config: { engine: 'shell' }, cols: 80, rows: 24 });
    expect(session).toMatchObject({ engine: 'shell', cwd: fs.realpathSync(process.cwd()) });
    expect(discover).not.toHaveBeenCalled(); expect(prepareLaunch).not.toHaveBeenCalled(); expect(onStarted).not.toHaveBeenCalled();
    const [file, args, options] = spawn.mock.calls[0];
    if (process.platform !== 'win32') { expect(file).toBe(process.execPath); expect(args).toEqual(['-l']); }
    expect(options).toMatchObject({ cwd: fs.realpathSync(process.cwd()), env: { PATH: '/bin', TERM: 'xterm-256color' } });
    expect(events[0]).toMatchObject({ type: 'started', engine: 'shell' });
  });
  it('reject settings, so nothing but the shell can be launched', async () => {
    const { manager, spawn } = fixture();
    await expect(manager.start(1, { sessionId: 'shell-two', cwd: process.cwd(), config: { engine: 'shell', model: 'x' }, cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('pick PowerShell on Windows (as administrator when sudo runs inline) and the login shell elsewhere, with safe fallbacks', () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    expect(shellProgram({ SystemRoot: 'C:\\Windows' }, 'win32', () => true, () => 3)).toEqual({ file: 'C:\\Windows\\System32\\sudo.exe', args: ['--inline', powershell, '-NoLogo'], name: 'PowerShell (administrator)' });
    // Sudo off, or set to a new window or no input: a normal PowerShell that says how to turn sudo on.
    for (const mode of [0, 1, 2]) { const program = shellProgram({ SystemRoot: 'C:\\Windows' }, 'win32', () => true, () => mode); expect(program.file).toBe(powershell); expect(program.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']); expect(program.args[3]).toContain('set it to Inline'); }
    expect(shellProgram({ SystemRoot: 'C:\\Windows' }, 'win32', (file) => !file.endsWith('sudo.exe'), () => 3).file).toBe(powershell);
    expect(shellProgram({}, 'win32', () => false, () => 0).file).toBe('powershell.exe');
    expect(shellProgram({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin', () => true)).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'], name: 'fish' });
    expect(shellProgram({ SHELL: 'zsh' }, 'darwin', () => true).file).toBe('/bin/zsh');
    expect(shellProgram({ SHELL: '/missing/zsh' }, 'linux', () => false).file).toBe('/bin/bash');
  });
});

describe('Stopping that fails', () => {
  it('reports the process still running after a window or quit stop, and starts again once quitting is cancelled', async () => {
    const stubborn: FakePty[] = [];
    const spawn = vi.fn(() => { const pty = new FakePty(); pty.kill = vi.fn(); stubborn.push(pty); return pty as unknown as IPty; });
    const events: SessionEvent[] = [];
    const manager = new PtyManager((_owner, event) => events.push(event), { spawn, discover: async (engine) => engines(engine), environment: () => ({ PATH: '/bin' }), stopDependencies: { platform: 'linux', signalGroup: () => {}, isAlive: () => true, waitMilliseconds: 5 } });
    managers.push(manager);
    const session = await manager.start(7, request());
    await manager.stopOwner(7);
    expect(manager.ownedProcessIds(7)).toEqual([session.pid]);
    expect(events.at(-1)).toMatchObject({ type: 'error', sessionId: session.sessionId });
    await manager.dispose();
    expect(manager.processIds()).toEqual([session.pid]);
    await expect(manager.start(7, request('session-two'))).rejects.toMatchObject({ code: 'HOST_CLOSING' });
    manager.reopen();
    await expect(manager.start(7, request('session-two'))).resolves.toMatchObject({ sessionId: 'session-two' });
    // Let the fixture's cleanup finish: the processes "exit" once asked again.
    for (const pty of stubborn) pty.exit({ exitCode: 0 });
  });
});

describe('Output flow control', () => {
  it('pauses a CLI whose output the window has not drawn, and resumes once the window catches up', async () => {
    const { manager, processes } = fixture();
    const session = await manager.start(1, request()); const pty = processes[0];
    const ack = (bytes: number) => manager.ack(1, { sessionId: session.sessionId, runId: session.runId, bytes });
    const chunk = 'x'.repeat(64 * 1024);
    for (let sent = 0; sent <= HIGH_WATER; sent += chunk.length) pty.data(chunk);
    expect(pty.pause).toHaveBeenCalledTimes(1);
    // Still too much waiting: stays paused. Under the low-water mark: resumes.
    ack(HIGH_WATER - LOW_WATER); expect(pty.resume).not.toHaveBeenCalled();
    ack(HIGH_WATER); expect(pty.resume).toHaveBeenCalledTimes(1);
    // Acknowledgements for another run, another window or nonsense are ignored or refused.
    manager.ack(1, { sessionId: session.sessionId, runId: crypto.randomUUID(), bytes: 1 }); manager.ack(2, { sessionId: session.sessionId, runId: session.runId, bytes: 1 });
    expect(() => manager.ack(1, { sessionId: session.sessionId, runId: session.runId, bytes: -1 })).toThrow();
  });
  it('never leaves a channel frozen when the window stops acknowledging', async () => {
    const processes: FakePty[] = []; let stalls = 0;
    const manager = new PtyManager(() => {}, { spawn: () => { const pty = new FakePty(); processes.push(pty); return pty as unknown as IPty; }, discover: async (engine) => engines(engine), environment: () => ({ PATH: '/bin' }), stopDependencies: { platform: 'linux', signalGroup: () => {} }, stallMilliseconds: 20, onStall: () => { stalls++; } });
    managers.push(manager);
    await manager.start(1, request());
    processes[0].data('y'.repeat(HIGH_WATER + 1));
    expect(processes[0].pause).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(processes[0].resume).toHaveBeenCalledTimes(1); expect(stalls).toBe(1);
  });
});

describe('Chat channels', () => {
  const fixtureScript = path.join(__dirname, '../../../scripts/fixtures/claude-stream-fixture.cjs');
  const chatEngine = (): DiscoveredEngine => { const engine = engines('claude'); engine.executable = { file: process.execPath, prefixArgs: [fixtureScript], extraEnv: {}, displayPath: 'claude' }; return engine; };
  const chatRequest = (sessionId = 'chat-one') => ({ sessionId, cwd: process.cwd(), config: { engine: 'claude' as const, chat: true, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }, cols: 80, rows: 24 });
  it('shows a resumed chat its earlier messages as it starts', async () => {
    const chats: ChatEnvelope[] = []; const asked: unknown[] = [];
    const history = { type: 'history' as const, messages: [{ role: 'user' as const, text: 'earlier', images: 0 }], results: {} };
    const manager = new PtyManager(() => {}, { discover: async () => { const engine = chatEngine(); engine.info.supportsResume = true; return engine; }, environment: () => ({ ...process.env } as Record<string, string>), stopDependencies: { platform: 'linux', signalGroup: () => {} }, onChat: (_owner, envelope) => chats.push(envelope), chatHistory: (config) => { asked.push(config); return history; } });
    managers.push(manager);
    const request = chatRequest('chat-resumed'); const session = await manager.start(1, { ...request, config: { ...request.config, resumeId: '11111111-2222-4333-8444-555555555555' } });
    expect(asked).toEqual([expect.objectContaining({ resumeId: '11111111-2222-4333-8444-555555555555' })]);
    expect(chats[0]).toEqual({ sessionId: 'chat-resumed', runId: session.runId, event: history });
  });
  it('runs Claude in structured mode: messages with images, streamed replies, approvals in the window, and the waiting state', async () => {
    const chats: ChatEnvelope[] = []; const events: SessionEvent[] = []; let launched: string[] = [];
    const manager = new PtyManager((_owner, event) => events.push(event), { discover: async () => chatEngine(), environment: () => ({ ...process.env } as Record<string, string>), stopDependencies: { platform: 'linux', signalGroup: () => {} }, onChat: (_owner, envelope) => chats.push(envelope),
      prepareLaunch: (_session, _config, _info, launch) => { launch.args.push('--session-id', 'fixture'); },
      spawnChat: (file, args, options) => { launched = args; return spawnChatProcess(file, args, options); } });
    managers.push(manager);
    const session = await manager.start(1, chatRequest());
    expect(launched).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--session-id', 'fixture']));
    // Raw terminal input (a Ctrl+C byte) never reaches the chat's JSON stdin.
    expect(() => manager.write(1, { sessionId: session.sessionId, runId: session.runId, data: '\x03' })).toThrow(/chat channel/);
    const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); expect(check()).toBe(true); };
    const kinds = () => chats.map((chat) => chat.event.type);

    manager.chat(1, { action: 'send', sessionId: session.sessionId, runId: session.runId, text: 'look at this', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] });
    // A Round Table opened meanwhile sees the run as in a turn until that turn's `done` (review-chain: stale seats).
    const tableRun = () => (manager as unknown as { tableHost(): { run(runId: string): { busy?: boolean } | null } }).tableHost().run(session.runId);
    expect(tableRun()?.busy).toBe(true);
    await until(() => kinds().includes('done'));
    expect(tableRun()?.busy).toBe(false);
    // The message is recorded for the run's history as it is sent, then Claude's conversation starts.
    expect(chats[0].event).toEqual({ type: 'user', text: 'look at this', images: 1 });
    expect(chats[1].event).toEqual({ type: 'ready', conversationId: '11111111-2222-4333-8444-555555555555', model: 'fixture-model' });
    expect(chats.filter((chat) => chat.event.type === 'delta').map((chat) => (chat.event as { text: string }).text).join('')).toBe('I see 1 image. look at this');
    expect(chats.find((chat) => chat.event.type === 'assistant')?.event).toMatchObject({ messageId: 'msg-1', blocks: [{ type: 'text', text: 'I see 1 image. look at this' }] });

    chats.length = 0;
    manager.chat(1, { action: 'send', sessionId: session.sessionId, runId: session.runId, text: 'please write a file', images: [] });
    await until(() => kinds().includes('permission'));
    const permission = chats.find((chat) => chat.event.type === 'permission')!.event as { requestId: string; toolName: string; canAllowEdits: boolean };
    expect(permission).toMatchObject({ toolName: 'Write', canAllowEdits: true });
    // Thinking and the tool call arrive as separate messages with the same id.
    expect(chats.filter((chat) => chat.event.type === 'assistant').map((chat) => (chat.event as { blocks: { type: string }[] }).blocks[0].type)).toEqual(['thinking', 'tool']);
    expect(events.at(-1)).toMatchObject({ type: 'attention', message: 'Approve Write: notes.txt' });
    manager.chat(1, { action: 'answer', sessionId: session.sessionId, runId: session.runId, requestId: permission.requestId, allow: true });
    await until(() => kinds().includes('done'));
    expect(kinds()).toContain('permission-done'); expect(events.some((event) => event.type === 'answered')).toBe(true);
    expect(chats.find((chat) => chat.event.type === 'tool-result')?.event).toMatchObject({ text: 'File written.', isError: false });
    expect(() => manager.chat(1, { action: 'answer', sessionId: session.sessionId, runId: session.runId, requestId: permission.requestId, allow: true })).toThrow(/already answered/);

    chats.length = 0;
    manager.chat(1, { action: 'send', sessionId: session.sessionId, runId: session.runId, text: 'fail please', images: [] });
    await until(() => kinds().includes('done'));
    expect(chats.at(-1)?.event).toEqual({ type: 'done', isError: true, error: 'Fixture failure.' });
    // A phone cannot type raw keys into a chat; another window cannot use it; an empty message is refused.
    expect(() => manager.writeRemote({ sessionId: session.sessionId, runId: session.runId }, 'y')).toThrow(/chat channel/);
    expect(() => manager.chat(2, { action: 'interrupt', sessionId: session.sessionId, runId: session.runId })).toThrow();
    expect(() => manager.chat(1, { action: 'send', sessionId: session.sessionId, runId: session.runId, text: '  ', images: [] })).toThrow(/Write a message/);
    await manager.stop(1, { sessionId: session.sessionId, runId: session.runId });
    expect(events.at(-1)).toMatchObject({ type: 'exit' });
  });
  it('takes messages, answers and interruptions from a phone or linked computer, as if the owning window sent them', async () => {
    const chats: { owner: number; envelope: ChatEnvelope }[] = []; const events: SessionEvent[] = [];
    const manager = new PtyManager((_owner, event) => events.push(event), { discover: async () => chatEngine(), environment: () => ({ ...process.env } as Record<string, string>), stopDependencies: { platform: 'linux', signalGroup: () => {} }, onChat: (owner, envelope) => chats.push({ owner, envelope }) });
    managers.push(manager);
    const session = await manager.start(3, chatRequest('chat-remote'));
    const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); expect(check()).toBe(true); };
    const kinds = () => chats.map((chat) => chat.envelope.event.type);
    manager.chatRemote({ action: 'send', sessionId: session.sessionId, runId: session.runId, text: 'please write a file', images: [] });
    await until(() => kinds().includes('permission'));
    // What the phone caused goes to the window that owns the run.
    expect(chats[0]).toEqual({ owner: 3, envelope: { sessionId: 'chat-remote', runId: session.runId, event: { type: 'user', text: 'please write a file', images: 0, remote: true } } });
    expect(chats.every((chat) => chat.owner === 3)).toBe(true);
    const permission = chats.find((chat) => chat.envelope.event.type === 'permission')!.envelope.event as { requestId: string };
    manager.chatRemote({ action: 'answer', sessionId: session.sessionId, runId: session.runId, requestId: permission.requestId, allow: true });
    await until(() => kinds().includes('done'));
    expect(kinds()).toContain('permission-done'); expect(events.some((event) => event.type === 'answered')).toBe(true);
    expect(() => manager.chatRemote({ action: 'interrupt', sessionId: session.sessionId, runId: session.runId })).not.toThrow();
    // A stale run, a terminal-style or malformed request, and an unknown channel are refused.
    expect(() => manager.chatRemote({ action: 'interrupt', sessionId: session.sessionId, runId: '00000000-0000-4000-8000-000000000000' })).toThrow(/stale/);
    expect(() => manager.chatRemote({ action: 'interrupt', sessionId: 'nope', runId: session.runId })).toThrow(/stale/);
    expect(() => manager.chatRemote({ action: 'send', sessionId: session.sessionId, runId: session.runId, text: 'x', images: [], extra: true })).toThrow(/Invalid chat request/);
    // Permissions change only on the computer itself: a phone must not be able to give an agent full access.
    expect(() => manager.chatRemote({ action: 'permissions', sessionId: session.sessionId, runId: session.runId, level: 'full' })).toThrow(/computer it runs on/);
    expect(() => manager.chat(3, { action: 'permissions', sessionId: session.sessionId, runId: session.runId, level: 'edits' })).not.toThrow();
  });
  it('cuts a chat approval’s alert text to one short line, however long the command it asks about', async () => {
    const processes: FakePty[] = []; const events: SessionEvent[] = [];
    const manager = new PtyManager((_owner, event) => events.push(event), { discover: async (engine) => engines(engine as 'claude' | 'codex'), environment: () => ({ PATH: '/bin' }), stopDependencies: { platform: 'linux', signalGroup: () => {} },
      spawnChat: () => { const pty = Object.assign(new FakePty(), { onStderr: () => {} }); processes.push(pty); return pty as unknown as IPty; } });
    managers.push(manager);
    await manager.start(1, { sessionId: 'long-command', cwd: process.cwd(), config: { engine: 'claude' as const, chat: true, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }, cols: 80, rows: 24 });
    processes[0].data(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', description: 'echo start\n' + 'x'.repeat(5000), input: { command: 'x' } } }) + '\n');
    const attention = events.find((event) => event.type === 'attention') as { message: string } | undefined;
    expect(attention?.message.startsWith('Approve Bash: echo start x')).toBe(true); expect(attention!.message.length).toBeLessThanOrEqual(200); expect(attention!.message).not.toContain('\n');
  });
  it('leaves a chat run not busy when its message fails at once (a Codex thread that never started)', async () => {
    const processes: FakePty[] = [];
    const manager = new PtyManager(() => {}, { discover: async (engine) => engines(engine as 'claude' | 'codex'), environment: () => ({ PATH: '/bin' }), stopDependencies: { platform: 'linux', signalGroup: () => {} },
      spawnChat: () => { const pty = Object.assign(new FakePty(), { onStderr: () => {} }); processes.push(pty); return pty as unknown as IPty; } });
    managers.push(manager);
    const codex = await manager.start(1, { sessionId: 'failing', cwd: process.cwd(), config: { engine: 'codex' as const, chat: true, model: '', reasoningEffort: null }, cols: 80, rows: 24 });
    const written = () => processes[0].write.mock.calls.map(([line]) => JSON.parse(String(line)) as { id?: number; method?: string });
    const answer = (method: string, reply: Record<string, unknown>) => { const request = written().find((line) => line.method === method)!; processes[0].data(JSON.stringify({ id: request.id, ...reply }) + '\n'); };
    answer('initialize', { result: {} }); answer('thread/start', { error: { message: 'not signed in' } });
    const tableRun = () => (manager as unknown as { tableHost(): { run(runId: string): { busy?: boolean } | null } }).tableHost().run(codex.runId);
    // The stream answers `done` (an error) inside send(); the run must not be left in a turn.
    manager.chat(1, { action: 'send', sessionId: codex.sessionId, runId: codex.runId, text: 'hello', images: [] });
    expect(tableRun()?.busy).toBe(false);
    (manager as unknown as { tableHost(): { send(runId: string, text: string, images: never[]): void } }).tableHost().send(codex.runId, 'again', []);
    expect(tableRun()?.busy).toBe(false);
  });
  it('runs a Round Table from a phone or linked computer: open, send, driver, rounds, stop and close', async () => {
    const processes: (FakePty & { onStderr: () => void })[] = []; const chats: { owner: number; envelope: ChatEnvelope }[] = []; const seated: string[][] = [];
    const manager = new PtyManager(() => {}, { discover: async (engine) => engines(engine as 'claude' | 'codex'), environment: () => ({ PATH: '/bin' }), stopDependencies: { platform: 'linux', signalGroup: () => {} }, onChat: (owner, envelope) => chats.push({ owner, envelope }), onSeated: (runIds) => seated.push(runIds),
      spawnChat: () => { const pty = Object.assign(new FakePty(), { onStderr: () => {} }); processes.push(pty); return pty as unknown as IPty; } });
    managers.push(manager);
    const claude = await manager.start(1, chatRequest('lead'));
    const codex = await manager.start(1, { sessionId: 'partner', cwd: process.cwd(), config: { engine: 'codex' as const, chat: true, model: '', reasoningEffort: null }, cols: 80, rows: 24 });
    const other = await manager.start(2, { sessionId: 'elsewhere', cwd: process.cwd(), config: { engine: 'codex' as const, chat: true, model: '', reasoningEffort: null }, cols: 80, rows: 24 });
    const lead = { sessionId: claude.sessionId, runId: claude.runId };
    const table = () => chats.filter((chat) => chat.envelope.event.type === 'table').at(-1)!;
    // A partner in another window cannot be seated from outside either.
    expect(() => manager.chatRemote({ action: 'table-open', ...lead, partner: { sessionId: other.sessionId, runId: other.runId }, driver: 'claude', rounds: 1 })).toThrow(/same window/);
    manager.chatRemote({ action: 'table-open', ...lead, partner: { sessionId: codex.sessionId, runId: codex.runId }, driver: 'claude', rounds: 1 });
    // The hidden partner is reported as seated (it writes no session summary of its own); the refused one was not.
    expect(seated).toEqual([[codex.runId]]);
    expect(table()).toMatchObject({ owner: 1, envelope: { sessionId: 'lead', event: { table: { driver: 'claude', rounds: 1, partner: { sessionId: 'partner' } } } } });
    const written = processes[0].write.mock.calls.length;
    manager.chatRemote({ action: 'table-send', ...lead, text: 'How should phones start channels?', images: [] });
    expect(processes[0].write.mock.calls.length).toBeGreaterThan(written); expect(String(processes[0].write.mock.calls.at(-1)![0])).toContain('How should phones start channels?');
    expect(chats.some((chat) => chat.envelope.event.type === 'user' && chat.owner === 1)).toBe(true);
    manager.chatRemote({ action: 'table-driver', ...lead, driver: 'codex' }); expect(table().envelope.event).toMatchObject({ table: { driver: 'codex' } });
    manager.chatRemote({ action: 'table-rounds', ...lead, rounds: 3 }); expect(table().envelope.event).toMatchObject({ table: { rounds: 3 } });
    manager.chatRemote({ action: 'table-stop', ...lead }); expect(table().envelope.event).toMatchObject({ table: { round: 3 } });
    // Closed by the person (here from a phone), so the window also stops the hidden partner.
    manager.chatRemote({ action: 'table-close', ...lead }); expect(table().envelope.event).toEqual({ type: 'table', table: null, closed: true });
  });
  it('runs a read-only seat’s command at Full access without an approval card or alert, and asks at other levels', async () => {
    const processes: (FakePty & { onStderr: () => void })[] = []; const chats: ChatEnvelope[] = []; const events: SessionEvent[] = [];
    const permitting = (engine: CLIEngine) => { const found = engines(engine); found.info.supportsPermissions = true; return found; };
    const manager = new PtyManager((_owner, event) => events.push(event), { discover: async (engine) => permitting(engine as 'claude' | 'codex'), environment: () => ({ PATH: '/bin' }), stopDependencies: { platform: 'linux', signalGroup: () => {} }, onChat: (_owner, envelope) => chats.push(envelope),
      spawnChat: () => { const pty = Object.assign(new FakePty(), { onStderr: () => {} }); processes.push(pty); return pty as unknown as IPty; } });
    managers.push(manager);
    const claude = (sessionId: string) => ({ sessionId, cwd: process.cwd(), config: { engine: 'claude' as const, chat: true, model: '', permissions: 'full' as const, thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }, cols: 80, rows: 24 });
    const builder = await manager.start(1, claude('builder'));
    const reviewer = await manager.start(1, { sessionId: 'reviewer', cwd: process.cwd(), config: { engine: 'codex' as const, chat: true, model: '', reasoningEffort: null, permissions: 'full' as const }, cols: 80, rows: 24 });
    const planner = await manager.start(1, claude('planner'));
    manager.chat(1, { action: 'table-open', kind: 'hierarchy', sessionId: builder.sessionId, runId: builder.runId, partner: { sessionId: reviewer.sessionId, runId: reviewer.runId }, planner: { sessionId: planner.sessionId, runId: planner.runId }, driver: 'claude', rounds: 2 });
    const plannerPty = processes[2];
    const ask = (id: string, tool: string) => plannerPty.data(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, display_name: tool, input: { command: 'git status' }, description: 'git status', permission_suggestions: [] } }) + '\n');
    const written = () => plannerPty.write.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('control_response')).map((line) => JSON.parse(line).response as { request_id: string; response: { behavior: string } });
    ask('cmd-1', 'Bash');
    expect(written()).toEqual([expect.objectContaining({ request_id: 'cmd-1', response: expect.objectContaining({ behavior: 'allow' }) })]);
    expect(chats.some((chat) => chat.event.type === 'permission' || chat.event.type === 'notice')).toBe(false); expect(events.some((event) => event.type === 'attention')).toBe(false);
    ask('edit-1', 'Write');
    expect(written().at(-1)).toMatchObject({ request_id: 'edit-1', response: { behavior: 'deny' } }); expect(chats.some((chat) => chat.event.type === 'notice')).toBe(true);
    // At Ask, the person decides: an approval card and an alert.
    manager.chat(1, { action: 'permissions', sessionId: planner.sessionId, runId: planner.runId, level: 'ask' });
    ask('cmd-2', 'Bash');
    expect(written().map((item) => item.request_id)).not.toContain('cmd-2');
    expect(chats.some((chat) => chat.event.type === 'permission' && chat.event.requestId === 'cmd-2')).toBe(true); expect(events.some((event) => event.type === 'attention')).toBe(true);
  });
});


describe('OSC 7501 from agents other than Gemini (1.43.0)', () => {
  const ESC = String.fromCharCode(27); const BEL = String.fromCharCode(7);
  const status = (body: string) => `${ESC}]7501;${body}${BEL}`; const notify = (text: string) => `${ESC}]9;${text}${BEL}`;
  function codexFixture() {
    const processes: FakePty[] = []; const events: SessionEvent[] = [];
    const spawn = vi.fn(() => { const pty = new FakePty(); processes.push(pty); return pty as unknown as IPty; });
    const manager = new PtyManager((_owner, event) => events.push(event), { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn, discover: async (engine) => engines(engine), environment: () => ({ PATH: '/bin' }) });
    managers.push(manager);
    return { processes, events, start: () => manager.start(1, { sessionId: 'cdx', cwd: process.cwd(), config: { engine: 'codex' as const, model: '', reasoningEffort: null }, cols: 80, rows: 24 }) };
  }
  const told = (events: SessionEvent[]) => events.filter((event) => ['attention', 'answered'].includes(event.type)).map((event) => event.type === 'attention' ? ['attention', event.message] : ['answered', 'finished' in event ? event.finished : false]);
  it('reads a question, its answer and the turn’s end from any CLI that sends it', async () => {
    const { processes, events, start } = codexFixture(); await start(); const pty = processes[0];
    pty.data(status('state=working')); pty.data(status(`state=blocked:kind=permission:msg=${Buffer.from('Approve Bash: npm test').toString('base64')}`));
    pty.data(status('state=working')); pty.data(status('state=done'));
    expect(told(events)).toEqual([['attention', 'Approve Bash: npm test'], ['answered', false], ['answered', true]]);
  });
  it('tells a turn’s end once when the CLI’s own notification and OSC 7501 both say so', async () => {
    const { processes, events, start } = codexFixture(); await start(); const pty = processes[0];
    pty.data(status('state=working')); pty.data(notify('agent-turn-complete: done')); pty.data(status('state=idle'));
    expect(told(events)).toEqual([['answered', true]]);
  });
});

describe('Gemini CLI terminal runs', () => {
  const ESC = String.fromCharCode(27); const BEL = String.fromCharCode(7);
  const status = (body: string) => `${ESC}]7501;${body}${BEL}`;
  const id = 'caf3f572-52a4-467c-8bc0-c7621834d34a';
  function geminiFixture(lookup: (cwd: string, since: number) => string | null = () => null, known: string[] = []) {
    const processes: FakePty[] = []; const events: SessionEvent[] = []; const looked: [string, number][] = [];
    const spawn = vi.fn(() => { const pty = new FakePty(); processes.push(pty); return pty as unknown as IPty; });
    const manager = new PtyManager((_owner, event) => events.push(event), { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn, discover: async (engine) => engines(engine), environment: () => ({ PATH: '/bin' }), geminiConversation: (cwd, since) => { looked.push([cwd, since]); return lookup(cwd, since); }, geminiKnown: () => known });
    managers.push(manager);
    return { manager, processes, events, looked, spawn, start: () => manager.start(1, { sessionId: 'gem', cwd: process.cwd(), config: { engine: 'gemini', model: '' }, cols: 80, rows: 24 }) };
  }
  it('says when it waits for the person (with agy’s question), when that was answered, and when the turn ended', async () => {
    const { processes, events, start } = geminiFixture(); await start(); const pty = processes[0];
    // agy says idle as it opens: that ends nothing.
    pty.data(status('state=idle:app=antigravity'));
    pty.data(status('state=working:app=antigravity'));
    pty.data(status(`state=blocked:kind=permission:app=antigravity:msg=${Buffer.from('Approve Bash: npm test').toString('base64')}`));
    pty.data(status('state=working:app=antigravity')); pty.data(status('state=idle:app=antigravity'));
    expect(events.filter((event) => ['attention', 'answered'].includes(event.type)).map((event) => event.type === 'attention' ? ['attention', event.message] : ['answered', 'finished' in event ? event.finished : false]))
      .toEqual([['attention', 'Approve Bash: npm test'], ['answered', false], ['answered', true]]);
  });
  it('gives one notice for a question agy repeats while it waits, and a new one for another question', async () => {
    const { processes, events, start } = geminiFixture(); await start(); const pty = processes[0];
    const blocked = (text: string) => status(`state=blocked:kind=permission:msg=${Buffer.from(text).toString('base64')}`);
    pty.data(status('state=working')); pty.data(blocked('Approve Bash: npm test')); pty.data(blocked('Approve Bash: npm test')); pty.data(blocked('Approve Bash: rm a.txt'));
    expect(events.filter((event) => event.type === 'attention').map((event) => (event as { message: string }).message)).toEqual(['Approve Bash: npm test', 'Approve Bash: rm a.txt']);
  });
  it('takes the conversation agy prints as it quits, before the exit, without looking it up', async () => {
    const { processes, events, looked, start } = geminiFixture(); await start();
    processes[0].data(`Resume with -c (or command below):\r\nagy --conversation=${id.toUpperCase()}\r\n`); processes[0].exit({ exitCode: 0 });
    const types = events.map((event) => event.type);
    expect(events.find((event) => event.type === 'conversation')).toMatchObject({ sessionId: 'gem', conversationId: id });
    expect(types.indexOf('conversation')).toBeLessThan(types.indexOf('exit')); expect(looked).toEqual([]);
  });
  it('looks the conversation up when agy printed none (stopped by Trace), and sends none when it is not found', async () => {
    const found = geminiFixture(() => id); await found.start(); found.processes[0].exit({ exitCode: 130 });
    expect(found.events.find((event) => event.type === 'conversation')).toMatchObject({ conversationId: id }); expect(found.looked[0][0]).toBe(process.cwd());
    const none = geminiFixture(() => null); await none.start(); none.processes[0].exit({ exitCode: 0 });
    expect(none.events.some((event) => event.type === 'conversation')).toBe(false);
  });
  it('does not take a conversation agy already had when the run started, which another agy changed meanwhile', async () => {
    const mine = geminiFixture(() => id, [id.toUpperCase()]); await mine.start(); mine.processes[0].exit({ exitCode: 130 });
    expect(mine.looked).toHaveLength(1); expect(mine.events.some((event) => event.type === 'conversation')).toBe(false);
  });
  it('starts agy with its status reports on', async () => {
    const { spawn, start } = geminiFixture(); await start();
    expect((spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ env: expect.objectContaining({ AGY_CLI_OSC7501: 'on' }) });
  });
});

describe('the background runner', () => {
  function heldFixture(kept: { sessionId: string; tail: string } | null = null) {
    const processes: FakePty[] = []; const events: SessionEvent[] = []; const metas: unknown[] = []; const adopted: unknown[] = [];
    const local = vi.fn(() => new FakePty() as unknown as IPty);
    const held = {
      spawn: vi.fn(async (_file: string, _args: string[], _options: unknown, meta: unknown) => { metas.push(meta); const pty = new FakePty(); processes.push(pty); return pty as unknown as IPty; }),
      take: vi.fn(async (sessionId: string) => {
        if (!kept || kept.sessionId !== sessionId) return null;
        const pty = new FakePty(); pty.pid = 4321; processes.push(pty); const found = kept; kept = null;
        return { pty: pty as unknown as IPty, tail: found.tail, meta: { session: { sessionId, runId: '55555555-5555-4555-8555-555555555555', engine: 'shell' as const, pid: 0, cwd: process.cwd() }, config: { engine: 'shell' as const } } };
      }),
    };
    const manager = new PtyManager((_owner, event) => events.push(event), { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn: local, discover: async (engine) => engines(engine), environment: () => ({ PATH: '/bin' }), held, onAdopted: (session, meta) => adopted.push({ session, meta }) });
    managers.push(manager);
    return { manager, processes, events, metas, adopted, local, held };
  }

  it('starts a terminal run there, with the channel it belongs to', async () => {
    const { manager, metas, local, events, processes } = heldFixture();
    const session = await manager.start(1, request('tile-a'));
    expect(local).not.toHaveBeenCalled();
    expect(metas[0]).toMatchObject({ session: { sessionId: 'tile-a', runId: session.runId, engine: 'codex' }, config: { engine: 'codex' } });
    processes[0].data('hello'); await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.filter((event) => event.type === 'data').map((event) => (event as { data: string }).data).join('')).toBe('hello');
  });

  it('takes up the terminal a channel left running when Trace closed, and draws what it wrote meanwhile', async () => {
    const { manager, events, adopted, local, held, processes } = heldFixture({ sessionId: 'tile-a', tail: 'before\r\nwhile closed\r\n' });
    const session = await manager.start(1, { ...request('tile-a'), config: { engine: 'shell' as const } });
    expect(session).toMatchObject({ sessionId: 'tile-a', runId: '55555555-5555-4555-8555-555555555555', pid: 4321 });
    expect(local).not.toHaveBeenCalled(); expect(held.spawn).not.toHaveBeenCalled(); expect(adopted).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'started', runId: '55555555-5555-4555-8555-555555555555' });
    expect(events.slice(1)).toEqual([{ type: 'data', sessionId: 'tile-a', runId: '55555555-5555-4555-8555-555555555555', data: 'before\r\nwhile closed\r\n', replay: true }]);
    // It is a run like any other from here: typing reaches it, and its exit ends the channel.
    manager.write(1, { sessionId: 'tile-a', runId: '55555555-5555-4555-8555-555555555555', data: 'ls\r' }); expect(processes[0].write).toHaveBeenCalledWith('ls\r');
    processes[0].exit({ exitCode: 0 }); expect(events.at(-1)).toMatchObject({ type: 'exit', runId: '55555555-5555-4555-8555-555555555555', exitCode: 0 });
  });

  it('starts a terminal here when the runner cannot', async () => {
    const { manager, local, held } = heldFixture(); held.spawn.mockRejectedValueOnce(new Error('The background runner is not connected.'));
    await manager.start(1, request('tile-a')); expect(local).toHaveBeenCalledTimes(1);
  });
});

describe('quitting with the background runner', () => {
  it('lets go of runs the runner holds, still running', async () => {
    const events: SessionEvent[] = []; const heldPty = new FakePty();
    const manager = new PtyManager((_owner, event) => events.push(event), { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn: () => new FakePty() as unknown as IPty, discover: async (engine) => engines(engine), environment: () => ({ PATH: '/bin' }), held: { spawn: async () => heldPty as unknown as IPty, take: async () => null } });
    managers.push(manager);
    await manager.start(1, request('tile-held'));
    await manager.dispose(false);
    expect(heldPty.kill).not.toHaveBeenCalled(); expect(manager.processIds()).toEqual([]); expect(manager.hasSessions).toBe(false);
    expect(events.some((event) => event.type === 'exit')).toBe(false);
  });
});

describe('updates with the background runner', () => {
  it('counts only runs an update would stop', async () => {
    const manager = new PtyManager(() => {}, { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn: () => new FakePty() as unknown as IPty, discover: async (engine) => engines(engine), environment: () => ({ PATH: '/bin' }), held: { spawn: async () => new FakePty() as unknown as IPty, take: async () => null } });
    managers.push(manager);
    await manager.start(1, request('tile-held'));
    expect(manager.hasSessions).toBe(true); expect(manager.hasLocalSessions).toBe(false);
  });
});

describe('plugin tiles', () => {
  it('run the program Trace finds for the plugin and tile the channel names', async () => {
    const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => new FakePty() as unknown as IPty);
    const pluginTile = vi.fn(() => ({ file: '/node', args: ['/plugins/sample/sample.js', 'tile'], env: { PATH: '/bin', TRACE_PLUGIN_ID: 'fixture.sample' } }));
    const manager = new PtyManager(() => {}, { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn, discover: async (engine) => engines(engine), environment: () => ({ PATH: '/bin' }), pluginTile });
    managers.push(manager);
    await manager.start(1, { ...request('tile-board'), config: { engine: 'shell' as const, plugin: { id: 'fixture.sample', tile: 'board' } } });
    expect(pluginTile).toHaveBeenCalledWith({ id: 'fixture.sample', tile: 'board' });
    expect(spawn.mock.calls[0][0]).toBe('/node'); expect(spawn.mock.calls[0][1]).toEqual(['/plugins/sample/sample.js', 'tile']);
    expect((spawn.mock.calls[0][2] as { env: Record<string, string> }).env.TRACE_PLUGIN_ID).toBe('fixture.sample');
    await expect(manager.start(1, { ...request('tile-bad'), config: { engine: 'shell' as const, plugin: { id: '../x', tile: 'board' } } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('custom agent runs (docs/custom-agents.md)', () => {
  it('starts the program the host built, reads its screen for Needs you and Done, and refuses without the custom launch', async () => {
    const processes: FakePty[] = []; const events: SessionEvent[] = []; const started: string[] = [];
    const spawn = vi.fn(() => { const pty = new FakePty(); processes.push(pty); return pty as unknown as IPty; });
    const discover = vi.fn(async (engine: CLIEngine) => engines(engine));
    const customLaunch = vi.fn(async () => ({ file: '/bin/agent', args: ['--yes'], env: { PATH: '/bin', AGENT: '1' }, status: { waiting: ['Allow\?'], turnEnd: ['^> $'] }, name: 'Aider' }));
    const manager = new PtyManager((_owner, event) => events.push(event), { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn, discover, customLaunch, onStarted: (session) => started.push(session.engine), environment: () => ({ PATH: '/bin' }) }); managers.push(manager);
    const config = { engine: 'custom' as const, agentId: 'aider', model: '' };
    const session = await manager.start(1, { sessionId: 'c1', cwd: process.cwd(), config, cols: 80, rows: 24 });
    expect(session.engine).toBe('custom'); expect(discover).not.toHaveBeenCalled(); expect(started).toEqual(['custom']);
    expect(spawn).toHaveBeenCalledWith('/bin/agent', ['--yes'], expect.objectContaining({ env: expect.objectContaining({ AGENT: '1', TERM: 'xterm-256color' }) }));
    processes[0].data('Allow? (y/n)'); await new Promise((resolve) => setTimeout(resolve, 450));
    expect(events.find((event) => event.type === 'attention')).toMatchObject({ message: 'Allow? (y/n)' });
    manager.write(1, { sessionId: 'c1', runId: session.runId, data: 'y\r' }); processes[0].data('\x1b[2J\x1b[H');
    await new Promise((resolve) => setTimeout(resolve, 300)); processes[0].data('Done.\r\n> '); await new Promise((resolve) => setTimeout(resolve, 450));
    expect(events.filter((event) => event.type === 'answered').map((event) => (event as { finished?: true }).finished ?? false)).toEqual([false, true]);
    const bare = new PtyManager(() => {}, { spawn, discover, environment: () => ({ PATH: '/bin' }) }); managers.push(bare);
    await expect(bare.start(1, { sessionId: 'c2', cwd: process.cwd(), config, cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'CUSTOM_AGENTS' });
  });
  it('runs a custom agent’s chat over ACP (phase 2): its acp launch, the channel’s level, its name for a Round Table, no screen reading', async () => {
    const processes: FakePty[] = []; const chats: ChatEnvelope[] = []; const terminal = vi.fn();
    const agent = { name: 'Fake ACP', prefix: 'acp', modes: { ask: 'read-only', full: 'yolo' }, allowEdits: true, mcpServers: [] };
    const customLaunch = vi.fn(async () => ({ file: '/bin/fake-acp', args: ['acp'], env: { PATH: '/bin' }, status: undefined, name: 'Fake ACP', chat: agent, level: 'full' as const }));
    const manager = new PtyManager(() => {}, { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn: terminal, discover: async (engine) => engines(engine), customLaunch, environment: () => ({ PATH: '/bin' }), onChat: (_owner, envelope) => chats.push(envelope),
      spawnChat: (file, args) => { expect([file, args]).toEqual(['/bin/fake-acp', ['acp']]); const pty = Object.assign(new FakePty(), { onStderr: () => {} }); processes.push(pty); return pty as unknown as IPty; } });
    managers.push(manager);
    const session = await manager.start(1, { sessionId: 'acp1', cwd: process.cwd(), config: { engine: 'custom' as const, agentId: 'fake-acp', model: '', chat: true, permissions: 'full' }, cols: 80, rows: 24 });
    expect(terminal).not.toHaveBeenCalled();
    const written = () => processes[0].write.mock.calls.map(([line]) => JSON.parse(String(line)) as { id?: number; method?: string; params?: Record<string, unknown> });
    const answer = (method: string, result: Record<string, unknown>) => { const request = written().filter((line) => line.method === method).at(-1)!; processes[0].data(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'); };
    answer('initialize', { protocolVersion: 1, agentCapabilities: {} });
    answer('session/new', { sessionId: 'S1', modes: { currentModeId: 'default', availableModes: [] } });
    // Full access asks for the definition's full mode; the answer confirms it, and the chat is ready.
    expect(written().at(-1)).toMatchObject({ method: 'session/set_mode', params: { sessionId: 'S1', modeId: 'yolo' } });
    answer('session/set_mode', {});
    expect(chats.map((envelope) => envelope.event)).toContainEqual({ type: 'ready', conversationId: 'S1', model: null });
    const host = (manager as unknown as { tableHost(): { run(runId: string): { engine: string; agentName?: string; permissions?: string } | null } }).tableHost();
    expect(host.run(session.runId)).toMatchObject({ engine: 'custom', agentName: 'Fake ACP', permissions: 'full' });
    // A terminal-only definition can't be a chat.
    const plain = new PtyManager(() => {}, { stopDependencies: { platform: 'linux', signalGroup: () => {} }, discover: async (engine) => engines(engine), customLaunch: async () => ({ file: '/bin/agent', args: [], env: {}, status: undefined, name: 'Aider' }), environment: () => ({ PATH: '/bin' }) }); managers.push(plain);
    await expect(plain.start(1, { sessionId: 'acp2', cwd: process.cwd(), config: { engine: 'custom' as const, agentId: 'aider', model: '', chat: true }, cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'AGENT_NO_CHAT' });
  });
});
