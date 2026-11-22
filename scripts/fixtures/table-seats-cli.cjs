// A stand-in for Claude Code (structured chat: stream-json) and Codex (chat: `app-server`) for scripts/table-seats-smoke.cjs.
// Which one it is comes from TABLE_SMOKE_ENGINE (set by the wrapper the smoke writes for each CLI). Every start and every
// message it receives is appended to TABLE_SMOKE_LOG as one JSON line ({ pid, engine, type: 'start' | 'recv', ... }), so the
// test can see what each seat was sent and in what order, and whether a seat's process is still alive.
// Its answers follow the steps of a Round Table: a plan ends PLAN READY, a challenge is NO CHALLENGES, a review is NO FINDINGS,
// the final review is APPROVED, a round of discussion is AGREE; the first message at a discussion table is answered with
// "Answer from <the seat's name>." (the name the brief gives it: "The others call you <name>."), so each seat's answer is told apart.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const ENGINE = process.env.TABLE_SMOKE_ENGINE === 'codex' ? 'codex' : 'claude';
const NAME = ENGINE === 'codex' ? 'Codex' : 'Claude Code';
const args = process.argv.slice(2);
const log = (entry) => { try { fs.appendFileSync(process.env.TABLE_SMOKE_LOG, JSON.stringify({ pid: process.pid, engine: ENGINE, ...entry }) + '\n'); } catch { /* The log folder is gone: the test is over. */ } };

function answerFor(text) {
  if (/\[Step: plan/.test(text)) return '1. Add the footer.\n2. Check it.\nPLAN READY';
  if (/\[Step: challenge/.test(text)) return 'NO CHALLENGES';
  if (/\[Step: answer the challenges/.test(text)) return 'ACCEPTED C1\n1. Add the footer.\nPLAN READY';
  if (/\[Step: implement/.test(text)) return 'Built the footer in footer.txt and read it back to check it.';
  if (/\[Step: review/.test(text)) return 'NO FINDINGS';
  if (/\[Step: (fix|changes from the final)/.test(text)) return 'Fixed what was asked.';
  if (/\[Step: final review/.test(text)) return 'APPROVED';
  if (/\[Trace Round Table · round/.test(text)) return 'AGREE';
  return `Answer from ${/The others call you ([^.]+)\./.exec(text)?.[1] ?? NAME}.`;
}

if (args.includes('--version')) { console.log(ENGINE === 'codex' ? 'codex-cli 0.99.0 (table seats smoke)' : '2.1.311 (table seats smoke)'); process.exit(0); }
if (args.includes('--help')) { console.log('--model <model> --config <value> --session-id <uuid> --resume <uuid> --settings <file-or-json> --append-system-prompt <text> --mcp-config <file>\nresume Resume conversation\nauth Manage authentication\nlogin Sign in\nstatus Show authentication status'); process.exit(0); }
if ((args[0] === 'auth' || args[0] === 'login') && args[1] === 'status') { if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true })); else console.error('Logged in using table seats smoke'); process.exit(0); }

if (ENGINE === 'codex' && args[0] === 'app-server') {
  log({ type: 'start', mode: 'app-server' });
  const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  let thread = null; let turn = 0;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const { method, params = {} } = message;
    if (method === 'initialize') out({ id: message.id, result: { userAgent: 'table-seats-smoke' } });
    else if (method === 'model/list') out({ id: message.id, result: { data: [], nextCursor: null } });
    else if (method === 'thread/start' || method === 'thread/resume') {
      thread = params.threadId ?? randomUUID(); log({ type: 'thread', method });
      out({ id: message.id, result: { thread: { id: thread }, model: 'fixture-model', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } } });
    } else if (method === 'turn/start') {
      const text = (params.input ?? []).filter((part) => part.type === 'text').map((part) => part.text).join(' '); log({ type: 'recv', text });
      const id = `turn-${++turn}`; const item = `item-${turn}`; const answer = answerFor(text);
      out({ id: message.id, result: { turn: { id } } });
      out({ method: 'turn/started', params: { threadId: thread, turn: { id } } });
      out({ method: 'item/agentMessage/delta', params: { threadId: thread, itemId: item, delta: answer } });
      out({ method: 'item/completed', params: { threadId: thread, item: { type: 'agentMessage', id: item, text: answer } } });
      out({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: 'completed' } } });
    } else if (method === 'turn/interrupt') out({ id: message.id, result: {} });
    else out({ id: message.id, error: { code: -32601, message: 'Unsupported by the table seats smoke' } });
  });
  setInterval(() => {}, 1000);
} else if (ENGINE === 'claude' && args.includes('stream-json')) {
  log({ type: 'start', mode: 'chat', resumed: args.includes('--resume') });
  const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  const session = randomUUID(); let count = 0;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'control_request') {
      const subtype = message.request?.subtype;
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: subtype === 'initialize' ? { commands: [] } : {} } });
      if (subtype === 'interrupt') out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Interrupted by the person.' });
      return;
    }
    if (message.type !== 'user') return;
    const text = message.message.content.filter((block) => block.type === 'text').map((block) => block.text).join(' '); log({ type: 'recv', text });
    if (!count++) out({ type: 'system', subtype: 'init', session_id: session, model: 'fixture-model', cwd: process.cwd(), tools: [] });
    const id = `msg-${count}`; const answer = answerFor(text);
    out({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    out({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: answer }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 5, output_tokens: 7 } });
  });
  setInterval(() => {}, 1000);
} else process.exit(0);
