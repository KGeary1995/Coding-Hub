import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** What the fake reg.exe answers for HKCU\Environment's Path; every other program runs for real. */
const registry = vi.hoisted(() => ({ userPath: '' }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = ((file: string, args: string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (file !== 'reg.exe') return (actual.execFile as (...values: unknown[]) => unknown)(file, args, options, callback);
    queueMicrotask(() => args[1] === 'HKCU\\Environment' && registry.userPath ? callback(null, `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    ${registry.userPath}\r\n`, '') : callback(new Error('not found'), '', ''));
    return undefined;
  }) as unknown as typeof actual.execFile;
  return { ...actual, execFile };
});

const { discoverEngine, findExecutable } = await import('./discovery');
const { findGitHub, inspectAccount } = await import('./account-connections');

const directories: string[] = []; const pathBefore = process.env.PATH;
afterEach(async () => { vi.useRealTimers(); process.env.PATH = pathBefore; registry.userPath = ''; await Promise.all(directories.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

describe('checks for an installed CLI after a PATH change', () => {
  it.runIf(process.platform === 'win32')('find a tool in a folder added to the registry PATH on the first check, without a second Refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000);
    const empty = await mkdtemp(path.join(os.tmpdir(), 'trace-empty-')); const installed = await mkdtemp(path.join(os.tmpdir(), 'trace-installed-')); directories.push(empty, installed);
    await writeFile(path.join(installed, 'claude.exe'), ''); await writeFile(path.join(installed, 'gh.exe'), '');
    process.env.PATH = empty;
    // The registry has been read once (no new folder yet), so a value is cached.
    expect((await findExecutable('claude').catch(() => null))?.file).not.toBe(path.join(installed, 'claude.exe'));
    // The person installs the tools, which adds a folder to their PATH, and presses Refresh later.
    registry.userPath = installed; vi.setSystemTime(1_000_000 + 10 * 60_000);
    expect((await findExecutable('claude')).file).toBe(path.join(installed, 'claude.exe'));
    vi.setSystemTime(1_000_000 + 20 * 60_000); registry.userPath = `${empty};${installed}`;
    expect((await findGitHub()).file).toBe(path.join(installed, 'gh.exe'));
    vi.setSystemTime(1_000_000 + 30 * 60_000);
    expect((await discoverEngine('claude', undefined, { authentication: false })).info.executable).toBe(path.join(installed, 'claude.exe'));
    vi.setSystemTime(1_000_000 + 40 * 60_000);
    // An empty gh.exe does not run, so Accounts reports a failure, but not "not installed": it found the file.
    const account = (await inspectAccount('github')).connection; expect(account.message).not.toMatch(/not installed/); expect(account.message).toBeTruthy();
  });
});
