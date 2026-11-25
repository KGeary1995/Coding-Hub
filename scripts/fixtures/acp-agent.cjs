// A stand-in Agent Client Protocol server (custom agents, phase 2; docs/custom-agents.md): JSON-RPC over stdin and
// stdout, one message per line, as `agy acp` and other ACP agents speak it. Used by the unit tests and the productivity
// smoke to drive AcpStream with a custom agent's definition.
// - initialize: offers loading a session, and no images.
// - session/new and session/load: modes default, read-only, edits and yolo (starting in default), models fx-small and
//   fx-large; load replays one exchange first. Trace's MCP servers are remembered by name.
// - session/set_mode and session/set_model: answered with an empty result, and no update of their own (the protocol's
//   answer confirms them).
// - session/prompt: "write <name.ext>" (a plain file name, so a reviewer's `write "VERIFIED F1"` instruction is not one) asks for a file change (kind edit) and, if allowed, writes the file in the session's
//   folder; a Round Table's round is answered AGREE; anything else is answered "ACP <mode> got: <text> (mcp: <names>)".
//   The answer streams as two agent_message_chunk updates, then the turn ends (end_turn).
// - "drift <mode>": answered, then, once the turn has ended, the agent switches to that mode by itself and says so
//   (current_mode_update), as an agent may between turns or after a resume.
// - session/cancel ends the open turn as cancelled.
// ACP_FIXTURE_LOG names a file that gets one JSON line per message received, for the tests.
if (process.argv.includes('--version')) { console.log('fixture-acp 1.0'); process.exit(0); }
const fs = require('node:fs');
const path = require('node:path');
const log = (entry) => { if (process.env.ACP_FIXTURE_LOG) fs.appendFileSync(process.env.ACP_FIXTURE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\n'); };
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
const MODES = ['default', 'read-only', 'edits', 'yolo'].map((id) => ({ id, name: id }));
const MODELS = ['fx-small', 'fx-large'].map((modelId) => ({ modelId, name: modelId }));
const sessions = new Map(); let nextId = 1000; const waiting = new Map(); let open = null;

function opened(sessionId, cwd, servers) {
  sessions.set(sessionId, { cwd, mode: 'default', model: 'fx-small', servers: (servers ?? []).map((server) => server.name) });
  return { sessionId, modes: { currentModeId: 'default', availableModes: MODES }, models: { currentModelId: 'fx-small', availableModels: MODELS } };
}
function finish(id, stopReason) { if (open?.id === id) open = null; send({ id, result: { stopReason } }); }
function say(id, sessionId, text) { const half = Math.ceil(text.length / 2); update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(0, half) } }); update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(half) } }); finish(id, 'end_turn'); }

function handle(message) {
  log({ method: message.method ?? null, id: message.id ?? null, params: message.params ?? null, result: message.result ?? null });
  // An answer to one of this agent's own requests (a permission).
  if (!message.method && waiting.has(message.id)) { const done = waiting.get(message.id); waiting.delete(message.id); done(message.result?.outcome); return; }
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize': return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, agentInfo: { name: 'fixture-acp', version: '1.0' } } });
    case 'session/new': return send({ id: message.id, result: opened(`fx-${process.pid}-${nextId++}`, params.cwd, params.mcpServers) });
    case 'session/load': {
      update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier question' } });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer' } });
      const { sessionId: _id, ...result } = opened(params.sessionId, params.cwd, params.mcpServers); return send({ id: message.id, result });
    }
    case 'session/set_mode': { const session = sessions.get(params.sessionId); if (!session || !MODES.some((mode) => mode.id === params.modeId)) return send({ id: message.id, error: { code: -32602, message: 'unknown mode' } }); session.mode = params.modeId; return send({ id: message.id, result: {} }); }
    case 'session/set_model': { const session = sessions.get(params.sessionId); if (!session || !MODELS.some((model) => model.modelId === params.modelId)) return send({ id: message.id, error: { code: -32602, message: 'unknown model' } }); session.model = params.modelId; return send({ id: message.id, result: {} }); }
    case 'session/cancel': if (open) finish(open.id, 'cancelled'); return;
    case 'session/prompt': {
      const session = sessions.get(params.sessionId); if (!session) return send({ id: message.id, error: { code: -32602, message: 'no such session' } });
      const text = (params.prompt ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n'); open = { id: message.id };
      const write = /\bwrite ([\w-]+\.\w+)\b/.exec(text)?.[1];
      if (write) {
        const asked = nextId++; const file = path.join(session.cwd, path.basename(write));
        waiting.set(asked, (outcome) => {
          if (outcome?.outcome === 'selected' && outcome.optionId === 'allow') { fs.writeFileSync(file, 'written by fixture-acp\n'); say(message.id, params.sessionId, `Wrote ${path.basename(file)}.`); }
          else if (outcome?.outcome === 'cancelled') finish(message.id, 'cancelled');
          else say(message.id, params.sessionId, `Did not write ${path.basename(file)}.`);
        });
        update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: `w${asked}`, title: `Write ${path.basename(file)}`, kind: 'edit', status: 'pending', locations: [{ path: file }] });
        return send({ id: asked, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCall: { toolCallId: `w${asked}`, title: `Write ${path.basename(file)}`, kind: 'edit', locations: [{ path: file }] }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
      }
      if (/\[Trace Round Table · round/.test(text)) return setTimeout(() => say(message.id, params.sessionId, 'AGREE'), 50);
      const drift = /\bdrift ([\w-]+)\b/.exec(text)?.[1];
      if (drift) return setTimeout(() => { say(message.id, params.sessionId, `Drifting to ${drift}.`); setTimeout(() => { session.mode = drift; update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: drift }); }, 30); }, 50);
      const last = text.trim().split('\n').filter(Boolean).at(-1) ?? '';
      return setTimeout(() => say(message.id, params.sessionId, `ACP ${session.mode} ${session.model} got: ${last.slice(0, 200)} (mcp: ${session.servers.join(',') || 'none'})`), 50);
    }
    default: if (message.id !== undefined && message.method) send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk; let end;
  while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (line) try { handle(JSON.parse(line)); } catch { /* Not JSON: ignored. */ } }
});
process.stdin.on('end', () => process.exit(0));
