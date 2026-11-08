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
  it('changes permission mode while running, keeps a Round Table reviewer in plan mode, and returns Ask to the person’s own mode', () => {
    const events: ChatEvent[] = []; const written: Record<string, unknown>[] = [];
    const stream = new ClaudeStream((line) => written.push(JSON.parse(line)), (event) => events.push(event));
    const modes = () => written.map((line) => (line.request as { mode?: string } | undefined)?.mode).filter(Boolean);
    stream.push(JSON.stringify({ type: 'system', subtype: 'init', permissionMode: 'acceptEdits', session_id: 's' }) + '\n');
    stream.setPermissions('full'); stream.setPermissions('full');
    expect(modes()).toEqual(['bypassPermissions']);
    stream.setReadOnly(true); stream.setPermissions('edits');
    expect(modes()).toEqual(['bypassPermissions', 'plan']);
    stream.setReadOnly(false); stream.setPermissions('ask');
    // Ask is the mode Claude started in with the person's settings, not a fixed default.
    expect(modes()).toEqual(['bypassPermissions', 'plan', 'acceptEdits', 'acceptEdits']);
    const refused = written[0].request_id;
    stream.push(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: refused, error: 'not launched with it' } }) + '\n');
    expect(events.at(-1)).toEqual({ type: 'notice', text: 'Claude did not change its permissions: not launched with it.' });
  });
  it('puts the level back and tells the window when Claude refuses a change', () => {
    const events: ChatEvent[] = []; const written: Record<string, unknown>[] = [];
    const stream = new ClaudeStream((line) => written.push(JSON.parse(line)), (event) => events.push(event), 'edits');
    stream.setPermissions('full');
    stream.push(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: written[0].request_id, error: 'bypass_not_launched' } }) + '\n');
    expect(events.slice(-2)).toEqual([{ type: 'notice', text: 'Claude did not change its permissions: bypass_not_launched.' }, { type: 'permissions', level: 'edits' }]);
    // Asking for the level again sends it again (the stream is back at edits).
    stream.setPermissions('full'); expect(written).toHaveLength(2);
  });
  it('does not let an older refused change undo a newer one, whichever answer comes first', () => {
    for (const newerFirst of [true, false]) {
      const events: ChatEvent[] = []; const written: Record<string, unknown>[] = [];
      const stream = new ClaudeStream((line) => written.push(JSON.parse(line)), (event) => events.push(event), 'edits');
      stream.setPermissions('full'); stream.setPermissions('ask');
      const [older, newer] = written.map((line) => line.request_id);
      const answer = (id: unknown, ok: boolean) => stream.push(JSON.stringify({ type: 'control_response', response: ok ? { subtype: 'success', request_id: id, response: {} } : { subtype: 'error', request_id: id, error: 'bypass_not_launched' } }) + '\n');
      if (newerFirst) { answer(newer, true); answer(older, false); } else { answer(older, false); answer(newer, true); }
      expect(events.filter((event) => event.type === 'permissions')).toEqual([]);
      // Still at Ask: asking for Ask again sends nothing.
      stream.setPermissions('ask'); expect(written).toHaveLength(2);
    }
  });
  it('reports the context window of the model the chat runs, not a subagent’s', () => {
    const events: ChatEvent[] = []; const stream = new ClaudeStream(() => {}, (event) => events.push(event));
    stream.push(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 's' }) + '\n');
    stream.push(JSON.stringify({ type: 'result', subtype: 'success', modelUsage: { 'claude-haiku-5-5': { contextWindow: 200000 }, 'claude-opus-5-5': { contextWindow: 1000000 } } }) + '\n');
    expect(events.filter((event) => event.type === 'context-window')).toEqual([{ type: 'context-window', size: 1000000 }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: false });
  });
  it('does not take a mode it was launched with for the person’s own', () => {
    const written: Record<string, unknown>[] = [];
    const stream = new ClaudeStream((line) => written.push(JSON.parse(line)), () => {}, 'edits');
    stream.push(JSON.stringify({ type: 'system', subtype: 'init', permissionMode: 'acceptEdits', session_id: 's' }) + '\n');
    stream.setPermissions('ask');
    expect(written.at(-1)).toMatchObject({ request: { subtype: 'set_permission_mode', mode: 'default' } });
  });
});
