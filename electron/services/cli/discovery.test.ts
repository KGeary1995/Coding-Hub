import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { adoptLoginShellPath, CLEAR_RUN_AS_NODE, discoverEngine, findExecutable, freshHostEnvironment, hostEnvironment, loginShellPath, mergePath, npmEntryForShim, RegistryPath, windowsRegistryPath, withoutAgentSession } from './discovery';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function fixture(bin: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coding hub npm shim '));
  directories.push(root);
  const packageRoot = path.join(root, 'node_modules', '@openai', 'codex');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin }));
  await writeFile(path.join(packageRoot, 'cli.cjs'), 'console.log("fixture")');
  return { root, packageRoot, shim: path.join(root, 'codex.cmd') };
}
describe('Windows npm CLI shim resolution', () => {
  it('resolves the declared entry with spaces in the path without invoking a shell', async () => {
    const { shim, packageRoot } = await fixture({ codex: 'cli.cjs' });
    expect(await npmEntryForShim(shim, 'codex')).toEqual({ file: process.execPath, prefixArgs: [CLEAR_RUN_AS_NODE, path.join(packageRoot, 'cli.cjs')], extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, displayPath: shim });
  });
  it('attaches directly to native Codex binaries in modern and legacy Windows package layouts', async () => {
    for (const folder of ['bin', 'codex']) {
      const { shim, packageRoot } = await fixture('cli.cjs');
      const directory = path.join(packageRoot, 'vendor/x86_64-pc-windows-msvc', folder); await mkdir(directory, { recursive: true });
      const binary = path.join(directory, 'codex.exe'); await writeFile(binary, 'native fixture');
      const resolved = await npmEntryForShim(shim, 'codex', 'x64'); expect(resolved.file).toBe(binary); expect(resolved.prefixArgs).toEqual([]); expect(resolved.extraEnv).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    }
  });
  it('runs native package bin entries without asking Electron to interpret an EXE as JavaScript', async () => {
    const { shim, packageRoot } = await fixture('cli.cjs'); await writeFile(path.join(packageRoot, 'claude.exe'), 'native fixture');
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { codex: 'claude.exe' } }));
    expect((await npmEntryForShim(shim, 'codex')).prefixArgs).toEqual([]);
  });
  it('runs JavaScript entries with an installed console Node.js instead of Electron when one is on PATH', async () => {
    const { shim, packageRoot } = await fixture({ codex: 'cli.cjs' });
    expect(await npmEntryForShim(shim, 'codex', 'arm', '/nodejs/node.exe')).toEqual({ file: '/nodejs/node.exe', prefixArgs: [path.join(packageRoot, 'cli.cjs')], extraEnv: {}, displayPath: shim });
  });
  it('supports string bin declarations', async () => {
    const { shim } = await fixture('cli.cjs');
    expect((await npmEntryForShim(shim, 'codex')).prefixArgs).toHaveLength(2);
  });
  it('rejects absent entries and paths outside the expected package', async () => {
    for (const bin of [{ other: 'cli.cjs' }, { codex: '../../../outside.cjs' }, { codex: 'missing.cjs' }]) {
      const { shim } = await fixture(bin);
      await expect(npmEntryForShim(shim, 'codex')).rejects.toThrow('Reinstall');
    }
  });
});

describe('Mac login shell PATH', () => {
  it('reads the PATH between markers, ignoring what a shell profile prints', () => {
    const calls: string[][] = [];
    const value = loginShellPath('/bin/zsh', (file, args) => { calls.push([file, ...args]); return 'Welcome back!\n__TRACE_PATH__/Users/me/.nvm/versions/node/v22/bin:/usr/bin__TRACE_PATH__\n'; });
    expect(value).toBe('/Users/me/.nvm/versions/node/v22/bin:/usr/bin');
    expect(calls[0].slice(0, 2)).toEqual(['/bin/zsh', '-ilc']);
    expect(loginShellPath('/bin/zsh', () => 'no markers here')).toBeNull();
    expect(loginShellPath('/bin/zsh', () => { throw new Error('timed out'); })).toBeNull();
  });
  it('adds the shell folders after the current ones without repeating any', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    adoptLoginShellPath(env, () => '/opt/homebrew/bin:/usr/bin:/Users/me/.volta/bin');
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/me/.volta/bin');
    adoptLoginShellPath(env, () => null);
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/me/.volta/bin');
  });
});

describe('withoutAgentSession', () => {
  it('drops the session a Claude agent passed to Trace, keeping the person\'s own settings', () => {
    const inherited = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_PID: '22011', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SESSION_ID: '3811d0e6-2794-42b9-bba3-c36e5c7813ae', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_AGENT_SDK_VERSION: '0.3.309', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'opus' };
    expect(withoutAgentSession(inherited)).toEqual({ PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'opus' });
  });
  it('leaves an environment alone when no agent started Trace', () => {
    const own = { PATH: '/bin', CLAUDE_CODE_SESSION_ID: 'set-by-hand' };
    expect(withoutAgentSession(own)).toBe(own);
  });
});

describe('Windows PATH changes made while Trace runs', () => {
  it('reads machine then user folders and expands their variables', async () => {
    const registry: Record<string, string> = { 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment': 'C:\\Windows\\system32;%SystemRoot%', 'HKCU\\Environment': '%USERPROFILE%\\tools;;%MISSING%\\bin' };
    expect(await windowsRegistryPath({ systemroot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' }, async (key) => registry[key] ?? null)).toEqual(['C:\\Windows\\system32', 'C:\\Windows', 'C:\\Users\\me\\tools', '%MISSING%\\bin']);
    expect(await windowsRegistryPath({}, () => null)).toEqual([]);
    expect(await windowsRegistryPath({}, async () => { throw new Error('reg.exe failed'); })).toEqual([]);
  });
  it('never makes a caller wait for the registry, and still picks up a PATH change within seconds', async () => {
    let now = 0; let value = ['C:\\First']; let release!: () => void; let reads = 0;
    const cache = new RegistryPath(async () => { reads++; await new Promise<void>((resolve) => { release = resolve; }); return value; }, 5000, () => now);
    // Nothing read yet: the answer comes at once, and one read starts; callers meanwhile share it.
    expect(cache.current({})).toEqual([]); expect(cache.current({})).toEqual([]); expect(reads).toBe(1);
    const waiting = cache.refresh({}); release(); expect(await waiting).toEqual(['C:\\First']);
    now = 4000; expect(cache.current({})).toEqual(['C:\\First']); expect(reads).toBe(1);
    // Older than five seconds: the last value at once, and a new read in the background.
    value = ['C:\\Added']; now = 6000; expect(cache.current({})).toEqual(['C:\\First']); expect(reads).toBe(2);
    release(); await cache.refresh({}); expect(cache.current({})).toEqual(['C:\\Added']);
  });
  it('waits for a fresh registry read before a channel starts, so a CLI installed a moment ago is found', async () => {
    let now = 0; const cache = new RegistryPath(async () => ['C:\\Installed\\Later'], 5000, () => now);
    const env = await freshHostEnvironment(cache);
    const folders = env[Object.keys(env).find((key) => key.toUpperCase() === 'PATH')!].split(path.delimiter);
    if (process.platform === 'win32') expect(folders).toContain('C:\\Installed\\Later'); else expect(folders).not.toContain('C:\\Installed\\Later');
  });
  it('does not pass Trace\'s crash handler to programs started in channels', () => {
    const before = process.env.CHROME_CRASHPAD_PIPE_NAME; process.env.CHROME_CRASHPAD_PIPE_NAME = '\\\\.\\pipe\\crashpad_1_TEST';
    try { const env = hostEnvironment(() => []); expect(Object.keys(env).filter((key) => /crashpad/i.test(key))).toEqual([]); expect(env.PATH ?? env.Path).toBeTruthy(); }
    finally { if (before === undefined) delete process.env.CHROME_CRASHPAD_PIPE_NAME; else process.env.CHROME_CRASHPAD_PIPE_NAME = before; }
  });
  it('adds each folder once, comparing Windows paths without case or a trailing slash', () => {
    expect(mergePath(['C:\\Tools', 'c:\\tools\\', '"C:\\Tools"', 'C:\\Other', ''], true)).toEqual(['C:\\Tools', 'C:\\Other']);
    expect(mergePath(['/usr/bin', '/USR/BIN', '/usr/bin'], false)).toEqual(['/usr/bin', '/USR/BIN']);
  });
  it.runIf(process.platform === 'win32')('puts a folder added after Trace started on the PATH of new launches, after the current ones', () => {
    const env = hostEnvironment(() => ['C:\\Installed\\Later']);
    const folders = env[Object.keys(env).find((key) => key.toUpperCase() === 'PATH')!].split(';');
    expect(folders).toContain('C:\\Installed\\Later');
    expect(folders.indexOf('C:\\Installed\\Later')).toBeGreaterThan(0);
  });
});

describe('CLI discovery for a channel start', () => {
  /** A fake `claude` on PATH that logs each run's arguments and answers like Claude Code. */
  async function fakeClaude() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trace discovery ')); directories.push(root); const log = path.join(root, 'runs.log');
    const script = `const fs=require('fs');const a=process.argv.slice(2).join(' ');fs.appendFileSync(process.env.TRACE_FAKE_LOG,a+'\\n');
console.log(a==='--version'?'2.1.400 (Claude Code)':a==='--help'?'Usage: claude\\n  --model <model>\\nCommands:\\n  auth  Manage sign-in':a==='auth --help'?'Commands:\\n  status  Show sign-in':a==='auth status'?'{"loggedIn":true}':'');`;
    if (process.platform === 'win32') {
      const packageRoot = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code'); await mkdir(packageRoot, { recursive: true });
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { claude: 'cli.cjs' } })); await writeFile(path.join(packageRoot, 'cli.cjs'), script); await writeFile(path.join(root, 'claude.cmd'), '@echo off\r\n');
    } else await writeFile(path.join(root, 'claude'), `#!${process.execPath}\n${script}`, { mode: 0o755 });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0].toUpperCase() !== 'PATH'));
    return { env: { ...env, PATH: [root, path.dirname(process.execPath)].join(path.delimiter), TRACE_FAKE_LOG: log }, runs: async () => (await readFile(log, 'utf8')).trim().split('\n') };
  }
  it('skips the two sign-in probes when the start does not need them, and runs them when it does', async () => {
    const quick = await fakeClaude(); const found = await discoverEngine('claude', quick.env, { authentication: false });
    expect(found.info).toMatchObject({ available: true, version: '2.1.400 (Claude Code)', supportsModel: true }); expect(found.info.authentication).toBeUndefined();
    expect((await quick.runs()).sort()).toEqual(['--help', '--version']);
    const full = await fakeClaude(); expect((await discoverEngine('claude', full.env)).info.authentication?.state).toBe('authenticated');
    expect(await full.runs()).toEqual(expect.arrayContaining(['auth --help', 'auth status']));
  }, 30000);
});

describe('npm launchers on Windows', () => {
  it.skipIf(process.platform !== 'win32')('never runs a .cmd launcher itself: one it cannot read is refused, and an executable later on PATH is used', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trace shim ')); directories.push(root);
    const shim = path.join(root, 'shim'); const bin = path.join(root, 'bin'); await mkdir(shim); await mkdir(bin);
    // A launcher whose package Trace cannot find: cmd.exe would run it, and treat & or | in arguments as commands.
    await writeFile(path.join(shim, 'claude.cmd'), '@echo off\r\nnode "%~dp0\missing\cli.js" %*\r\n');
    await expect(findExecutable('claude', { PATH: shim })).rejects.toThrow();
    await writeFile(path.join(bin, 'claude.exe'), 'MZ');
    const found = await findExecutable('claude', { PATH: [shim, bin].join(path.delimiter) });
    expect(found.file).toBe(path.join(bin, 'claude.exe')); expect(found.file).not.toMatch(/\.cmd$/i);
  });
});
