import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
import { ClaudeStream } from './claude-stream';

describe('Claude chat protocol', () => {
  it('skips lines that are not messages instead of throwing', () => {
    const events: ChatEvent[] = []; const stream = new ClaudeStream(() => {}, (event) => events.push(event));
    expect(() => stream.push('null\n[1]\n"text"\n{"type":"assistant","message":null}\n{"type":"control_request","request":null}\n')).not.toThrow();
    expect(events.filter((event) => event.type === 'assistant' || event.type === 'permission')).toEqual([]);
  });
});
