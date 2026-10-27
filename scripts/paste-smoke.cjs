// Image and text paste on Windows, against the system clipboard: what a terminal channel sends the CLI for Ctrl+V and
// Alt+V, and what a chat channel sends. Claude Code and Codex attach a clipboard image on Alt+V on Windows and ignore
// ^V, so Ctrl+V with only an image must arrive as Alt+V, and Ctrl+V with text as the text.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { tileControl } = require('./lib/navigate.cjs');
if (process.platform !== 'win32') { console.log('SKIP: paste smoke runs on Windows only (the system clipboard is set through Windows Forms).'); process.exit(0); }

const RECORDER = `const fs = require('node:fs'); const log = (line) => fs.appendFileSync(process.env.PASTE_SMOKE_LOG, line + '\\n'); const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.311 (paste smoke)'); process.exit(0); }
if (args.includes('--help')) { console.log('--model <model> --session-id <uuid> --resume <uuid> --settings <file-or-json> --append-system-prompt <text> --mcp-config <file>'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (args.includes('-p') && args.includes('stream-json')) { const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => { log('CHAT ' + line); let message; try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'control_request') out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    if (message.type === 'user') out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'paste-smoke' }); });
} else if (args.includes('-p') || args[0] === 'app-server') { process.exit(0); }
else { process.stdout.write('PASTE SMOKE READY\\r\\n'); if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.on('data', (data) => log('TTY ' + Buffer.from(data).toString('hex'))); setInterval(() => {}, 1000); }`;
const CLIPBOARD = `param([string]$Mode)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if ($Mode -eq 'text') { [System.Windows.Forms.Clipboard]::SetText('pasted text'); exit 0 }
$bmp = New-Object System.Drawing.Bitmap 64, 48; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::OrangeRed); $g.Dispose()
[System.Windows.Forms.Clipboard]::SetImage($bmp)`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (text) => Buffer.from(text).toString('hex');

(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-paste-'))); const bin = path.join(root, 'bin'); const project = path.join(root, 'project'); const log = path.join(root, 'received.log'); const script = path.join(root, 'clipboard.ps1');
  await Promise.all([bin, project].map((folder) => fs.mkdir(folder))); await fs.writeFile(log, ''); await fs.writeFile(script, CLIPBOARD);
  for (const engine of ['claude', 'codex']) {
    const packageRoot = path.join(bin, 'node_modules', ...(engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex').split('/'));
    await fs.mkdir(packageRoot, { recursive: true }); await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { [engine]: 'fixture.cjs' } }));
    await fs.writeFile(path.join(packageRoot, 'fixture.cjs'), RECORDER); await fs.writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
  }
  const setClipboard = (mode) => execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, mode]);
  const env = { ...process.env, PASTE_SMOKE_LOG: log, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') }; delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  const received = async () => (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean);
  const after = async (mark, prefix, wait = 1500) => { await sleep(wait); return (await received()).slice(mark).filter((line) => line.startsWith(prefix)); };
  const useFolder = async (tile) => {
    const name = await tile.getByRole('button', { name: /^Engine settings for session \d+$/ }).getAttribute('aria-label');
    await (await tileControl(tile, name)).click();
    await tile.getByLabel('Working directory', { exact: true }).selectOption('independent'); await tile.getByLabel('Repository path', { exact: true }).fill(project);
    await (await tileControl(tile, name)).click();
  };
  let app;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'], env });
    const page = await app.firstWindow(); await page.waitForSelector('.tr-empty, .session-tile');
    await page.getByRole('button', { name: 'Use channels without a project', exact: true }).click();

    const tile = page.locator('.session-tile').first(); await useFolder(tile);
    await tile.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.session-tile .xterm-rows')?.textContent?.includes('PASTE SMOKE READY'), null, { timeout: 30000 });
    await tile.locator('.xterm').click(); await sleep(300);

    setClipboard('image'); let mark = (await received()).length; await page.keyboard.press('Control+V');
    assert.deepEqual(await after(mark, 'TTY'), ['TTY ' + hex('\x1bv')], 'Ctrl+V with only an image sends Alt+V, the key both CLIs attach images on');
    await page.waitForFunction(() => document.querySelectorAll('.session-tile .pasted-thumb').length === 1, null, { timeout: 10000 });
    mark = (await received()).length; await page.keyboard.press('Alt+V');
    assert.deepEqual(await after(mark, 'TTY'), ['TTY ' + hex('\x1bv')], 'Alt+V still reaches the CLI unchanged');
    setClipboard('text'); mark = (await received()).length; await page.keyboard.press('Control+V');
    assert.deepEqual(await after(mark, 'TTY'), ['TTY ' + hex('pasted text')], 'Ctrl+V with text pastes the text, not ^V');

    // The menu item's name includes its description ("Claude chat Claude as a conversation, …").
    await page.getByRole('button', { name: 'New channel', exact: true }).click(); await page.getByRole('menuitem', { name: /^Claude chat/ }).click();
    const chatTile = page.locator('.session-tile').last(); await useFolder(chatTile);
    await chatTile.getByRole('button', { name: 'Start session', exact: true }).click();
    const box = chatTile.locator('textarea'); await page.waitForFunction(() => { const area = [...document.querySelectorAll('.session-tile')].at(-1)?.querySelector('textarea'); return area && !area.disabled; }, null, { timeout: 30000 });
    setClipboard('image'); await box.click(); await page.keyboard.press('Control+V');
    await page.waitForFunction(() => [...document.querySelectorAll('.session-tile')].at(-1)?.querySelectorAll('.chat-attachments li').length === 1, null, { timeout: 10000 });
    mark = (await received()).length; await box.fill('what is this'); await page.keyboard.press('Enter');
    const sent = (await after(mark, 'CHAT', 2000)).map((line) => JSON.parse(line.slice(5))).find((message) => message.type === 'user');
    assert.ok(sent, 'The chat message reached the CLI');
    assert.deepEqual(sent.message.content.map((part) => part.type), ['image', 'text']); assert.equal(sent.message.content[0].source.media_type, 'image/png');
    console.log('PASS: Windows paste: Ctrl+V image sends Alt+V and shows Attached, Alt+V unchanged, Ctrl+V text pastes text, chat sends the pasted image.');
  } finally { await app?.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {}); }
})().catch((error) => { console.error(error); process.exit(1); });
