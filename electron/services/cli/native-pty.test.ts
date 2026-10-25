import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSpawnHelper } from './native-pty';

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
