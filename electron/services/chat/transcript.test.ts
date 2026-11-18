import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatHistory, chatText, taskHistory } from './transcript';

/** transcript.ts READ_LIMIT: the most read after a task's prompt. */
const READ_BYTES = 8 * 1024 * 1024;
const file = (lines: unknown[]) => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-')); const target = path.join(directory, 'conversation.jsonl'); fs.writeFileSync(target, lines.map((line) => JSON.stringify(line)).join('\n') + '\n'); return target; };

describe('chat transcripts', () => {
  it('reads a resumed Claude conversation: messages, merged reply blocks, tool results, without the CLI\'s own context', () => {
    const history = chatHistory('claude', file([
      { type: 'mode', mode: 'default' },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Look at this' }, { type: 'image', source: {} }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'hmm' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Running it.' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: false }] } },
      { type: 'assistant', isSidechain: true, message: { id: 'side', content: [{ type: 'text', text: 'subagent' }] } },
      'not json',
    ]));
    expect(history.messages).toEqual([
      { role: 'user', text: 'Look at this', images: 1 },
      { role: 'assistant', messageId: 'm1', blocks: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Running it.' }, { type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    ]);
    expect(history.results).toEqual({ t1: { text: 'a.txt', isError: false, image: false } });
  });
  it('reads a resumed Codex conversation, leaving out the context it adds to the first message', () => {
    const history = chatHistory('codex', file([
      { type: 'session_meta', payload: { id: 't', cwd: '/p' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:' }, { type: 'input_text', text: 'Fix it' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'a.txt' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'r1', content: [{ type: 'output_text', text: 'Done.' }] } },
    ]));
    expect(history.messages).toEqual([
      { role: 'user', text: 'Fix it', images: 1 },
      { role: 'assistant', messageId: 'c1', blocks: [{ type: 'tool', id: 'c1', name: 'shell', input: { command: ['ls'] } }] },
      { role: 'assistant', messageId: 'r1', blocks: [{ type: 'text', text: 'Done.' }] },
    ]);
    expect(history.results.c1).toMatchObject({ text: 'a.txt' });
  });
  it('reads a long task from its own prompt, past the window a resumed chat shows, across pieces and multi-byte text', async () => {
    const said = (text: string, id: string) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
    const target = file([
      { type: 'user', message: { role: 'user', content: 'Task t-00000001: Earlier.' } }, said('Old reply', 'm0'),
      { type: 'user', message: { role: 'user', content: 'Task t-0000abcd: Long task.\n\nDetails' } },
      ...Array.from({ length: 450 }, (_, index) => said('é'.repeat(10000) + index, `m${index + 1}`)), said('All done.\nTASK COMPLETE', 'last'),
    ]);
    expect(fs.statSync(target).size).toBeGreaterThan(8 * 1024 * 1024);
    expect(chatHistory('claude', target).messages.some((message) => message.role === 'user' && message.text.includes('Task t-0000abcd:'))).toBe(false);
    const history = await taskHistory('claude', target, 'Task t-0000abcd:');
    // The prompt, then only the end of what followed (the reply is at the end): not 9 MB of messages each time Tasks looks.
    expect(history?.messages[0]).toEqual({ role: 'user', text: 'Task t-0000abcd: Long task.\n\nDetails', images: 0 }); expect(history?.messages).toHaveLength(201); expect(history?.results).toEqual({});
    expect(history?.messages.at(-1)).toEqual({ role: 'assistant', messageId: 'last', blocks: [{ type: 'text', text: 'All done.\nTASK COMPLETE' }] });
    expect(history?.messages.slice(1, -1).every((message) => message.role === 'assistant' && message.blocks[0].type === 'text' && /^é{10000}\d+$/.test(message.blocks[0].text))).toBe(true);
    expect(JSON.stringify(history).length).toBeLessThan(READ_BYTES);
    // It ends where the next task was sent, also when that is far past the task's own prompt.
    const next = file([
      { type: 'user', message: { role: 'user', content: 'Task t-0000abcd: First.' } }, ...Array.from({ length: 900 }, (_, index) => said('x'.repeat(10000) + index, `a${index}`)), said('Mine.\nTASK COMPLETE', 'mine'),
      { type: 'user', message: { role: 'user', content: 'Task t-0000beef: Second.' } }, said('Theirs.\nTASK COMPLETE', 'theirs'),
    ]);
    const first = await taskHistory('claude', next, 'Task t-0000abcd:');
    expect(first?.messages[0]).toMatchObject({ role: 'user', text: 'Task t-0000abcd: First.' }); expect(first?.messages.at(-1)).toEqual({ role: 'assistant', messageId: 'mine', blocks: [{ type: 'text', text: 'Mine.\nTASK COMPLETE' }] });
    expect((await taskHistory('claude', next, 'Task t-0000beef:'))?.messages.map((message) => message.role === 'user' ? message.text : message.messageId)).toEqual(['Task t-0000beef: Second.', 'theirs']);
    // A mark only the agent quoted is not the task's prompt; a mark nobody sent is not found.
    expect(await taskHistory('claude', file([said('I saw Task t-0000ffff: in the log', 'q')]), 'Task t-0000ffff:')).toBeNull();
    expect((await taskHistory('codex', file([{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Task t-00000002: Fix.' }] } }, { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'r', content: [{ type: 'output_text', text: 'Fixed.' }] } }]), 'Task t-00000002:'))?.messages).toEqual([{ role: 'user', text: 'Task t-00000002: Fix.', images: 0 }, { role: 'assistant', messageId: 'r', blocks: [{ type: 'text', text: 'Fixed.' }] }]);
    expect(await taskHistory('claude', path.join(os.tmpdir(), 'missing-transcript.jsonl'), 'Task t-00000003:')).toBeNull();
  });
  it('writes the conversation as text for the run\'s saved output', () => {
    expect(chatText({ type: 'user', text: 'two\nlines', images: 2 })).toBe('\r\n› two\r\nlines [2 images]\r\n');
    expect(chatText({ type: 'assistant', messageId: 'm', blocks: [{ type: 'thinking', text: 'x' }, { type: 'text', text: 'Hi' }, { type: 'tool', id: 't', name: 'Bash', input: {} }] })).toBe('\r\nHi\r\n  ⏺ Bash\r\n');
    expect(chatText({ type: 'delta', messageId: 'm', text: 'H' })).toBe('');
    expect(chatText({ type: 'done', isError: true, error: 'Interrupted.' })).toBe('\r\nInterrupted.\r\n');
  });
});
