import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('smoke scripts', () => {
  // waitForFunction treats a returned promise as truthy, so an async check passes before it has run; see lib/wait.cjs.
  it('never pass an async check to waitForFunction', () => {
    const scripts = path.join(__dirname, '..');
    const offenders = fs.readdirSync(scripts).filter((file) => file.endsWith('.cjs') && /waitForFunction\(\s*async\b/.test(fs.readFileSync(path.join(scripts, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
