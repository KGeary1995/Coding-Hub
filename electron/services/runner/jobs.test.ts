import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Jobs } from './jobs';

const roots: string[] = []; const open: Jobs[] = [];
afterEach(() => { for (const jobs of open.splice(0)) jobs.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/**
 * A stand-in for native/trace-jobs.exe under Node, speaking its protocol (one line each way): it knows the jobs it was
 * given, answers err 1168 (ERROR_NOT_FOUND) for others, and leaves without answering when asked to add key 13.
 */
const FAKE = `
const known = new Set(); let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk; let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const [verb, key, pid] = buffer.slice(0, at).trim().split(' '); buffer = buffer.slice(at + 1);
    if (verb === 'add' && key === '13') process.exit(0);
    if (verb === 'add' && pid) { known.add(key); process.stdout.write('ok ' + key + '\\n'); }
    else if (verb === 'kill') process.stdout.write(known.has(key) ? 'ok ' + key + '\\n' : 'err ' + key + ' 1168\\n');
    else if (verb === 'drop') { known.delete(key); process.stdout.write('ok ' + key + '\\n'); }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
function fake(log: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-jobs-')); roots.push(root);
  const script = path.join(root, 'fake-jobs.cjs'); fs.writeFileSync(script, FAKE);
  const jobs = new Jobs(process.execPath, (message) => log.push(message), [script]); open.push(jobs); return jobs;
}

describe('Windows job objects (the helper protocol)', () => {
  it('adds, ends and lets go of a program\'s job, and says when there is none', async () => {
    const log: string[] = []; const jobs = fake(log);
    expect(jobs.available).toBe(true);
    expect(await jobs.add(4242)).toBe(true);
    expect(await jobs.kill(4242)).toBe(true);
    expect(await jobs.drop(4242)).toBe(true);
    expect(await jobs.kill(4242)).toBe(false); expect(log).toEqual(['job helper: err 4242 1168']);
  });

  it('answers requests for the same program in the order they were sent', async () => {
    const jobs = fake();
    expect(await Promise.all([jobs.kill(7), jobs.add(7), jobs.kill(7), jobs.drop(7), jobs.kill(7)])).toEqual([false, true, true, true, false]);
  });

  it('does nothing without the helper, and never asks about an invalid process id', async () => {
    const missing = new Jobs(path.join(os.tmpdir(), 'no-such-trace-jobs.exe'));
    expect(missing.available).toBe(false); expect(await missing.add(4242)).toBe(false); expect(await missing.kill(4242)).toBe(false);
    expect(new Jobs(null).available).toBe(false);
    const jobs = fake(); expect(await jobs.add(0)).toBe(false); expect(await jobs.kill(-1)).toBe(false); expect(await jobs.add(1.5)).toBe(false);
  });

  it('answers what was waiting, and everything after, with false when the helper goes away', async () => {
    const jobs = fake();
    expect(await jobs.add(5)).toBe(true);
    expect(await jobs.add(13)).toBe(false);
    expect(jobs.available).toBe(false); expect(await jobs.kill(5)).toBe(false);
  });
});
