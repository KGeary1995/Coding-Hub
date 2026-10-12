if (process.argv.includes('--version')) { console.log('2.1.296 (Coding Hub test fixture)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--model <model> --config <value> --session-id <uuid>\nauth Manage authentication\nlogin Sign in\nstatus Show authentication status'); process.exit(0); }
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fixtureArgs = process.argv.slice(2);
const loginProvider = fixtureArgs[0] === 'auth' && fixtureArgs[1] === 'login' ? 'claude' : fixtureArgs[0] === 'login' && fixtureArgs.length === 1 ? 'codex' : null;
const authRoot = fixtureArgs[0] === 'auth' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const authMarker = authRoot && path.join(authRoot, 'fixture-authenticated');
if ((fixtureArgs[0] === 'auth' || fixtureArgs[0] === 'login') && fixtureArgs[1] === 'status') {
  const authenticated = authMarker && fs.existsSync(authMarker);
  if (fixtureArgs[0] === 'auth') console.log(JSON.stringify({ loggedIn: Boolean(authenticated), email: 'private-fixture@example.invalid' }));
  else console.error(authenticated ? 'Logged in using fixture' : 'Not logged in');
  process.exit(authenticated ? 0 : 1);
}
let usageFile = null;
let engine = null;
const sessionIndex = process.argv.indexOf('--session-id');
if (sessionIndex >= 0 && process.env.CLAUDE_CONFIG_DIR) {
  engine = 'claude'; const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-fixture'); fs.mkdirSync(dir, { recursive: true }); usageFile = path.join(dir, process.argv[sessionIndex + 1] + '.jsonl'); fs.writeFileSync(usageFile, '');
} else if (process.env.CODEX_HOME && process.argv.some((a) => a.startsWith('log_dir='))) {
  engine = 'codex'; const thread = randomUUID(); const logDir = JSON.parse(process.argv.find((a) => a.startsWith('log_dir=')).slice(8)); fs.mkdirSync(logDir, { recursive: true }); fs.writeFileSync(path.join(logDir, 'codex-tui.log'), `thread_id="${thread}"\n`);
  const now = new Date(); const dir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0')); fs.mkdirSync(dir, { recursive: true }); usageFile = path.join(dir, `rollout-${thread}.jsonl`);
  fs.writeFileSync(usageFile, JSON.stringify({ type: 'session_meta', timestamp: now.toISOString(), payload: { id: thread, cwd: process.cwd() } }) + '\n' + JSON.stringify({ type: 'turn_context', payload: { model: 'fixture-model' } }) + '\n');
}
let turn = 0;
function reportUsage() {
  if (!usageFile) return; turn++;
  const event = engine === 'claude' ? { type: 'assistant', message: { id: 'message-' + turn, model: 'fixture-model', usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 20 } } } : { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: turn * 100, cached_input_tokens: turn * 20, output_tokens: turn * 25, reasoning_output_tokens: turn * 10 }, last_token_usage: { input_tokens: 100, output_tokens: 25 }, model_context_window: 1000 } } };
  fs.appendFileSync(usageFile, JSON.stringify(event) + '\n');
}
console.log(`\x1b[32mREADY\x1b[0m CWD:${process.cwd()}`);
const size = () => console.log(`SIZE:${process.stdout.columns}x${process.stdout.rows}`);
size();
process.stdout.on('resize', size);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (value) => { if (value.trim() === 'fail-launch') { process.stdout.write('\x1b[?1049hError: fixture invalid model\x1b[?1049l\n'); process.exit(1); } if (value.trim() === 'spawn-child') { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); console.log('CHILD:' + child.pid); return; } if (loginProvider && value.trim() === 'complete-login') { const directory = loginProvider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME; fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'fixture-authenticated'), 'fixture-only'); console.log('LOGIN COMPLETE'); process.exit(0); } console.log(`ECHO:${value.trim()}`); if (value.trim()) reportUsage(); });
process.on('SIGTERM', () => { process.stdout.write('FINAL:fixture shutdown\n'); setTimeout(() => process.exit(0), 100); });
