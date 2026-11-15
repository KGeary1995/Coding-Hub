// A stand-in for Claude Code in structured mode (--input-format/--output-format stream-json), shaped like the messages
// the real CLI sends: an init message, streamed text, one assistant message per content block, an approval request
// (control_request/can_use_tool) once the host has said initialize, the tool's result, and a result with usage.
// A message containing "write" asks to write a file; one with an image says so; "fail" ends in an error result;
// "slow-fixture-reply" is answered after 4 s, so a test can stop the turn while it works (an interrupt cancels the answer).
const readline = require('node:readline');
const session = process.env.FIXTURE_SESSION ?? '11111111-2222-4333-8444-555555555555';
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let initialized = false; let waiting = null; let count = 0; let slow = null;
const reply = (id, text) => {
  out({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  for (const piece of text.match(/.{1,6}/g)) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
  out({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize') { initialized = true; out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [] } } }); return; }
  if (message.type === 'control_request' && message.request.subtype === 'interrupt') { clearTimeout(slow); slow = null; out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } }); out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Interrupted by the person.' }); return; }
  if (message.type === 'control_response' && waiting) {
    const allowed = message.response.response.behavior === 'allow'; const id = waiting; waiting = null;
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: allowed ? 'File written.' : 'Denied.', is_error: !allowed }] } });
    reply('msg-after-' + id, allowed ? 'Wrote notes.txt.' : 'I did not write it.');
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 10, output_tokens: 20 } });
    return;
  }
  if (message.type !== 'user') return;
  const content = message.message.content; const text = content.filter((block) => block.type === 'text').map((block) => block.text).join(' ');
  const images = content.filter((block) => block.type === 'image').length;
  if (!count++) out({ type: 'system', subtype: 'init', session_id: session, model: 'fixture-model', cwd: process.cwd(), tools: [] });
  if (/fail/.test(text)) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Fixture failure.' }); return; }
  if (/write/.test(text)) {
    const id = 'toolu_' + count; const messageId = 'msg-' + count;
    out({ type: 'assistant', message: { id: messageId, role: 'assistant', content: [{ type: 'thinking', thinking: 'The person wants a file.' }] } });
    out({ type: 'assistant', message: { id: messageId, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: 'notes.txt', content: 'hi' } }] } });
    // Without the host's initialize, Claude refuses instead of asking (as the real CLI does).
    if (!initialized) { out({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', message: 'Write was not allowed.' }); return; }
    waiting = id;
    out({ type: 'control_request', request_id: 'perm-' + count, request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input: { file_path: 'notes.txt', content: 'hi' }, description: 'notes.txt', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], tool_use_id: id } });
    return;
  }
  const answer = (id) => { reply(id, images ? `I see ${images} image${images === 1 ? '' : 's'}. ${text}` : `You said: ${text}`); out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 5, output_tokens: 7 } }); };
  if (/slow-fixture-reply/.test(text)) {
    // Streams a first word at once, as the real CLI does, so the window sees the turn at work.
    const id = 'msg-' + count; out({ type: 'stream_event', event: { type: 'message_start', message: { id: id + '-early' } } }); out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working… ' } } });
    slow = setTimeout(() => { slow = null; answer(id); }, 4000); return;
  }
  answer('msg-' + count);
});
