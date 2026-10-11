import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { SessionEvent } from '../../../shared/ipc';
import { PtyManager } from './pty-manager';
import type { DiscoveredEngine } from './discovery';

class FakePty {
  pid = 99999999;
  data: (value: string) => void = () => {};
  exit: (value: { exitCode: number }) => void = () => {};
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn(() => { queueMicrotask(() => this.exit({ exitCode: 0 })); });
  onData = (listener: typeof this.data) => { this.data = listener; return { dispose() {} }; };
  onExit = (listener: typeof this.exit) => { this.exit = listener; return { dispose() {} }; };
}

const engines = (engine: 'claude' | 'codex'): DiscoveredEngine => ({ info: { engine, available: true, executable: '/fixture', version: '2.1.296', supportsModel: true, supportsConfig: true, supportsNoDaemon: false, error: null }, executable: { file: '/fixture', prefixArgs: [], extraEnv: {}, displayPath: '/fixture' } });
const request = (sessionId = 'session-one') => ({ sessionId, cwd: process.cwd(), config: { engine: 'codex' as const, model: '', reasoningEffort: null }, cols: 80, rows: 24 });
const managers: PtyManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.dispose())); });
function fixture(discover = async (engine: 'claude' | 'codex') => engines(engine)) {
  const processes: FakePty[] = [];
  const events: SessionEvent[] = [];
  const spawn = vi.fn(() => { const pty = new FakePty(); processes.push(pty); return pty as unknown as IPty; });
  const manager = new PtyManager((_owner, event) => events.push(event), { stopDependencies: { platform: 'linux', signalGroup: () => {} }, spawn, discover, environment: () => ({ PATH: '/bin', HUB_FIXTURE: 'inherited' }) });
  managers.push(manager);
  return { manager, processes, events, spawn };
}

describe('PTY lifecycle and IPC ownership', () => {
  it('binds concurrent Claude sessions to their selected profile environments before discovery and spawning', async () => {
    const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => new FakePty() as unknown as IPty);
    const discover = vi.fn(async (engine: 'claude' | 'codex', _env?: Record<string, string>) => { const result = engines(engine); result.info.authentication = { state: 'authenticated', checkedAt: new Date().toISOString(), message: 'Profile authenticated.' }; return result; });
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
  it('rejects named profiles when host profile storage is unavailable instead of using the default account', async () => {
    const { manager, spawn } = fixture();
    await expect(manager.start(7, { ...request(), config: { engine: 'claude', accountProfileId: '11111111-1111-4111-8111-111111111111', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } })).rejects.toMatchObject({ code: 'PROFILE_STORAGE' });
    expect(spawn).not.toHaveBeenCalled();
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
  it('reserves pending launches and enforces the four-process limit under concurrency', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager } = fixture(async (engine) => { await gate; return engines(engine); });
    const starts = [0, 1, 2, 3].map((index) => manager.start(7, request(`session-${index}`)));
    await expect(manager.start(7, request('fifth'))).rejects.toThrow('four');
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
