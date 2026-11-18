import fs from 'node:fs';
import { TOOL_RESULT_LIMIT, type ChatBlock, type ChatEvent, type ChatHistoryMessage } from '../../../shared/chat';
import { nextTaskPrompt, SIGNAL_INSTRUCTION } from '../../../shared/task-signal';

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
  const history = historyOf(engine, tail(file)); return { ...history, messages: history.messages.slice(-MESSAGES) };
}

/** The most a task read goes back through a transcript: far past any one task, short of holding a runaway file. */
const TASK_READ_LIMIT = 256 * 1024 * 1024; const CHUNK = 1024 * 1024;
/** Bytes that start another task's prompt: its send id, or the instruction every task prompt carries. */
const NEXT_SEND = Buffer.from('Task t-'); const INSTRUCTION = Buffer.from(JSON.stringify(SIGNAL_INSTRUCTION).slice(1, -1));
/** Offsets of the lines in `region` that contain any of `needles`, newest first. */
function linesWith(region: Buffer, needles: Buffer[]): number[] {
  const starts = new Set<number>();
  for (const needle of needles) for (let at = region.lastIndexOf(needle); at >= 0; at = at > 0 ? region.lastIndexOf(needle, at - 1) : -1) starts.add(region.lastIndexOf(10, at) + 1);
  return [...starts].sort((a, b) => b - a);
}
/**
 * A task's part of a conversation, for the reply to it: the newest user message that carries `mark` (the task's send
 * mark, "Task <sendId>:"), then the last MESSAGES messages of what followed, up to the next task's prompt, read from at
 * most READ_LIMIT before that point (the task can have run for hours). The transcript is read backwards a piece at a
 * time without holding the process, keeping only where lines of interest start. Tool results are left out (the reply is
 * text). Null when no message carries the mark (or the file cannot be read).
 */
export async function taskHistory(engine: 'claude' | 'codex', file: string, mark: string): Promise<Extract<ChatEvent, { type: 'history' }> | null> {
  // As the mark appears inside a JSON line.
  const raw = Buffer.from(JSON.stringify(mark).slice(1, -1)); let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(file, 'r'); } catch { return null; }
  const users = (line: string) => historyOf(engine, [line]).messages.filter((message) => message.role === 'user');
  try {
    const size = (await handle.stat()).size; let position = size;
    // `carry`: the start of the piece read last, up to its first line break (a line that may begin in an earlier piece).
    // Pieces are joined as bytes, so no character is split. `stop`: where the next task's prompt starts, if one was sent.
    let carry = Buffer.alloc(0); let stop = size;
    while (position > 0 && size - position < TASK_READ_LIMIT) {
      const length = Math.min(CHUNK, position); position -= length; const piece = Buffer.alloc(length);
      const { bytesRead } = await handle.read(piece, 0, length, position); const block = Buffer.concat([piece.subarray(0, bytesRead), carry]);
      const cut = position > 0 ? block.indexOf(10) + 1 : 0; if (position > 0 && cut === 0) { carry = block; continue; }
      carry = block.subarray(0, cut); const region = block.subarray(cut); const offset = position + cut;
      for (const start of linesWith(region, [raw, NEXT_SEND, INSTRUCTION])) {
        const end = region.indexOf(10, start); const bytes = region.subarray(start, end < 0 ? region.length : end); const line = bytes.toString('utf8');
        const said = users(line);
        if (bytes.includes(raw) && said.some((message) => message.text.includes(mark))) return { type: 'history', messages: [...said.filter((message) => message.text.includes(mark)).slice(-1), ...await after(handle, offset + start + bytes.length + 1, stop)], results: {} };
        if (said.some((message) => nextTaskPrompt(message.text, mark))) stop = offset + start;
      }
    }
    return null;
  } catch { return null; } finally { await handle.close().catch(() => {}); }
  /** The last MESSAGES messages between `from` and `to`, read from at most READ_LIMIT before `to`, from the start of a whole line. */
  async function after(file: fs.promises.FileHandle, from: number, to: number): Promise<ChatHistoryMessage[]> {
    if (from >= to) return [];
    const start = Math.max(from, to - READ_LIMIT); const buffer = Buffer.alloc(to - start); const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    return historyOf(engine, start > from ? lines.slice(1) : lines).messages.slice(-MESSAGES);
  }
}

function historyOf(engine: 'claude' | 'codex', lines: string[]): Extract<ChatEvent, { type: 'history' }> {
  const messages: ChatHistoryMessage[] = []; const results: Extract<ChatEvent, { type: 'history' }>['results'] = {};
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
  return { type: 'history', messages, results };
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
