import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { conptyOptions, ensureSpawnHelper, ptyProcessEnded, skipConsoleProcessLookup } from './native-pty';

describe('node-pty Windows internals Trace relies on', () => {
  it('replaces the console process lookup and reads the exit node-pty has not reported yet', async () => {
    const agent: { exitCode?: number; _getConsoleProcessList: () => Promise<number[]> } = { _getConsoleProcessList: async () => [4242] };
    skipConsoleProcessLookup({ _agent: agent }); expect(await agent._getConsoleProcessList()).toEqual([]);
    expect(ptyProcessEnded({ _agent: agent })).toBe(false); agent.exitCode = 0; expect(ptyProcessEnded({ _agent: agent })).toBe(true);
    // A POSIX terminal has no such agent: nothing to replace, and no early exit to see.
    expect(() => skipConsoleProcessLookup({})).not.toThrow(); expect(ptyProcessEnded({})).toBe(false); expect(ptyProcessEnded(null)).toBe(false);
  });
  it('are still where the installed node-pty keeps them', () => {
    const lib = path.join(path.dirname(createRequire(path.join(process.cwd(), 'package.json')).resolve('node-pty/package.json')), 'lib');
    expect(fs.readFileSync(path.join(lib, 'windowsTerminal.js'), 'utf8')).toContain('_this._agent = new');
    const agent = fs.readFileSync(path.join(lib, 'windowsPtyAgent.js'), 'utf8');
    expect(agent).toContain('this._getConsoleProcessList().then('); expect(agent).toContain('"exitCode", {');
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('node-pty spawn-helper', () => {
  it('makes the macOS prebuilt helper executable, as node-pty 1.1 ships it without the bit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-')); roots.push(root);
    for (const folder of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'prebuilds/win32-x64']) { fs.mkdirSync(path.join(root, folder), { recursive: true }); fs.writeFileSync(path.join(root, folder, 'spawn-helper'), 'helper', { mode: 0o644 }); }
    const changed = ensureSpawnHelper(root, 'darwin');
    expect(changed.map((file) => path.relative(root, file)).sort()).toEqual([path.join('prebuilds', 'darwin-arm64', 'spawn-helper'), path.join('prebuilds', 'darwin-x64', 'spawn-helper')]);
    expect(fs.statSync(path.join(root, 'prebuilds/darwin-arm64/spawn-helper')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, 'prebuilds/win32-x64/spawn-helper')).mode & 0o777).toBe(0o644);
    expect(ensureSpawnHelper(root, 'darwin')).toEqual([]);
  });
});

describe('the bundled ConPTY switch', () => {
  it('is off unless CODING_HUB_CONPTY_DLL=1, and only on Windows', () => {
    expect(conptyOptions({}, 'win32')).toEqual({});
    expect(conptyOptions({ CODING_HUB_CONPTY_DLL: 'true' }, 'win32')).toEqual({});
    expect(conptyOptions({ CODING_HUB_CONPTY_DLL: '1' }, 'win32')).toEqual({ useConptyDll: true });
    expect(conptyOptions({ CODING_HUB_CONPTY_DLL: '1' }, 'darwin')).toEqual({});
  });
  it('is an option the installed node-pty has, with the files it loads for it', () => {
    const root = path.dirname(createRequire(path.join(process.cwd(), 'package.json')).resolve('node-pty/package.json'));
    expect(fs.readFileSync(path.join(root, 'typings', 'node-pty.d.ts'), 'utf8')).toContain('useConptyDll?: boolean;');
    // conpty.node loads conpty\conpty.dll from its own folder, and that starts the OpenConsole.exe beside it.
    for (const arch of ['x64', 'arm64']) for (const name of ['conpty.dll', 'OpenConsole.exe']) expect(fs.existsSync(path.join(root, 'prebuilds', `win32-${arch}`, 'conpty', name))).toBe(true);
  });
  it('needs nothing for Ctrl+C: node-pty restores it in the spawning process before it starts each program', () => {
    // An inherited "ignore Ctrl+C" (a detached runner can have one: libuv starts it with CREATE_NEW_PROCESS_GROUP) would
    // otherwise reach every program; the flag is inherited, so clearing it before CreateProcessW gives the default.
    const source = fs.readFileSync(path.join(path.dirname(createRequire(path.join(process.cwd(), 'package.json')).resolve('node-pty/package.json')), 'src', 'win', 'conpty.cc'), 'utf8');
    expect(source.indexOf('SetConsoleCtrlHandler(NULL, FALSE);')).toBeGreaterThan(0);
    expect(source.indexOf('SetConsoleCtrlHandler(NULL, FALSE);')).toBeLessThan(source.indexOf('CreateProcessW('));
  });
});
