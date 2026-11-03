import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DayUsage } from './day-usage';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
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
  it('counts Claude replies once, on the day they were written, with subagents, and Codex by what its total gained today', () => {
    const { claude, project, codex, sessions } = homes();
    // Yesterday's reply, today's replies (one written twice, as Claude Code does for a reply with several parts), a subagent's.
    fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('old', earlier, 500, 500) + reply('a', now, 10, 100, 9000) + reply('a', now, 10, 100, 9000) + reply('b', now, 5, 50));
    fs.writeFileSync(path.join(project, 'conv', 'subagents', 'agent-x1.jsonl'), reply('s', now, 1, 2));
    // A resumed conversation's copy of an earlier reply does not count again.
    fs.writeFileSync(path.join(project, 'other.jsonl'), reply('a', now, 10, 100));
    // A Codex session from yesterday that went on today: 1,000 new input (300 of it cached) and 40 output today.
    fs.writeFileSync(path.join(sessions, 'rollout-1.jsonl'), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }) + '\n' + total(earlier, 2000, 1000, 100) + total(now, 3000, 1300, 140));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }, { engine: 'codex', root: codex }], () => [{ model: 'claude-opus', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }], () => now);
    expect(usage.totals()).toEqual({ day: '2026-11-02', claude: 168, codex: 740, cost: 168 / 1000000, complete: true });
    // More is written: only that is read.
    fs.appendFileSync(path.join(project, 'conv.jsonl'), reply('c', now, 2, 2)); fs.appendFileSync(path.join(sessions, 'rollout-1.jsonl'), total(now, 3100, 1300, 150));
    expect(usage.totals()).toMatchObject({ claude: 172, codex: 850 });
  });
  it('starts over on a new day, and leaves out logs that did not change today', () => {
    const { claude, project } = homes(); let clock = now;
    fs.writeFileSync(path.join(project, 'conv.jsonl'), reply('a', now, 10, 10));
    const usage = new DayUsage(() => [{ engine: 'claude', root: claude }], () => [], () => clock);
    expect(usage.totals().claude).toBe(20);
    clock = new Date(2026, 10, 3, 9, 0); expect(usage.totals()).toMatchObject({ day: '2026-11-03', claude: 0 });
  });
});
