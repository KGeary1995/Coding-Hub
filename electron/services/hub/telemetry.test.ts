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
    // A rate entered for the plain model does not price its [1m] variant: the published price does.
    expect(rateFor('claude-opus-5-5[1m]', [rate])).toMatchObject({ model: 'claude-opus-5-5', input: 4 });
    expect(rateFor('claude-opus-5-5[1m]', [{ ...rate, model: 'Claude Opus 5.5 [1m]' }])?.model).toBe('Claude Opus 5.5 [1m]');
    expect(rateFor('claude-opus-5-5-20261101[1m]', [{ ...rate, model: 'claude-opus-5-5[1m]' }])?.model).toBe('claude-opus-5-5[1m]');
    expect(rateFor('claude-opus-5', [rate])?.model).toBe('claude-opus-5'); expect(rateFor('<synthetic>', [{ ...rate, model: '---' }])).toBeUndefined();
  });
  it('price Gemini CLI\'s models by the model, whatever effort, tier or trial its name carries', () => {
    const record = { runId: 'r', sessionId: 's', engine: 'gemini', cwd: '/', model: 'gemini-4-neon', timestamp: new Date().toISOString(), input: 1000000, output: 1000000, cached: 1000000, cacheWrite: 0, reasoning: null, context: null, cost: null } satisfies UsageRecord;
    // $3 input, $15 output (thinking included), $0.15 for input read from the cache.
    expect(usageCost(record, [])).toBeCloseTo(18.15);
    for (const model of ['gemini-4-neon-high', 'gemini-4-neon-xhigh']) expect(usageCost({ ...record, model }, [])).toBeCloseTo(18.15);
    expect(rateFor('gemini-4-hydrogen-tiered-high', [])?.model).toBe('gemini-4-hydrogen'); expect(rateFor('gemini-4-argon-trial', [])?.model).toBe('gemini-4-argon'); expect(rateFor('gemini-3.5-flash-lite', [])?.input).toBe(0.3);
    expect(rateFor('gemini-9-unknown-high', [])).toBeUndefined();
  });
  it('use the published prices when no rate was entered, and an entered rate first', () => {
    const record = { runId: 'r', sessionId: 's', engine: 'claude', cwd: '/', model: 'claude-fable-5-2', timestamp: new Date().toISOString(), input: 1000000, output: 1000000, cached: 1000000, cacheWrite: 1000000, reasoning: null, context: null, cost: null } satisfies UsageRecord;
    // $8 input, $40 output, $0.20 cache reads, $16 for Claude Code's one-hour cache writes.
    expect(usageCost(record, [])).toBeCloseTo(64.2);
    expect(usageCost({ ...record, model: 'claude-fable-5-2-20261101' }, [])).toBeCloseTo(64.2);
    expect(usageCost(record, [{ model: 'Claude Fable 5.2', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }])).toBe(4);
    // Codex counts cached input inside its input: 2M input of which 1M cached, at $2 and $0.10, and $10 output.
    expect(usageCost({ ...record, engine: 'codex', model: 'gpt-6.1-sol', input: 2000000, cacheWrite: 0 }, [])).toBeCloseTo(12.1);
    expect(usageCost({ ...record, model: 'a-model-nobody-lists' }, [])).toBeNull();
  });
});

describe('a Claude run the background runner kept while Trace was closed', () => {
  it('is followed again in its conversation, counting what it did meanwhile once, without passing old lines on as new', async () => {
    vi.useFakeTimers(); const { root, home, dir } = setup(); const run = { runId: randomUUID(), sessionId: 's', engine: 'claude' as const, cwd: '/project', pid: 1 }; const conversation = randomUUID();
    const file = path.join(dir, conversation + '.jsonl'); fs.writeFileSync(file, reply('a', 100, 1));
    const first = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex'));
    try { first.start(run, { ...claude, resumeId: conversation } as never); vi.advanceTimersByTime(750); expect(first.runUsage(run.runId)).toMatchObject({ input: 100, context: { used: 101 } }); } finally { first.close(); }
    // Trace was closed while Claude went on in the runner.
    fs.appendFileSync(file, reply('b', 900, 2));
    const lines: unknown[] = []; const published: UsageRecord[] = [];
    const again = new TelemetryService(path.join(root, 'telemetry'), () => [], (usage) => published.push(usage), () => {}, home, path.join(root, 'codex')); again.onLine = (_run, _config, raw) => { lines.push(raw); };
    try {
      const before = again.runUsage(run.runId)!.timestamp;
      // Its saved channel settings name no conversation: the one it was last read in is used.
      again.adopt(run, claude); again.setContextWindow(run.runId, 1_000_000); vi.advanceTimersByTime(750);
      expect(again.runUsage(run.runId)).toMatchObject({ input: 1000, output: 3, timestamp: before, context: { used: 902, limit: 1_000_000 } }); expect(lines).toEqual([]);
      fs.appendFileSync(file, reply('c', 50, 1)); vi.advanceTimersByTime(750);
      expect(again.runUsage(run.runId)).toMatchObject({ input: 1050, context: { used: 51 } }); expect(lines).toHaveLength(1);
      // Taken up once only; a Codex run is not.
      again.adopt(run, claude); again.adopt({ ...run, runId: randomUUID(), engine: 'codex' as const }, { ...claude, engine: 'codex' } as never);
      expect((again as unknown as { watches: Map<string, unknown> }).watches.size).toBe(1);
    } finally { again.close(); }
  });
  const service = (root: string, home: string, lines: unknown[] = []) => { const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => [], () => {}, () => {}, home, path.join(root, 'codex')); telemetry.onLine = (_run, _config, raw) => { lines.push(raw); }; return telemetry; };
  it('counts a resumed conversation\'s earlier replies and subagents for it neither before nor after a restart', async () => {
    vi.useFakeTimers(); const { root, home, dir } = setup(); const run = { runId: randomUUID(), sessionId: 's', engine: 'claude' as const, cwd: '/project', pid: 1 }; const conversation = randomUUID();
    // A conversation made outside Trace, with a subagent: none of it is this run's.
    const file = path.join(dir, conversation + '.jsonl'); fs.writeFileSync(file, reply('old', 300000, 1)); const agents = path.join(dir, conversation, 'subagents'); fs.mkdirSync(agents, { recursive: true }); fs.writeFileSync(path.join(agents, 'agent-old.jsonl'), reply('old-agent', 5000, 1));
    const first = service(root, home);
    try { first.setResumeSource(run.runId, file, 'claude', ''); first.start(run, { ...claude, resumeId: conversation } as never); fs.appendFileSync(file, reply('new', 10, 1)); vi.advanceTimersByTime(750); expect(first.runUsage(run.runId)).toMatchObject({ input: 10 }); } finally { first.close(); }
    // While Trace was closed: one more reply, and a new subagent.
    fs.appendFileSync(file, reply('closed', 20, 1)); fs.writeFileSync(path.join(agents, 'agent-new.jsonl'), reply('new-agent', 400, 1));
    const lines: unknown[] = []; const again = service(root, home, lines);
    try { again.adopt(run, claude); vi.advanceTimersByTime(5000); expect(again.runUsage(run.runId)).toMatchObject({ input: 430, output: 3, context: { used: 21 } }); expect(lines).toEqual([]); } finally { again.close(); }
  });
  it('after a restart, follows a conversation switch made before it, and coaches the first lines of a new transcript', async () => {
    vi.useFakeTimers(); const { root, home, dir } = setup(); const run = { runId: randomUUID(), sessionId: 's', engine: 'claude' as const, cwd: '/project', pid: 1 }; const cleared = randomUUID();
    fs.writeFileSync(path.join(dir, run.runId + '.jsonl'), reply('a', 100, 1));
    const first = service(root, home);
    // /clear just before Trace closed: the new transcript is written only with the next prompt.
    try { first.start(run, claude); vi.advanceTimersByTime(750); first.follow(run.runId, cleared); } finally { first.close(); }
    const lines: unknown[] = []; const again = service(root, home, lines);
    try {
      again.adopt(run, claude); vi.advanceTimersByTime(750); fs.writeFileSync(path.join(dir, cleared + '.jsonl'), reply('b', 7, 1)); vi.advanceTimersByTime(750);
      expect(again.runUsage(run.runId)).toMatchObject({ input: 107, context: { used: 8 } }); expect(lines).toHaveLength(1);
      // And after another /clear once taken up, the new transcript's lines are coached from its start.
      const next = randomUUID(); again.follow(run.runId, next); fs.writeFileSync(path.join(dir, next + '.jsonl'), reply('c', 3, 1)); vi.advanceTimersByTime(750); expect(lines).toHaveLength(2);
    } finally { again.close(); }
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
