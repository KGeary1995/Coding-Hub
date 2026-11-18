// The screenshot tour's stand-ins: a small Git project to open, and fixture CLIs in place of Claude Code and Codex, so
// the tour shows Trace in use without the person's own folders, accounts or tokens.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FILES = {
  'package.json': JSON.stringify({ name: 'tour-project', version: '0.1.0', private: true, scripts: { test: 'node --test test' } }, null, 2) + '\n',
  'README.md': '# Tour project\n\nA small greeting library, made for Trace\'s screenshot tour.\n',
  'src/index.ts': 'export { greet } from \'./greet\';\nexport { formatName } from \'./format\';\n',
  'src/greet.ts': 'import { formatName } from \'./format\';\n\n/** A greeting for one person. */\nexport function greet(name: string): string {\n  return `Hello, ${formatName(name)}!`;\n}\n',
  'src/format.ts': '/** Capitalises each word of a name. */\nexport function formatName(name: string): string {\n  return name.split(\' \').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(\' \');\n}\n',
  'test/greet.test.ts': 'import { strict as assert } from \'node:assert\';\nimport { test } from \'node:test\';\nimport { greet } from \'../src/greet\';\n\ntest(\'greets by name\', () => assert.equal(greet(\'ada lovelace\'), \'Hello, Ada Lovelace!\'));\n',
};

/** A Git repository with one commit, then one modified, one staged and one untracked file, so Changes and Files have content. */
async function makeProject(directory) {
  for (const [file, text] of Object.entries(FILES)) { await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await fs.writeFile(path.join(directory, file), text); }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Tour', '-c', 'user.email=tour@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: directory, stdio: 'pipe' });
  git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'Greeting library with a test');
  await fs.writeFile(path.join(directory, 'src/greet.ts'), FILES['src/greet.ts'].replace('return `Hello, ${formatName(name)}!`;', 'const trimmed = name.trim();\n  if (!trimmed) return \'Hello!\';\n  return `Hello, ${formatName(trimmed)}!`;'));
  await fs.writeFile(path.join(directory, 'README.md'), FILES['README.md'] + '\n## Use\n\n```ts\ngreet(\'ada lovelace\'); // Hello, Ada Lovelace!\n```\n'); git('add', 'README.md');
  await fs.writeFile(path.join(directory, 'src/farewell.ts'), 'export const farewell = (name: string) => `Goodbye, ${name}.`;\n');
}

/** Codex's app server as a chat channel uses it: a thread, and each turn answered with one short message. */
const CODEX_CHAT = `if (process.argv[2] === 'app-server') {
  const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n'); let turns = 0;
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line); if (request.id === undefined) return;
    if (request.method === 'initialize') out({ id: request.id, result: { userAgent: 'tour fixture' } });
    else if (request.method === 'model/list') out({ id: request.id, result: { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', description: 'Tour fixture', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }], nextCursor: null } });
    else if (request.method === 'thread/start' || request.method === 'thread/resume') out({ id: request.id, result: { thread: { id: request.params.threadId ?? 'tour-thread' }, model: 'fixture-model' } });
    else if (request.method === 'turn/start') {
      const id = 'turn-' + ++turns; out({ id: request.id, result: { turn: { id } } });
      out({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'reply-' + id, text: 'Reviewed: the empty-name case is covered. Add a test for a name with extra spaces.' } } });
      out({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
    } else out({ id: request.id, error: { message: 'Unsupported fixture method' } });
  });
  return;
}
`;

/**
 * Puts fixture CLIs named claude and codex in `bin`, the way the smoke tests do: on Windows an npm shim with the package
 * beside it (Trace runs the package's script), elsewhere an executable script. Claude is the structured fixture when it
 * starts as a chat, else the terminal one; Codex answers its app server for chats. `homes` (optional) pins the fixtures'
 * own CLAUDE_CONFIG_DIR and CODEX_HOME, so they never write into the person's real folders.
 */
async function installFixtures(bin, homes) {
  const terminal = await fs.readFile(path.join(__dirname, '../fixtures/interactive-cli.cjs'), 'utf8');
  const chat = await fs.readFile(path.join(__dirname, '../fixtures/claude-stream-fixture.cjs'), 'utf8');
  const pin = homes ? `process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(homes.claude)}; process.env.CODEX_HOME = ${JSON.stringify(homes.codex)};\n` : '';
  const scripts = { claude: `${pin}if (process.argv.includes('--input-format')) {\n${chat}\n} else {\n${terminal}\n}\n`, codex: `${pin}${CODEX_CHAT}${terminal}` };
  await fs.mkdir(bin, { recursive: true });
  for (const [engine, script] of Object.entries(scripts)) {
    if (process.platform === 'win32') {
      const packageRoot = path.join(bin, 'node_modules', ...(engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex').split('/'));
      await fs.mkdir(packageRoot, { recursive: true }); await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: engine, bin: { [engine]: 'fixture.cjs' } }));
      await fs.writeFile(path.join(packageRoot, 'fixture.cjs'), script); await fs.writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
      // Trace looks for Codex's native program with Node's module search, which goes on through the folders above the temp
      // folder. An empty package of that name ends the search here, so a real codex.exe further up is never started.
      if (engine === 'codex') for (const architecture of ['x64', 'arm64']) {
        const native = path.join(packageRoot, 'node_modules', '@openai', `codex-win32-${architecture}`);
        await fs.mkdir(native, { recursive: true }); await fs.writeFile(path.join(native, 'package.json'), JSON.stringify({ name: `@openai/codex-win32-${architecture}` }));
      }
    } else await fs.writeFile(path.join(bin, engine), '#!/usr/bin/env node\n' + script, { mode: 0o755 });
  }
}

module.exports = { makeProject, installFixtures };
