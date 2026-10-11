import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { npmEntryForShim } from './discovery';

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
    expect(await npmEntryForShim(shim, 'codex')).toEqual({ file: process.execPath, prefixArgs: [path.join(packageRoot, 'cli.cjs')], extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, displayPath: shim });
  });
  it('supports string bin declarations', async () => {
    const { shim } = await fixture('cli.cjs');
    expect((await npmEntryForShim(shim, 'codex')).prefixArgs).toHaveLength(1);
  });
  it('rejects absent entries and paths outside the expected package', async () => {
    for (const bin of [{ other: 'cli.cjs' }, { codex: '../../../outside.cjs' }, { codex: 'missing.cjs' }]) {
      const { shim } = await fixture(bin);
      await expect(npmEntryForShim(shim, 'codex')).rejects.toThrow('Reinstall');
    }
  });
});
