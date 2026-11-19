import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { CLAUDE_USAGE_ARGS, inBatches, readClaudeLimits, readCodexLimits } from './plan-limits';

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
