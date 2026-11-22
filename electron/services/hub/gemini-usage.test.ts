import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localDay } from '../../../shared/hub';
import { DayUsage } from './day-usage';
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
