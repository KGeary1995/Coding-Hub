import { TOOL_RESULT_LIMIT, type ChatEvent, type ChatImage } from '../../../shared/chat';
import type { ChatStream } from './claude-stream';

const text = (value: unknown) => typeof value === 'string' ? value : '';
const shorten = (value: string) => value.length > TOOL_RESULT_LIMIT ? value.slice(0, TOOL_RESULT_LIMIT) + `\n… ${(value.length - TOOL_RESULT_LIMIT).toLocaleString('en-US')} more characters` : value;
const record = (value: unknown) => (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

/** How a Codex thread starts: the model and reasoning chosen for the channel, and a saved thread to resume. */
export interface CodexThreadOptions { cwd: string; model: string; reasoningEffort: string | null; resumeId?: string }

/**
 * One chat run's conversation with Codex's app server (`codex app-server`, the protocol its IDE extension uses):
 * JSON-RPC over stdin/stdout, one message per line. Trace starts (or resumes) a thread, sends each message as a
 * turn whose input holds the images as data URLs, and turns Codex's notifications into the same ChatEvents as
 * Claude's: streamed text, commands and file changes as tool cards with their output, and Codex's approval requests
 * (server requests) as approvals answered accept / accept for session / decline.
 */
export class CodexStream implements ChatStream {
  private buffer = ''; private nextId = 1;
  private calls = new Map<number, (message: Record<string, unknown>) => void>();
  private approvals = new Map<string, { id: number | string; method: string }>();
  private threadId: string | null = null; private turnId: string | null = null;
  /** Messages written before the thread exists wait for it. */
  private queued: (() => void)[] = [];
  constructor(private write: (line: string) => void, private emit: (event: ChatEvent) => void, private options: CodexThreadOptions) {}

  start() {
    this.request('initialize', { clientInfo: { name: 'trace', title: 'Trace', version: '1' }, capabilities: null }, () => {
      this.line({ method: 'initialized' });
      const { cwd, model, reasoningEffort, resumeId } = this.options;
      const settings = { cwd, ...(model ? { model } : {}), ...(reasoningEffort ? { config: { model_reasoning_effort: reasoningEffort } } : {}) };
      this.request(resumeId ? 'thread/resume' : 'thread/start', resumeId ? { threadId: resumeId, ...settings } : settings, (response) => {
        const result = record(response.result); const thread = record(result.thread);
        if (response.error || !text(thread.id)) { this.emit({ type: 'done', isError: true, error: text(record(response.error).message) || 'Codex could not start the conversation.' }); return; }
        this.threadId = text(thread.id);
        this.emit({ type: 'ready', conversationId: this.threadId, model: text(result.model) || null });
        for (const run of this.queued.splice(0)) run();
      });
    });
  }
  send(message: string, images: ChatImage[]) {
    const go = () => {
      const input = [...images.map((image) => ({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` })), ...(message ? [{ type: 'text', text: message, text_elements: [] }] : [])];
      this.request('turn/start', { threadId: this.threadId, input }, (response) => {
        const turn = record(record(response.result).turn);
        if (response.error) this.emit({ type: 'done', isError: true, error: text(record(response.error).message) || 'Codex did not accept the message.' });
        else if (text(turn.id)) this.turnId = text(turn.id);
      });
    };
    if (this.threadId) go(); else this.queued.push(go);
  }
  answer(requestId: string, allow: boolean, allowEdits = false) {
    const approval = this.approvals.get(requestId); if (!approval) return false;
    this.approvals.delete(requestId);
    // Current requests take accept / acceptForSession / decline; the older ones approved / approved_for_session / denied.
    const legacy = approval.method === 'execCommandApproval' || approval.method === 'applyPatchApproval';
    const decision = allow ? (allowEdits ? (legacy ? 'approved_for_session' : 'acceptForSession') : (legacy ? 'approved' : 'accept')) : (legacy ? 'denied' : 'decline');
    this.line({ id: approval.id, result: { decision } });
    this.emit({ type: 'permission-done', requestId });
    return true;
  }
  interrupt() { if (this.threadId && this.turnId) this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, () => {}); }
  close() { for (const requestId of this.approvals.keys()) this.emit({ type: 'permission-done', requestId }); this.approvals.clear(); }

  push(data: string) {
    this.buffer += data; let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message: Record<string, unknown>; try { message = JSON.parse(line); } catch { continue; }
      this.read(message);
    }
    if (this.buffer.length > 64 * 1024 * 1024) this.buffer = '';
  }

  private line(value: unknown) { this.write(JSON.stringify(value) + '\n'); }
  private request(method: string, params: unknown, done: (response: Record<string, unknown>) => void) { const id = this.nextId++; this.calls.set(id, done); this.line({ id, method, params }); }

  private read(message: Record<string, unknown>) {
    const method = text(message.method); const params = record(message.params);
    // A response to one of Trace's requests.
    if (!method && typeof message.id === 'number' && this.calls.has(message.id)) { const done = this.calls.get(message.id)!; this.calls.delete(message.id); done(message); return; }
    // A request from Codex: approvals become cards; anything else is declined so Codex does not wait.
    if (method && message.id !== undefined) {
      const requestId = `codex-${String(message.id)}`;
      if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
        const command = text(params.command) || (Array.isArray(params.command) ? (params.command as unknown[]).map(text).join(' ') : '');
        this.approvals.set(requestId, { id: message.id as number | string, method });
        this.emit({ type: 'permission', requestId, toolName: 'Shell', description: text(params.reason) || command, input: { command }, canAllowEdits: true });
      } else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
        this.approvals.set(requestId, { id: message.id as number | string, method });
        const files = Object.keys(record(params.fileChanges ?? params.changes));
        this.emit({ type: 'permission', requestId, toolName: 'File changes', description: text(params.reason) || (files.length ? files.map((file) => file.split(/[\\/]/).pop()).join(', ') : 'Edit files in this project'), input: { files }, canAllowEdits: true });
      } else this.line({ id: message.id, error: { code: -32601, message: `Trace does not handle ${method}.` } });
      return;
    }
    if (method === 'item/agentMessage/delta') { this.emit({ type: 'delta', messageId: text(params.itemId), text: text(params.delta) }); return; }
    if (method === 'item/started' || method === 'item/completed') { this.item(record(params.item), method === 'item/completed'); return; }
    if (method === 'turn/completed') {
      const turn = record(params.turn); const failed = turn.status === 'failed';
      this.turnId = null;
      // Approvals belong to their turn: one that ended (an interruption, say) leaves nothing to approve.
      this.close();
      this.emit({ type: 'done', isError: failed || turn.status === 'interrupted', error: failed ? text(record(turn.error).message) || 'Codex ended the turn with an error.' : turn.status === 'interrupted' ? 'Interrupted.' : null });
      return;
    }
    if (method === 'error') { const error = record(params.error); if (text(error.message)) this.emit({ type: 'notice', text: text(error.message) }); }
  }

  /** Codex's items: its messages, its reasoning, and the commands, edits and tools it runs (shown as cards). */
  private item(item: Record<string, unknown>, completed: boolean) {
    const id = text(item.id);
    switch (item.type) {
      case 'agentMessage': if (completed && text(item.text)) this.emit({ type: 'assistant', messageId: id, blocks: [{ type: 'text', text: text(item.text) }] }); return;
      case 'reasoning': {
        const summary = (Array.isArray(item.summary) ? item.summary : []).map(text).filter(Boolean).join('\n\n');
        if (completed && summary) this.emit({ type: 'assistant', messageId: id, blocks: [{ type: 'thinking', text: summary }] });
        return;
      }
      case 'commandExecution':
        if (!completed) this.emit({ type: 'assistant', messageId: id, blocks: [{ type: 'tool', id, name: 'Bash', input: { command: text(item.command) } }] });
        else this.emit({ type: 'tool-result', toolUseId: id, text: shorten(text(item.aggregatedOutput)), isError: typeof item.exitCode === 'number' && item.exitCode !== 0 || item.status === 'failed' || item.status === 'declined', image: false });
        return;
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
        if (!completed) this.emit({ type: 'assistant', messageId: id, blocks: [{ type: 'tool', id, name: 'Edit', input: { file_path: changes.map((change) => text(change.path)).join(', ') } }] });
        else this.emit({ type: 'tool-result', toolUseId: id, text: shorten(changes.map((change) => `${text(record(change.kind).type) || text(change.kind) || 'update'} ${text(change.path)}\n${text(change.diff)}`).join('\n')), isError: item.status === 'failed' || item.status === 'declined', image: false });
        return;
      }
      case 'mcpToolCall': case 'dynamicToolCall': {
        const name = item.type === 'mcpToolCall' ? `${text(item.server)}.${text(item.tool)}` : text(item.tool);
        if (!completed) this.emit({ type: 'assistant', messageId: id, blocks: [{ type: 'tool', id, name, input: record(item.arguments) }] });
        else this.emit({ type: 'tool-result', toolUseId: id, text: shorten(JSON.stringify(item.result ?? item.error ?? item.contentItems ?? '', null, 2) ?? ''), isError: Boolean(item.error) || item.status === 'failed', image: false });
        return;
      }
      case 'webSearch':
        if (!completed) this.emit({ type: 'assistant', messageId: id, blocks: [{ type: 'tool', id, name: 'WebSearch', input: { query: text(item.query) } }] });
        else this.emit({ type: 'tool-result', toolUseId: id, text: '', isError: false, image: false });
    }
  }
}
