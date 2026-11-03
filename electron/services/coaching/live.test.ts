import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coachable, promptTips, type LiveTip } from '../../../shared/coaching';
import type { AgentRunningSession } from '../../../shared/ipc';
import type { CLIEngineConfig } from '../../../shared/types';
import { conversationTurn, LiveCoach, REVIEW_ARGS, reviewInput } from './live';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const run = (cwd = '/repo', runId = 'run-1'): AgentRunningSession => ({ sessionId: 'session-1', runId, engine: 'claude', pid: 1, cwd });
const config = (resumeId?: string) => ({ engine: 'claude', model: '', ...(resumeId ? { resumeId } : {}) }) as unknown as CLIEngineConfig;
const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
function coach() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-live-')); roots.push(root);
  const published: LiveTip[] = []; const review = vi.fn(async () => ({ advice: 'Name the page.', rewrite: 'Fix the sign-in page.' }));
  const live = new LiveCoach(root, (tip) => published.push(structuredClone(tip)), async () => ({ executable: { file: 'claude', prefixArgs: [], extraEnv: {}, displayPath: 'claude' }, env: {} }), review);
  return { root, live, published, review };
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
  it('asks Claude Haiku with no tools, no MCP servers and no saved session', () => {
    expect(REVIEW_ARGS).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--no-session-persistence', '--strict-mcp-config', '--json-schema']));
    expect(REVIEW_ARGS[REVIEW_ARGS.indexOf('--tools') + 1]).toBe('');
  });
});
