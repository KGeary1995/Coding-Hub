import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coachable, promptTips, type LiveTip } from '../../../shared/coaching';
import type { AgentRunningSession } from '../../../shared/ipc';
import type { CLIEngineConfig } from '../../../shared/types';
import { conversationTurn, LiveCoach, REVIEW_ARGS, reviewInput, runCodexReview } from './live';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const run = (cwd = '/repo', runId = 'run-1'): AgentRunningSession => ({ sessionId: 'session-1', runId, engine: 'claude', pid: 1, cwd });
const config = (resumeId?: string) => ({ engine: 'claude', model: '', ...(resumeId ? { resumeId } : {}) }) as unknown as CLIEngineConfig;
const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
function coach() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-live-')); roots.push(root);
  const published: LiveTip[] = []; const review = vi.fn(async () => ({ advice: 'Name the page.', rewrite: 'Fix the sign-in page.' })); const codexReview = vi.fn(async () => ({ advice: 'From Codex.', rewrite: 'x' }));
  const installed = new Set(['claude', 'codex']);
  const live = new LiveCoach(root, (tip) => published.push(structuredClone(tip)), async (engine) => installed.has(engine) ? { executable: { file: engine, prefixArgs: [], extraEnv: {}, displayPath: engine }, env: {} } : null, review, codexReview);
  return { root, live, published, review, codexReview, installed };
}

describe('local prompt tips', () => {
  it('leave slash commands and short follow-ups alone', () => {
    expect(coachable('/compact', true)).toBe(false); expect(coachable('yes do it', false)).toBe(false); expect(coachable('fix it', true)).toBe(true);
    expect(promptTips('yes, go ahead', false)).toEqual([]);
  });
  it('ask a thin first prompt for a goal, scope and finish line', () => { expect(promptTips('fix the login', true)[0]).toMatch(/little to go on/); });
  it('ask for the error text when a problem has none, but not when it is pasted', () => {
    expect(promptTips('The settings page is broken after the last change, can you take a look at what happened there', false).join(' ')).toMatch(/exact error/);
    expect(promptTips('The settings page is broken: TypeError: cannot read properties of undefined at Settings.tsx:42', false).join(' ')).not.toMatch(/exact error/);
  });
  it('ask a task how success will be checked', () => {
    expect(promptTips('Please add a dark mode toggle to the settings screen next to the font size option', false)).toContain('Say how you\'ll know it worked: the behavior you expect, or a test or command that should pass.');
    expect(promptTips('Please add a dark mode toggle to the settings screen; the existing tests should still pass', false).join(' ')).not.toMatch(/know it worked/);
  });
  it('give at most two tips', () => { expect(promptTips('it is broken, make it better and add tests\n1. a\n2. b\n3. c\n4. d', true).length).toBeLessThanOrEqual(2); });
});

describe('conversation turns from CLI transcripts', () => {
  it('read what the person sent and what Claude said, skipping tool results and context the CLI adds', () => {
    expect(conversationTurn('claude', user('Add a footer'))).toEqual({ role: 'user', text: 'Add a footer' });
    expect(conversationTurn('claude', user([{ type: 'text', text: 'Look at this' }, { type: 'image', source: {} }]))).toEqual({ role: 'user', text: 'Look at this' });
    expect(conversationTurn('claude', user([{ type: 'tool_result', content: 'ok' }]))).toBeNull();
    expect(conversationTurn('claude', user('<command-name>/model</command-name>'))).toBeNull();
    expect(conversationTurn('claude', user('[Request interrupted by user]'))).toBeNull();
    expect(conversationTurn('claude', { ...user('subagent prompt'), isSidechain: true })).toBeNull();
    expect(conversationTurn('claude', assistant('Done.'))).toEqual({ role: 'assistant', text: 'Done.' });
  });
  it('read Codex user and agent messages', () => {
    expect(conversationTurn('codex', { type: 'event_msg', payload: { type: 'user_message', message: 'Add a footer' } })).toEqual({ role: 'user', text: 'Add a footer' });
    expect(conversationTurn('codex', { type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } })).toEqual({ role: 'assistant', text: 'Done.' });
    expect(conversationTurn('codex', { type: 'response_item', payload: { role: 'user', content: [] } })).toBeNull();
  });
});

describe('live coaching', () => {
  it('keeps coached prompts across restarts for 30 days, sums up the last 7, and forgets them on Clear', () => {
    const { root, live } = coach();
    live.observe(run(), config(), user('fix the login'));
    live.observe(run(), config(), assistant('Which page?'));
    live.observe(run(), config(), user('Please add a dark mode toggle to the settings screen next to the font size option'));
    expect(live.list().week).toEqual({ prompts: 2, coached: 2, reviewed: 0, kinds: { thin: 1, check: 1 } });
    const later = new LiveCoach(root, () => {}, async () => null, undefined, undefined, () => new Date(Date.now() + 3 * 86400000));
    expect(later.list().tips.map((tip) => tip.prompt)).toEqual(['Please add a dark mode toggle to the settings screen next to the font size option', 'fix the login']);
    const muchLater = new LiveCoach(root, () => {}, async () => null, undefined, undefined, () => new Date(Date.now() + 10 * 86400000));
    expect(muchLater.list().tips).toHaveLength(2); expect(muchLater.list().week.prompts).toBe(0);
    expect(new LiveCoach(root, () => {}, async () => null, undefined, undefined, () => new Date(Date.now() + 31 * 86400000)).list().tips).toEqual([]);
    later.clear(); expect(new LiveCoach(root, () => {}, async () => null).list().tips).toEqual([]);
  });
  it('coaches each prompt with local tips, treats the first prompt of a new conversation as first, and keeps the reply before it for a review', async () => {
    const { live, published, review } = coach();
    live.observe(run(), config(), user('fix the login'));
    expect(published).toHaveLength(1); expect(published[0].tips[0]).toMatch(/little to go on/); expect(published[0].sessionId).toBe('session-1');
    live.observe(run(), config(), assistant('Which login page, the admin one or the customer one?'));
    live.observe(run(), config(), user('ok'));
    expect(published).toHaveLength(1);
    live.observe(run(), config(), user('The customer one, it shows an error when the password has a space in it'));
    const tip = published[1]; expect(tip.tips.join(' ')).toMatch(/exact error/);
    const reviewed = await live.ask(tip.id);
    expect(reviewed.review).toEqual({ advice: 'Name the page.', rewrite: 'Fix the sign-in page.' }); expect(published.at(-1)!.review).not.toBeNull();
    expect((review.mock.calls[0] as unknown[])[2]).toBe(reviewInput(tip.prompt, 'Which login page, the admin one or the customer one?'));
    // Asking again does not ask Claude again.
    await live.ask(tip.id); expect(review).toHaveBeenCalledTimes(1);
  });
  it('treats a resumed conversation\'s first prompt as a follow-up', () => {
    const { live, published } = coach();
    live.observe(run(), config('3f1c2c8e-0000-4000-8000-000000000000'), user('ok'));
    expect(published).toHaveLength(0);
  });
  it('can be turned off, and never coaches Trace\'s own coaching channels', () => {
    const { live, published, root } = coach();
    live.observe(run(path.join(root, 'report')), config(), user('Read COACHING_REPORT.md and coach me'));
    expect(published).toHaveLength(0);
    expect(live.setEnabled(false).enabled).toBe(false);
    live.observe(run(), config(), user('Add a footer to every page with the version number'));
    expect(published).toHaveLength(0); expect(live.list().enabled).toBe(false);
  });
  it('reads its on/off switch from disk once, not on every check', () => {
    const { live } = coach(); const reads = vi.spyOn(fs, 'readFileSync');
    try { for (let i = 0; i < 5; i++) live.latest('channel'); expect(reads.mock.calls.filter(([file]) => String(file).endsWith('live.json')).length).toBeLessThanOrEqual(1); live.setEnabled(false); expect(live.enabled()).toBe(false); }
    finally { reads.mockRestore(); }
  });
  it('has Claude review every prompt, Codex channels too, and Codex only when Claude Code is not installed', async () => {
    const { live, published, review, codexReview, installed } = coach(); const codexRun = { ...run(), engine: 'codex' as const, runId: 'run-2' };
    live.observe(codexRun, { engine: 'codex', model: '' } as unknown as CLIEngineConfig, { type: 'event_msg', payload: { type: 'user_message', message: 'fix the login' } });
    expect((await live.ask(published[0].id)).review?.advice).toBe('Name the page.'); expect(codexReview).not.toHaveBeenCalled();
    installed.delete('claude'); live.observe({ ...codexRun, runId: 'run-3' }, { engine: 'codex', model: '' } as unknown as CLIEngineConfig, { type: 'event_msg', payload: { type: 'user_message', message: 'fix the signup' } });
    expect((await live.ask(published.at(-1)!.id)).review?.advice).toBe('From Codex.'); expect(review).toHaveBeenCalledTimes(1);
    expect(live.latest('session-1')?.prompt).toBe('fix the signup');
  });
  it('asks Claude Haiku with no tools and no MCP servers, keeping its session so its usage is counted', () => {
    expect(REVIEW_ARGS).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--strict-mcp-config', '--json-schema'])); expect(REVIEW_ARGS).not.toContain('--no-session-persistence');
    expect(REVIEW_ARGS[REVIEW_ARGS.indexOf('--tools') + 1]).toBe('');
  });
  describe('Codex review without the user config', () => {
    // A fake codex: logs its arguments, and answers by writing the file named after -o.
    const fake = () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-codex-')); roots.push(root); const script = path.join(root, 'codex.cjs'); const log = path.join(root, 'args.json');
      fs.writeFileSync(script, `const fs = require('fs'); const a = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(a)); fs.writeFileSync(a[a.indexOf('-o') + 1], JSON.stringify({ advice: 'ok', rewrite: 'ok' })); process.stdin.resume();`);
      return { root, executable: { file: process.execPath, prefixArgs: [script], extraEnv: {}, displayPath: script }, args: (): string[] => JSON.parse(fs.readFileSync(log, 'utf8')) };
    };
    const help = (text: string) => vi.fn(async (_executable?: unknown, _args?: string[]) => ({ stdout: text, stderr: '', exitCode: 0, timedOut: false }));
    it('passes --ignore-user-config only when `codex exec --help` lists it, and reads the help once per Codex', async () => {
      const { root, executable, args } = fake(); const probe = help('Options:\n      --ignore-user-config  Do not load config.toml\n');
      await runCodexReview(executable, {}, 'input', root, probe); expect(args().slice(0, 2)).toEqual(['exec', '--ignore-user-config']);
      await runCodexReview(executable, {}, 'input', root, probe); expect(probe).toHaveBeenCalledTimes(1); expect(probe.mock.calls[0][1]).toEqual(['exec', '--help']);
      const old = fake(); const oldProbe = help('Options:\n  -s, --sandbox <MODE>\n');
      await runCodexReview(old.executable, {}, 'input', old.root, oldProbe); expect(old.args()).not.toContain('--ignore-user-config'); expect(old.args()).toContain('--skip-git-repo-check');
    });
    it('leaves the flag out, and asks again next time, when the help could not be read', async () => {
      const { root, executable, args } = fake(); const probe = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }));
      await runCodexReview(executable, {}, 'input', root, probe); expect(args()).not.toContain('--ignore-user-config');
      await runCodexReview(executable, {}, 'input', root, probe); expect(probe).toHaveBeenCalledTimes(2);
    });
  });
});
