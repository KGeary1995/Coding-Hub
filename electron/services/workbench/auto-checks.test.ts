import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoCheckStatus } from '../../../shared/auto-checks';
const files = vi.hoisted(() => ({ state: null as string | null }));
/** What the folder's files are (repositoryState): null, as outside Git, unless a test sets it. */
vi.mock('./repository-state', () => ({ repositoryState: async () => files.state }));
const { AutoChecks, detectChecks, failureText, MAX_FIXES } = await import('./auto-checks');
type AutoCheck = import('./auto-checks').AutoCheck;

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); files.state = null; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
function project(files: Record<string, string>) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auto-checks-')); roots.push(root); for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text); return root; }
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });

describe('the checks a project defines', () => {
  it('runs typecheck before test, and only scripts the project has', () => {
    expect(detectChecks(project({ 'package.json': pkg({ test: 'vitest', typecheck: 'tsc', build: 'vite build' }) })).map((check) => check.label)).toEqual(['npm run typecheck', 'npm test']);
    expect(detectChecks(project({ 'package.json': pkg({ 'type-check': 'tsc' }) })).map((check) => check.args)).toEqual([['run', 'type-check']]);
  });
  it('skips npm’s placeholder test, and guesses nothing for a project without checks', () => {
    expect(detectChecks(project({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) }))).toEqual([]);
    expect(detectChecks(project({ 'README.md': '# hi' }))).toEqual([]);
    expect(detectChecks(project({ 'package.json': '{ not json' }))).toEqual([]);
  });
  it('uses cargo test and go test for Rust and Go projects', () => {
    expect(detectChecks(project({ 'Cargo.toml': '[package]' }))[0].label).toBe('cargo test');
    expect(detectChecks(project({ 'go.mod': 'module x' }))[0].label).toBe('go test ./...');
  });
  it('gives the agent the end of the output without colours', () => {
    expect(failureText('\x1b[31merror\x1b[0m TS2345\r\n\n\n\nline')).toBe('error TS2345\n\nline');
    expect(failureText('a'.repeat(5000), 100)).toBe(`…${'a'.repeat(100)}`);
  });
});

describe('automatic checks after a turn', () => {
  function setup(results: boolean[], options: { canMessage?: boolean; enabled?: boolean } = {}) {
    const folder = project({ 'package.json': pkg({ typecheck: 'tsc', test: 'vitest' }) });
    const statuses: AutoCheckStatus[] = []; const sent: string[] = []; const ran: string[] = [];
    const checks = new AutoChecks({ enabled: () => options.enabled !== false, canMessage: () => options.canMessage !== false, send: async (_id, text) => { sent.push(text); }, publish: (status) => statuses.push(status),
      run: async (check: AutoCheck) => { ran.push(check.label); return { passed: results.shift() ?? true, output: `${check.label} output` }; } });
    return { folder, checks, statuses, sent, ran };
  }
  const settle = () => vi.advanceTimersByTimeAsync(6000);

  it('runs every check and says they passed', async () => {
    vi.useFakeTimers(); const { folder, checks, statuses, sent, ran } = setup([true, true]);
    checks.turnEnded('s1', folder); await settle();
    expect(ran).toEqual(['npm run typecheck', 'npm test']); expect(sent).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ sessionId: 's1', state: 'passed', summary: 'Checks passed: npm run typecheck, npm test' });
  });
  it('sends a failure to the agent and stops at the first failing check', async () => {
    vi.useFakeTimers(); const { folder, checks, statuses, sent, ran } = setup([false]);
    checks.turnEnded('s1', folder); await settle();
    expect(ran).toEqual(['npm run typecheck']);
    expect(sent[0]).toMatch(/^\[Trace checks\] `npm run typecheck` failed after your changes\./); expect(sent[0]).toContain('npm run typecheck output');
    expect(statuses.at(-1)).toMatchObject({ state: 'failed', summary: 'npm run typecheck failed: sent to the agent to fix.' });
  });
  it(`hands over to the person after ${MAX_FIXES} fixes in a row, or when the agent is waiting for them`, async () => {
    vi.useFakeTimers(); const { folder, checks, statuses, sent } = setup(Array(MAX_FIXES + 1).fill(false));
    for (let i = 0; i <= MAX_FIXES; i++) { checks.turnEnded('s1', folder); await settle(); }
    expect(sent).toHaveLength(MAX_FIXES); expect(statuses.at(-1)?.summary).toBe(`npm run typecheck failed after ${MAX_FIXES} fixes by the agent: over to you.`);
    const waiting = setup([false], { canMessage: false }); waiting.checks.turnEnded('s2', waiting.folder); await settle();
    expect(waiting.sent).toEqual([]); expect(waiting.statuses.at(-1)?.summary).toBe('npm run typecheck failed: over to you.');
  });
  it('runs once for turns that end close together, and not at all when turned off', async () => {
    vi.useFakeTimers(); const { folder, checks, ran } = setup([true, true]);
    checks.turnEnded('s1', folder); await vi.advanceTimersByTimeAsync(2000); checks.turnEnded('s2', folder); await settle();
    expect(ran).toEqual(['npm run typecheck', 'npm test']);
    const off = setup([], { enabled: false }); off.checks.turnEnded('s1', off.folder); await settle(); expect(off.ran).toEqual([]);
  });
  it('does not run when the turn changed no files since the channel started or the last check', async () => {
    vi.useFakeTimers(); const { folder, checks, ran } = setup([true, true, true, true]);
    files.state = 'a'; await checks.started(folder); checks.turnEnded('s1', folder); await settle(); expect(ran).toEqual([]);
    files.state = 'b'; checks.turnEnded('s1', folder); await settle(); expect(ran).toHaveLength(2);
    checks.turnEnded('s1', folder); await settle(); expect(ran).toHaveLength(2);
  });
});

describe('running a project’s real check', () => {
  it('runs the npm scripts in the folder and passes the failing one’s output to the agent', async () => {
    const folder = project({ 'package.json': pkg({ typecheck: 'node -e "console.log(42)"', test: 'node -e "console.error(\'2 tests failed\'); process.exit(1)"' }) });
    const statuses: AutoCheckStatus[] = []; const sent: string[] = [];
    const checks = new AutoChecks({ enabled: () => true, canMessage: () => true, send: async (_id, text) => { sent.push(text); }, publish: (status) => statuses.push(status) });
    checks.turnEnded('s1', folder);
    for (let i = 0; i < 600 && !sent.length; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statuses.map((status) => status.state)).toEqual(['running', 'running', 'failed']);
    expect(sent[0]).toContain('`npm test` failed'); expect(sent[0]).toContain('2 tests failed');
  }, 60_000);
});
