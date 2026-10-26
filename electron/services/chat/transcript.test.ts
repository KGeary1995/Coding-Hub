import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatHistory, chatText } from './transcript';

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
  it('writes the conversation as text for the run\'s saved output', () => {
    expect(chatText({ type: 'user', text: 'two\nlines', images: 2 })).toBe('\r\n› two\r\nlines [2 images]\r\n');
    expect(chatText({ type: 'assistant', messageId: 'm', blocks: [{ type: 'thinking', text: 'x' }, { type: 'text', text: 'Hi' }, { type: 'tool', id: 't', name: 'Bash', input: {} }] })).toBe('\r\nHi\r\n  ⏺ Bash\r\n');
    expect(chatText({ type: 'delta', messageId: 'm', text: 'H' })).toBe('');
    expect(chatText({ type: 'done', isError: true, error: 'Interrupted.' })).toBe('\r\nInterrupted.\r\n');
  });
});
