import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
import { ClaudeStream } from './claude-stream';

describe('Claude chat protocol', () => {
  it('skips lines that are not messages instead of throwing', () => {
    const events: ChatEvent[] = []; const stream = new ClaudeStream(() => {}, (event) => events.push(event));
    expect(() => stream.push('null\n[1]\n"text"\n{"type":"assistant","message":null}\n{"type":"control_request","request":null}\n')).not.toThrow();
    expect(events.filter((event) => event.type === 'assistant' || event.type === 'permission')).toEqual([]);
  });
  it('closes an approval Claude withdraws, and then ignores an answer to it', () => {
    const events: ChatEvent[] = []; const written: string[] = []; const stream = new ClaudeStream((line) => written.push(line), (event) => events.push(event));
    stream.push(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } }) + '\n');
    expect(events.at(-1)).toMatchObject({ type: 'permission', requestId: 'r1' });
    stream.push(JSON.stringify({ type: 'control_cancel_request', request_id: 'r1' }) + '\n');
    expect(events.at(-1)).toEqual({ type: 'permission-done', requestId: 'r1' });
    expect(stream.answer('r1', true)).toBe(false); expect(written).toEqual([]);
  });
});
