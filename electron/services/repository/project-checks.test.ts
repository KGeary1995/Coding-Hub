import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProjectChecks } from './project-checks';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it('finds scoped instructions, skips dependencies, and runs only confirmed named scripts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hub-checks-')); roots.push(root);
  mkdirSync(path.join(root, 'nested')); mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'CLAUDE.md'), 'rules'); writeFileSync(path.join(root, 'nested', 'AGENTS.md'), 'other rules'); writeFileSync(path.join(root, 'node_modules', 'AGENTS.md'), 'ignored');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(123)"', lint: 'node -e "process.exit(7)"', arbitrary: 'node -e "process.exit(0)"' } }));
  const checks = new ProjectChecks(() => { throw new Error('Rules missing'); });
  expect(checks.inspect(root)).toMatchObject({ rulesApplied: false, scripts: ['test', 'lint'] }); expect(checks.inspect(root).instructions).toHaveLength(2);
  expect(await checks.execute({ action: 'run', directory: root, script: 'test' }, async () => false)).toMatchObject({ cancelled: true });
  await expect(checks.execute({ action: 'run', directory: root, script: 'arbitrary' }, async () => true)).rejects.toMatchObject({ code: 'INVALID_CHECK_REQUEST' });
  const success = await checks.execute({ action: 'run', directory: root, script: 'test' }, async () => true); expect(success).toMatchObject({ exitCode: 0 }); expect('output' in success && success.output).toContain('123');
  expect(await checks.execute({ action: 'run', directory: root, script: 'lint' }, async () => true)).toMatchObject({ exitCode: 7 });
});
