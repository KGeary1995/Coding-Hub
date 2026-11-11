import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { adoptLoginShellPath, CLEAR_RUN_AS_NODE, discoverGemini, findGeminiExecutable, hostEnvironment, loginShellPath, mergePath, npmEntryForShim, windowsRegistryPath, withoutAgentSession } from './discovery';

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
  it('reads machine then user folders and expands their variables', () => {
    const registry: Record<string, string> = { 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment': 'C:\\Windows\\system32;%SystemRoot%', 'HKCU\\Environment': '%USERPROFILE%\\tools;;%MISSING%\\bin' };
    expect(windowsRegistryPath({ systemroot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' }, (key) => registry[key] ?? null)).toEqual(['C:\\Windows\\system32', 'C:\\Windows', 'C:\\Users\\me\\tools', '%MISSING%\\bin']);
    expect(windowsRegistryPath({}, () => null)).toEqual([]);
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

describe('Gemini CLI discovery', () => {
  it('finds agy by name on PATH and ignores an npm shim of the same name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trace agy ')); directories.push(root);
    const shimOnly = path.join(root, 'shim'); const bin = path.join(root, 'bin'); await mkdir(shimOnly); await mkdir(bin);
    const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
    await writeFile(path.join(shimOnly, 'agy.cmd'), '@echo off'); await writeFile(path.join(bin, name), '', { mode: 0o755 });
    const found = await findGeminiExecutable({ PATH: [shimOnly, bin].join(path.delimiter) });
    expect(found).toEqual({ file: path.join(bin, name), prefixArgs: [], extraEnv: {}, displayPath: path.join(bin, name) });
  });
  it('says how to install agy when it is not on PATH', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trace no agy ')); directories.push(root);
    await expect(findGeminiExecutable({ PATH: root })).rejects.toMatchObject({ code: 'CLI_NOT_FOUND', message: expect.stringContaining('Gemini CLI (agy) was not found on PATH') });
    const result = await discoverGemini({ PATH: root });
    expect(result).toMatchObject({ executable: null, info: { engine: 'gemini', available: false, error: expect.stringContaining('Gemini CLI (agy) was not found on PATH') } });
  });
  it('reads the version and the flags Gemini channels need from agy --help, which agy prints on stderr', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trace fake agy ')); directories.push(root);
    // A Node script stands in for agy here (the PATH lookup is tested above).
    const script = path.join(root, 'agy.cjs');
    await writeFile(script, "if (process.argv[2] === '--version') console.log('1.5.6'); else console.error(['Usage of agy.exe:', '  --dangerously-skip-permissions  Auto-approve', '  --mode  Set the agent execution mode', '  --model  Model for the current CLI session', '', 'Available subcommands:', '  acp             Start the Agent Client Protocol (ACP) stdio server'].join('\\n'));");
    const result = await discoverGemini({ PATH: '' }, async () => ({ file: process.execPath, prefixArgs: [script], extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, displayPath: script }));
    expect(result.info).toMatchObject({ engine: 'gemini', available: true, version: '1.5.6', supportsModel: true, supportsMode: true, supportsSkipPermissions: true, supportsAcp: true, authentication: { state: 'unknown' } });
  });
});
