import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CLEAR_RUN_AS_NODE, npmEntryForShim } from './discovery';

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
