import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
import { ClaudeStream } from './claude-stream';
import { Lines, readLines } from './lines';

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
  it('passes back only the accept-edits mode and session folders on Allow edits, and names the tool’s own name when Claude shows another', () => {
    const events: ChatEvent[] = []; const written: Record<string, unknown>[] = [];
    const stream = new ClaudeStream((line) => written.push(JSON.parse(line)), (event) => events.push(event));
    const rule = { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' }; const mode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
    stream.push(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Edit', display_name: 'Edit file', input: { file_path: 'a.ts' }, permission_suggestions: [rule, mode] } }) + '\n');
    expect(events.at(-1)).toMatchObject({ type: 'permission', toolName: 'Edit file', tool: 'Edit', canAllowEdits: true });
    stream.answer('r1', true, true);
    expect(written.at(-1)).toMatchObject({ response: { response: { behavior: 'allow', updatedPermissions: [mode] } } });
    stream.push(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }) + '\n');
    expect(events.at(-1)).not.toHaveProperty('tool');
    // A write outside the project: the folder added for this session goes back with the mode; one saved to settings does not.
    const folder = { type: 'addDirectories', directories: ['C:/other'], destination: 'session' }; const saved = { ...folder, destination: 'projectSettings' };
    stream.push(JSON.stringify({ type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'C:/other/b.ts' }, permission_suggestions: [mode, folder, saved] } }) + '\n');
    stream.answer('r3', true, true);
    expect((written.at(-1) as { response: { response: { updatedPermissions: unknown[] } } }).response.response.updatedPermissions).toEqual([mode, folder]);
  });
  it('reads a line split over many chunks, and skips one past the limit with a notice', () => {
    const events: ChatEvent[] = []; const stream = new ClaudeStream(() => {}, (event) => events.push(event));
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'x'.repeat(100_000) }) + '\n';
    for (let at = 0; at < line.length; at += 997) stream.push(line.slice(at, at + 997));
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    const read: Record<string, unknown>[] = []; const notices: ChatEvent[] = []; const lines = new Lines(10);
    for (const chunk of ['{"a":', '1}\n{"b":"long', 'er than ten"', '}\n{"c":3}', '\n']) readLines(lines, chunk, 'Codex', (event) => notices.push(event), (message) => read.push(message));
    // The long line is dropped whole, up to its line break; the lines around it are read.
    expect(read).toEqual([{ a: 1 }, { c: 3 }]); expect(notices).toEqual([{ type: 'notice', text: expect.stringContaining('Trace skipped a message from Codex') }]);
  });
  it('does not take a mode it was launched with for the person’s own', () => {
    const written: Record<string, unknown>[] = [];
    const stream = new ClaudeStream((line) => written.push(JSON.parse(line)), () => {}, 'edits');
    stream.push(JSON.stringify({ type: 'system', subtype: 'init', permissionMode: 'acceptEdits', session_id: 's' }) + '\n');
    stream.setPermissions('ask');
    expect(written.at(-1)).toMatchObject({ request: { subtype: 'set_permission_mode', mode: 'default' } });
  });
});
