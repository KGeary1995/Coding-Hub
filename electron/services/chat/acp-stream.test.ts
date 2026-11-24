import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
import { AcpStream, type AcpAgent } from './acp-stream';
import { spawnChatProcess, type ChatProcess } from './chat-process';

/**
 * A custom agent's chat over ACP (custom agents, phase 2), against the stand-in server scripts/fixtures/acp-agent.cjs run
 * as a real child process, as pty-manager runs one: it answers set_mode and set_model with no update of its own, so the
 * protocol's answer is what confirms them (agy's reports are GeminiStream's, tested in gemini-stream.test.ts).
 */
const FIXTURE = path.join(__dirname, '../../../scripts/fixtures/acp-agent.cjs');
const AGENT: AcpAgent = { name: 'Fixture ACP', prefix: 'acp', modes: { ask: 'read-only', edits: 'edits', full: 'yolo' }, allowEdits: true, mcpServers: [{ name: 'coding-hub-memory', command: 'node', args: ['memory.js'], env: [{ name: 'A', value: '1' }] }] };
const children: ChatProcess[] = []; const folders: string[] = [];
// Each agent is stopped and waited for before its folder goes: Windows keeps a running process's folder.
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => new Promise<void>((resolve) => { child.onExit(() => resolve()); child.kill(); })));
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function run(options: { permissions?: 'ask' | 'edits' | 'full'; model?: string; resumeId?: string; agent?: Partial<AcpAgent> } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-')); folders.push(cwd); const log = path.join(cwd, 'received.log');
  const child = spawnChatProcess(process.execPath, [FIXTURE], { cwd, env: { ...process.env, ACP_FIXTURE_LOG: log } as Record<string, string> }); children.push(child);
  const events: ChatEvent[] = [];
  const stream = new AcpStream((line) => child.write(line), (event) => events.push(event), { cwd, permissions: options.permissions ?? 'ask', ...(options.model ? { model: options.model } : {}), ...(options.resumeId ? { resumeId: options.resumeId } : {}) }, { ...AGENT, ...options.agent });
  child.onData((data) => stream.push(data)); stream.start();
  const received = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string | null; params: Record<string, unknown> | null }) : []);
  const until = async <T>(check: () => T | undefined | false, what: string) => { const end = Date.now() + 5000; while (Date.now() < end) { const value = check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error(`Timed out: ${what} ${JSON.stringify(events)}`); };
  const reply = (count = 1) => until(() => events.filter((event) => event.type === 'done').length >= count && events.filter((event) => event.type === 'assistant').at(-1), 'a reply');
  const textOf = (event: ChatEvent | false | undefined) => event && event.type === 'assistant' ? event.blocks.map((block) => block.type === 'text' ? block.text : '').join('') : '';
  return { cwd, stream, events, received, until, reply, textOf };
}
const modes = (received: { method: string | null; params: Record<string, unknown> | null }[]) => received.filter((item) => item.method === 'session/set_mode').map((item) => item.params!.modeId);

describe('custom agent chat over ACP (AcpStream)', () => {
  it('opens a session with Trace’s MCP servers, asks for Ask’s mode, and is ready once the agent answers', async () => {
    const { events, received, reply, textOf, stream, until } = run();
    await until(() => events.find((event) => event.type === 'ready'), 'ready');
    expect(received().find((item) => item.method === 'session/new')?.params).toMatchObject({ mcpServers: [{ name: 'coding-hub-memory', command: 'node', args: ['memory.js'], env: [{ name: 'A', value: '1' }] }] });
    expect(modes(received())).toEqual(['read-only']);
    expect(events.find((event) => event.type === 'ready')).toMatchObject({ conversationId: expect.stringMatching(/^fx-/), model: 'fx-small' });
    stream.send('hello there', []);
    expect(textOf(await reply())).toBe('ACP read-only fx-small got: hello there (mcp: coding-hub-memory)');
    // The streamed text arrived as deltas first, under the agent's own message ids.
    expect(events.filter((event) => event.type === 'delta').length).toBe(2);
    expect(events.find((event) => event.type === 'assistant')).toMatchObject({ messageId: expect.stringMatching(/^acp-fx-/) });
  });
  it('sets the chosen model with session/set_model, and refuses one the agent does not offer', async () => {
    const chosen = run({ model: 'fx-large', permissions: 'full' });
    await chosen.until(() => chosen.events.find((event) => event.type === 'ready'), 'ready');
    expect(chosen.received().filter((item) => item.method === 'session/set_model').map((item) => item.params!.modelId)).toEqual(['fx-large']);
    chosen.stream.send('which model', []); expect(chosen.textOf(await chosen.reply())).toContain('ACP yolo fx-large got');
    const missing = run({ model: 'fx-huge' });
    await missing.until(() => missing.events.find((event) => event.type === 'notice'), 'the refusal');
    expect(missing.events.find((event) => event.type === 'notice')).toMatchObject({ text: 'Fixture ACP does not offer fx-huge on this account. Choose another model for this seat.' });
    missing.stream.send('hello', []); expect(missing.events.at(-1)).toMatchObject({ type: 'done', isError: true });
  });
  it('at Ask is read-only: a file change it asks for is declined and said, and nothing is written', async () => {
    const { cwd, events, reply, textOf, stream, until } = run({ permissions: 'ask' });
    await until(() => events.find((event) => event.type === 'ready'), 'ready');
    stream.send('please write a.txt', []);
    expect(textOf(await reply())).toBe('Did not write a.txt.');
    expect(events.some((event) => event.type === 'permission')).toBe(false);
    // Its tool call is said first (a read-only run's write), then Trace's no.
    expect(events.filter((event) => event.type === 'notice').map((event) => event.type === 'notice' ? event.text : '')).toEqual([expect.stringContaining('Fixture ACP writes'), expect.stringMatching(/^Fixture ACP asked to change .*a\.txt\. At Ask it only reads/)]);
    expect(fs.existsSync(path.join(cwd, 'a.txt'))).toBe(false);
  });
  it('at Allow edits writes without an approval card (Trace answers its file change), in the edits mode', async () => {
    const { cwd, events, received, reply, textOf, stream, until } = run({ permissions: 'edits' });
    await until(() => events.find((event) => event.type === 'ready'), 'ready');
    expect(modes(received())).toEqual(['edits']);
    stream.send('write b.txt', []);
    expect(textOf(await reply())).toBe('Wrote b.txt.');
    expect(events.some((event) => event.type === 'permission')).toBe(false); expect(fs.existsSync(path.join(cwd, 'b.txt'))).toBe(true);
  });
  it('as a Round Table’s reviewer goes to Ask’s mode whatever its level, and leaves its file change to the table (an approval, not allowed)', async () => {
    const { events, received, stream, until } = run({ permissions: 'full' });
    await until(() => events.find((event) => event.type === 'ready'), 'ready');
    stream.setReadOnly(true);
    await until(() => modes(received()).length === 2, 'the read-only mode');
    expect(modes(received())).toEqual(['yolo', 'read-only']);
    stream.send('write c.txt', []);
    const asked = await until(() => events.find((event) => event.type === 'permission'), 'the approval');
    expect(asked).toMatchObject({ toolName: 'File changes', requestId: expect.stringMatching(/^acp-/) });
    // While it writes nothing, its write in a read-only run is said.
    expect(events.some((event) => event.type === 'notice' && event.text.startsWith('Fixture ACP writes'))).toBe(true);
    stream.setReadOnly(false); stream.interrupt();
    await until(() => events.find((event) => event.type === 'done'), 'stopped');
    expect(events.find((event) => event.type === 'done')).toMatchObject({ isError: true, error: 'Stopped.' });
    await until(() => modes(received()).length === 3, 'back to its level’s mode'); expect(modes(received()).at(-1)).toBe('yolo');
  });
  it('without a mode for a level keeps the mode it started in, and a seat never stays in a freer one', async () => {
    const { events, received, stream, until } = run({ permissions: 'full', agent: { modes: { full: 'yolo' } } });
    await until(() => events.find((event) => event.type === 'ready'), 'ready'); expect(modes(received())).toEqual(['yolo']);
    stream.setReadOnly(true); await until(() => modes(received()).length === 2, 'the start mode'); expect(modes(received())).toEqual(['yolo', 'default']);
    const plain = run({ permissions: 'edits', agent: { modes: {} } });
    await plain.until(() => plain.events.find((event) => event.type === 'ready'), 'ready'); expect(modes(plain.received())).toEqual([]);
  });
  it('loads a saved session and shows its messages again; images go only to an agent that takes them', async () => {
    const { events, received, stream, until, reply } = run({ resumeId: 'fx-saved-1' });
    await until(() => events.find((event) => event.type === 'ready'), 'ready');
    expect(received().find((item) => item.method === 'session/load')?.params).toMatchObject({ sessionId: 'fx-saved-1' });
    expect(events.find((event) => event.type === 'history')).toMatchObject({ messages: [{ role: 'user', text: 'Earlier question' }, { role: 'assistant', messageId: 'acp-replay-1', blocks: [{ type: 'text', text: 'Earlier answer' }] }] });
    expect(events.find((event) => event.type === 'ready')).toMatchObject({ conversationId: 'fx-saved-1' });
    stream.send('look', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]); await reply();
    expect(events.find((event) => event.type === 'notice')).toMatchObject({ text: 'Fixture ACP does not take images, so only the text was sent.' });
    expect(received().find((item) => item.method === 'session/prompt')?.params).toMatchObject({ prompt: [{ type: 'text', text: 'look' }] });
  });
  it('starts a new session, and says so, when the agent cannot load one', () => {
    const written: Record<string, unknown>[] = []; const events: ChatEvent[] = [];
    const stream = new AcpStream((line) => written.push(JSON.parse(line)), (event) => events.push(event), { cwd: '/p', resumeId: 'old' }, { ...AGENT, modes: {} });
    stream.start(); stream.push(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\n');
    expect(written.at(-1)).toMatchObject({ method: 'session/new' }); expect(events[0]).toEqual({ type: 'notice', text: 'Fixture ACP can\'t open an earlier conversation, so this is a new one.' });
  });
});
