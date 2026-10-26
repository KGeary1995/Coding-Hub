import { randomUUID } from 'node:crypto';
import { TOOL_RESULT_LIMIT, type ChatBlock, type ChatEvent, type ChatImage } from '../../../shared/chat';

/** The flags that run Claude Code in structured mode, answering its permission prompts here (see ClaudeStream). */
export const CHAT_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];

const text = (value: unknown) => typeof value === 'string' ? value : '';
const shorten = (value: string) => value.length > TOOL_RESULT_LIMIT ? value.slice(0, TOOL_RESULT_LIMIT) + `\n… ${(value.length - TOOL_RESULT_LIMIT).toLocaleString('en-US')} more characters` : value;

/**
 * One chat run's conversation with Claude Code over stdin/stdout, one JSON object per line. Claude's messages become
 * ChatEvents; the window's messages and approvals become Claude's input. Approval requests arrive as
 * `control_request`/`can_use_tool` once the host has introduced itself (`initialize`), and are answered with a
 * `control_response` saying allow (with the input unchanged) or deny.
 */
/** What a chat run needs from the CLI's protocol, whichever CLI it is. */
export interface ChatStream { start(): void; send(message: string, images: ChatImage[]): void; answer(requestId: string, allow: boolean, allowEdits?: boolean): boolean; interrupt(): void; close(): void; push(data: string): void }

export class ClaudeStream implements ChatStream {
  private buffer = '';
  private pending = new Map<string, { input: Record<string, unknown>; suggestions: unknown[] }>();
  constructor(private write: (line: string) => void, private emit: (event: ChatEvent) => void) {}

  /** Says hello; Claude then sends approval requests here instead of refusing them. */
  start() { this.control({ subtype: 'initialize', hooks: null }); }
  send(message: string, images: ChatImage[]) {
    const content = [...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })), ...(message ? [{ type: 'text', text: message }] : [])];
    this.line({ type: 'user', message: { role: 'user', content } });
  }
  answer(requestId: string, allow: boolean, allowEdits = false) {
    const request = this.pending.get(requestId); if (!request) return false;
    this.pending.delete(requestId);
    const response = allow
      ? { behavior: 'allow', updatedInput: request.input, ...(allowEdits && request.suggestions.length ? { updatedPermissions: request.suggestions } : {}) }
      : { behavior: 'deny', message: 'The person declined this in Trace.' };
    this.line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emit({ type: 'permission-done', requestId });
    return true;
  }
  interrupt() { this.control({ subtype: 'interrupt' }); }
  /** Requests still waiting when the run ends are closed in the window. */
  close() { for (const requestId of this.pending.keys()) this.emit({ type: 'permission-done', requestId }); this.pending.clear(); }

  /** Output from Claude: complete lines are parsed, a partial line waits for the rest. */
  push(data: string) {
    this.buffer += data; let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message: unknown; try { message = JSON.parse(line); } catch { continue; }
      // Only JSON objects are messages; a line that is not one (or one that cannot be handled) is skipped, never let
      // out of the output listener, where it would bring down the app.
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      try { this.read(message as Record<string, unknown>); } catch { /* Skipped. */ }
    }
    // A single line this large is not something Claude sends; drop it rather than grow without bound.
    if (this.buffer.length > 64 * 1024 * 1024) this.buffer = '';
  }

  private line(value: unknown) { this.write(JSON.stringify(value) + '\n'); }
  private control(request: Record<string, unknown>) { this.line({ type: 'control_request', request_id: randomUUID(), request }); }

  private read(message: Record<string, unknown>) {
    const type = message.type;
    if (type === 'system' && message.subtype === 'init') { this.emit({ type: 'ready', conversationId: text(message.session_id), model: text(message.model) || null }); return; }
    if (type === 'system' && message.subtype === 'permission_denied') { this.emit({ type: 'notice', text: text(message.message) || `${text(message.tool_name)} was not allowed.` }); return; }
    if (type === 'system' && message.subtype === 'api_retry') { this.emit({ type: 'notice', text: 'Claude’s API was busy; retrying.' }); return; }
    if (type === 'stream_event') {
      const event = message.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      const id = text((message as { message_id?: unknown }).message_id) || text((message.event as { message?: { id?: unknown } } | undefined)?.message?.id);
      if (event?.type === 'message_start') this.streaming = text((event as { message?: { id?: unknown } }).message?.id) || randomUUID();
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) this.emit({ type: 'delta', messageId: id || this.streaming || 'streaming', text: event.delta.text });
      return;
    }
    if (type === 'assistant') {
      const body = message.message as { id?: unknown; content?: unknown[] } | undefined;
      const blocks: ChatBlock[] = [];
      for (const raw of body?.content ?? []) {
        const block = raw as { type?: string; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown };
        if (block.type === 'text' && text(block.text)) blocks.push({ type: 'text', text: text(block.text) });
        else if (block.type === 'thinking' && text(block.thinking)) blocks.push({ type: 'thinking', text: text(block.thinking) });
        else if (block.type === 'tool_use') blocks.push({ type: 'tool', id: text(block.id), name: text(block.name), input: (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown> });
      }
      if (blocks.length) this.emit({ type: 'assistant', messageId: text(body?.id) || randomUUID(), blocks });
      return;
    }
    if (type === 'user') {
      // Tool results come back to Claude as user messages; the person's own messages are not echoed.
      for (const raw of ((message.message as { content?: unknown[] } | undefined)?.content ?? [])) {
        const block = raw as { type?: string; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
        if (block.type !== 'tool_result') continue;
        const parts = Array.isArray(block.content) ? block.content as { type?: string; text?: unknown }[] : [{ type: 'text', text: block.content }];
        this.emit({ type: 'tool-result', toolUseId: text(block.tool_use_id), text: shorten(parts.filter((part) => part.type === 'text').map((part) => text(part.text)).join('\n')), isError: block.is_error === true, image: parts.some((part) => part.type === 'image') });
      }
      return;
    }
    if (type === 'control_request') {
      const request = message.request as { subtype?: string; tool_name?: unknown; display_name?: unknown; description?: unknown; input?: unknown; permission_suggestions?: unknown } | undefined;
      const requestId = text(message.request_id);
      if (request?.subtype === 'can_use_tool' && requestId) {
        const input = (request.input && typeof request.input === 'object' ? request.input : {}) as Record<string, unknown>;
        const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
        this.pending.set(requestId, { input, suggestions });
        this.emit({ type: 'permission', requestId, toolName: text(request.display_name) || text(request.tool_name), description: text(request.description), input, canAllowEdits: suggestions.some((item) => (item as { mode?: unknown }).mode === 'acceptEdits') });
      } else if (requestId) {
        // Requests the host does not handle are answered, so Claude does not wait on them.
        this.line({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Trace does not handle ${request?.subtype ?? 'this request'}.` } });
      }
      return;
    }
    if (type === 'result') {
      const isError = message.is_error === true || (typeof message.subtype === 'string' && message.subtype.startsWith('error'));
      this.emit({ type: 'done', isError, error: isError ? (text(message.result) || (Array.isArray(message.errors) ? (message.errors as unknown[]).map(text).join(' ') : '') || 'The reply ended with an error.') : null });
    }
  }
  private streaming: string | null = null;
}
