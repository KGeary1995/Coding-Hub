import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const { removeFolder } = createRequire(import.meta.url)('./cleanup.cjs') as { removeFolder: (folder: string, remove?: (folder: string, options: object) => Promise<void>) => Promise<void> };

describe('smoke test cleanup', () => {
  it('retries a busy folder and never throws, so the test keeps its own result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const remove = vi.fn(async () => { throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }); });
    await expect(removeFolder('/tmp/held', remove)).resolves.toBeUndefined();
    // rm backs off linearly (retryDelay × attempt), so 10 × 500 ms would wait about 27 s on a held folder, not 5.
    const options = (remove.mock.calls[0] as unknown[])[1] as { maxRetries: number; retryDelay: number };
    expect(remove).toHaveBeenCalledWith('/tmp/held', expect.objectContaining({ recursive: true, force: true }));
    expect(options.retryDelay * options.maxRetries * (options.maxRetries + 1) / 2).toBeLessThanOrEqual(6000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EBUSY')); warn.mockRestore();
  });

  it('removes the folder', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cleanup-')); fs.writeFileSync(path.join(folder, 'file'), 'x');
    await removeFolder(folder); expect(fs.existsSync(folder)).toBe(false);
  });

  // A bare rm in `finally` throws EBUSY over the assertion that failed; every smoke script goes through removeFolder.
  it('is how every smoke script removes its temporary folder', () => {
    const scripts = path.join(__dirname, '..');
    // windows-install-smoke keeps its folder on purpose when uninstalling failed; gpu-crash-smoke swallows its own error.
    const offenders = fs.readdirSync(scripts).filter((file) => file.endsWith('.cjs') && !['windows-install-smoke.cjs', 'gpu-crash-smoke.cjs'].includes(file))
      .filter((file) => /await (?:fs\.)?rm\(\s*root\b/.test(fs.readFileSync(path.join(scripts, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
