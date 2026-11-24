import { TOOL_RESULT_LIMIT, type ChatEvent, type ChatHistoryMessage, type ChatImage } from '../../../shared/chat';
import type { ChatStream } from './claude-stream';
import type { PermissionLevel } from '../../../shared/types';

const text = (value: unknown) => typeof value === 'string' ? value : '';
const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const shorten = (value: string) => value.length > TOOL_RESULT_LIMIT ? value.slice(0, TOOL_RESULT_LIMIT) + `\n… ${(value.length - TOOL_RESULT_LIMIT).toLocaleString('en-US')} more characters` : value;
/** Tool kinds that change files (ACP's ToolKind). Their approval requests are named "File changes", which a read-only seat is always refused. */
const WRITES = new Set(['edit', 'delete', 'move']);
/** How long the session has to confirm the model and mode after Trace set them. */
export const CONFIRM_MS = 20_000;
/** The most messages of a loaded conversation the thread shows again. */
const REPLAYED = 40;
/**
 * agy's session mode for each permission level while the run may edit (from 1.39). agy 1.5.16 offers default, accept-edits,
 * auto and plan in `session/new` and `session/load` (seen 2026-11-24). Default asks before commands and, by agy's own
 * permission settings, may write files without asking (it did, seen with 1.5.16): Trace cannot set those settings over
 * ACP. Accept edits writes without asking and asks before commands. Auto also runs commands it takes for safe; at Full
 * access Trace answers whatever it still asks (allow), as Claude's and Codex's full access never ask.
 */
export const GEMINI_MODE: Record<PermissionLevel, string> = { ask: 'default', edits: 'accept-edits', full: 'auto' };
/**
 * A model as the session reports it: agy 1.5.6 takes `session/set_model` with `gemini-4-argon-high`, then reports
 * model `gemini-4-argon` and thinking level `high` in its config options (scripts/fixtures/agy-acp-1.5.6.jsonl).
 */
const modelParts = (model: string) => { const at = model.lastIndexOf('-'); return at > 0 ? { model: model.slice(0, at), level: model.slice(at + 1) } : { model, level: '' }; };

/**
 * A Gemini chat run: a Round Table's seat (in 1.20, removed in 1.21, back in 1.28), and from 1.39 a chat channel that
 * leads a table or edits at one. Gemini CLI's Agent Client Protocol server (`agy acp`), JSON-RPC over stdin/stdout, one
 * message per line. Trace opens a session in the folder (or loads the saved conversation, `session/load`, whose id is
 * agy's conversation id), sets the model (when one is named; otherwise Gemini CLI's own) and the mode: plan while the
 * run is read-only at a table, else GEMINI_MODE of its level. It goes on only once the session reports them (otherwise
 * every message fails with the reason); a later change of mode holds new messages until agy reports it. Each message is
 * a `session/prompt` turn; its `session/update` notifications become the same ChatEvents as Claude's and Codex's; its
 * approval requests become approvals (a file change is named "File changes", so a table declines it from a read-only
 * seat). Stop is `session/cancel`.
 *
 * Plan mode does not make agy read-only: seen with agy 1.5.6, it writes its own plan notes under ~/.gemini without
 * asking. Each write a read-only run makes is said in the thread, and the Round Table records the project's files with
 * each finding.
 */
export class GeminiStream implements ChatStream {
  private buffer = ''; private nextId = 1;
  private calls = new Map<number, (message: Record<string, unknown>) => void>();
  private approvals = new Map<string, { id: number | string; options: { optionId: string; kind: string }[] }>();
  private sessionId: string | null = null;
  /** Set once the session confirmed the model and mode; messages written before, or while a new mode is not yet reported, wait. */
  private ready = false; private queued: (() => void)[] = [];
  /** Read-only at a Round Table: plan mode, whatever the level. The mode last asked of agy, while its answer is awaited. */
  private readOnly = false; private asked: string | null = null;
  /** A loaded conversation's messages as agy replays them before it answers `session/load` (their text only), for the thread. */
  private replay: ChatHistoryMessage[] | null = null;
  /** Why the session cannot be used: later messages fail at once. */
  private failed: string | null = null;
  private config = { model: '', level: '', mode: '' };
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** The turn under way: the message being streamed (text and thinking), and whether one is running. */
  private turn = { busy: false, count: 0, messageId: '', text: '', thinking: '', segment: 0 };
  private tools = new Map<string, { title: string; kind: string }>();
  private level: PermissionLevel;
  /** `model`: an agy model ID (it names the effort too, `gemini-4-neon-high`); '' keeps Gemini CLI's own. `resumeId`: agy's conversation to load. */
  private model: string; private parts: { model: string; level: string };
  constructor(private write: (line: string) => void, private emit: (event: ChatEvent) => void, private options: { cwd: string; model?: string; resumeId?: string; permissions?: PermissionLevel; confirmMs?: number }) { this.level = options.permissions ?? 'ask'; this.model = options.model ?? ''; this.parts = modelParts(this.model); }

  /** The mode the run should be in now. */
  private mode() { return this.readOnly ? 'plan' : GEMINI_MODE[this.level]; }
  /** A Round Table's reviewer reads but does not edit: plan mode (and its edits are declined there). */
  setReadOnly(readOnly: boolean) { if (readOnly === this.readOnly) return; this.readOnly = readOnly; this.applyMode(); }
  /** From the next turn: agy is not switched in the middle of one. */
  setPermissions(level: PermissionLevel) { if (level === this.level) return; this.level = level; this.applyMode(); }
  permissions() { return this.level; }
  /**
   * Asks agy for the mode the run should be in, once the session is open and no turn runs (a turn's end asks again).
   * New messages wait until agy reports it (check); one it does not report in time, or refuses, ends the run's use.
   */
  private applyMode() {
    const sessionId = this.sessionId; const mode = this.mode();
    if (!sessionId || this.failed || this.turn.busy || this.asked !== null) return;
    // Already in it (back to the mode it was in before the answer came): the messages waiting go.
    if (this.config.mode === mode) { this.check(); return; }
    this.asked = mode;
    this.request('session/set_mode', { sessionId, modeId: mode }, (answer) => {
      this.asked = null;
      if (answer.error) return this.fail(`Gemini would not switch to ${mode} mode (${this.errorText(answer)}).`);
      clearTimeout(this.confirmTimer);
      if (!this.confirmed()) this.confirmTimer = setTimeout(() => { if (!this.failed && !this.confirmed() && this.asked === null && this.mode() === mode) this.fail(`Gemini did not confirm ${this.ready ? '' : `${this.model || 'its model'} in `}${mode} mode (it reports ${this.describe()}), so Trace does not use it.`); }, this.options.confirmMs ?? CONFIRM_MS);
      // The run's mode changed meanwhile (a table made it read-only): asked again.
      if (this.mode() !== mode) this.applyMode(); else this.check();
    });
  }

  start() {
    this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, (response) => {
      if (response.error) return this.fail(`Gemini did not start its session (${this.errorText(response)}).`);
      // A saved conversation is loaded (agy replays it as updates first, which no turn takes in), else a new one opened.
      const resume = this.options.resumeId; if (resume) this.replay = [];
      this.request(resume ? 'session/load' : 'session/new', { ...(resume ? { sessionId: resume } : {}), cwd: this.options.cwd, mcpServers: [] }, (created) => {
        const result = record(created.result); const sessionId = created.error ? '' : text(result.sessionId) || resume || '';
        const earlier = (this.replay ?? []).slice(-REPLAYED); this.replay = null;
        if (sessionId && earlier.length) this.emit({ type: 'history', messages: earlier, results: {} });
        if (!sessionId) return this.fail(resume ? `Gemini could not open this conversation again (${this.errorText(created)}). Clear the resume in the channel's settings to start a new one.` : `Gemini did not open a session (${this.errorText(created)}).`);
        this.sessionId = sessionId; this.readConfig(result.configOptions);
        const models = record(result.models); const offered = Array.isArray(models.availableModels) ? models.availableModels.map((model) => text(record(model).modelId)) : [];
        const wanted = this.model;
        if (wanted && offered.length && !offered.includes(wanted)) return this.fail(`Gemini does not offer ${wanted} on this account. Choose another model for this seat.`);
        // A mode agy reports already (a new session's default, at Ask) is not asked for again: seen with agy 1.5.16, setting
        // the mode it is in brings no report, so the run would wait for one in vain.
        const setMode = () => this.applyMode();
        if (!wanted) return setMode();
        this.request('session/set_model', { sessionId, modelId: wanted }, (model) => {
          if (model.error) return this.fail(`Gemini would not switch to ${wanted} (${this.errorText(model)}).`);
          setMode();
        });
      });
    });
  }
  private errorText(message: Record<string, unknown>) { return text(record(message.error).message) || 'no answer'; }
  private describe() { return `model ${this.config.model || 'unknown'}, thinking ${this.config.level || 'unknown'}, mode ${this.config.mode || 'unknown'}`; }
  private confirmed() { return this.config.mode === this.mode() && (!this.model || (this.config.model === this.parts.model && this.config.level === this.parts.level) || this.config.model === this.model); }
  private readConfig(options: unknown) {
    if (!Array.isArray(options)) return;
    for (const option of options) { const item = record(option); const value = text(item.currentValue); if (item.id === 'model') this.config.model = value; else if (item.id === 'thought_level') this.config.level = value; else if (item.id === 'mode') this.config.mode = value; }
  }
  /** Ready once the session reports the model and mode (and again after each change of mode); then the messages written meanwhile go. */
  private check() {
    if (this.failed || !this.sessionId || this.asked !== null || !this.confirmed()) return;
    clearTimeout(this.confirmTimer);
    if (!this.ready) { this.ready = true; this.emit({ type: 'ready', conversationId: this.sessionId, model: this.model || (this.config.model ? [this.config.model, this.config.level].filter(Boolean).join('-') : null) }); }
    for (const task of this.queued.splice(0)) task();
  }
  /** Whether a message can go now: the session is ready, and in the mode the run should be in. */
  private open() { return this.ready && this.asked === null && this.confirmed(); }
  private fail(reason: string) {
    if (this.failed) return; this.failed = reason; clearTimeout(this.confirmTimer);
    this.emit({ type: 'notice', text: reason });
    // Messages already waiting end at once, with the reason.
    const waiting = this.queued.splice(0).length;
    for (let index = 0; index < waiting; index++) this.emit({ type: 'done', isError: true, error: reason });
  }

  send(message: string, images: ChatImage[]) {
    if (this.failed) { this.emit({ type: 'done', isError: true, error: this.failed }); return; }
    if (!this.open()) { this.queued.push(() => this.send(message, images)); return; }
    const prompt = [...images.map((image) => ({ type: 'image', mimeType: image.mediaType, data: image.data })), ...(message ? [{ type: 'text', text: message }] : [])];
    this.turn = { busy: true, count: this.turn.count + 1, messageId: '', text: '', thinking: '', segment: 0 };
    const count = this.turn.count;
    this.request('session/prompt', { sessionId: this.sessionId, prompt }, (response) => {
      if (count !== this.turn.count) return;
      this.flush(); this.turn.busy = false;
      // A mode asked for during the turn (a table's roles, the person's level) is set before the next one.
      this.applyMode();
      const result = record(response.result); const stop = text(result.stopReason);
      if (response.error) this.emit({ type: 'done', isError: true, error: `Gemini: ${this.errorText(response)}` });
      else if (stop === 'cancelled') this.emit({ type: 'done', isError: true, error: 'Stopped.' });
      else if (stop === 'refusal') this.emit({ type: 'done', isError: true, error: 'Gemini refused to answer.' });
      else this.emit({ type: 'done', isError: false, error: null });
    });
  }
  /** `shown`: the request was shown as an approval, so its end is said (one Trace answered itself never was). */
  answer(requestId: string, allow: boolean, _allowEdits = false, shown = true) {
    const pending = this.approvals.get(requestId); if (!pending) return false;
    this.approvals.delete(requestId);
    const option = pending.options.find((item) => item.kind === (allow ? 'allow_once' : 'reject_once'));
    this.line({ jsonrpc: '2.0', id: pending.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
    if (shown) this.emit({ type: 'permission-done', requestId });
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
    if (this.replay && (kind === 'user_message_chunk' || kind === 'agent_message_chunk')) { this.replayed(kind === 'user_message_chunk' ? 'user' : 'assistant', text(record(update.content).text)); return; }
    if (!this.turn.busy) return;
    if (kind === 'agent_message_chunk') { const piece = text(record(update.content).text); if (piece) { this.turn.text += piece; this.emit({ type: 'delta', messageId: this.messageId(), text: piece }); } return; }
    if (kind === 'agent_thought_chunk') { this.turn.thinking += text(record(update.content).text); return; }
    if (kind === 'tool_call') {
      const id = text(update.toolCallId); const tool = { title: text(update.title) || text(update.name) || 'Tool', kind: text(update.kind) };
      this.tools.set(id, tool); this.flush();
      const input = record(update.rawInput); const paths = this.paths(update);
      this.emit({ type: 'assistant', messageId: `gemini-tool-${id}`, blocks: [{ type: 'tool', id, name: text(update.name) || tool.kind || 'tool', input: { ...input, ...(paths.length ? { paths } : {}), title: tool.title } }] });
      // A write a read-only run makes without asking (plan mode writes its own notes so) is shown, so nothing it writes goes unseen.
      if (WRITES.has(tool.kind) && this.readOnly) this.emit({ type: 'notice', text: `Gemini writes ${paths.length ? paths.join(', ') : tool.title} (Trace checks the project's files after this step).` });
      return;
    }
    if (kind === 'tool_call_update') {
      const id = text(update.toolCallId); const status = text(update.status); if (status !== 'completed' && status !== 'failed') return;
      const output = record(update.rawOutput); const content = Array.isArray(update.content) ? update.content.map((item) => text(record(record(item).content).text)).filter(Boolean).join('\n') : '';
      this.emit({ type: 'tool-result', toolUseId: id, text: shorten(text(output.output) || content || (status === 'failed' ? 'Failed.' : 'Done.')), isError: status === 'failed', image: false });
    }
  }
  /** A replayed piece of text, joined to the message before it when that is the same side's. */
  private replayed(role: 'user' | 'assistant', piece: string) {
    if (!piece || !this.replay) return; const last = this.replay.at(-1);
    if (last?.role === 'user' && role === 'user') last.text += piece;
    else if (last?.role === 'assistant' && role === 'assistant' && last.blocks[0]?.type === 'text') last.blocks[0] = { type: 'text', text: last.blocks[0].text + piece };
    else this.replay.push(role === 'user' ? { role, text: piece, images: 0 } : { role, messageId: `gemini-replay-${this.replay.length}`, blocks: [{ type: 'text', text: piece }] });
  }
  private paths(update: Record<string, unknown>) { return Array.isArray(update.locations) ? update.locations.map((item) => text(record(item).path)).filter(Boolean) : []; }
  private approval(message: Record<string, unknown>) {
    const params = record(message.params); const call = record(params.toolCall); const kind = text(call.kind);
    const requestId = `gemini-${String(message.id)}`;
    const options = Array.isArray(params.options) ? params.options.map((item) => ({ optionId: text(record(item).optionId), kind: text(record(item).kind) })) : [];
    this.approvals.set(requestId, { id: message.id as number | string, options });
    // Full access on a run that may edit: allowed at once, with no approval card, as Claude's and Codex's full access never ask.
    if (this.level === 'full' && !this.readOnly) { this.answer(requestId, true, false, false); return; }
    const paths = this.paths(call); const title = text(call.title) || text(call.name);
    const toolName = WRITES.has(kind) ? 'File changes' : kind === 'execute' ? 'Shell' : title || 'Tool';
    this.emit({ type: 'permission', requestId, toolName, description: paths.length ? paths.join(', ') : title, input: record(call.rawInput), canAllowEdits: false });
  }
}
