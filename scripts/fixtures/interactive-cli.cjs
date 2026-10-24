if (process.argv.includes('--version')) { console.log('2.1.296 (Coding Hub test fixture)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--model <model> --config <value> --session-id <uuid> --resume <uuid> --settings <file-or-json>\nresume Resume conversation\nauth Manage authentication\nlogin Sign in\nstatus Show authentication status'); process.exit(0); }
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fixtureArgs = process.argv.slice(2);
if (fixtureArgs[0] === 'app-server') {
  const model = (model, hidden = false) => ({ id: 'picker-' + model, model, displayName: 'Catalog ' + model, description: 'Fixture catalog model', hidden, isDefault: !hidden, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }, { reasoningEffort: 'ultra', description: 'Ultra' }] });
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line); if (request.id === undefined) return;
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: 'fixture' } }) + '\n');
    else if (request.method === 'model/list' && request.params?.includeHidden === true) process.stdout.write(JSON.stringify({ id: request.id, result: request.params.cursor ? { data: [model('fixture-hidden-model', true)], nextCursor: null } : { data: [model('fixture-current-model'), model('fixture-extra-model')], nextCursor: 'next-page' } }) + '\n');
    else process.stdout.write(JSON.stringify({ id: request.id, error: { message: 'Unsupported fixture method' } }) + '\n');
  });
  return;
}
const loginProvider = fixtureArgs[0] === 'auth' && fixtureArgs[1] === 'login' ? 'claude' : fixtureArgs[0] === 'login' && fixtureArgs.length === 1 ? 'codex' : null;
const authRoot = fixtureArgs[0] === 'auth' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const authMarker = authRoot && path.join(authRoot, 'fixture-authenticated');
if ((fixtureArgs[0] === 'auth' || fixtureArgs[0] === 'login') && fixtureArgs[1] === 'status') {
  const authenticated = authMarker && fs.existsSync(authMarker);
  if (fixtureArgs[0] === 'auth') console.log(JSON.stringify({ loggedIn: Boolean(authenticated), email: 'private-fixture@example.invalid' }));
  else console.error(authenticated ? 'Logged in using fixture' : 'Not logged in');
  process.exit(authenticated ? 0 : 1);
}
const resumeIndex = process.argv.indexOf('--resume'); const resumeId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : fixtureArgs[0] === 'resume' ? fixtureArgs[1] : null;
if (resumeId) console.log('RESUMING:' + resumeId);
let usageFile = null;
let engine = null;
const sessionIndex = process.argv.indexOf('--session-id');
if ((sessionIndex >= 0 || resumeIndex >= 0) && process.env.CLAUDE_CONFIG_DIR) {
  engine = 'claude'; const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-fixture'); fs.mkdirSync(dir, { recursive: true }); usageFile = path.join(dir, (resumeId ?? process.argv[sessionIndex + 1]) + '.jsonl'); if (!resumeId || !fs.existsSync(usageFile)) fs.writeFileSync(usageFile, JSON.stringify({ type: 'user', cwd: process.cwd(), sessionId: resumeId ?? process.argv[sessionIndex + 1] }) + '\n');
} else if (process.env.CODEX_HOME && process.argv.some((a) => a.startsWith('log_dir='))) {
  engine = 'codex'; const thread = resumeId ?? randomUUID(); const logDir = JSON.parse(process.argv.find((a) => a.startsWith('log_dir=')).slice(8)); fs.mkdirSync(logDir, { recursive: true }); fs.writeFileSync(path.join(logDir, 'codex-tui.log'), `thread_id="${thread}"\n`);
  const now = new Date(); const dir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0')); fs.mkdirSync(dir, { recursive: true }); usageFile = path.join(dir, `rollout-${thread}.jsonl`);
  if (!resumeId || !fs.existsSync(usageFile)) fs.writeFileSync(usageFile, JSON.stringify({ type: 'session_meta', timestamp: now.toISOString(), payload: { id: thread, cwd: process.cwd() } }) + '\n' + JSON.stringify({ type: 'turn_context', payload: { model: 'fixture-model' } }) + '\n');
}
let turn = 0; if (resumeId && engine === 'codex' && usageFile) try { for (const line of fs.readFileSync(usageFile, 'utf8').split('\n')) { try { const event = JSON.parse(line); if (event.payload?.info?.total_token_usage) turn = Math.floor(event.payload.info.total_token_usage.input_tokens / 100); } catch {} } } catch {}
function reportUsage() {
  if (!usageFile) return; turn++;
  const event = engine === 'claude' ? { type: 'assistant', message: { id: 'message-' + turn, model: 'fixture-model', usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 20 } } } : { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: turn * 100, cached_input_tokens: turn * 20, output_tokens: turn * 25, reasoning_output_tokens: turn * 10 }, last_token_usage: { input_tokens: 100, output_tokens: 25 }, model_context_window: 1000 } } };
  fs.appendFileSync(usageFile, JSON.stringify(event) + '\n');
}
console.log(`\x1b[32mREADY\x1b[0m CWD:${process.cwd()}`);
const modelIndex = process.argv.indexOf('--model');
console.log('MODEL_OVERRIDE:' + (modelIndex >= 0 ? process.argv[modelIndex + 1] : 'CLI_DEFAULT'));
const size = () => console.log(`SIZE:${process.stdout.columns}x${process.stdout.rows}`);
size();
process.stdout.on('resize', size);
process.stdin.setEncoding('utf8');
// Terminal writes are asynchronous on Windows: exit only after the final message is written.
// Raise an approval request the way each real CLI does: Claude through its HTTP Notification hook, Codex as an OSC 9 notification.
function requestApproval() {
  const settingsIndex = process.argv.indexOf('--settings');
  const hook = settingsIndex >= 0 ? JSON.parse(process.argv[settingsIndex + 1]).hooks?.Notification?.[0]?.hooks?.[0] : null;
  if (hook?.type === 'http') { void fetch(hook.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }) }).then(() => console.log('APPROVAL:requested')).catch(() => console.log('APPROVAL:hook-failed')); return; }
  if (process.argv.includes('tui.notification_method="osc9"')) { process.stdout.write('Allow command? [y/n]\x1b]9;Approval requested: npm test\x07\n'); return; }
  console.log('APPROVAL:unsupported');
}
const handleLine = (value) => { if (value.trim() === 'need-approval') { requestApproval(); return; } if (value.trim() === 'fail-launch') { process.stdout.write('\x1b[?1049hError: fixture invalid model\x1b[?1049l\n', () => process.exit(1)); return; } if (value.trim() === 'spawn-child') { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); console.log('CHILD:' + child.pid); return; } if (loginProvider && value.trim() === 'complete-login') { const directory = loginProvider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME; fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'fixture-authenticated'), 'fixture-only'); process.stdout.write('LOGIN COMPLETE\n', () => process.exit(0)); return; } console.log(`ECHO:${value.trim()}`); if (value.trim()) reportUsage(); };
if (process.platform === 'win32' && process.stdin.isTTY) {
  // Like the real CLIs, read raw input: on Windows Node only reports console resizes in raw mode.
  process.stdin.setRawMode(true); let pending = ''; let afterReturn = false;
  process.stdin.on('data', (chunk) => {
    for (const character of chunk) {
      if (character === '\n' && afterReturn) { afterReturn = false; continue; }
      afterReturn = character === '\r';
      if (character === '\r' || character === '\n') { const line = pending; pending = ''; handleLine(line + '\n'); } else pending += character;
    }
  });
} else process.stdin.on('data', handleLine);
process.on('SIGTERM', () => { process.stdout.write('FINAL:fixture shutdown\n'); setTimeout(() => process.exit(0), 100); });
