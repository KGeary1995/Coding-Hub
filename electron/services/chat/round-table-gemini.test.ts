import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent } from '../../../shared/chat';
import { GeminiStream } from './gemini-stream';
import { ReviewChains } from './review-chain';
import { RoundTables, type TableHost } from './round-table';

const A = '11111111-1111-4111-8111-111111111111'; const B = '22222222-2222-4222-8222-222222222222';

/**
 * A Round Table led by a Gemini chat (from 1.39): the lead is a real GeminiStream, wired to the table as pty-manager wires
 * it (an approval passes the table first; every other event after the window has it), talking to a fake agy that answers
 * as agy 1.5.16 did (a new session at default, `current_mode_update` after each mode set). The other seat is a Claude
 * chat the test answers for.
 */
function setup(permissions: 'ask' | 'edits' | 'full' = 'edits') {
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex' | 'gemini'; cwd: string; owner: number; permissions?: 'ask' | 'edits' | 'full' }> = {
    [A]: { sessionId: 'a', engine: 'gemini', cwd: '/p', owner: 1 }, [B]: { sessionId: 'b', engine: 'claude', cwd: '/p', owner: 1, permissions },
  };
  const window: ChatEnvelope[] = []; const toClaude: string[] = []; const claudeModes: boolean[] = []; const claudeAnswers: { requestId: string; allow: boolean }[] = [];
  /** What Trace wrote to agy, in order, and what agy has yet to answer. */
  const agy: Record<string, unknown>[] = []; let unread = 0;
  let tables: { observe(envelope: ChatEnvelope): string | null } = { observe: () => null };
  const emit = (event: ChatEvent) => {
    const envelope = { sessionId: 'a', runId: A, event };
    if (event.type === 'permission') { const handled = tables.observe(envelope); if (handled !== null) { if (handled) window.push({ ...envelope, event: { type: 'notice', text: handled } }); return; } }
    window.push(envelope); if (event.type !== 'permission') tables.observe(envelope);
  };
  const gemini = new GeminiStream((line) => agy.push(JSON.parse(line)), emit, { cwd: '/p', permissions });
  runs[A].permissions = permissions;
  const push = (message: Record<string, unknown>) => gemini.push(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const update = (body: Record<string, unknown>) => push({ method: 'session/update', params: { sessionId: 's1', update: body } });
  /** The fake agy answers everything Trace wrote since it last looked; a prompt stays open until the test answers it. */
  const pump = () => {
    while (unread < agy.length) {
      const message = agy[unread++]; const id = message.id as number; const params = message.params as Record<string, unknown> | undefined;
      if (message.method === 'initialize') push({ id, result: { protocolVersion: 1 } });
      else if (message.method === 'session/new') push({ id, result: { sessionId: 's1', configOptions: [{ id: 'model', currentValue: 'gemini-4-neon' }, { id: 'thought_level', currentValue: 'high' }, { id: 'mode', currentValue: 'default' }] } });
      else if (message.method === 'session/set_mode') { push({ id, result: {} }); update({ sessionUpdate: 'current_mode_update', currentModeId: params!.modeId }); }
    }
  };
  const prompts = () => agy.filter((message) => message.method === 'session/prompt').map((message) => ((message.params as { prompt: { text: string }[] }).prompt.at(-1)!.text));
  const modes = () => agy.filter((message) => message.method === 'session/set_mode').map((message) => (message.params as { modeId: string }).modeId);
  /** Gemini answers the open prompt. */
  const geminiSays = (text: string) => { const open = agy.filter((message) => message.method === 'session/prompt').at(-1)!; update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }); push({ id: open.id, result: { stopReason: 'end_turn' } }); pump(); };
  const claudeSays = (text: string) => { tables.observe({ sessionId: 'b', runId: B, event: { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] } }); tables.observe({ sessionId: 'b', runId: B, event: { type: 'done', isError: false, error: null } }); pump(); };
  const geminiAsks = (id: number, kind: string, title: string) => { push({ id, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: `t${id}`, kind, title, locations: kind === 'edit' ? [{ path: `/p/${title}` }] : [] }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } }); pump(); };
  const host: TableHost = {
    run: (id) => runs[id] ? { ...runs[id], permissions: id === A ? gemini.permissions() : runs[id].permissions } : null,
    send: (runId, text) => { if (runId === A) gemini.send(text, []); else toClaude.push(text); },
    setReadOnly: (runId, readOnly) => { if (runId === A) gemini.setReadOnly(readOnly); else claudeModes.push(readOnly); },
    answer: (runId, requestId, allow) => { if (runId === A) gemini.answer(requestId, allow); else claudeAnswers.push({ requestId, allow }); },
    interrupt: (runId) => { if (runId === A) gemini.interrupt(); },
    emit: (_owner, envelope) => { window.push(envelope); },
  };
  gemini.start(); pump();
  const last = () => (window.filter((envelope) => envelope.event.type === 'table').at(-1)!.event as Extract<ChatEvent, { type: 'table' }>).table!;
  return { host, gemini, agy, window, toClaude, claudeModes, claudeAnswers, prompts, modes, pump, geminiSays, claudeSays, geminiAsks, last, bind: (coordinator: { observe(envelope: ChatEnvelope): string | null }) => { tables = coordinator; } };
}

describe('a discussion Round Table that Gemini leads and drives', () => {
  it('keeps Gemini in plan mode while they discuss, declines its edits then, and lets it edit, in its own level’s mode, once the discussion is over', () => {
    const t = setup(); const tables = new RoundTables(t.host); t.bind(tables);
    // Opened on the Gemini chat, which drives: it may edit (Allow edits: accept-edits); Claude Code reviews, read-only.
    expect(t.modes()).toEqual(['accept-edits']);
    expect(tables.open(1, A, [{ runId: B }], 'a', 1)).toMatchObject({ seats: [{ sessionId: 'a', engine: 'gemini' }, { sessionId: 'b', engine: 'claude' }], driverSeat: 'a', driver: 'gemini' });
    expect(t.claudeModes).toEqual([true]);
    tables.send(A, 'Add a README.', []); t.pump();
    // The person's message is discussed first: Gemini is put in plan mode before its prompt goes.
    expect(t.modes()).toEqual(['accept-edits', 'plan']);
    expect(t.agy.findIndex((message) => message.method === 'session/prompt')).toBeGreaterThan(t.agy.findIndex((message) => (message.params as { modeId?: string } | undefined)?.modeId === 'plan'));
    expect(t.prompts()[0]).toContain('You are the driver'); expect(t.prompts()[0]).toContain('Add a README.'); expect(t.toClaude[0]).toContain('check the driver');
    // An edit Gemini asks for while they discuss is declined, with agy's own reject option, and said in the thread.
    t.geminiAsks(41, 'edit', 'README.md');
    expect(t.agy.at(-1)).toEqual({ jsonrpc: '2.0', id: 41, result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
    expect(t.window.some((envelope) => envelope.event.type === 'notice' && envelope.event.text === 'Trace declined File changes for Gemini: files change once the discussion is over.')).toBe(true);
    t.geminiSays('I would add README.md with a short summary.'); t.claudeSays('Also list the commands.');
    // Round 1: each hears the other.
    expect(t.prompts()[1]).toContain('Claude Code answered:\n\nAlso list the commands.'); expect(t.toClaude[1]).toContain('Gemini answered:\n\nI would add README.md');
    t.geminiSays('AGREE'); t.claudeSays('AGREE');
    // Agreed: Gemini carries it out, back in accept-edits before that prompt goes; Claude stays read-only.
    expect(t.modes()).toEqual(['accept-edits', 'plan', 'accept-edits']); expect(t.prompts()).toHaveLength(3); expect(t.prompts()[2]).toContain('Now carry out what the person asked');
    expect(t.last()).toMatchObject({ phase: 'acting', driver: 'gemini' }); expect(t.claudeModes.at(-1)).toBe(true);
    // Its command now reaches the person as an approval (Allow edits asks before commands), answered with agy's allow.
    t.geminiAsks(42, 'execute', 'npm test');
    const permission = t.window.map((envelope) => envelope.event).find((event) => event.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
    expect(permission).toMatchObject({ toolName: 'Shell', description: 'npm test' });
    t.gemini.answer(permission.requestId, true); expect(t.agy.at(-1)).toEqual({ jsonrpc: '2.0', id: 42, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    t.geminiSays('Added README.md.'); expect(t.last()).toMatchObject({ phase: 'idle', agreed: true });
  });
  it('at Full access lets the Gemini driver run without asking, while the read-only reviewer’s commands are the table’s to allow', () => {
    const t = setup('full'); const tables = new RoundTables(t.host); t.bind(tables);
    expect(t.modes()).toEqual(['auto']);
    tables.open(1, A, [{ runId: B }], 'a', 0); tables.send(A, 'Run the tests.', []); t.pump();
    // No rounds: the driver starts at once, in its own mode; what agy still asks is allowed with no approval card.
    expect(t.modes()).toEqual(['auto']); t.geminiAsks(51, 'execute', 'npm test');
    expect(t.agy.at(-1)).toEqual({ jsonrpc: '2.0', id: 51, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    expect(t.window.some((envelope) => envelope.event.type === 'permission')).toBe(false);
    // Claude Code drives instead: Gemini reviews in plan mode, its edits declined and its commands allowed by the table.
    t.geminiSays('Done.'); t.claudeSays('Fine.');
    tables.setDriver(A, 'b'); t.pump(); expect(t.modes()).toEqual(['auto', 'plan']); expect(t.last()).toMatchObject({ driverSeat: 'b', driver: 'claude' });
    tables.send(A, 'Review it.', []); t.pump();
    t.geminiAsks(52, 'edit', 'a.ts'); expect(t.agy.at(-1)).toMatchObject({ id: 52, result: { outcome: { optionId: 'deny' } } });
    t.geminiAsks(53, 'execute', 'git diff'); expect(t.agy.at(-1)).toMatchObject({ id: 53, result: { outcome: { optionId: 'allow' } } });
  });
});

describe('a hierarchy Round Table that Gemini leads as the builder', () => {
  it('opens with Gemini building (it may edit) and the planner read-only; only the builder’s edits pass', () => {
    const t = setup(); const chains = new ReviewChains(t.host); t.bind(chains);
    expect(chains.open(1, A, [{ runId: A, duties: ['build'] }, { runId: B, duties: ['plan', 'final'] }])).toMatchObject({ kind: 'hierarchy', driver: 'gemini', seats: [{ engine: 'gemini', duties: ['build'] }, { engine: 'claude', duties: ['plan', 'final'] }] });
    t.pump(); expect(t.modes()).toEqual(['accept-edits']); expect(t.claudeModes).toEqual([true]);
    expect(chains.observe({ sessionId: 'b', runId: B, event: { type: 'permission', requestId: 'r1', toolName: 'Edit', description: '', input: {}, canAllowEdits: true } })).toBe('Trace declined Edit for the planner: only the builder edits files.');
    expect(chains.observe({ sessionId: 'a', runId: A, event: { type: 'permission', requestId: 'r2', toolName: 'File changes', description: '', input: {}, canAllowEdits: false } })).toBeNull();
  });
});
