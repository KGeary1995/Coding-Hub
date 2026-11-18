import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileTree } from './process-tree';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

it('ends the whole process tree when the time limit passes, not only the direct child', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tree-')); roots.push(root); const marker = path.join(root, 'late');
  // The direct child starts a grandchild (as git starts a hook, or gh starts git) that writes a mark after 2 s.
  const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 2000)`;
  const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 10000)`;
  await expect(execFileTree(process.execPath, ['-e', child], { timeout: 500, windowsHide: true })).rejects.toMatchObject({ killed: true });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(fs.existsSync(marker)).toBe(false);
}, 15000);

// A shell whose background job keeps the output pipe (Node's own children do not hand it on, on Windows): Git Bash there.
const sh = process.platform === 'win32' ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((root) => path.join(root!, 'Git', 'bin', 'sh.exe')).find((file) => fs.existsSync(file)) : 'sh';
it.skipIf(!sh)('returns once the program ends, even when a job it left running holds the output open', async () => {
  // As a hook that starts a background job: it shares the output pipe and outlives the shell by 6 s.
  const started = Date.now();
  expect((await execFileTree(sh!, ['-c', 'sleep 6 & printf done'], { timeout: 10000, windowsHide: true })).stdout.toString()).toBe('done');
  expect(Date.now() - started).toBeLessThan(4500);
  // Past the limit it settles as a timeout, whether or not the stop reached that job.
  const again = Date.now();
  await expect(execFileTree(sh!, ['-c', 'sleep 6 & sleep 6'], { timeout: 300, windowsHide: true })).rejects.toMatchObject({ killed: true });
  expect(Date.now() - again).toBeLessThan(4500);
}, 20000);

it('returns output, and the output of a failure, as execFile does', async () => {
  expect((await execFileTree(process.execPath, ['-e', 'process.stdout.write("done")'], { timeout: 10000 })).stdout.toString()).toBe('done');
  await expect(execFileTree(process.execPath, ['-e', 'process.stderr.write("refused"); process.exit(3)'], { timeout: 10000 })).rejects.toMatchObject({ code: 3, killed: false });
  await expect(execFileTree(process.execPath, ['-e', 'process.stderr.write("refused"); process.exit(3)'], { timeout: 10000 }).catch((error) => error.stderr.toString())).resolves.toBe('refused');
});
