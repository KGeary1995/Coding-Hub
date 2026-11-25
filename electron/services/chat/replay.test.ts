import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
import { CodexStream } from './codex-stream';
import { ClaudeStream } from './claude-stream';
import { AcpStream } from './acp-stream';

/**
 * Spike for runner step 4 (docs/plans/runner-chat-channels.md, step 1): can a chat's stream be rebuilt from a journal of
 * the lines its CLI wrote, with its own writes muted, so a chat kept running while Trace was closed can be taken up
 * again? The journal is every line in both directions, in order, as the runner would keep it.
 */
type Entry = { dir: 'in' | 'out'; line: string };

/** A Codex chat recorded as the runner would: what Trace wrote to Codex ('in') and what Codex wrote back ('out'). */
function recordCodex() {
  const journal: Entry[] = []; const events: ChatEvent[] = [];
  const stream = new CodexStream((line) => journal.push({ dir: 'in', line }), (event) => events.push(event), { cwd: '/p', model: '', reasoningEffort: null });
  const out = (message: unknown) => { const line = JSON.stringify(message) + '\n'; journal.push({ dir: 'out', line }); stream.push(line); };
  stream.start(); out({ id: 1, result: {} }); out({ id: 2, result: { thread: { id: 't1' }, model: 'gpt-x' } });
  stream.send('list the files', []); out({ id: 3, result: { turn: { id: 'u1', status: 'inProgress' } } });
  out({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'Two ' } }); out({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'files.' } });
  out({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm1', text: 'Two files.' } } });
  // An approval still open when Trace closed.
  out({ id: 40, method: 'item/commandExecution/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'c1', command: 'npm test', reason: null } });
  return { journal, events };
}

describe('replaying a chat from its journal (runner step 4 spike)', () => {
  it('rebuilds a Codex chat: the same events, the open approval answerable, and no line written to the CLI', () => {
    const { journal, events } = recordCodex();
    const written: string[] = []; const replayed: ChatEvent[] = []; let muted = true;
    const fresh = new CodexStream((line) => { if (!muted) written.push(line); }, (event) => replayed.push(event), { cwd: '/p', model: '', reasoningEffort: null });
    // Replay: Trace's own requests are made again in the same order (start, then the person's message), so the ids Codex
    // answered (1, 2, 3: a counter, not random) match; Codex's lines are fed as they came.
    fresh.start();
    for (const entry of journal) {
      if (entry.dir === 'out') fresh.push(entry.line);
      else if (JSON.parse(entry.line).method === 'turn/start') fresh.send('list the files', []);
    }
    expect(replayed).toEqual(events);
    // Live again: answering the approval reaches Codex with the request id it asked with.
    muted = false; expect(fresh.answer('codex-40', true)).toBe(true);
    expect(written.map((line) => JSON.parse(line))).toEqual([{ id: 40, result: { decision: 'accept' } }]);
    // It knows the turn, so Stop names it.
    fresh.interrupt(); expect(JSON.parse(written.at(-1)!)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 't1', turnId: 'u1' } });
  });
  it('needs the person’s messages again to replay: the journal’s lines alone do not make the stream send them', () => {
    const { journal, events } = recordCodex();
    const replayed: ChatEvent[] = []; const written: string[] = []; let muted = true;
    const fresh = new CodexStream((line) => { if (!muted) written.push(line); }, (event) => replayed.push(event), { cwd: '/p', model: '', reasoningEffort: null });
    fresh.start(); for (const entry of journal) if (entry.dir === 'out') fresh.push(entry.line);
    // Codex's answer to turn/start (id 3) has no request waiting for it, so the turn's id is not known.
    expect(replayed).toEqual(events);
    // Without the turn id, Stop has nothing to name: it is only remembered for later.
    muted = false; fresh.interrupt(); expect(written).toEqual([]);
  });
});

describe('ids a replay can give again (runner step 2)', () => {
  const counter = () => { let n = 0; return () => `id-${++n}`; };
  it('makes a Claude chat write the same requests, and name its messages the same, each time', () => {
    const run = () => { const written: string[] = []; const events: ChatEvent[] = []; const stream = new ClaudeStream((line) => written.push(line), (event) => events.push(event), 'ask', 'ask', counter());
      stream.setPermissions('edits'); stream.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }) + '\n'); return { written, events }; };
    const first = run(); const second = run();
    expect(second.written).toEqual(first.written); expect(JSON.parse(first.written[0])).toMatchObject({ type: 'control_request', request_id: 'id-1' });
    expect(second.events).toEqual(first.events); expect(first.events.find((event) => event.type === 'assistant')).toMatchObject({ messageId: 'id-2' });
  });
  it('gives an ACP chat the same run tag, so its messages keep their ids', () => {
    const tag = (ids?: () => string) => (new AcpStream(() => {}, () => {}, { cwd: '/p', ...(ids ? { ids } : {}) }, { name: 'Agent', prefix: 'agent', modes: {} }) as unknown as { run: string }).run;
    expect(tag(counter())).toBe(tag(counter())); expect(tag(counter())).toBe('id-1');
    // Without one it stays random, as before.
    expect(tag()).not.toBe(tag());
  });
});
