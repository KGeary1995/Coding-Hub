import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
import { GEMINI_MODEL } from '../../../shared/gemini';
import { GeminiStream } from './gemini-stream';

/** What agy 1.5.6's ACP server said in a real session (paths and account details taken out): scripts/fixtures/agy-acp-1.5.6.jsonl. */
type Recorded = { file: string; dir: 'in' | 'out'; message: Record<string, unknown> };
const recorded: Recorded[] = fs.readFileSync(path.join(__dirname, '../../../scripts/fixtures/agy-acp-1.5.6.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const session = recorded.filter((item) => item.file === 'log2');
/** agy's reply to the first request of `method` in the recording. */
function replyTo(method: string) { const sent = session.find((item) => item.dir === 'out' && item.message.method === method)!; return session.find((item) => item.dir === 'in' && item.message.id === sent.message.id && !item.message.method)!.message; }
const updates = (kind: string) => session.filter((item) => item.dir === 'in' && item.message.method === 'session/update' && (item.message.params as { update: { sessionUpdate: string } }).update.sessionUpdate === kind).map((item) => item.message);

function setup(confirmMs?: number) {
  const written: Record<string, unknown>[] = []; const events: ChatEvent[] = [];
  const stream = new GeminiStream((line) => written.push(JSON.parse(line)), (event) => events.push(event), { cwd: '/project', permissions: 'full', ...(confirmMs ? { confirmMs } : {}) });
  /** agy answers Trace's latest request with what it said in the recording. */
  const answer = (method: string, override?: Record<string, unknown>) => { const request = written.filter((item) => item.method === method).at(-1)!; stream.push(JSON.stringify({ ...(override ?? replyTo(method)), id: request.id }) + '\n'); };
  const feed = (message: Record<string, unknown>) => stream.push(JSON.stringify(message) + '\n');
  /** The session as agy 1.5.6 opened it, up to plan mode, with its config updates. */
  const open = () => { stream.start(); answer('initialize'); answer('session/new'); answer('session/set_model'); for (const update of updates('config_option_update')) feed(update); answer('session/set_mode'); };
  return { stream, written, events, answer, feed, open };
}

describe('Gemini seat over ACP (agy acp)', () => {
  it('opens a session in the folder, sets the one allowed model and plan mode, and is ready only once agy reports both', () => {
    const { stream, written, events, answer, feed } = setup();
    stream.start(); answer('initialize');
    expect(written[0]).toMatchObject({ method: 'initialize', params: { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
    answer('session/new');
    expect(written.at(-2)).toMatchObject({ method: 'session/new', params: { cwd: '/project' } });
    // agy starts new sessions on gemini-4-argon-medium: Trace asks for the model, then plan mode.
    expect(written.at(-1)).toMatchObject({ method: 'session/set_model', params: { modelId: GEMINI_MODEL } });
    answer('session/set_model'); answer('session/set_mode');
    expect(written.at(-1)).toMatchObject({ method: 'session/set_mode', params: { modeId: 'plan' } });
    expect(events.some((event) => event.type === 'ready')).toBe(false);
    // A message written before it is ready waits.
    stream.send('Hello', []); expect(written.some((item) => item.method === 'session/prompt')).toBe(false);
    for (const update of updates('config_option_update')) feed(update);
    expect(events).toContainEqual({ type: 'ready', conversationId: expect.any(String), model: GEMINI_MODEL });
    expect(written.at(-1)).toMatchObject({ method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'Hello' }] } });
  });
  it('refuses to go on when agy does not confirm the model in plan mode, and fails every message with the reason', async () => {
    const { stream, events, answer, feed } = setup(10);
    stream.start(); answer('initialize'); answer('session/new'); answer('session/set_model'); answer('session/set_mode');
    // agy reports the medium thinking level it started with: not GEMINI_MODEL.
    feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'gemini-4-argon' }, { id: 'thought_level', currentValue: 'medium' }, { id: 'mode', currentValue: 'plan' }] } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.some((event) => event.type === 'ready')).toBe(false);
    expect(events.find((event) => event.type === 'notice')).toMatchObject({ text: expect.stringContaining(`did not confirm ${GEMINI_MODEL}`) });
    stream.send('Review this', []);
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true, error: expect.stringContaining('thinking medium') });
  });
  it('refuses at once when the account does not offer the model', () => {
    const { stream, events, written, answer } = setup();
    stream.start(); answer('initialize');
    const created = replyTo('session/new'); const result = created.result as Record<string, unknown>;
    answer('session/new', { ...created, result: { ...result, models: { availableModels: [{ modelId: 'gemini-4-argon-medium' }], currentModelId: 'gemini-4-argon-medium' } } });
    expect(written.some((item) => item.method === 'session/set_model')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'notice', text: expect.stringContaining('runs no other Gemini model') });
  });
  it('streams a turn as messages, tool cards and results, with a command’s approval and a write shown', () => {
    const { stream, written, events, answer, feed, open } = setup(); open();
    stream.send('Run git status', []);
    for (const item of session.filter((each) => each.dir === 'in' && each.message.method === 'session/update' && !['config_option_update', 'current_mode_update', 'user_message_chunk', 'session_info_update'].includes((each.message.params as { update: { sessionUpdate: string } }).update.sessionUpdate))) feed(item.message);
    const permission = session.find((item) => item.message.method === 'session/request_permission')!.message;
    feed(permission);
    expect(events.find((event) => event.type === 'permission')).toMatchObject({ toolName: 'Shell', description: 'git status --short', canAllowEdits: false });
    const requestId = (events.find((event) => event.type === 'permission') as { requestId: string }).requestId;
    // Allowed: agy's own "allow" option, answered to its request id.
    expect(stream.answer(requestId, true)).toBe(true);
    expect(written.at(-1)).toEqual({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    expect(events).toContainEqual({ type: 'permission-done', requestId });
    answer('session/prompt');
    const kinds = events.map((event) => event.type);
    expect(kinds).toContain('delta'); expect(kinds).toContain('tool-result'); expect(kinds.at(-1)).toBe('done');
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, error: null });
    expect(events.filter((event) => event.type === 'assistant').flatMap((event) => (event as { blocks: { type: string }[] }).blocks.map((block) => block.type))).toEqual(expect.arrayContaining(['thinking', 'tool', 'text']));
    // agy wrote its plan notes under ~/.gemini without asking: the thread says so.
    expect(events.find((event) => event.type === 'notice' && event.text.startsWith('Gemini writes'))).toMatchObject({ text: expect.stringContaining('.gemini') });
  });
  it('names a file change "File changes", so a Round Table declines it, and answers with agy’s reject option', () => {
    const { stream, written, events, feed, open } = setup(); open(); stream.send('x', []);
    // agy never asked before a write in the recorded sessions; this is its command request with a write's kind.
    const recordedRequest = session.find((item) => item.message.method === 'session/request_permission')!.message as { params: { toolCall: Record<string, unknown> } };
    feed({ ...recordedRequest, id: '7', params: { ...recordedRequest.params, toolCall: { ...recordedRequest.params.toolCall, kind: 'edit', title: 'notes.txt', locations: [{ path: '/project/notes.txt' }] } } });
    const permission = events.find((event) => event.type === 'permission') as { requestId: string; toolName: string; description: string };
    expect(permission).toMatchObject({ toolName: 'File changes', description: '/project/notes.txt' });
    stream.answer(permission.requestId, false);
    expect(written.at(-1)).toEqual({ jsonrpc: '2.0', id: '7', result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
  });
  it('stops a turn with session/cancel, cancels a waiting approval, and ends the turn as stopped', () => {
    const { stream, written, events, answer, feed, open } = setup(); open(); stream.send('Count slowly', []);
    feed(session.find((item) => item.message.method === 'session/request_permission')!.message);
    stream.interrupt();
    const cancel = recorded.find((item) => item.file === 'log3' && item.message.method === 'session/cancel')!.message;
    expect(written.find((item) => item.method === 'session/cancel')).toMatchObject({ method: 'session/cancel', params: { sessionId: expect.any(String) } });
    expect(Object.keys(cancel.params as object)).toEqual(['sessionId']);
    expect(written.some((item) => (item.result as { outcome?: { outcome: string } } | undefined)?.outcome?.outcome === 'cancelled')).toBe(true);
    expect(events.some((event) => event.type === 'permission-done')).toBe(true);
    // agy's reply to the cancelled prompt (log3): stopReason cancelled.
    const stopped = recorded.find((item) => item.file === 'log3' && (item.message.result as { stopReason?: string } | undefined)?.stopReason === 'cancelled')!.message;
    answer('session/prompt', stopped);
    expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'Stopped.' });
  });
  it('refuses requests it does not serve (file system, terminal), so agy uses its own', () => {
    const { written, feed, open } = setup(); open();
    feed({ jsonrpc: '2.0', id: 9, method: 'fs/write_text_file', params: { path: '/project/a.txt', content: 'x' } });
    expect(written.at(-1)).toMatchObject({ id: 9, error: { code: -32601 } });
  });
});
