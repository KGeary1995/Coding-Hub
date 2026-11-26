import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localDay, newTokens, type PriceRate, type UsageRecord } from '../../../shared/hub';
import { DayUsage } from './day-usage';
import { TelemetryService } from './telemetry';
import { dayTotal } from '../../../src/state/day-usage-store';
import { geminiUsageFiles, parseGeminiRequest, parseGeminiStepTime, readGeminiRequests } from './gemini-usage';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/** Just enough protobuf to write what Gemini CLI writes: varint fields and nested messages. */
const varint = (value: number) => { const bytes: number[] = []; let rest = value; do { let byte = rest % 128; rest = Math.floor(rest / 128); if (rest) byte += 128; bytes.push(byte); } while (rest); return Buffer.from(bytes); };
const number = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field: number, value: Buffer | string) => { const body = typeof value === 'string' ? Buffer.from(value) : value; return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]); };
const pair = (key: string, value: string) => bytes(20, Buffer.concat([bytes(1, key), bytes(2, value)]));
/** A request's record as found in real conversations (2026-11-22): other fields first, the record (field 1) anywhere. */
const request = (usage: { input: number; output: number; cached?: number; thinking?: number }, model: string, step: number) => Buffer.concat([
  bytes(3, Buffer.concat([number(1, 1532), number(6, 262144)])),
  bytes(1, Buffer.concat([number(3, 1532), bytes(4, Buffer.concat([number(1, 1532), number(2, usage.input), number(3, usage.output), ...(usage.cached ? [number(5, usage.cached)] : []), number(9, usage.thinking ?? 0), bytes(7, 'Q4QCa5PtK6KB0PEPk6SU8Qo')])), bytes(19, model), pair('used_claude', 'false'), pair('last_step_index', String(step)), pair('cascade_id', 'x')])),
]);
const stepMetadata = (seconds: number) => Buffer.concat([bytes(1, number(1, seconds)), bytes(26, bytes(1, bytes(2, number(1, seconds))))]);

function conversation(home: string, id: string, rows: { data: Buffer; step: number; at: number }[]) {
  const folder = path.join(home, 'conversations'); fs.mkdirSync(folder, { recursive: true }); const file = path.join(folder, id + '.db');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE IF NOT EXISTS gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx)); CREATE TABLE IF NOT EXISTS steps (idx integer, step_type integer NOT NULL DEFAULT 0, metadata blob, PRIMARY KEY (idx));');
  const have = Number(database.prepare('SELECT COUNT(*) AS rows FROM gen_metadata').get()!.rows);
  rows.forEach((row, index) => { database.prepare('INSERT OR REPLACE INTO gen_metadata (idx, data) VALUES (?, ?)').run(have + index, row.data); database.prepare('INSERT OR REPLACE INTO steps (idx, metadata) VALUES (?, ?)').run(row.step, stepMetadata(row.at)); });
  database.close(); return file;
}
const home = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-')); roots.push(root); return root; };
const ID = '11111111-2222-4333-8444-555555555555';

describe('Gemini CLI usage from its conversation files', () => {
  it('reads a request\'s tokens, model and time, as its structured output reports them', () => {
    // The numbers of a real request (stream-json said: input 2946, output 38, thinking 36, cache read 8635).
    expect(parseGeminiRequest(request({ input: 2946, output: 38, cached: 8635, thinking: 36 }, 'gemini-4-neon', 2))).toEqual({ model: 'gemini-4-neon', input: 2946, output: 38, cached: 8635, thinking: 36, step: 2 });
    expect(parseGeminiStepTime(stepMetadata(1795361320))).toBe(1795361320);
    // Not a request record, a record with no usage, bytes that are no message, and a time that is no time: nothing is made up.
    expect(parseGeminiRequest(bytes(3, number(1, 5)))).toBeNull(); expect(parseGeminiRequest(bytes(1, bytes(19, 'gemini-4-neon')))).toBeNull();
    expect(parseGeminiRequest(Buffer.from([0x0a, 0x7f, 0x01]))).toBeNull(); expect(parseGeminiRequest(Buffer.alloc(0))).toBeNull();
    expect(parseGeminiStepTime(bytes(1, number(1, 12)))).toBeNull(); expect(parseGeminiStepTime(null)).toBeNull();
  });
  it('lists a conversation\'s requests from a row on, and nothing for a file that is no conversation', () => {
    const root = home(); const file = conversation(root, ID, [{ data: request({ input: 100, output: 10 }, 'gemini-4-neon', 0), step: 0, at: 1795361277 }, { data: request({ input: 20, output: 5, cached: 90 }, 'gemini-4-argon-trial', 2), step: 2, at: 1795361320 }]);
    expect(readGeminiRequests(file)).toEqual({ rows: 2, requests: [{ model: 'gemini-4-neon', input: 100, output: 10, cached: 0, thinking: 0, at: 1795361277, row: 0 }, { model: 'gemini-4-argon-trial', input: 20, output: 5, cached: 90, thinking: 0, at: 1795361320, row: 1 }] });
    expect(readGeminiRequests(file, 1)?.requests.map((item) => item.row)).toEqual([1]);
    expect(geminiUsageFiles(root, 0).map((item) => item.file)).toEqual([file]); expect(geminiUsageFiles(root, Date.now() + 60000)).toEqual([]);
    const other = path.join(root, 'conversations', '99999999-2222-4333-8444-555555555555.db'); fs.writeFileSync(other, 'not a database'); expect(readGeminiRequests(other)).toBeNull();
  });
  it('counts on the day of each request, once, also while the last request is still growing', async () => {
    const root = home(); const now = new Date(2026, 10, 22, 15, 0, 0); const at = (hours: number) => Math.floor(new Date(2026, 10, 22, hours).getTime() / 1000); const yesterday = Math.floor(new Date(2026, 10, 21, 23).getTime() / 1000);
    const file = conversation(root, ID, [{ data: request({ input: 1000, output: 100 }, 'gemini-4-neon', 0), step: 0, at: yesterday }, { data: request({ input: 200, output: 20, cached: 5000 }, 'gemini-4-neon', 2), step: 2, at: at(9) }]);
    const saved = path.join(root, 'day-usage.json');
    const make = () => new DayUsage(() => [], () => [{ model: 'gemini-4-neon', input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 }], () => now, saved, () => root);
    const usage = make(); await usage.refresh();
    // Today: 200 input and 20 output are new tokens; the 5,000 read from the cache are not. Priced with the rate given.
    expect(usage.totals()).toEqual({ day: localDay(now), claude: 0, codex: 0, gemini: 220, cost: (200 * 1 + 20 * 10 + 5000 * 0.1) / 1000000, complete: true });
    expect(usage.days().days[localDay(new Date(2026, 10, 21))].gemini).toMatchObject({ input: 1000, output: 100 });
    // The last request finishes with more output, and another follows: the first is not counted twice.
    const database = new DatabaseSync(file); database.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 1').run(request({ input: 200, output: 60, cached: 5000 }, 'gemini-4-neon', 2)); database.close();
    conversation(root, ID, [{ data: request({ input: 30, output: 3 }, 'gemini-4-neon', 4), step: 4, at: at(10) }]);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); (usage as unknown as { geminiReadAt: number }).geminiReadAt = 0;
    await usage.refresh(); expect(usage.totals().gemini).toBe(200 + 60 + 30 + 3);
    // What was counted is kept for the next start, which reads only what is new.
    await usage.save(); const again = make(); await again.refresh(); expect(again.totals().gemini).toBe(293);
  });
});

describe('a Gemini CLI run’s own usage', () => {
  const NEON = 'gemini-4-neon'; const OTHER = '99999999-2222-4333-8444-555555555555'; const THIRD = '77777777-2222-4333-8444-555555555555';
  const day = (date: number, hours: number) => Math.floor(new Date(2026, 10, date, hours).getTime() / 1000);
  const row = (input: number, output: number, step: number, at: number, cached = 0) => ({ data: request({ input, output, cached }, NEON, step), step, at });
  const seat = { engine: 'gemini' as const, chat: true, model: '' }; const terminal = { engine: 'gemini' as const, model: '' };
  const run = (runId: string, sessionId: string, cwd = 'C:/project') => ({ runId, sessionId, engine: 'gemini' as const, cwd, pid: 1, startedAt: new Date().toISOString() });
  function service(root: string, rates: PriceRate[] = []) {
    const published: UsageRecord[] = []; const telemetry = new TelemetryService(path.join(root, 'telemetry'), () => rates, (usage) => published.push(usage), () => {});
    telemetry.geminiHome = () => root; return { telemetry, published };
  }
  const tokens = (usage: UsageRecord | null | undefined) => usage ? newTokens(usage) : null;

  it('counts a seat’s requests from the conversation it says is its own, as each is written, and prices them', async () => {
    const root = home(); const { telemetry, published } = service(root, [{ model: NEON, input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 }]);
    telemetry.startGemini(run('r1', 's1') as never, seat as never);
    // Nothing is measured before the seat has a conversation: no record, which the bar shows as "—".
    expect(telemetry.runUsage('r1')).toBeNull();
    telemetry.setGeminiConversation('r1', ID); expect(telemetry.runUsage('r1')).toBeNull();
    conversation(root, ID, [row(200, 20, 0, day(22, 9), 5000)]);
    // The same conversation again is nothing new; the next read is what finds the row.
    telemetry.setGeminiConversation('r1', ID); expect(telemetry.runUsage('r1')).toBeNull();
    conversation(root, ID, [row(300, 30, 2, day(22, 10))]);
    await telemetry.end('r1');
    const usage = telemetry.runUsage('r1')!;
    expect(usage).toMatchObject({ engine: 'gemini', sessionId: 's1', conversationId: ID, model: NEON, input: 500, output: 50, cached: 5000, context: null, source: 'cli-logs', costBasis: 'configured-model-rates' });
    // New tokens leave the cache reads out, as the day's total does; the cost counts them at their own rate.
    expect(tokens(usage)).toBe(550); expect(usage.cost).toBeCloseTo((500 * 1 + 50 * 10 + 5000 * 0.1) / 1000000, 12);
    expect(published.at(-1)).toMatchObject({ runId: 'r1', input: 500, output: 50 });
    telemetry.close();
  });

  it('takes a seat’s context from what agy reports (usage_update: in use and the window), and makes none without a window', async () => {
    const root = home(); const { telemetry, published } = service(root);
    telemetry.startGemini(run('r1', 's1') as never, seat as never); telemetry.setGeminiConversation('r1', ID);
    // Reported before the first request is read: kept, and shown with the run's first record.
    telemetry.setContextWindow('r1', 1_048_576, 14_986); expect(telemetry.runUsage('r1')).toBeNull();
    conversation(root, ID, [row(14_746, 240, 0, day(22, 9))]); await telemetry.end('r1');
    expect(telemetry.runUsage('r1')?.context).toEqual({ used: 14_986, limit: 1_048_576 });
    // The next report is published at once, so the meter and the automatic handoff see it.
    const count = published.length; telemetry.setContextWindow('r1', 1_048_576, 900_000);
    expect(published).toHaveLength(count + 1); expect(published.at(-1)?.context).toEqual({ used: 900_000, limit: 1_048_576 });
    // The same again is nothing new; nonsense is ignored.
    telemetry.setContextWindow('r1', 1_048_576, 900_000); telemetry.setContextWindow('r1', 1_048_576, -1); telemetry.setContextWindow('r1', 0, 5); expect(published).toHaveLength(count + 1);
    // Another run that never reported a window has no context, as before.
    telemetry.startGemini(run('r2', 's2') as never, seat as never); telemetry.setGeminiConversation('r2', THIRD); conversation(root, THIRD, [row(10, 1, 0, day(22, 9))]); await telemetry.end('r2');
    expect(telemetry.runUsage('r2')?.context).toBeNull();
    telemetry.close();
  });

  it('counts a request once while it is still growing', async () => {
    const root = home(); const { telemetry } = service(root);
    telemetry.startGemini(run('r1', 's1') as never, seat as never);
    const file = conversation(root, ID, [row(100, 10, 0, day(22, 9))]); telemetry.setGeminiConversation('r1', ID);
    expect(tokens(telemetry.runUsage('r1'))).toBe(110);
    const database = new DatabaseSync(file); database.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(request({ input: 100, output: 90 }, NEON, 0)); database.close();
    conversation(root, ID, [row(40, 4, 2, day(22, 10))]);
    await telemetry.end('r1');
    expect(telemetry.runUsage('r1')).toMatchObject({ input: 140, output: 94, eventCount: 2 });
    telemetry.close();
  });

  it('counts only what a resumed conversation gains, and never a row an earlier run already counted', async () => {
    const root = home(); const { telemetry } = service(root);
    // The conversation has two requests from before Trace followed it.
    conversation(root, ID, [row(1000, 100, 0, day(22, 8)), row(2000, 200, 2, day(22, 9))]);
    telemetry.startGemini(run('r1', 's1') as never, { ...seat, resumeId: ID } as never);
    conversation(root, ID, [row(30, 3, 4, day(22, 10))]);
    await telemetry.end('r1'); expect(tokens(telemetry.runUsage('r1'))).toBe(33);
    // The channel restarts and resumes the same conversation: the second run adds only its own request.
    telemetry.startGemini(run('r2', 's1') as never, { ...seat, resumeId: ID } as never);
    conversation(root, ID, [row(50, 5, 6, day(22, 11))]);
    await telemetry.end('r2');
    expect(tokens(telemetry.runUsage('r1'))).toBe(33); expect(tokens(telemetry.runUsage('r2'))).toBe(55);
    // The channel's day is both runs: what the seat counter sums.
    expect(telemetry.list().filter((usage) => usage.sessionId === 's1').reduce((sum, usage) => sum + newTokens(usage), 0)).toBe(88);
    telemetry.close();
  });

  it('keeps the earlier conversation’s tokens when a seat restarts into a new one', async () => {
    const root = home(); const { telemetry } = service(root);
    telemetry.startGemini(run('r1', 's1') as never, seat as never); telemetry.setGeminiConversation('r1', ID);
    conversation(root, ID, [row(100, 10, 0, day(22, 9))]); await telemetry.end('r1');
    telemetry.startGemini(run('r2', 's1') as never, seat as never); telemetry.setGeminiConversation('r2', OTHER);
    conversation(root, OTHER, [row(7, 3, 0, day(22, 10))]); await telemetry.end('r2');
    expect(telemetry.list().filter((usage) => usage.sessionId === 's1').map(tokens).sort((a, b) => a! - b!)).toEqual([10, 110]);
    telemetry.close();
  });

  it('tells two seats in one folder apart by their conversations, and looks for none on their behalf', async () => {
    const root = home(); const { telemetry } = service(root); const looked: string[] = [];
    telemetry.findGeminiConversation = (cwd) => { looked.push(cwd); return OTHER; };
    telemetry.startGemini(run('r1', 's1') as never, seat as never); telemetry.startGemini(run('r2', 's2') as never, seat as never);
    telemetry.setGeminiConversation('r1', ID); telemetry.setGeminiConversation('r2', OTHER);
    conversation(root, ID, [row(100, 10, 0, day(22, 9))]); conversation(root, OTHER, [row(7, 3, 0, day(22, 9))]);
    await telemetry.end('r1'); await telemetry.end('r2');
    expect(tokens(telemetry.runUsage('r1'))).toBe(110); expect(tokens(telemetry.runUsage('r2'))).toBe(10); expect(looked).toEqual([]);
    telemetry.close();
  });

  it('counts each request on the day it was made, across midnight and after a resume', async () => {
    const root = home(); const { telemetry } = service(root);
    conversation(root, ID, [row(1000, 100, 0, day(21, 20))]);
    telemetry.startGemini(run('r1', 's1') as never, { ...seat, resumeId: ID } as never);
    conversation(root, ID, [row(10, 1, 2, day(21, 23)), row(20, 2, 4, day(22, 1))]);
    await telemetry.end('r1');
    const days = telemetry.runUsage('r1')!.days!;
    expect(Object.fromEntries(Object.entries(days).map(([key, used]) => [key, used.tokens]))).toEqual({ [localDay(new Date(2026, 10, 21))]: 11, [localDay(new Date(2026, 10, 22))]: 22 });
    telemetry.close();
  });

  it('finds a terminal’s new conversation once there is exactly one, and takes the one Gemini CLI names on quitting', async () => {
    const root = home(); const { telemetry } = service(root);
    // One that was there before the run is never taken for the run's own.
    conversation(root, OTHER, [row(999, 99, 0, day(22, 7))]);
    let found: string | null = null; const asked: ReadonlySet<string>[] = [];
    telemetry.findGeminiConversation = (_cwd, _since, known) => { asked.push(known); return found; };
    telemetry.startGemini(run('r1', 's1') as never, terminal as never);
    conversation(root, ID, [row(100, 10, 0, day(22, 9))]);
    // Not told apart yet (two channels in one folder, say): nothing is counted, and nothing guessed.
    await telemetry.end('r1'); expect(telemetry.runUsage('r1')).toBeNull(); expect(asked[0]?.has(OTHER)).toBe(true);
    // The next run's is found by the look.
    telemetry.startGemini(run('r2', 's1') as never, terminal as never);
    found = THIRD; conversation(root, THIRD, [row(5, 5, 0, day(22, 9)), row(50, 5, 2, day(22, 10))]); await telemetry.end('r2');
    // A conversation made since the run started is the run's from its first row.
    expect(tokens(telemetry.runUsage('r2'))).toBe(65);
    // And a run told its conversation as Gemini CLI quits counts it without a look.
    found = null; telemetry.startGemini(run('r3', 's2') as never, terminal as never);
    const NEW = '66666666-2222-4333-8444-555555555555'; conversation(root, NEW, [row(5, 5, 0, day(22, 9))]);
    telemetry.setGeminiConversation('r3', NEW); await telemetry.end('r3');
    expect(tokens(telemetry.runUsage('r3'))).toBe(10);
    telemetry.close();
  });

  it('agrees with the day’s total for the same requests, which stays the one count of the day', async () => {
    const root = home(); const now = new Date(2026, 10, 22, 15); const { telemetry } = service(root);
    telemetry.startGemini(run('r1', 's1') as never, seat as never); telemetry.setGeminiConversation('r1', ID);
    conversation(root, ID, [row(200, 20, 0, day(22, 9), 5000), row(300, 30, 2, day(22, 10))]); await telemetry.end('r1');
    const logs = new DayUsage(() => [], () => [], () => now, null, () => root); await logs.refresh();
    const today = logs.totals(); const runs = telemetry.list().reduce((sum, usage) => sum + (usage.days?.[localDay(now)]?.tokens ?? 0), 0);
    // The seat's counter and the day's total read the same rows: equal here, and Today takes the day's, never their sum.
    expect(runs).toBe(550); expect(today.gemini).toBe(550); expect(dayTotal(today, { tokens: runs, cost: null }, now).tokens).toBe(550);
    telemetry.close();
  });

  it('takes a conversation as changed when only its write-ahead log is newer', () => {
    const root = home(); const file = conversation(root, ID, [row(1, 1, 0, day(22, 9))]);
    const before = geminiUsageFiles(root, 0)[0].mtime; const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(file + '-wal', ''); fs.utimesSync(file + '-wal', later, later);
    expect(geminiUsageFiles(root, 0)[0].mtime).toBeGreaterThan(before); expect(geminiUsageFiles(root, before + 30_000)).toHaveLength(1);
  });
});
