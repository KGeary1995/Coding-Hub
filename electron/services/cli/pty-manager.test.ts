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
  const manager = new PtyManager((_owner, event) => events.push(event), { spawn, discover, environment: () => ({ PATH: '/bin', HUB_FIXTURE: 'inherited' }) });
  managers.push(manager);
  return { manager, processes, events, spawn };
}

describe('PTY lifecycle and IPC ownership', () => {
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
