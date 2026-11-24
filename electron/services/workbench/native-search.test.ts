import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProfiles } from '../cli/claude-profiles';
import { NativeSessions, SEARCH_LIMITS } from './native-sessions';
import type { NativeSearch } from '../../../shared/workbench';
import { writeGeminiConversation } from '../chat/gemini-conversation.fixture';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });
/** A Claude home and a Codex home with conversations written in each CLI's own transcript shape (as in transcript.test.ts). */
function homes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-search-')); roots.push(root); const claude = path.join(root, 'claude'); const codex = path.join(root, 'codex'); vi.stubEnv('CODEX_HOME', codex);
  const project = path.join(root, 'project'); let at = 1_000_000;
  const write = (file: string, lines: unknown[]) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n'); at += 1000; fs.utimesSync(file, at, at); };
  const claudeChat = (lines: unknown[]) => { const id = randomUUID(); write(path.join(claude, 'projects', 'project', `${id}.jsonl`), [{ type: 'user', cwd: project, sessionId: id, message: { role: 'user', content: '<command-name>/clear</command-name>' } }, ...lines]); return id; };
  const codexChat = (lines: unknown[]) => { const id = randomUUID(); write(path.join(codex, 'sessions', '2026', '11', '24', `rollout-${id}.jsonl`), [{ type: 'session_meta', payload: { id, cwd: project } }, ...lines]); return id; };
  return { root, claude, claudeChat, codexChat, sessions: () => new NativeSessions(new ClaudeProfiles(root), [], claude) };
}
const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const reply = (id: string, content: unknown[]) => ({ type: 'assistant', message: { id, content } });
const codexSaid = (role: 'user' | 'assistant', text: string) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

describe('searching inside CLI conversations', () => {
  it('finds words in both CLIs\' messages, ignoring case, newest first, with marked snippets on one line', async () => {
    const { claudeChat, codexChat, sessions } = homes();
    const older = claudeChat([user('Please fix the Flaky Login test.'), reply('m1', [{ type: 'thinking', thinking: 'flaky login thoughts' }, { type: 'text', text: `${'a'.repeat(100)}\nThe flaky login\nwas a race in the session ${'b'.repeat(100)}` }])]);
    const newer = codexChat([codexSaid('user', '<environment_context>flaky login</environment_context>'), codexSaid('user', 'FLAKY LOGIN again on CI'), { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["grep","flaky login"]}' } }, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'flaky login' } }]);
    const found = await sessions().search('flaky LOGIN');
    expect(found).toMatchObject({ query: 'flaky LOGIN', partial: false, skipped: 0 });
    expect(found.results.map((item) => item.id)).toEqual([newer, older]);
    // Codex: the user's own message only, not the context it adds, the command it ran or what that printed.
    expect(found.results[0]).toMatchObject({ engine: 'codex', matches: 1, snippets: [{ role: 'user', before: '', match: 'FLAKY LOGIN', after: ' again on CI' }] });
    // Claude: the person's message and the reply's text, not its thinking; the snippet is cut to the words around the hit, on one line.
    const claude = found.results[1]; expect(claude).toMatchObject({ engine: 'claude', matches: 2, key: `claude:default:${older}` });
    expect(claude.snippets[0]).toEqual({ role: 'user', before: 'Please fix the ', match: 'Flaky Login', after: ' test.' });
    expect(claude.snippets[1]).toMatchObject({ role: 'assistant', match: 'flaky login' }); expect(claude.snippets[1].before).toMatch(/^…a+ The $/); expect(claude.snippets[1].after).toMatch(/^ was a race in the session b+…$/);
    expect(JSON.stringify(claude.snippets)).not.toContain('\\n'); expect(claude.snippets[1].before.length + claude.snippets[1].after.length).toBeLessThanOrEqual(150);
  });
  it('leaves out tool calls and their output, and shows at most three snippets however often the words appear', async () => {
    const { claudeChat, sessions } = homes();
    claudeChat([user('List the files.'), reply('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo zebra' } }]), user([{ type: 'tool_result', tool_use_id: 't1', content: 'zebra.txt' }])]);
    const often = claudeChat(Array.from({ length: 5 }, (_, index) => user(`Quoted "needle" ${index} and "needle" again`)));
    const search = sessions(); expect((await search.search('zebra')).results).toEqual([]);
    // Quotes are written escaped in the transcript; the words are still found.
    const found = await search.search('"needle"'); expect(found.results).toHaveLength(1); expect(found.results[0]).toMatchObject({ id: often, matches: 10 }); expect(found.results[0].snippets).toHaveLength(3);
  });
  it('stops at its limits and says so, skips files that are too large, and checks what it is asked', async () => {
    const { claudeChat, codexChat, sessions } = homes();
    claudeChat([user('common words here')]); const big = codexChat([codexSaid('user', `common words ${'x'.repeat(4000)}`)]); const newest = claudeChat([user('Common words, newest')]);
    const search = sessions();
    const limited = await search.search('common words', { ...SEARCH_LIMITS, results: 1 }); expect(limited.partial).toBe(true); expect(limited.results.map((item) => item.id)).toEqual([newest]);
    expect(await search.search('common words', { ...SEARCH_LIMITS, ms: 0 })).toMatchObject({ results: [], partial: true });
    const skipping = await search.search('common words', { ...SEARCH_LIMITS, bytes: 1000 }); expect(skipping).toMatchObject({ partial: false, skipped: 1 }); expect(skipping.results.some((item) => item.id === big)).toBe(false); expect(skipping.results).toHaveLength(2);
    expect(((await search.execute({ action: 'native-search', query: '  common words  ' })) as NativeSearch).results).toHaveLength(3);
    await expect(search.execute({ action: 'native-search', query: 'c' })).rejects.toThrow('at least 2 characters');
    await expect(search.execute({ action: 'native-search', query: 'x'.repeat(201) })).rejects.toThrow();
    await expect(search.execute({ action: 'native-search', query: 'common', extra: true })).rejects.toThrow();
  });
  it('finds words in Gemini\'s conversations too, in what was said only, alongside the other CLIs\' and within the size limit', async () => {
    const { root, claude, claudeChat } = homes(); const gemini = path.join(root, 'gemini'); const project = path.join(root, 'project');
    const said = writeGeminiConversation(gemini, [{ input: 'Where is the Zebra crossing set up?' }, { thinking: 'zebra thoughts', tools: [{ id: 'c1', name: 'run_command', input: '{"CommandLine":"rg zebra"}' }] }, { toolOutput: 'zebra.ts:1' }, { reply: `${'a'.repeat(100)} The zebra crossing is in map.ts.` }]);
    const unsaid = writeGeminiConversation(gemini, [{ input: 'Run the tests.' }, { thinking: 'zebra', tools: [{ id: 'c2', name: 'run_command', input: '{"CommandLine":"echo zebra"}' }] }, { toolOutput: 'zebra' }, { agentMessage: 'zebra' }]);
    const missing = path.join(gemini, 'conversations', `${randomUUID()}.db`); const older = claudeChat([user('A zebra in Claude.')]);
    const conversations = [{ file: said, at: 3e12 }, { file: unsaid, at: 2.5e12 }, { file: missing, at: 2e12 }].map(({ file, at }) => ({ id: path.basename(file, '.db'), directory: project, modified: at, file }));
    const sessions = (bytes = SEARCH_LIMITS.bytes) => new NativeSessions(new ClaudeProfiles(root), [], claude, { list: () => conversations, file: () => undefined }).search('ZEBRA', { ...SEARCH_LIMITS, bytes });
    const found = await sessions();
    expect(found.results.map((item) => item.id)).toEqual([path.basename(said, '.db'), older]);
    expect(found.results[0]).toMatchObject({ engine: 'gemini', key: `gemini:default:${path.basename(said, '.db')}`, directory: project, matches: 2, snippets: [{ role: 'user', before: 'Where is the ', match: 'Zebra', after: ' crossing set up?' }, { role: 'assistant', match: 'zebra', after: ' crossing is in map.ts.' }] });
    expect(found.results[0].snippets[1].before).toMatch(/^…a+ The $/);
    const limit = fs.statSync(said).size - 1; expect(await sessions(limit)).toMatchObject({ skipped: [said, unsaid].filter((file) => fs.statSync(file).size > limit).length, results: [{ id: older }] });
  });
});
