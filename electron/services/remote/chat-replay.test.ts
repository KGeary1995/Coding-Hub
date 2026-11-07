import { describe, expect, it } from 'vitest';
import { CHAT_REPLAY_BYTES, CHAT_REPLAY_EVENTS, ChatReplayBuffer } from './chat-replay';

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
  it('trims a long resumed history from its oldest messages', () => {
    const buffer = new ChatReplayBuffer();
    const messages = Array.from({ length: 30 }, (_, index) => ({ role: 'user' as const, text: `${index}`.padEnd(100 * 1024, '.'), images: 0 }));
    buffer.record({ sessionId: 's', runId: 'r', event: { type: 'history', messages, results: {} } });
    const history = buffer.take('s').events[0] as { messages: { text: string }[] };
    expect(history.messages.length).toBeLessThan(30); expect(history.messages.at(-1)!.text.startsWith('29')).toBe(true);
    expect(JSON.stringify(history).length).toBeLessThanOrEqual(1024 * 1024);
  });
});
