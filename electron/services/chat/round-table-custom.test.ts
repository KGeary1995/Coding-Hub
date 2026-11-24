import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent } from '../../../shared/chat';
import { AcpStream } from './acp-stream';
import { ReviewChains } from './review-chain';
import { RoundTables, type TableHost } from './round-table';

const A = '11111111-1111-4111-8111-111111111111'; const B = '22222222-2222-4222-8222-222222222222';

/**
 * Round Tables with a custom agent's ACP chat (custom agents, phase 2): a real AcpStream, wired to the table as
 * pty-manager wires it, talking to a fake agent that answers every request at once (its answer confirms a mode). The
 * other seat is a Claude chat the test answers for. The custom seat goes by its agent's name.
 */
function setup(permissions: 'ask' | 'edits' | 'full' = 'edits') {
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'custom'; agentName?: string; cwd: string; owner: number; permissions?: 'ask' | 'edits' | 'full' }> = {
    [A]: { sessionId: 'a', engine: 'custom', agentName: 'Fixture ACP', cwd: '/p', owner: 1 }, [B]: { sessionId: 'b', engine: 'claude', cwd: '/p', owner: 1, permissions },
  };
  const window: ChatEnvelope[] = []; const toClaude: string[] = []; const claudeModes: boolean[] = [];
  const sent: Record<string, unknown>[] = []; let unread = 0;
  let tables: { observe(envelope: ChatEnvelope): string | null } = { observe: () => null };
  const emit = (event: ChatEvent) => {
    const envelope = { sessionId: 'a', runId: A, event };
    if (event.type === 'permission') { const handled = tables.observe(envelope); if (handled !== null) { if (handled) window.push({ ...envelope, event: { type: 'notice', text: handled } }); return; } }
    window.push(envelope); if (event.type !== 'permission') tables.observe(envelope);
  };
  const agent = new AcpStream((line) => sent.push(JSON.parse(line)), emit, { cwd: '/p', permissions }, { name: 'Fixture ACP', prefix: 'acp', modes: { ask: 'read-only', edits: 'edits', full: 'yolo' }, allowEdits: true });
  const push = (message: Record<string, unknown>) => agent.push(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const update = (body: Record<string, unknown>) => push({ method: 'session/update', params: { sessionId: 's1', update: body } });
  const pump = () => {
    while (unread < sent.length) {
      const message = sent[unread++]; const id = message.id as number;
      if (message.method === 'initialize') push({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (message.method === 'session/new') push({ id, result: { sessionId: 's1', modes: { currentModeId: 'default', availableModes: [] } } });
      else if (message.method === 'session/set_mode') push({ id, result: {} });
    }
  };
  const prompts = () => sent.filter((message) => message.method === 'session/prompt').map((message) => ((message.params as { prompt: { text: string }[] }).prompt.at(-1)!.text));
  const modes = () => sent.filter((message) => message.method === 'session/set_mode').map((message) => (message.params as { modeId: string }).modeId);
  const agentSays = (text: string) => { const open = sent.filter((message) => message.method === 'session/prompt').at(-1)!; update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }); push({ id: open.id, result: { stopReason: 'end_turn' } }); pump(); };
  const claudeSays = (text: string) => { tables.observe({ sessionId: 'b', runId: B, event: { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] } }); tables.observe({ sessionId: 'b', runId: B, event: { type: 'done', isError: false, error: null } }); pump(); };
  const agentAsks = (id: number, kind: string, title: string) => { push({ id, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: `t${id}`, kind, title, locations: kind === 'edit' ? [{ path: `/p/${title}` }] : [] }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } }); pump(); };
  const host: TableHost = {
    run: (id) => runs[id] ? { ...runs[id], permissions: id === A ? agent.permissions() : runs[id].permissions } : null,
    send: (runId, text) => { if (runId === A) agent.send(text, []); else toClaude.push(text); },
    setReadOnly: (runId, readOnly) => { if (runId === A) agent.setReadOnly(readOnly); else claudeModes.push(readOnly); },
    answer: (runId, requestId, allow) => { if (runId === A) agent.answer(requestId, allow); },
    interrupt: (runId) => { if (runId === A) agent.interrupt(); },
    emit: (_owner, envelope) => { window.push(envelope); },
  };
  agent.start(); pump();
  const last = () => (window.filter((envelope) => envelope.event.type === 'table').at(-1)!.event as Extract<ChatEvent, { type: 'table' }>).table!;
  return { host, sent, window, toClaude, claudeModes, prompts, modes, pump, agentSays, claudeSays, agentAsks, last, bind: (coordinator: { observe(envelope: ChatEnvelope): string | null }) => { tables = coordinator; } };
}

describe('a discussion Round Table with a custom agent’s ACP chat', () => {
  it('names the seat by its agent, keeps it in Ask’s mode as a reviewer (its edits declined), and lets it drive in its own level’s mode', () => {
    const t = setup(); const tables = new RoundTables(t.host); t.bind(tables);
    expect(t.modes()).toEqual(['edits']);
    // Claude Code drives; the custom agent reviews, read-only: Ask's mode, whatever its level.
    expect(tables.open(1, B, [{ runId: A }], 'b', 1)).toMatchObject({ seats: [{ sessionId: 'b', engine: 'claude' }, { sessionId: 'a', engine: 'custom', agentName: 'Fixture ACP' }], driverSeat: 'b', driver: 'claude', partner: { engine: 'custom' } });
    t.pump(); expect(t.modes()).toEqual(['edits', 'read-only']);
    tables.send(B, 'Add a README.', []); t.pump();
    expect(t.prompts()[0]).toContain('You are the reviewer'); expect(t.prompts()[0]).toContain('one conversation with the person and Claude Code');
    expect(t.toClaude[0]).toContain('the person and Fixture ACP');
    t.agentAsks(61, 'edit', 'README.md');
    expect(t.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 61, result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
    t.agentSays('Looks fine.'); t.claudeSays('I will add it.');
    expect(t.toClaude[1]).toContain('Fixture ACP answered:\n\nLooks fine.');
    t.agentSays('AGREE'); t.claudeSays('AGREE');
    t.claudeSays('Added.'); expect(t.last()).toMatchObject({ phase: 'idle' });
    // Now the custom agent drives: back in its level's mode once the discussion of the next message is over.
    tables.setDriver(B, 'a'); t.pump(); expect(t.last()).toMatchObject({ driverSeat: 'a', driver: 'custom' });
    tables.send(B, 'Now a licence.', []); t.pump();
    t.agentSays('I would add MIT.'); t.claudeSays('Fine.'); t.agentSays('AGREE'); t.claudeSays('AGREE');
    expect(t.modes().at(-1)).toBe('edits'); expect(t.prompts().at(-1)).toContain('Now carry out what the person asked');
    // At Allow edits Trace answers its file change itself, as the level says.
    t.agentAsks(62, 'edit', 'LICENSE'); expect(t.sent.at(-1)).toMatchObject({ id: 62, result: { outcome: { optionId: 'allow' } } });
  });
});

describe('a hierarchy Round Table with a custom agent as the builder', () => {
  it('opens with it building (it may edit) and names it in the planner’s brief', () => {
    const t = setup(); const chains = new ReviewChains(t.host); t.bind(chains);
    expect(chains.open(1, A, [{ runId: A, duties: ['build'] }, { runId: B, duties: ['plan', 'final'] }])).toMatchObject({ kind: 'hierarchy', driver: 'custom', seats: [{ engine: 'custom', agentName: 'Fixture ACP', duties: ['build'] }, { engine: 'claude', duties: ['plan', 'final'] }] });
    t.pump(); expect(t.modes()).toEqual(['edits']); expect(t.claudeModes).toEqual([true]);
    expect(chains.observe({ sessionId: 'a', runId: A, event: { type: 'permission', requestId: 'r2', toolName: 'File changes', description: '', input: {}, canAllowEdits: false } })).toBeNull();
  });
});
