import fs from 'node:fs';
import { TOOL_RESULT_LIMIT, type ChatBlock, type ChatEvent, type ChatHistoryMessage } from '../../../shared/chat';

/** The end of a transcript that is read for a resumed conversation's earlier messages. */
const READ_LIMIT = 8 * 1024 * 1024;
/** The most earlier messages shown, and the longest text kept from each. */
const MESSAGES = 200; const TEXT_LIMIT = 20000;

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, TEXT_LIMIT) : '';
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];

/** The last part of a file, from the start of a whole line. */
function tail(file: string): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size; const start = Math.max(0, size - READ_LIMIT); const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start); const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally { fs.closeSync(fd); }
}
const parse = (line: string): Json | null => { try { return record(JSON.parse(line)); } catch { return null; } };

/**
 * A resumed conversation's earlier messages, from the CLI's own transcript: what the person wrote (with how many images)
 * and what the agent replied and ran, with the results of its tools. Context the CLI adds itself is left out.
 */
export function chatHistory(engine: 'claude' | 'codex', file: string): Extract<ChatEvent, { type: 'history' }> {
  const messages: ChatHistoryMessage[] = []; const results: Extract<ChatEvent, { type: 'history' }>['results'] = {};
  const lines = tail(file);
  if (engine === 'claude') {
    for (const line of lines) {
      const event = parse(line); if (!event || event.isSidechain || event.isMeta) continue;
      const message = record(event.message); const content = message.content;
      if (event.type === 'user') {
        if (typeof content === 'string') { if (!content.startsWith('<')) messages.push({ role: 'user', text: text(content), images: 0 }); continue; }
        const blocks = list(content); let images = 0; const words: string[] = [];
        for (const block of blocks) {
          if (block.type === 'text' && !text(block.text).startsWith('<')) words.push(text(block.text));
          else if (block.type === 'image') images++;
          else if (block.type === 'tool_result') {
            const output = typeof block.content === 'string' ? block.content : list(block.content).filter((part) => part.type === 'text').map((part) => text(part.text)).join('\n');
            results[text(block.tool_use_id)] = { text: output.slice(0, TOOL_RESULT_LIMIT), isError: block.is_error === true, image: list(block.content).some((part) => part.type === 'image') };
          }
        }
        if (words.length || images) messages.push({ role: 'user', text: words.join('\n'), images });
      } else if (event.type === 'assistant') {
        const blocks: ChatBlock[] = list(content).flatMap((block): ChatBlock[] => block.type === 'text' && text(block.text) ? [{ type: 'text', text: text(block.text) }]
          : block.type === 'thinking' && text(block.thinking) ? [{ type: 'thinking', text: text(block.thinking) }]
          : block.type === 'tool_use' ? [{ type: 'tool', id: text(block.id), name: text(block.name), input: record(block.input) }] : []);
        if (!blocks.length) continue;
        // Claude writes one line per block of a message, all with the message's id.
        const id = text(message.id); const last = messages.at(-1);
        if (last?.role === 'assistant' && id && last.messageId === id) last.blocks.push(...blocks); else messages.push({ role: 'assistant', messageId: id, blocks });
      }
    }
  } else {
    for (const line of lines) {
      const event = parse(line); if (!event || event.type !== 'response_item') continue;
      const item = record(event.payload);
      if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) {
        const parts = list(item.content); const words = parts.filter((part) => part.type === 'input_text' || part.type === 'output_text').map((part) => text(part.text)).filter((value) => value && !value.startsWith('<'));
        const images = parts.filter((part) => part.type === 'input_image').length;
        if (item.role === 'user') { if (words.length || images) messages.push({ role: 'user', text: words.join('\n'), images }); }
        else if (words.length) messages.push({ role: 'assistant', messageId: text(item.id), blocks: words.map((value) => ({ type: 'text', text: value })) });
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        let input: Json = {}; try { input = record(JSON.parse(text(item.arguments ?? item.input))); } catch { input = { input: text(item.input ?? item.arguments) }; }
        messages.push({ role: 'assistant', messageId: text(item.call_id), blocks: [{ type: 'tool', id: text(item.call_id), name: text(item.name), input }] });
      } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const output = record(item.output); results[text(item.call_id)] = { text: (typeof item.output === 'string' ? item.output : text(output.content)).slice(0, TOOL_RESULT_LIMIT), isError: false, image: false };
      }
    }
  }
  return { type: 'history', messages: messages.slice(-MESSAGES), results };
}

/** A chat event as plain text for the run's saved output, so chats can be searched and exported like terminals. */
export function chatText(event: ChatEvent): string {
  const lines = (value: string) => value.replace(/\r?\n/g, '\r\n');
  switch (event.type) {
    case 'user': return `\r\n› ${lines(event.text)}${event.images ? ` [${event.images} image${event.images === 1 ? '' : 's'}]` : ''}\r\n`;
    case 'assistant': return event.blocks.map((block) => block.type === 'text' ? `\r\n${lines(block.text)}\r\n` : block.type === 'tool' ? `  ⏺ ${block.name}\r\n` : '').join('');
    case 'notice': return `\r\n${lines(event.text)}\r\n`;
    case 'done': return event.isError && event.error ? `\r\n${lines(event.error)}\r\n` : '';
    default: return '';
  }
}
