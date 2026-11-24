import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
const GEMINI_MODEL = 'gemini-4-argon-high';
import { GEMINI_MODE, GeminiStream } from './gemini-stream';

/** What agy 1.5.6's ACP server said in a real session (paths and account details taken out): scripts/fixtures/agy-acp-1.5.6.jsonl. */
type Recorded = { file: string; dir: 'in' | 'out'; message: Record<string, unknown> };
const recorded: Recorded[] = fs.readFileSync(path.join(__dirname, '../../../scripts/fixtures/agy-acp-1.5.6.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const session = recorded.filter((item) => item.file === 'log2');
/** agy's reply to the first request of `method` in the recording. */
function replyTo(method: string) { const sent = session.find((item) => item.dir === 'out' && item.message.method === method)!; return session.find((item) => item.dir === 'in' && item.message.id === sent.message.id && !item.message.method)!.message; }
const updates = (kind: string) => session.filter((item) => item.dir === 'in' && item.message.method === 'session/update' && (item.message.params as { update: { sessionUpdate: string } }).update.sessionUpdate === kind).map((item) => item.message);

/** A Round Table's reviewer seat, read-only (plan mode) as the table makes it; agy's side recorded with 1.5.6. */
function setup(confirmMs?: number) {
  const written: Record<string, unknown>[] = []; const events: ChatEvent[] = [];
  const stream = new GeminiStream((line) => written.push(JSON.parse(line)), (event) => events.push(event), { cwd: '/project', model: GEMINI_MODEL, permissions: 'full', ...(confirmMs ? { confirmMs } : {}) });
  stream.setReadOnly(true);
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
    expect(events.at(-1)).toMatchObject({ type: 'notice', text: expect.stringContaining('Choose another model for this seat') });
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
  it('F3: Stop before the session is ready drops the waiting prompt and ends it as stopped, so it never runs', () => {
    const { stream, written, events, answer, feed } = setup();
    stream.start(); answer('initialize'); stream.send('Challenge this plan', []);
    stream.interrupt();
    expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'Stopped.' });
    expect(written.some((item) => item.method === 'session/cancel')).toBe(false);
    answer('session/new'); answer('session/set_model'); answer('session/set_mode'); for (const update of updates('config_option_update')) feed(update);
    expect(events.some((event) => event.type === 'ready')).toBe(true);
    expect(written.some((item) => item.method === 'session/prompt')).toBe(false);
  });
});


/**
 * A Gemini chat that may edit (a Round Table's lead or driver, from 1.39), against a fake agy that opens sessions as agy
 * 1.5.16 did on 2026-11-24: modes default, accept-edits, auto and plan, a new or loaded session starting at default, and
 * `current_mode_update` after a mode is set. Permission options were allow (allow_once) and deny (reject_once).
 */
describe('a Gemini chat that may edit (lead or driver)', () => {
  const OPENED = { sessionId: 's1', modes: { currentModeId: 'default', availableModes: ['default', 'accept-edits', 'auto', 'plan'].map((id) => ({ id, name: id })) }, configOptions: [{ id: 'model', currentValue: 'gemini-4-neon' }, { id: 'thought_level', currentValue: 'high' }, { id: 'mode', currentValue: 'default' }] };
  const REQUEST = { sessionId: 's1', toolCall: { toolCallId: 't1', name: 'run_command', kind: 'execute', title: 'git status --short', rawInput: { CommandLine: 'git status --short' } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] };
  function peer(options: { permissions?: 'ask' | 'edits' | 'full'; resumeId?: string; confirmMs?: number } = {}) {
    const written: Record<string, unknown>[] = []; const events: ChatEvent[] = [];
    const stream = new GeminiStream((line) => written.push(JSON.parse(line)), (event) => events.push(event), { cwd: '/project', permissions: options.permissions ?? 'edits', ...(options.resumeId ? { resumeId: options.resumeId } : {}), ...(options.confirmMs ? { confirmMs: options.confirmMs } : {}) });
    const sent = (method: string) => written.filter((item) => item.method === method);
    const push = (message: Record<string, unknown>) => stream.push(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    const reply = (method: string, result: Record<string, unknown> = {}) => push({ id: sent(method).at(-1)!.id, result });
    const update = (body: Record<string, unknown>) => push({ method: 'session/update', params: { sessionId: 's1', update: body } });
    /** agy sets the mode Trace asked for last, and reports it. */
    const switched = () => { const mode = (sent('session/set_mode').at(-1)!.params as { modeId: string }).modeId; reply('session/set_mode'); update({ sessionUpdate: 'current_mode_update', currentModeId: mode }); return mode; };
    const open = () => { stream.start(); reply('initialize'); reply('session/new', OPENED); return switched(); };
    const ask = (id: number) => push({ id, method: 'session/request_permission', params: REQUEST });
    return { stream, written, events, sent, push, reply, update, switched, open, ask };
  }

  it('runs in the mode of its level (Ask: plan, Allow edits: accept-edits, Full access: auto), and is ready only once agy reports it', () => {
    expect(GEMINI_MODE).toEqual({ ask: 'plan', edits: 'accept-edits', full: 'auto' });
    for (const level of ['ask', 'edits', 'full'] as const) {
      const { stream, events, sent, reply, update } = peer({ permissions: level });
      stream.start(); reply('initialize'); reply('session/new', OPENED);
      // A new session is in default, as agy reports: every level asks for its own mode.
      expect(sent('session/set_mode').map((item) => item.params)).toEqual([{ sessionId: 's1', modeId: GEMINI_MODE[level] }]);
      stream.send('Hello', []);
      { reply('session/set_mode'); expect(sent('session/prompt')).toHaveLength(0); expect(events.some((event) => event.type === 'ready')).toBe(false); update({ sessionUpdate: 'current_mode_update', currentModeId: GEMINI_MODE[level] }); }
      expect(events).toContainEqual({ type: 'ready', conversationId: 's1', model: 'gemini-4-neon-high' });
      expect(sent('session/prompt')).toHaveLength(1);
    }
  });
  it('goes into plan mode while a table keeps it read-only, holds a message until agy reports it, and may edit again after', () => {
    const { stream, sent, open, reply, switched } = peer(); expect(open()).toBe('accept-edits');
    stream.setReadOnly(true); expect((sent('session/set_mode').at(-1)!.params as { modeId: string }).modeId).toBe('plan');
    stream.send('Discuss it first.', []); expect(sent('session/prompt')).toHaveLength(0);
    expect(switched()).toBe('plan'); expect(sent('session/prompt')).toHaveLength(1);
    // The discussion is over: the driver carries it out, in its own level's mode again.
    reply('session/prompt', { stopReason: 'end_turn' });
    stream.setReadOnly(false); stream.send('Now carry it out.', []); expect(sent('session/prompt')).toHaveLength(1);
    expect(switched()).toBe('accept-edits'); expect(sent('session/prompt')).toHaveLength(2);
  });
  it('changes its mode between turns, never during one', () => {
    const { stream, sent, open, reply, switched } = peer(); open();
    stream.send('Work.', []); stream.setPermissions('full'); expect(stream.permissions()).toBe('full');
    expect(sent('session/set_mode')).toHaveLength(1);
    reply('session/prompt', { stopReason: 'end_turn' }); expect(switched()).toBe('auto');
  });
  it('asks the person at Allow edits and answers with agy’s own option; at Full access answers itself, but not for a read-only seat', () => {
    const asking = peer(); asking.open(); asking.stream.send('Check the status.', []);
    asking.ask(7); const permission = asking.events.find((event) => event.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
    expect(permission).toMatchObject({ toolName: 'Shell', description: 'git status --short', canAllowEdits: false });
    expect(asking.stream.answer(permission.requestId, true)).toBe(true); expect(asking.written.at(-1)).toEqual({ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    const full = peer({ permissions: 'full' }); full.open(); full.stream.send('Check the status.', []);
    full.ask(8); expect(full.written.at(-1)).toEqual({ jsonrpc: '2.0', id: 8, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    expect(full.events.some((event) => event.type === 'permission' || event.type === 'permission-done')).toBe(false);
    // Read-only at Full access: the table decides (it declines edits and allows the rest), so the request is passed on.
    full.reply('session/prompt', { stopReason: 'end_turn' }); full.stream.setReadOnly(true); full.switched(); full.stream.send('Review.', []);
    full.ask(9); expect(full.events.at(-1)).toMatchObject({ type: 'permission', toolName: 'Shell' });
  });
  it('at Ask is read-only: plan mode, a file change it asks for is declined and said, a command is still asked about', () => {
    const { stream, events, written, open, push } = peer({ permissions: 'ask' }); expect(open()).toBe('plan'); stream.send('Fix it.', []);
    push({ id: 11, method: 'session/request_permission', params: { ...REQUEST, toolCall: { toolCallId: 't2', name: 'write_file', kind: 'edit', title: 'a.txt', locations: [{ path: '/project/a.txt' }] } } });
    expect(written.at(-1)).toEqual({ jsonrpc: '2.0', id: 11, result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
    expect(events.some((event) => event.type === 'permission')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'notice', text: expect.stringContaining('/project/a.txt') });
    push({ id: 12, method: 'session/request_permission', params: REQUEST }); expect(events.at(-1)).toMatchObject({ type: 'permission', toolName: 'Shell' });
  });
  it('says nothing about its writes while it may edit; a read-only seat’s writes are said', () => {
    const { stream, events, open, update, reply, switched } = peer(); open(); stream.send('Write it.', []);
    const write = { sessionUpdate: 'tool_call', toolCallId: 'w1', name: 'write_file', kind: 'edit', title: 'File hello.txt', locations: [{ path: '/project/hello.txt' }] };
    update(write); expect(events.some((event) => event.type === 'notice')).toBe(false);
    reply('session/prompt', { stopReason: 'end_turn' }); stream.setReadOnly(true); switched(); stream.send('Review.', []);
    update({ ...write, toolCallId: 'w2' }); expect(events.at(-1)).toMatchObject({ type: 'notice', text: expect.stringContaining('Gemini writes /project/hello.txt') });
  });
  it('resumes a saved conversation with session/load and shows its messages again', () => {
    const resumeId = '70253404-1a63-473e-8348-dd2f445bd93c';
    const { stream, events, sent, reply, update, switched } = peer({ resumeId });
    stream.start(); reply('initialize');
    expect(sent('session/load')).toEqual([expect.objectContaining({ params: { sessionId: resumeId, cwd: '/project', mcpServers: [] } })]); expect(sent('session/new')).toHaveLength(0);
    // agy replays the conversation before it answers (seen with 1.5.16): the person's words in pieces, then the reply.
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '/plan' } }); update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: ' Make hello.txt' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Made ' } }); update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'it.' } });
    reply('session/load', { ...OPENED, sessionId: resumeId });
    expect(events.find((event) => event.type === 'history')).toEqual({ type: 'history', results: {}, messages: [{ role: 'user', text: '/plan Make hello.txt', images: 0 }, { role: 'assistant', messageId: 'gemini-replay-1', blocks: [{ type: 'text', text: 'Made it.' }] }] });
    switched(); expect(events).toContainEqual({ type: 'ready', conversationId: resumeId, model: 'gemini-4-neon-high' });
  });
  it('says why when agy cannot load the conversation, or will not switch mode', () => {
    const lost = peer({ resumeId: '70253404-1a63-473e-8348-dd2f445bd93c' }); lost.stream.start(); lost.reply('initialize');
    lost.push({ id: lost.sent('session/load')[0].id, error: { code: -32603, message: 'conversation not found' } });
    expect(lost.events.at(-1)).toMatchObject({ type: 'notice', text: expect.stringContaining('could not open this conversation again (conversation not found)') });
    const stuck = peer(); stuck.stream.start(); stuck.reply('initialize'); stuck.reply('session/new', OPENED); stuck.stream.send('Hi', []);
    stuck.push({ id: stuck.sent('session/set_mode')[0].id, error: { code: -32602, message: 'unknown mode' } });
    expect(stuck.events.slice(-2)).toEqual([{ type: 'notice', text: 'Gemini would not switch to accept-edits mode (unknown mode).' }, { type: 'done', isError: true, error: 'Gemini would not switch to accept-edits mode (unknown mode).' }]);
  });
  it('stops using a session that does not report the new mode in time', async () => {
    const { stream, events, open, reply, sent } = peer({ confirmMs: 10 }); open();
    stream.setReadOnly(true); reply('session/set_mode'); stream.send('Review.', []);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent('session/prompt')).toHaveLength(0); expect(events.at(-1)).toMatchObject({ type: 'done', isError: true, error: expect.stringContaining('did not confirm plan mode') });
  });
});
