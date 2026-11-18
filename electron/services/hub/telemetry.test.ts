import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UsageRecord } from '../../../shared/hub';
import { rateFor, TelemetryService, usageCost } from './telemetry';
import { mainStalls } from '../storage/host-health';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-telemetry-')); roots.push(root);
  const home = path.join(root, 'claude'); const dir = path.join(home, 'projects', '-project'); fs.mkdirSync(dir, { recursive: true });
  return { root, home, dir };
}
const claude = { engine: 'claude' as const, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } };
const reply = (id: string, input: number, output: number, at?: string) => JSON.stringify({ type: 'assistant', ...(at ? { timestamp: at } : {}), message: { id, model: 'm', usage: { input_tokens: input, output_tokens: output } } }) + '\n';
const codexTotal = (input: number, output: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } } }) + '\n';

describe('price rates', () => {
  const rate = { model: 'Claude Opus 5.5', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  it('match the CLI\'s model ID when entered as the model\'s name', () => {
    expect(rateFor('claude-opus-5-5', [rate])).toBe(rate);
    expect(rateFor('claude-opus-5-5-20261101', [rate])).toBe(rate);
    expect(rateFor('gpt-6.1-sol', [{ ...rate, model: 'GPT 6.1 Sol' }])?.model).toBe('GPT 6.1 Sol');
    const record = { runId: 'r', sessionId: 's', engine: 'claude', cwd: '/', model: 'claude-opus-5-5', timestamp: new Date().toISOString(), input: 1000000, output: 0, cached: 0, cacheWrite: 0, reasoning: null, context: null, cost: null } satisfies UsageRecord;
    expect(usageCost(record, [rate])).toBe(5);
  });
  it('keep context-size variants and other models apart', () => {
    expect(rateFor('claude-opus-5-5[1m]', [rate])).toBeUndefined();
    expect(rateFor('claude-opus-5-5[1m]', [{ ...rate, model: 'Claude Opus 5.5 [1m]' }])?.model).toBe('Claude Opus 5.5 [1m]');
    expect(rateFor('claude-opus-5-5-20261101[1m]', [{ ...rate, model: 'claude-opus-5-5[1m]' }])?.model).toBe('claude-opus-5-5[1m]');
    expect(rateFor('claude-opus-5', [rate])).toBeUndefined(); expect(rateFor('<synthetic>', [{ ...rate, model: '---' }])).toBeUndefined();
  });
});

describe('subagents started by a workflow', () => {
  it('count toward the run, apart from another workflow run\'s agent of the same name and from files that are not transcripts', async () => {
    vi.useFakeTimers(); const { root, home, dir } = setup(); const run = { runId: randomUUID(), sessionId: 's', engine: 'claude' as const, cwd: '/project', pid: 1 };
    const published: UsageRecord[] = []; const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], (usage) => published.push(usage), () => {}, home, path.join(root, 'codex'));
    try {
      const workflows = path.join(dir, run.runId, 'subagents', 'workflows'); fs.mkdirSync(path.join(workflows, 'one'), { recursive: true }); fs.mkdirSync(path.join(workflows, 'two'), { recursive: true });
      fs.writeFileSync(path.join(dir, run.runId + '.jsonl'), reply('main', 1, 1));
      fs.writeFileSync(path.join(workflows, 'one', 'agent-a.jsonl'), reply('one-a', 10, 1)); fs.writeFileSync(path.join(workflows, 'two', 'agent-a.jsonl'), reply('two-a', 100, 1));
      fs.writeFileSync(path.join(workflows, 'one', 'journal.jsonl'), reply('journal', 5000, 5000));
      telemetry.start(run, claude); vi.advanceTimersByTime(750);
      expect(published.at(-1)).toMatchObject({ input: 111, output: 3 });
      // A workflow agent that writes more while the conversation itself is quiet is read too.
      fs.appendFileSync(path.join(workflows, 'two', 'agent-a.jsonl'), reply('two-a-2', 1000, 1)); vi.advanceTimersByTime(750);
      expect(published.at(-1)).toMatchObject({ input: 1111, output: 4 });
      // So is an agent a later workflow starts, within a few seconds; the folders are not listed on every read meanwhile.
      const readdir = vi.spyOn(fs, 'readdirSync'); const walks = () => readdir.mock.calls.filter(([folder]) => String(folder).startsWith(workflows)).length;
      fs.mkdirSync(path.join(workflows, 'three')); fs.writeFileSync(path.join(workflows, 'three', 'agent-a.jsonl'), reply('three-a', 10000, 1)); vi.advanceTimersByTime(750);
      expect(walks()).toBe(0); vi.advanceTimersByTime(4250);
      expect(walks()).toBeGreaterThan(0); expect(published.at(-1)).toMatchObject({ input: 11111, output: 5 });
      await telemetry.end(run.runId); expect(telemetry.runUsage(run.runId)).toMatchObject({ input: 11111, output: 5 });
    } finally { telemetry.close(); }
  });
  it('are counted for a resumed run only by what they gain after the resume', async () => {
    vi.useFakeTimers(); const { root, home, dir } = setup(); const run = { runId: randomUUID(), sessionId: 's', engine: 'claude' as const, cwd: '/project', pid: 1 };
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      const file = path.join(dir, run.runId + '.jsonl'); const agent = path.join(dir, run.runId, 'subagents', 'workflows', 'w1', 'agent-x.jsonl'); fs.mkdirSync(path.dirname(agent), { recursive: true });
      fs.writeFileSync(file, reply('main', 1, 1)); fs.writeFileSync(agent, reply('x-1', 500, 50));
      telemetry.start(run, claude); vi.advanceTimersByTime(750); await telemetry.end(run.runId);
      expect(telemetry.runUsage(run.runId)).toMatchObject({ input: 501, output: 51 });
      const resumed = { ...run, runId: randomUUID() }; telemetry.setResumeSource(resumed.runId, file, 'claude', '');
      telemetry.start(resumed, { ...claude, resumeId: run.runId } as never);
      fs.appendFileSync(agent, reply('x-2', 7, 3)); vi.advanceTimersByTime(750); await telemetry.end(resumed.runId);
      expect(telemetry.runUsage(resumed.runId)).toMatchObject({ input: 7, output: 3 });
    } finally { telemetry.close(); }
  });
  it('are dated from their transcripts by the one-time backfill', async () => {
    vi.useFakeTimers(); const { root, home, dir } = setup(); const run = { runId: randomUUID(), sessionId: 's', engine: 'claude' as const, cwd: '/project', pid: 1 };
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      const agent = path.join(dir, run.runId, 'subagents', 'workflows', 'w1', 'agent-x.jsonl'); fs.mkdirSync(path.dirname(agent), { recursive: true });
      fs.writeFileSync(path.join(dir, run.runId + '.jsonl'), ''); fs.writeFileSync(agent, reply('x-1', 10, 90));
      telemetry.start(run, claude); vi.advanceTimersByTime(750); await telemetry.end(run.runId);
      fs.writeFileSync(agent, reply('x-1', 10, 90, new Date(2026, 9, 26, 12).toISOString()));
      expect(telemetry.backfillDays([home])).toBe(1); expect(telemetry.runUsage(run.runId)!.days).toEqual({ '2026-10-26': { tokens: 100, cost: null } });
    } finally { telemetry.close(); }
  });
});

describe('run totals', () => {
  it('follow new usage and changed rates without reading every row again', () => {
    vi.useFakeTimers(); const { root, home, dir } = setup(); const run = { runId: randomUUID(), sessionId: 's', engine: 'claude' as const, cwd: '/project', pid: 1 };
    let rates = [{ model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }];
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => rates, () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      const file = path.join(dir, run.runId + '.jsonl'); fs.writeFileSync(file, reply('a', 100, 10)); telemetry.start(run, claude); vi.advanceTimersByTime(750);
      expect(telemetry.list()[0]).toMatchObject({ input: 100, output: 10, eventCount: 1 }); expect(telemetry.list()[0].cost).toBeCloseTo(0.00011);
      // The run's rows are read again only after it gains usage, not on every list.
      const prepare = vi.spyOn((telemetry as unknown as { database: { prepare: (sql: string) => unknown } }).database, 'prepare'); const rowReads = () => prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT snapshot FROM usage u')).length;
      telemetry.list(); telemetry.list(); expect(rowReads()).toBe(0);
      fs.appendFileSync(file, reply('b', 1, 1)); vi.advanceTimersByTime(750);
      expect(telemetry.list()[0]).toMatchObject({ input: 101, output: 11, eventCount: 2 }); telemetry.list(); expect(rowReads()).toBe(1);
      rates = [{ ...rates[0], input: 2 }]; expect(telemetry.list()[0].cost).toBeCloseTo(0.000213); expect(rowReads()).toBe(1);
    } finally { telemetry.close(); }
  });
  it('commit each read without a disk flush per commit, and the backfill in one commit', () => {
    const { root, home } = setup(); const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      const database = (telemetry as unknown as { database: { prepare: (sql: string) => { get: () => Record<string, unknown> }; exec: (sql: string) => void } }).database;
      // 1 is NORMAL (2, FULL, was the default): with WAL the database stays whole after a crash.
      expect(database.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 });
      const exec = vi.spyOn(database, 'exec'); telemetry.backfillDays([home]); expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
    } finally { telemetry.close(); }
  });
  it('read again what a failed write did not record', () => {
    vi.useFakeTimers(); const { root, home, dir } = setup(); const run = { runId: randomUUID(), sessionId: 's', engine: 'claude' as const, cwd: '/project', pid: 1 };
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      const database = (telemetry as unknown as { database: { exec: (sql: string) => void } }).database; const exec = database.exec.bind(database); let failed = false;
      vi.spyOn(database, 'exec').mockImplementation((sql: string) => { if (sql === 'COMMIT' && !failed) { failed = true; throw new Error('disk I/O error'); } return exec(sql); });
      fs.writeFileSync(path.join(dir, run.runId + '.jsonl'), reply('a', 100, 10)); telemetry.start(run, claude);
      expect(failed).toBe(true); expect(telemetry.runUsage(run.runId)).toBeNull();
      vi.advanceTimersByTime(750); expect(telemetry.runUsage(run.runId)).toMatchObject({ input: 100, output: 10, eventCount: 1 });
    } finally { telemetry.close(); }
  });
});

describe('Codex runs', () => {
  const codexRun = () => ({ runId: randomUUID(), sessionId: 's', engine: 'codex' as const, cwd: '/project', pid: 1 });
  const codex = { engine: 'codex' as const, model: '', reasoningEffort: null };
  it('count only what a resumed conversation gains, though its last total is far back in the rollout', async () => {
    vi.useFakeTimers(); const { root, home } = setup(); const run = codexRun();
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      const file = path.join(root, 'rollout.jsonl'); const output = (JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(1000) } }) + '\n').repeat(400);
      fs.writeFileSync(file, codexTotal(1000, 100) + output);
      telemetry.setResumeSource(run.runId, file, 'codex', ''); telemetry.start(run, codex as never);
      fs.appendFileSync(file, codexTotal(1500, 150)); vi.advanceTimersByTime(750); await telemetry.end(run.runId);
      expect(telemetry.runUsage(run.runId)).toMatchObject({ input: 500, output: 50 });
    } finally { telemetry.close(); }
  });
  it('look for a rollout they cannot tell apart less often after the first minute', () => {
    vi.useFakeTimers(); const { root, home } = setup(); const a = codexRun(); const b = { ...codexRun(), cwd: a.cwd };
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try {
      const logDir = path.join(root, 'telemetry', a.runId); fs.mkdirSync(logDir, { recursive: true });
      const readdir = vi.spyOn(fs, 'readdirSync'); const looks = () => readdir.mock.calls.filter(([folder]) => folder === logDir).length;
      telemetry.start(a, codex as never); telemetry.start(b, codex as never);
      vi.advanceTimersByTime(60000); const first = looks(); expect(first).toBeGreaterThan(70);
      vi.advanceTimersByTime(60000); expect(looks() - first).toBeLessThanOrEqual(13);
    } finally { telemetry.close(); }
  });
  it('leave no log folder behind after a restart', async () => {
    const { root, home } = setup(); const telemetryRoot = path.join(root, 'telemetry'); const left = path.join(telemetryRoot, randomUUID()); fs.mkdirSync(left, { recursive: true }); fs.writeFileSync(path.join(left, 'codex-tui.log'), 'x');
    const other = path.join(telemetryRoot, 'keep'); fs.mkdirSync(other);
    const telemetry = new TelemetryService(telemetryRoot, () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try { await vi.waitFor(() => expect(fs.existsSync(left)).toBe(false)); expect(fs.existsSync(other)).toBe(true); expect(fs.existsSync(path.join(telemetryRoot, 'usage.db'))).toBe(true); }
    finally { telemetry.close(); }
  });
});
describe('the stall record', () => {
  it('names each 750 ms read of a log telemetry-poll', async () => {
    vi.useFakeTimers(); const { root, home, dir } = setup(); const run = { runId: randomUUID(), sessionId: 's', engine: 'claude' as const, cwd: '/project', pid: 1 };
    const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    const timed = vi.spyOn(mainStalls, 'timed');
    try {
      fs.writeFileSync(path.join(dir, run.runId + '.jsonl'), reply('main', 1, 1));
      telemetry.start(run, claude); expect(timed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(750); expect(timed).toHaveBeenCalledWith('telemetry-poll', expect.any(Function));
      await telemetry.end(run.runId);
    } finally { telemetry.close(); }
  });
});
