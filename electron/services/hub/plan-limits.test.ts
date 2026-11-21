import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CLAUDE_USAGE_ARGS, inBatches, PlanLimitsService, readClaudeLimits, readCodexLimits, readGeminiLimits } from './plan-limits';

/** Node itself stands in for a CLI: `--` keeps the CLI's arguments (`-p /usage`, `app-server`) away from Node. */
const fake = (script: string) => ({ file: process.execPath, prefixArgs: ['-e', script, '--'], extraEnv: {}, displayPath: 'node' });
const missing = { file: path.join(os.tmpdir(), 'trace-no-such-cli', 'cli.exe'), prefixArgs: [], extraEnv: {}, displayPath: 'cli' };
const env = process.env as Record<string, string>;
/** Answers Codex's handshake, then reports the given rate limits. */
const codexServer = (rateLimits: unknown) => fake(`require('readline').createInterface({ input: process.stdin }).on('line', (line) => { const { id } = JSON.parse(line); if (id === 1) console.log(JSON.stringify({ id: 1, result: {} })); if (id === 2) console.log(${JSON.stringify(JSON.stringify({ id: 2, result: { rateLimits } }))}); });`);

describe('a reading without limits says whether the check failed or the account has none', () => {
  it('marks a Claude Code that does not start, or that reports no limits, as a failed check', async () => {
    expect(await readClaudeLimits(missing, env, 'Default')).toMatchObject({ windows: [], error: 'Claude Code did not answer /usage.', failed: true });
    expect(await readClaudeLimits(fake(`console.log(JSON.stringify({ result: 'Something else' }))`), env, 'Default')).toMatchObject({ windows: [], error: 'Claude Code did not report usage limits.', failed: true });
  });
  it('marks an account billed by API usage as a fact, not a failure', async () => {
    expect(await readClaudeLimits(fake(`console.log(JSON.stringify({ result: 'You are using an API key; usage is billed by API usage.' }))`), env, 'Work')).toMatchObject({ account: 'Work', windows: [], error: 'This account is billed by API usage, which has no session or weekly limit.', failed: false });
  });
  it('marks a reading with limits as neither', async () => {
    expect(await readClaudeLimits(fake(`console.log(JSON.stringify({ result: 'Current session: 5% used' }))`), env, 'Default')).toMatchObject({ windows: [{ label: 'Session', usedPercent: 5 }], error: null, failed: false });
  });
  it('marks a Codex that does not start, or answers with an error or a form Trace does not read, as a failed check', async () => {
    expect(await readCodexLimits(missing, env)).toMatchObject({ windows: [], error: 'Codex could not be started.', failed: true });
    expect(await readCodexLimits(codexServer({ primary: { usedPercent: 'many' } }), env)).toMatchObject({ windows: [], error: 'Codex reported its usage limits in a form Trace does not read. Update Trace.', failed: true });
  });
  it('marks a Codex account without limits as a fact', async () => {
    expect(await readCodexLimits(codexServer({}), env)).toMatchObject({ windows: [], error: 'This Codex account has no usage limits to show.', failed: false });
  });
});

describe('usage limit checks', () => {
  it('reads Claude usage without starting MCP servers, so no server opens a console window', () => {
    expect(CLAUDE_USAGE_ARGS).toEqual(expect.arrayContaining(['-p', '/usage', '--no-session-persistence', '--strict-mcp-config']));
    expect(CLAUDE_USAGE_ARGS).not.toContain('--mcp-config');
  });

  it('runs at most the given number of checks at once and keeps their order', async () => {
    let running = 0; let most = 0;
    const tasks = Array.from({ length: 11 }, (_, index) => async () => {
      running++; most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5 + (index % 3) * 5));
      running--; return index;
    });
    expect(await inBatches(tasks, 2)).toEqual(Array.from({ length: 11 }, (_, index) => index));
    expect(most).toBe(2);
    expect(await inBatches([], 2)).toEqual([]);
  });
});

describe('Gemini CLI plan limits', () => {
  const agy = { file: '/agy', prefixArgs: [], extraEnv: {}, displayPath: '/agy' };
  const usage = JSON.stringify({ command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0.9 }] }] } } });
  const probe = (version: string, out = usage, exitCode = 0) => { const runs: string[][] = []; return { runs, probe: async (_executable: unknown, args: string[]) => { runs.push(args); return args[0] === '--version' ? { stdout: version, stderr: '', exitCode: 0, timedOut: false } : { stdout: out, stderr: '', exitCode, timedOut: false }; } }; };
  it('asks agy for /usage only from 1.1.11, which answers it without sending it to the model', async () => {
    const old = probe('1.1.10'); expect(await readGeminiLimits(agy, {}, old.probe as never)).toBeNull(); expect(old.runs).toEqual([['--version']]);
    const current = probe('1.5.12'); const limits = await readGeminiLimits(agy, {}, current.probe as never);
    expect(current.runs).toEqual([['--version'], ['-p', '/usage', '--output-format', 'json']]);
    expect(limits).toMatchObject({ engine: 'gemini', account: 'Default', windows: [{ label: 'Session', usedPercent: 10 }], error: null });
  });
  it('says the check failed when agy does not report its limits', async () => {
    expect(await readGeminiLimits(agy, {}, probe('1.5.12', 'Please sign in', 1).probe as never)).toMatchObject({ windows: [], failed: true, error: 'Gemini CLI did not report usage limits. Check that it is signed in.' });
  });
});

describe('the plan limits service', () => {
  /** A folder whose only program is a `claude`: the checks search only the PATH they are given, so no real CLI runs. */
  const claudeOnPath = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-limits-')); fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'MZ', { mode: 0o755 }); return dir; };
  const profile = (id: string, name: string) => ({ id, name, createdAt: '2026-11-21T00:00:00.000Z' });
  afterEach(() => { vi.useRealTimers(); });
  it('reads again five minutes after the last read began, not after it ended', async () => {
    const dir = claudeOnPath(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000); let reads = 0;
    const service = new PlanLimitsService(() => [], (base) => { reads++; vi.setSystemTime(1_020_000); return base; }, () => ({ PATH: dir }));
    await service.refresh(); expect(reads).toBe(1);
    // Asked exactly five minutes after the start, as the window does.
    vi.setSystemTime(1_000_000 + 5 * 60_000); await service.refresh(); expect(reads).toBe(2);
    vi.setSystemTime(1_000_000 + 5 * 60_000 + 1000); await service.refresh(); expect(reads).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('shows an account whose check cannot run as failed, and still reports the others', async () => {
    const dir = claudeOnPath();
    const service = new PlanLimitsService(() => [profile('p1', 'Work')], (base, id) => { if (!id) throw new Error('no profile'); return base; }, () => ({ PATH: dir }), 1);
    const limits = await service.refresh(true);
    expect(limits.map((item) => [item.account, item.failed])).toEqual([['Default', true], ['Work', true]]);
    expect(limits.find((item) => item.account === 'Default')).toMatchObject({ error: 'Trace could not check Claude Code\'s usage limits.' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('does not wait for the input Claude Code would otherwise wait 3 seconds for', async () => {
    const waiting = fake(`process.stdin.on('end', () => console.log(JSON.stringify({ result: 'Current session: 5% used' }))); process.stdin.resume();`);
    expect(await readClaudeLimits(waiting, env, 'Default')).toMatchObject({ windows: [{ label: 'Session', usedPercent: 5 }], failed: false });
  });
});
