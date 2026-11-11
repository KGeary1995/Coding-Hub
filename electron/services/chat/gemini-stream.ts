import { TOOL_RESULT_LIMIT, type ChatEvent, type ChatImage } from '../../../shared/chat';
import type { ChatStream } from './claude-stream';
import type { PermissionLevel } from '../../../shared/types';
import { GEMINI_MODEL } from '../../../shared/gemini';

const text = (value: unknown) => typeof value === 'string' ? value : '';
const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const shorten = (value: string) => value.length > TOOL_RESULT_LIMIT ? value.slice(0, TOOL_RESULT_LIMIT) + `\n… ${(value.length - TOOL_RESULT_LIMIT).toLocaleString('en-US')} more characters` : value;
/** Tool kinds that change files (ACP's ToolKind). Their approval requests are named "File changes", which a read-only seat is always refused. */
const WRITES = new Set(['edit', 'delete', 'move']);
/** How long the session has to confirm the model and plan mode after Trace set them. */
export const CONFIRM_MS = 20_000;
/**
 * GEMINI_MODEL as the session reports it: agy 1.5.6 takes `session/set_model` with `gemini-4-argon-high`, then reports
 * model `gemini-4-argon` and thinking level `high` in its config options (scripts/fixtures/agy-acp-1.5.6.jsonl).
 */
const MODEL_PARTS = (() => { const at = GEMINI_MODEL.lastIndexOf('-'); return { model: GEMINI_MODEL.slice(0, at), level: GEMINI_MODEL.slice(at + 1) }; })();

/**
 * A hierarchy Round Table's Gemini seat: Gemini CLI's Agent Client Protocol server (`agy acp`), JSON-RPC over
 * stdin/stdout, one message per line. Trace opens a session in the folder, sets GEMINI_MODEL and plan mode, and goes on
 * only once the session reports both (otherwise every message fails with the reason). Each message is a `session/prompt`
 * turn; its `session/update` notifications become the same ChatEvents as Claude's and Codex's; its approval requests
 * become approvals (a file change is named "File changes", so the Round Table declines it). Stop is `session/cancel`.
 *
 * Plan mode does not make agy read-only: seen with agy 1.5.6, it writes its own plan notes under ~/.gemini without
 * asking. The Round Table compares the project's files before and after each Gemini step (review-chain.ts).
 */
export class GeminiStream implements ChatStream {
  private buffer = ''; private nextId = 1;
  private calls = new Map<number, (message: Record<string, unknown>) => void>();
  private approvals = new Map<string, { id: number | string; options: { optionId: string; kind: string }[] }>();
  private sessionId: string | null = null;
  /** Set once the session confirmed the model and plan mode; messages written before wait. */
  private ready = false; private queued: (() => void)[] = [];
  /** Why the session cannot be used: later messages fail at once. */
  private failed: string | null = null;
  private config = { model: '', level: '', mode: '' };
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** The turn under way: the message being streamed (text and thinking), and whether one is running. */
  private turn = { busy: false, count: 0, messageId: '', text: '', thinking: '', segment: 0 };
  private tools = new Map<string, { title: string; kind: string }>();
  private level: PermissionLevel;
  constructor(private write: (line: string) => void, private emit: (event: ChatEvent) => void, private options: { cwd: string; permissions?: PermissionLevel; confirmMs?: number }) { this.level = options.permissions ?? 'ask'; }

  /** The seat is always in plan mode; read-only is kept by the Round Table (declined edits, the file check). */
  setReadOnly() {}
  /** Recorded for the Round Table's Full-access rule; agy's own mode stays plan. */
  setPermissions(level: PermissionLevel) { this.level = level; }
  permissions() { return this.level; }

  start() {
    this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, (response) => {
      if (response.error) return this.fail(`Gemini CLI did not start its session (${this.errorText(response)}).`);
      this.request('session/new', { cwd: this.options.cwd, mcpServers: [] }, (created) => {
        const result = record(created.result); const sessionId = text(result.sessionId);
        if (created.error || !sessionId) return this.fail(`Gemini CLI did not open a session (${this.errorText(created)}).`);
        this.sessionId = sessionId; this.readConfig(result.configOptions);
        const models = record(result.models); const offered = Array.isArray(models.availableModels) ? models.availableModels.map((model) => text(record(model).modelId)) : [];
        if (offered.length && !offered.includes(GEMINI_MODEL)) return this.fail(`Gemini CLI does not offer ${GEMINI_MODEL} on this account, and Trace runs no other Gemini model.`);
        this.request('session/set_model', { sessionId, modelId: GEMINI_MODEL }, (model) => {
          if (model.error) return this.fail(`Gemini CLI would not switch to ${GEMINI_MODEL} (${this.errorText(model)}).`);
          this.request('session/set_mode', { sessionId, modeId: 'plan' }, (mode) => {
            if (mode.error) return this.fail(`Gemini CLI would not switch to plan mode (${this.errorText(mode)}).`);
            if (!this.confirmed()) this.confirmTimer = setTimeout(() => { if (!this.ready && !this.failed) this.fail(`Gemini CLI did not confirm ${GEMINI_MODEL} in plan mode (it reports ${this.describe()}), so Trace does not use it.`); }, this.options.confirmMs ?? CONFIRM_MS);
            this.check();
          });
        });
      });
    });
  }
  private errorText(message: Record<string, unknown>) { return text(record(message.error).message) || 'no answer'; }
  private describe() { return `model ${this.config.model || 'unknown'}, thinking ${this.config.level || 'unknown'}, mode ${this.config.mode || 'unknown'}`; }
  private confirmed() { return this.config.model === MODEL_PARTS.model && this.config.level === MODEL_PARTS.level && this.config.mode === 'plan'; }
  private readConfig(options: unknown) {
    if (!Array.isArray(options)) return;
    for (const option of options) { const item = record(option); const value = text(item.currentValue); if (item.id === 'model') this.config.model = value; else if (item.id === 'thought_level') this.config.level = value; else if (item.id === 'mode') this.config.mode = value; }
  }
  /** Ready once the session reports the model and plan mode; then the messages written meanwhile go. */
  private check() {
    if (this.ready || this.failed || !this.sessionId || !this.confirmed()) return;
    this.ready = true; clearTimeout(this.confirmTimer);
    this.emit({ type: 'ready', conversationId: this.sessionId, model: GEMINI_MODEL });
    for (const task of this.queued.splice(0)) task();
  }
  private fail(reason: string) {
    if (this.failed) return; this.failed = reason; clearTimeout(this.confirmTimer);
    this.emit({ type: 'notice', text: reason });
    // Messages already waiting end at once, with the reason.
    const waiting = this.queued.splice(0).length;
    for (let index = 0; index < waiting; index++) this.emit({ type: 'done', isError: true, error: reason });
  }

  send(message: string, images: ChatImage[]) {
    if (this.failed) { this.emit({ type: 'done', isError: true, error: this.failed }); return; }
    if (!this.ready) { this.queued.push(() => this.send(message, images)); return; }
    const prompt = [...images.map((image) => ({ type: 'image', mimeType: image.mediaType, data: image.data })), ...(message ? [{ type: 'text', text: message }] : [])];
    this.turn = { busy: true, count: this.turn.count + 1, messageId: '', text: '', thinking: '', segment: 0 };
    const count = this.turn.count;
    this.request('session/prompt', { sessionId: this.sessionId, prompt }, (response) => {
      if (count !== this.turn.count) return;
      this.flush(); this.turn.busy = false;
      const result = record(response.result); const stop = text(result.stopReason);
      if (response.error) this.emit({ type: 'done', isError: true, error: `Gemini CLI: ${this.errorText(response)}` });
      else if (stop === 'cancelled') this.emit({ type: 'done', isError: true, error: 'Stopped.' });
      else if (stop === 'refusal') this.emit({ type: 'done', isError: true, error: 'Gemini refused to answer.' });
      else this.emit({ type: 'done', isError: false, error: null });
    });
  }
  answer(requestId: string, allow: boolean) {
    const pending = this.approvals.get(requestId); if (!pending) return false;
    this.approvals.delete(requestId);
    const option = pending.options.find((item) => item.kind === (allow ? 'allow_once' : 'reject_once'));
    this.line({ jsonrpc: '2.0', id: pending.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
    this.emit({ type: 'permission-done', requestId });
    return true;
  }
  /** Stops the turn: ACP's cancel, and any approval still open is answered "cancelled", as the protocol asks. */
  interrupt() {
    // Messages still waiting for the session to be ready are dropped, each ending as stopped, so the table's Stop holds
    // (they would otherwise go once the session is ready) and Continue becomes available.
    const waiting = this.queued.splice(0).length;
    for (let index = 0; index < waiting; index++) this.emit({ type: 'done', isError: true, error: 'Stopped.' });
    if (!this.sessionId || !this.turn.busy) return;
    this.line({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    for (const [requestId, pending] of this.approvals) { this.line({ jsonrpc: '2.0', id: pending.id, result: { outcome: { outcome: 'cancelled' } } }); this.emit({ type: 'permission-done', requestId }); }
    this.approvals.clear();
  }
  close() { clearTimeout(this.confirmTimer); for (const requestId of this.approvals.keys()) this.emit({ type: 'permission-done', requestId }); this.approvals.clear(); }

  push(data: string) {
    this.buffer += data; let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message: Record<string, unknown>; try { message = record(JSON.parse(line)); } catch { continue; }
      this.handle(message);
    }
  }

  private line(message: Record<string, unknown>) { this.write(JSON.stringify(message) + '\n'); }
  private request(method: string, params: Record<string, unknown>, reply: (message: Record<string, unknown>) => void) {
    const id = this.nextId++; this.calls.set(id, reply); this.line({ jsonrpc: '2.0', id, method, params });
  }
  /** The streamed text so far becomes one finished message (thinking first), as Claude's does. */
  private flush() {
    const blocks = [...(this.turn.thinking.trim() ? [{ type: 'thinking' as const, text: this.turn.thinking.trim() }] : []), ...(this.turn.text ? [{ type: 'text' as const, text: this.turn.text }] : [])];
    if (blocks.length) this.emit({ type: 'assistant', messageId: this.messageId(), blocks });
    this.turn.text = ''; this.turn.thinking = ''; this.turn.messageId = ''; this.turn.segment++;
  }
  private messageId() { if (!this.turn.messageId) this.turn.messageId = `gemini-${this.sessionId ?? 'session'}-${this.turn.count}-${this.turn.segment}`; return this.turn.messageId; }

  private handle(message: Record<string, unknown>) {
    const method = text(message.method);
    // A reply to one of Trace's requests.
    if (!method && typeof message.id === 'number') { const reply = this.calls.get(message.id); if (reply) { this.calls.delete(message.id); reply(message); } return; }
    if (method === 'session/request_permission' && message.id !== undefined) return this.approval(message);
    // Requests Trace does not serve (it offered no file system or terminal): refused, so agy uses its own.
    if (method && message.id !== undefined) { this.line({ jsonrpc: '2.0', id: message.id as number | string, error: { code: -32601, message: `Trace does not serve ${method}.` } }); return; }
    if (method !== 'session/update') return;
    const update = record(record(message.params).update); const kind = text(update.sessionUpdate);
    if (kind === 'config_option_update') { this.readConfig(update.configOptions); this.check(); return; }
    if (kind === 'current_mode_update') { this.config.mode = text(update.currentModeId) || this.config.mode; this.check(); return; }
    if (!this.turn.busy) return;
    if (kind === 'agent_message_chunk') { const piece = text(record(update.content).text); if (piece) { this.turn.text += piece; this.emit({ type: 'delta', messageId: this.messageId(), text: piece }); } return; }
    if (kind === 'agent_thought_chunk') { this.turn.thinking += text(record(update.content).text); return; }
    if (kind === 'tool_call') {
      const id = text(update.toolCallId); const tool = { title: text(update.title) || text(update.name) || 'Tool', kind: text(update.kind) };
      this.tools.set(id, tool); this.flush();
      const input = record(update.rawInput); const paths = this.paths(update);
      this.emit({ type: 'assistant', messageId: `gemini-tool-${id}`, blocks: [{ type: 'tool', id, name: text(update.name) || tool.kind || 'tool', input: { ...input, ...(paths.length ? { paths } : {}), title: tool.title } }] });
      // A write agy makes without asking (plan mode writes its own notes so) is shown, so nothing it writes goes unseen.
      if (WRITES.has(tool.kind)) this.emit({ type: 'notice', text: `Gemini writes ${paths.length ? paths.join(', ') : tool.title} (Trace checks the project's files after this step).` });
      return;
    }
    if (kind === 'tool_call_update') {
      const id = text(update.toolCallId); const status = text(update.status); if (status !== 'completed' && status !== 'failed') return;
      const output = record(update.rawOutput); const content = Array.isArray(update.content) ? update.content.map((item) => text(record(record(item).content).text)).filter(Boolean).join('\n') : '';
      this.emit({ type: 'tool-result', toolUseId: id, text: shorten(text(output.output) || content || (status === 'failed' ? 'Failed.' : 'Done.')), isError: status === 'failed', image: false });
    }
  }
  private paths(update: Record<string, unknown>) { return Array.isArray(update.locations) ? update.locations.map((item) => text(record(item).path)).filter(Boolean) : []; }
  private approval(message: Record<string, unknown>) {
    const params = record(message.params); const call = record(params.toolCall); const kind = text(call.kind);
    const requestId = `gemini-${String(message.id)}`;
    const options = Array.isArray(params.options) ? params.options.map((item) => ({ optionId: text(record(item).optionId), kind: text(record(item).kind) })) : [];
    this.approvals.set(requestId, { id: message.id as number | string, options });
    const paths = this.paths(call); const title = text(call.title) || text(call.name);
    const toolName = WRITES.has(kind) ? 'File changes' : kind === 'execute' ? 'Shell' : title || 'Tool';
    this.emit({ type: 'permission', requestId, toolName, description: paths.length ? paths.join(', ') : title, input: record(call.rawInput), canAllowEdits: false });
  }
}
