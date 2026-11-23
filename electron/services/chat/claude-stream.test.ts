import { describe, expect, it, vi } from 'vitest';
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
  it('keeps the person’s own mode for Ask when a later turn’s init reports the mode Trace set', () => {
    const written: Record<string, unknown>[] = []; const stream = new ClaudeStream((line) => written.push(JSON.parse(line)), () => {});
    const modes = () => written.map((line) => (line.request as { mode?: string } | undefined)?.mode).filter(Boolean);
    const init = (permissionMode: string) => stream.push(JSON.stringify({ type: 'system', subtype: 'init', permissionMode, session_id: 's' }) + '\n');
    init('default'); stream.setPermissions('full');
    init('bypassPermissions');
    stream.setPermissions('ask');
    expect(modes()).toEqual(['bypassPermissions', 'default']);
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
  describe('a turn with background subagents', () => {
    const setup = () => { const events: ChatEvent[] = []; const stream = new ClaudeStream(() => {}, (event) => events.push(event)); const push = (message: Record<string, unknown>) => stream.push(JSON.stringify(message) + '\n'); const dones = () => events.filter((event) => event.type === 'done').length; return { events, stream, push, dones }; };
    const tasks = (...types: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: types.map((task_type, i) => ({ task_id: `t${i}`, task_type })) });
    const say = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: text, content: [{ type: 'text', text }] } });
    const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, ...extra });
    const notification = { origin: { kind: 'task-notification', producer: 'session-task' } };
    it('gives one done, after DONE, for the order Claude sends in a chat run', () => {
      vi.useFakeTimers();
      try {
        const { events, push, dones } = setup();
        push(tasks('local_agent')); push(say('STARTED')); push(result({ result: 'STARTED' }));
        expect(dones()).toBe(0);
        push(tasks()); push(say('DONE')); push(result({ result: 'DONE', ...notification }));
        expect(dones()).toBe(1); expect(events.at(-1)).toEqual({ type: 'done', isError: false, error: null });
        expect(events.findIndex((event) => event.type === 'done')).toBeGreaterThan(events.findIndex((event) => event.type === 'assistant' && event.blocks[0]?.type === 'text' && event.blocks[0].text === 'DONE'));
        vi.advanceTimersByTime(60000); expect(dones()).toBe(1);
      } finally { vi.useRealTimers(); }
    });
    it('ends a reply Claude started by itself, after a background command reported back, for the display only', () => {
      const { events, stream, push, dones } = setup();
      stream.send('watch the release in the background', []); push(tasks('local_bash')); push(say('Watching.')); push(result()); expect(dones()).toBe(1);
      // The command finishes and tells Claude, which writes a reply nobody asked for. Its end is no turn's end (no `done`,
      // which a task or a handoff would act on), but the conversation is told, or "Claude Code is working" stayed on.
      push(tasks()); push(say('It is published.')); push(result(notification));
      expect(dones()).toBe(1); expect(events.at(-1)).toEqual({ type: 'settled' });
      // And again for the next one.
      push(say('One more thing.')); push(result(notification)); expect(dones()).toBe(1); expect(events.filter((event) => event.type === 'settled')).toHaveLength(2);
    });
    it('leaves a reply the person is owed open when a notification’s turn ends before it', () => {
      const { events, stream, push, dones } = setup();
      stream.send('first', []); push(say('one')); push(result()); expect(dones()).toBe(1);
      // The person's next message is waiting behind a turn Claude started itself: that turn's end frees nothing.
      stream.send('second', []); push(say('The background task finished.')); push(result(notification));
      expect(dones()).toBe(1); expect(events.some((event) => event.type === 'settled')).toBe(false);
      push(say('two')); push(result()); expect(dones()).toBe(2); expect(events.at(-1)).toEqual({ type: 'done', isError: false, error: null });
      // Nothing owed again: a later one settles.
      push(say('late')); push(result(notification)); expect(events.at(-1)).toEqual({ type: 'settled' });
    });
    it('settles a subagent’s notification that comes after its turn was already given up as ended', () => {
      vi.useFakeTimers();
      try {
        const { events, stream, push, dones } = setup();
        stream.send('use an agent', []); push(tasks('local_agent')); push(say('STARTED')); push(result()); expect(dones()).toBe(0);
        // The agent ends, no result follows in time, and the held turn is ended.
        push(tasks()); vi.advanceTimersByTime(60000); expect(dones()).toBe(1);
        // Its notification's turn comes late: one more `done` would end a turn nobody has open.
        push(say('The agent reported.')); push(result(notification));
        expect(dones()).toBe(1); expect(events.at(-1)).toEqual({ type: 'settled' });
      } finally { vi.useRealTimers(); }
    });
    it('still ends a turn with an error or after Stop, whatever started it', () => {
      const { events, stream, push, dones } = setup();
      push(say('broken')); push(result({ ...notification, is_error: true, result: 'It failed.' }));
      expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'It failed.' });
      stream.interrupt(); push(result(notification)); expect(dones()).toBe(2);
    });
    it('ends a plain turn at its result, and ignores a background shell command', () => {
      const { push, dones } = setup(); push(result()); expect(dones()).toBe(1);
      push(tasks('local_bash')); push(result()); expect(dones()).toBe(2);
    });
    it('ends no turn with a notification result when none is held', () => {
      const { push, dones } = setup(); push(result(notification)); expect(dones()).toBe(0);
    });
    it('does not hold an error result or a result after Stop, and clears the hold', () => {
      const { push, dones, stream } = setup();
      push(tasks('local_agent')); push({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }); expect(dones()).toBe(1);
      stream.send('next', []); push(result()); expect(dones()).toBe(1); // Stop ends the held turn at once (Claude kills the subagent and sends no further result); a result that did come is not held either.
      stream.interrupt(); expect(dones()).toBe(2); push(result()); expect(dones()).toBe(3);
      push(tasks()); push(result(notification)); expect(dones()).toBe(3);
    });
    it('sends the held done after 15 seconds when no result follows, and not after close', () => {
      vi.useFakeTimers();
      try {
        const { push, dones, stream } = setup(); push(tasks('local_agent')); push(result()); push(tasks());
        vi.advanceTimersByTime(14999); expect(dones()).toBe(0); vi.advanceTimersByTime(1); expect(dones()).toBe(1);
        push(tasks('local_agent')); push(result()); push(tasks()); stream.close(); vi.advanceTimersByTime(60000); expect(dones()).toBe(1); expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });
    it('holds until the last of two subagents is gone', () => {
      const { push, dones } = setup();
      push(tasks('local_agent', 'local_agent')); push(result()); push(tasks('local_agent')); push(result(notification)); expect(dones()).toBe(0);
      push(tasks()); push(result(notification)); expect(dones()).toBe(1);
    });
  });
  it('does not show a subagent\'s messages as the agent\'s own: only those with no parent tool call', () => {
    const events: ChatEvent[] = []; const stream = new ClaudeStream(() => {}, (event) => events.push(event));
    const assistant = (parent: string | null, id: string, content: unknown[]) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { id, content } }) + '\n';
    stream.push(assistant(null, 'm1', [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }]));
    stream.push(assistant('toolu_1', 'm2', [{ type: 'thinking', thinking: 'hm' }])); stream.push(assistant('toolu_1', 'm3', [{ type: 'text', text: 'PINEAPPLE' }]));
    stream.push(JSON.stringify({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PINE' } } }) + '\n');
    stream.push(JSON.stringify({ type: 'user', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'sub result' }] } }) + '\n');
    stream.push(JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'agent result' }] } }) + '\n');
    stream.push(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'DO' } } }) + '\n');
    stream.push(assistant(null, 'm4', [{ type: 'text', text: 'DONE' }]));
    expect(events).toEqual([
      { type: 'assistant', messageId: 'm1', blocks: [{ type: 'tool', id: 'toolu_1', name: 'Agent', input: {} }] },
      { type: 'tool-result', toolUseId: 'toolu_1', text: 'agent result', isError: false, image: false },
      { type: 'delta', messageId: 'streaming', text: 'DO' },
      { type: 'assistant', messageId: 'm4', blocks: [{ type: 'text', text: 'DONE' }] },
    ]);
  });
  it('ends a held turn at once when Stop is pressed while its background subagent still runs', () => {
    const events: ChatEvent[] = []; const stream = new ClaudeStream(() => {}, (event) => events.push(event));
    const line = (value: unknown) => stream.push(JSON.stringify(value) + '\n');
    stream.send('go', []); line({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_type: 'local_agent' }] }); line({ type: 'result', subtype: 'success', result: 'STARTED' });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
    stream.interrupt(); expect(events.filter((event) => event.type === 'done')).toHaveLength(1); stream.close();
  });
});
