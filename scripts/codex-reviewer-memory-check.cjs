// Manual check with the real Codex CLI (uses a little of your Codex plan): a Codex chat run as Trace runs a Round Table
// reviewer (read-only), with Trace's memory server, asked to use read_memory and write_handoff. With the approval setting
// Trace adds, both calls succeed and a note is written; without it Codex asks (mcpServer/elicitation/request), Trace
// declines, and Codex reports "user rejected MCP tool call". Not part of CI.
// Usage: npm run build:host && CODEX_EXE=<path to codex.exe or codex> node scripts/codex-reviewer-memory-check.cjs <with|without>
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const { CodexStream } = require(path.join(repo, 'dist-electron/electron/services/chat/codex-stream.js'));
const mode = process.argv[2] === 'without' ? 'without' : 'with';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-reviewer-')); const memory = path.join(root, 'memory'); const project = path.join(root, 'project'); fs.mkdirSync(project);
execFileSync('git', ['init', '-q'], { cwd: project });
const server = path.join(repo, 'dist-electron/electron/services/hub/memory-server.js');
const config = [
  `mcp_servers.coding-hub-memory.command=${JSON.stringify(process.execPath)}`,
  `mcp_servers.coding-hub-memory.args=${JSON.stringify([server, memory, 'reviewer-check', 'codex', project])}`,
  ...(mode === 'with' ? ['mcp_servers.coding-hub-memory.default_tools_approval_mode="approve"'] : []),
];
const exe = process.env.CODEX_EXE || 'codex';
const child = spawn(exe, ['app-server', ...config.flatMap((value) => ['--config', value])], { cwd: project, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
let errText = ''; child.on('error', (e) => { errText = String(e); });
const events = [];
const stream = new CodexStream((line) => child.stdin.write(line.endsWith('\n') ? line : line + '\n'), (event) => events.push(event), { cwd: project, model: '', reasoningEffort: null, permissions: 'ask' });
child.stdout.on('data', (data) => stream.push(data.toString()));
child.stderr.on('data', (d) => { errText += d.toString().slice(0, 500); });
stream.setReadOnly(true); stream.start();
stream.send('Call the read_memory tool of the coding-hub-memory MCP server once, then call its write_handoff tool once with title "Reviewer check" and content "ok". Do nothing else. Then reply with OK, or the exact error text of any call that failed.', []);
const timer = setTimeout(() => finish('timed out'), 240000);
const tick = setInterval(() => { if (events.some((event) => event.type === 'done')) finish('done'); }, 500);
function finish(how) {
  clearTimeout(timer); clearInterval(tick);
  const text = events.filter((event) => event.type === 'assistant').flatMap((event) => event.blocks).filter((block) => block.type === 'text').map((block) => block.text).join(' ').trim();
  const tools = events.filter((event) => event.type === 'tool' || event.type === 'tool-result' || event.type === 'permission').map((event) => `${event.type}:${event.toolName ?? event.name ?? ''}${event.isError ? ':error' : ''}`);
  let notes = []; try { notes = fs.readdirSync(path.join(memory, 'reviewer-check')).filter((name) => name.endsWith('.json')); } catch { /* None written. */ }
  console.log(JSON.stringify({ mode, how, err: errText.slice(-300), reply: text.slice(0, 300), tools, notesWritten: notes.length }));
  try { child.kill(); } catch {}
  setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Codex still holds it. */ } process.exit(0); }, 1500);
}
