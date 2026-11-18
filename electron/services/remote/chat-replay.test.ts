import { describe, expect, it } from 'vitest';
import { CHAT_REPLAY_BYTES, CHAT_REPLAY_EVENTS, ChatReplayBuffer, forFollowers } from './chat-replay';

describe('chat replay', () => {
  it('keeps a run’s last events within the count and size limits, folding streamed text and old table states', () => {
    const buffer = new ChatReplayBuffer();
    for (let index = 0; index < CHAT_REPLAY_EVENTS + 50; index++) buffer.record({ sessionId: 's', runId: 'r', event: { type: 'notice', text: `n${index}` } });
    const kept = buffer.take('s').events; expect(kept).toHaveLength(CHAT_REPLAY_EVENTS); expect(kept[0]).toEqual({ type: 'notice', text: 'n50' });
    for (let index = 0; index < 5; index++) buffer.record({ sessionId: 's', runId: 'r', event: { type: 'notice', text: 'x'.repeat(600 * 1024) } });
    expect(JSON.stringify(buffer.take('s').events).length).toBeLessThanOrEqual(CHAT_REPLAY_BYTES + 100);
    // A new run starts a new thread.
    buffer.record({ sessionId: 's', runId: 'r2', event: { type: 'delta', messageId: 'm', text: 'a' } });
    buffer.record({ sessionId: 's', runId: 'r2', event: { type: 'delta', messageId: 'm', text: 'b' } });
    expect(buffer.take('s')).toEqual({ sessionId: 's', runId: 'r2', events: [{ type: 'delta', messageId: 'm', text: 'ab' }] });
    buffer.record({ sessionId: 's', runId: 'r2', event: { type: 'table', table: null } });
    buffer.record({ sessionId: 's', runId: 'r2', event: { type: 'assistant', messageId: 'm', blocks: [{ type: 'text', text: 'ab' }] } });
    buffer.record({ sessionId: 's', runId: 'r2', event: { type: 'table', table: null } });
    expect(buffer.take('s').events.map((event) => event.type)).toEqual(['assistant', 'table']);
    expect(buffer.take('other')).toEqual({ sessionId: 'other', runId: null, events: [] });
  });
  it('counts a streamed reply’s size piece by piece, as its JSON would be', () => {
    const buffer = new ChatReplayBuffer();
    for (let index = 0; index < 2000; index++) buffer.record({ sessionId: 's', runId: 'r', event: { type: 'delta', messageId: 'm', text: index % 2 ? 'a "quoted"\n' : 'plain ' } });
    const entry = (buffer as unknown as { sessions: Map<string, { events: { size: number }[]; bytes: number }> }).sessions.get('s')!;
    const json = JSON.stringify(buffer.take('s').events[0]).length;
    expect(entry.events[0].size).toBe(json); expect(entry.bytes).toBe(json);
  });
  it('trims a long resumed history from its oldest messages', () => {
    const buffer = new ChatReplayBuffer();
    const messages = Array.from({ length: 30 }, (_, index) => ({ role: 'user' as const, text: `${index}`.padEnd(100 * 1024, '.'), images: 0 }));
    buffer.record({ sessionId: 's', runId: 'r', event: { type: 'history', messages, results: {} } });
    const history = buffer.take('s').events[0] as { messages: { text: string }[] };
    expect(history.messages.length).toBeLessThan(30); expect(history.messages.at(-1)!.text.startsWith('29')).toBe(true);
    expect(JSON.stringify(history).length).toBeLessThanOrEqual(1024 * 1024);
  });
  it('gives followers a Round Table’s images as a count, so a table with 3 MB of them leaves the thread before it in place', () => {
    const buffer = new ChatReplayBuffer(); const image = { mediaType: 'image/png' as const, data: 'A'.repeat(3 * 1024 * 1024) };
    buffer.record({ sessionId: 's', runId: 'r', event: { type: 'notice', text: 'earlier' } });
    const table = { partner: { sessionId: 'p', runId: 'r', engine: 'codex' as const }, driver: 'claude' as const, rounds: 2, round: 0, phase: 'idle' as const, agreed: false, kind: 'hierarchy' as const,
      chain: { step: 'implementing' as const, task: 't', plan: '', report: '', reviewRound: 0, finalRound: 0, verdict: null, note: '', images: [image] }, waiting: 'w', waitingImages: [image, image] };
    const envelope = { sessionId: 's', runId: 'r', event: { type: 'table' as const, table } }; const sent = forFollowers(envelope); buffer.record(sent);
    expect(buffer.take('s').events.map((event) => event.type)).toEqual(['notice', 'table']); expect(JSON.stringify(sent).length).toBeLessThan(2000);
    expect(sent.event).toMatchObject({ table: { waiting: 'w', waitingImageCount: 2, chain: { task: 't' } } }); expect(table.chain.images).toHaveLength(1); expect(table.waitingImages).toHaveLength(2);
    const plain = { sessionId: 's', runId: 'r', event: { type: 'table' as const, table: null } }; expect(forFollowers(plain)).toBe(plain);
  });
});
