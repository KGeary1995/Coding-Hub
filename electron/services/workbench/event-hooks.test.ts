import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHooks } from './event-hooks';

const roots: string[] = [];
const fixture = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-hooks-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
/** A hook that writes what it was given (its event, channel and message) to `out`. */
const writer = (out: string) => ['-e', `require('fs').appendFileSync(${JSON.stringify(out)}, [process.env.TRACE_EVENT, process.env.TRACE_CHANNEL, process.env.TRACE_CHANNEL_NAME, process.env.TRACE_MESSAGE].join('|') + '\\n')`];
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50)); };

describe('event hooks', () => {
  it('saves a hook only once the person confirms it, and only a program named by its full path', async () => {
    const root = fixture(); let answer = false; const asked: unknown[] = [];
    const hooks = new EventHooks(root, async (hook) => { asked.push(hook); return answer; });
    await expect(hooks.execute({ action: 'hook-save', event: 'needs-you', program: process.execPath, args: ['-v'] })).rejects.toMatchObject({ code: 'HOOK_DECLINED' });
    expect((await hooks.execute({ action: 'hook-list' }) as { hooks: unknown[] }).hooks).toHaveLength(0);
    await expect(hooks.execute({ action: 'hook-save', event: 'needs-you', program: 'node', args: [] })).rejects.toMatchObject({ code: 'HOOK_PROGRAM' });
    await expect(hooks.execute({ action: 'hook-save', event: 'needs-you', program: path.join(root, 'missing.exe'), args: [] })).rejects.toMatchObject({ code: 'HOOK_PROGRAM' });
    answer = true; await hooks.execute({ action: 'hook-save', event: 'needs-you', program: process.execPath, args: ['-v'] });
    expect(asked).toHaveLength(2); expect((await hooks.execute({ action: 'hook-list' }) as { hooks: unknown[] }).hooks).toHaveLength(1);
  });
  it('runs the hooks for an event with what happened in their environment, once per channel in ten seconds', async () => {
    const root = fixture(); const out = path.join(root, 'out.txt'); const hooks = new EventHooks(root, async () => true);
    await hooks.execute({ action: 'hook-save', event: 'needs-you', program: process.execPath, args: writer(out) });
    await hooks.execute({ action: 'hook-save', event: 'failed', program: process.execPath, args: writer(out) });
    hooks.fire('needs-you', 's1', { channel: 2, name: 'Builder', message: 'Allow rm?', folder: '/p' });
    hooks.fire('needs-you', 's1', { channel: 2, name: 'Builder', message: 'Again', folder: '/p' });
    hooks.fire('turn-ended', 's1', { channel: 2, name: 'Builder', message: 'Done', folder: '/p' });
    await until(() => fs.existsSync(out)); await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fs.readFileSync(out, 'utf8')).toBe('needs-you|2|Builder|Allow rm?\n');
    const { hooks: listed } = await hooks.execute({ action: 'hook-list' }) as { hooks: { event: string; lastRun?: { ok: boolean } }[] };
    expect(listed.find((item) => item.event === 'needs-you')?.lastRun?.ok).toBe(true);
  });
  it('tests a hook on request, and deletes it', async () => {
    const root = fixture(); const out = path.join(root, 'out.txt'); const hooks = new EventHooks(root, async () => true);
    const saved = await hooks.execute({ action: 'hook-save', event: 'turn-ended', program: process.execPath, args: writer(out) }) as { id: string };
    const tested = await hooks.execute({ action: 'hook-test', id: saved.id }) as { hooks: { lastRun?: { note: string } }[] };
    expect(fs.readFileSync(out, 'utf8')).toBe('test|0|Test from Trace|This is a test of the event hook.\n'); expect(tested.hooks[0].lastRun?.note).toBe('Test: Ran');
    await hooks.execute({ action: 'hook-delete', id: saved.id }); expect((await hooks.execute({ action: 'hook-list' }) as { hooks: unknown[] }).hooks).toHaveLength(0);
  });
});
