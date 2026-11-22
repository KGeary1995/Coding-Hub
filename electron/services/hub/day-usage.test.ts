import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DayUsage } from './day-usage';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const now = new Date(2026, 10, 2, 15, 0); const earlier = new Date(2026, 10, 1, 22, 0);
const reply = (id: string, at: Date, input: number, output: number, cached = 0) => JSON.stringify({ type: 'assistant', timestamp: at.toISOString(), message: { id, model: 'claude-opus', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cached } } }) + '\n';
const total = (at: Date, input: number, cached: number, output: number) => JSON.stringify({ type: 'event_msg', timestamp: at.toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } }) + '\n';
function homes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-day-')); roots.push(root);
  const claude = path.join(root, 'claude'); const project = path.join(claude, 'projects', 'C--work'); fs.mkdirSync(path.join(project, 'conv', 'subagents'), { recursive: true });
  const codex = path.join(root, 'codex'); const sessions = path.join(codex, 'sessions', '2026', '11', '01'); fs.mkdirSync(sessions, { recursive: true });
  return { claude, project, codex, sessions };
}

describe("today's usage from the CLIs' own logs", () => {
  it('counts Claude replies once, on the day they were written, with subagents, and Codex by what its total gained today', async () => {
    const { claude, project, codex, sessions } = homes();
    // Yesterday's reply, today's replies (one written twice, as Claude Code does for a reply with several parts), a subagent's.
    fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('old', earlier, 500, 500) + reply('a', now, 10, 100, 9000) + reply('a', now, 10, 100, 9000) + reply('b', now, 5, 50));
    fs.writeFileSync(path.join(project, 'conv', 'subagents', 'agent-x1.jsonl'), reply('s', now, 1, 2));
    // A resumed conversation's copy of an earlier reply does not count again.
    fs.writeFileSync(path.join(project, 'other.jsonl'), reply('a', now, 10, 100));
    // A Codex session from yesterday that went on today: 1,000 new input (300 of it cached) and 40 output today.
    fs.writeFileSync(path.join(sessions, 'rollout-1.jsonl'), JSON.stringify({ type: 'turn_context', payload: { model: 'a-model-with-no-price' } }) + '\n' + total(earlier, 2000, 1000, 100) + total(now, 3000, 1300, 140));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }, { engine: 'codex', root: codex }], () => [{ model: 'claude-opus', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }], () => now);
    await usage.refresh(); expect(usage.totals()).toEqual({ day: '2026-11-02', claude: 168, codex: 740, cost: 168 / 1000000, complete: true });
    // More is written: only that is read.
    fs.appendFileSync(path.join(project, 'conv.jsonl'), reply('c', now, 2, 2)); fs.appendFileSync(path.join(sessions, 'rollout-1.jsonl'), total(now, 3100, 1300, 150));
    await usage.refresh(); expect(usage.totals()).toMatchObject({ claude: 172, codex: 850 });
  });
  it('starts over on a new day, and leaves out logs that did not change today', async () => {
    const { claude, project } = homes(); let clock = now;
    fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('a', now, 10, 10));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }], () => [], () => clock);
    await usage.refresh(); expect(usage.totals().claude).toBe(20);
    clock = new Date(2026, 10, 3, 9, 0); expect(usage.totals()).toMatchObject({ day: '2026-11-03', claude: 0 });
  });
  it('counts the agents a workflow started, which Claude Code writes two folders further down, and not its other files', async () => {
    const { claude, project } = homes(); const run = path.join(project, 'conv', 'subagents', 'workflows', 'run-1'); fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('main', now, 1, 1));
    fs.writeFileSync(path.join(run, 'agent-w1.jsonl'), reply('w1', now, 10, 100)); fs.writeFileSync(path.join(run, 'journal.jsonl'), reply('journal', now, 5000, 5000));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }], () => [], () => now);
    await usage.refresh(); expect(usage.totals().claude).toBe(112);
  });
  it('answers at once from what was read, and says it is not complete while a read runs', async () => {
    const { claude, project } = homes(); fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('a', now, 10, 10));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }], () => [], () => now);
    expect(usage.totals()).toMatchObject({ claude: 0, complete: false });
    await usage.refresh(); expect(usage.totals()).toMatchObject({ claude: 20, complete: true });
  });
  it('saves where it read to, so the next start reads only what the logs gained', async () => {
    const { claude, project, codex, sessions } = homes(); const saved = path.join(path.dirname(claude), 'storage', 'day-usage.json');
    fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('a', now, 10, 100)); fs.writeFileSync(path.join(sessions, 'rollout-1.jsonl'), total(earlier, 2000, 1000, 100) + total(now, 3000, 1300, 140));
    const sources = () => [{ engine: 'claude' as const, root: claude }, { engine: 'codex' as const, root: codex }];
    const first = new DayUsage(sources, () => [], () => now, saved); await first.refresh(); expect(first.totals()).toMatchObject({ claude: 110, codex: 740 });
    expect(JSON.parse(fs.readFileSync(saved, 'utf8')).version).toBe(1);
    // Trace starts again: nothing changed, so no log is opened, and the totals are as they were.
    const open = vi.spyOn(fs.promises, 'open'); const second = new DayUsage(sources, () => [], () => now, saved); await second.refresh();
    expect(open).not.toHaveBeenCalled(); expect(second.totals()).toMatchObject({ claude: 110, codex: 740 });
    // What the logs gained is read, once (a reply seen before the restart is not counted again).
    fs.appendFileSync(path.join(project, 'conv.jsonl'), reply('a', now, 10, 100) + reply('b', now, 1, 1)); fs.appendFileSync(path.join(sessions, 'rollout-1.jsonl'), total(now, 3100, 1300, 150));
    await second.refresh(); expect(second.totals()).toMatchObject({ claude: 112, codex: 850 });
  });
  it('reads the logs again when what was saved is unreadable', async () => {
    const { claude, project } = homes(); const saved = path.join(path.dirname(claude), 'day-usage.json'); fs.writeFileSync(saved, '{"version":1,"files":{"x":{"offset":-4}}');
    fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('a', now, 10, 10));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }], () => [], () => now, saved); await usage.refresh();
    expect(usage.totals().claude).toBe(20);
    fs.writeFileSync(saved, JSON.stringify({ version: 1, files: { [path.join(project, 'conv.jsonl')]: { offset: 'x', model: 'm', total: [0, 0, 0, 0] } }, used: {}, seen: {} }));
    const again = new DayUsage(() => [{ engine: 'claude', root: claude }], () => [], () => now, saved); await again.refresh(); expect(again.totals().claude).toBe(20);
  });
  it('does not count a Codex session again when its log is rewritten shorter', async () => {
    const { codex, sessions } = homes(); const file = path.join(sessions, 'rollout-1.jsonl');
    fs.writeFileSync(file, total(now, 1000, 0, 100) + total(now, 2000, 0, 200));
    const usage = new DayUsage(() => [{ engine: 'codex', root: codex }], () => [], () => now); await usage.refresh(); expect(usage.totals().codex).toBe(2200);
    fs.writeFileSync(file, total(now, 2000, 0, 200)); await usage.refresh(); expect(usage.totals().codex).toBe(2200);
  });
  it('does not count a Codex session again when its log is missing from one listing, also after a restart', async () => {
    const { codex, sessions } = homes(); const file = path.join(sessions, 'rollout-1.jsonl'); const away = path.join(path.dirname(codex), 'away.jsonl'); const saved = path.join(path.dirname(codex), 'day-usage.json');
    fs.writeFileSync(file, total(now, 1000, 0, 100) + total(now, 2000, 0, 200));
    const sources = () => [{ engine: 'codex' as const, root: codex }];
    const usage = new DayUsage(sources, () => [], () => now, saved); await usage.refresh(); expect(usage.totals().codex).toBe(2200);
    fs.renameSync(file, away); await usage.refresh(); expect(usage.totals().codex).toBe(2200); await usage.save();
    fs.renameSync(away, file); await usage.refresh(); expect(usage.totals().codex).toBe(2200);
    // Saved while it was missing, and read again after a restart.
    fs.renameSync(file, away); const restarted = new DayUsage(sources, () => [], () => now, saved); await restarted.refresh(); await restarted.save();
    fs.renameSync(away, file); const again = new DayUsage(sources, () => [], () => now, saved); await again.refresh(); expect(again.totals().codex).toBe(2200);
  });
  it('gives a caller that asks once current numbers, but does not wait for a long read', async () => {
    const { claude, project } = homes(); fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('a', now, 10, 10));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }], () => [], () => now); await usage.refresh();
    fs.appendFileSync(path.join(project, 'conv.jsonl'), reply('b', now, 1, 1)); (usage as unknown as { readAt: number }).readAt = 0;
    await usage.settled(); expect(usage.totals()).toMatchObject({ claude: 22, complete: true });
    (usage as unknown as { readAt: number }).readAt = 0; vi.spyOn(fs.promises, 'readdir').mockReturnValue(new Promise(() => {}) as never);
    const started = Date.now(); await usage.settled(50); expect(Date.now() - started).toBeLessThan(1000); expect(usage.totals()).toMatchObject({ claude: 22, complete: false });
  });
  it('leaves no temporary file behind when a save fails', async () => {
    const { claude, project } = homes(); const saved = path.join(path.dirname(claude), 'day-usage.json'); fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('a', now, 10, 10));
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('Held by another program.'));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }], () => [], () => now, saved); await usage.refresh();
    expect(fs.readdirSync(path.dirname(saved)).filter((name) => name.startsWith('day-usage'))).toEqual([]);
    await usage.save(); expect(fs.readdirSync(path.dirname(saved)).filter((name) => name.startsWith('day-usage'))).toEqual(['day-usage.json']);
  });
  it('keeps no more of a log in memory than its unfinished last line, and forgets replies older than the window', async () => {
    const { claude, project } = homes(); let clock = now;
    fs.writeFileSync(path.join(project, 'conv.jsonl'), (JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } }) + '\n').repeat(1500) + reply('a', now, 10, 10));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }], () => [], () => clock); await usage.refresh();
    const inside = usage as unknown as { files: Map<string, { partial: Buffer }>; seen: Map<string, string> };
    for (const state of inside.files.values()) expect(state.partial.buffer.byteLength).toBeLessThan(64 * 1024);
    expect(inside.seen.size).toBe(1);
    clock = new Date(2027, 5, 1, 9, 0); await usage.refresh(); expect(inside.seen.size).toBe(0); expect(inside.files.size).toBe(0);
  });
});
