import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventHook, EventHookData, EventHookEvent } from '../../../shared/workbench';
import { load, save } from './local-store';
import { HubError } from '../cli/engine-adapter';

/**
 * Event hooks (1.33.1, from herdr's plugin event hooks): a program of the person's own that Trace runs when a channel
 * needs them, ends its turn, or fails, such as a script that sends a message to their phone. Saving one asks in a native
 * dialog with the exact command (`confirm`), so the window alone cannot add one. A hook runs without a shell, with what
 * happened in its environment (TRACE_EVENT, TRACE_CHANNEL, TRACE_CHANNEL_NAME, TRACE_MESSAGE, TRACE_FOLDER), and is
 * stopped after 30 seconds. The same hook runs at most once every 10 seconds for one channel, so a burst sends one.
 */
export const HOOK_EVENTS = ['needs-you', 'turn-ended', 'failed'] as const;
const hook = z.object({ id: z.uuid(), event: z.enum(HOOK_EVENTS), program: z.string().min(1).max(4096), args: z.array(z.string().max(500).refine((value) => !value.includes('\0'))).max(20), createdAt: z.iso.datetime() }).strict();
const dataSchema = z.object({ hooks: z.array(hook).max(20) }).strict();
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('hook-list') }).strict(),
  z.object({ action: z.literal('hook-save'), event: z.enum(HOOK_EVENTS), program: hook.shape.program, args: hook.shape.args }).strict(),
  z.object({ action: z.literal('hook-delete'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('hook-test'), id: z.uuid() }).strict(),
]);
export interface HookDetails { channel: number; name: string; message: string; folder: string | null }
const RUN_LIMIT_MS = 30000; const GAP_MS = 10000; const AT_ONCE = 4;

export class EventHooks {
  private last = new Map<string, number>();
  private lastRun = new Map<string, { at: string; ok: boolean; note: string }>();
  private running = 0;
  constructor(private root: string, private confirm: (hook: { event: EventHookEvent; program: string; args: string[] }) => Promise<boolean>) {}
  private hooks() { return load(this.root, 'event-hooks.json', dataSchema, { hooks: [] }).hooks; }
  data(): EventHookData { return { hooks: this.hooks().map((item) => ({ ...item, ...(this.lastRun.has(item.id) ? { lastRun: this.lastRun.get(item.id)! } : {}) })) }; }

  async execute(input: unknown): Promise<EventHookData | EventHook | null> {
    const request = schema.parse(input);
    if (request.action === 'hook-list') return this.data();
    const hooks = this.hooks();
    if (request.action === 'hook-delete') { save(this.root, 'event-hooks.json', { hooks: hooks.filter((item) => item.id !== request.id) }); this.lastRun.delete(request.id); return null; }
    if (request.action === 'hook-test') { const found = hooks.find((item) => item.id === request.id); if (!found) throw new HubError('HOOK_MISSING', 'That event hook is gone.'); await this.run(found, { channel: 0, name: 'Test from Trace', message: 'This is a test of the event hook.', folder: null }, true); return this.data(); }
    if (hooks.length >= 20) throw new HubError('HOOK_LIMIT', 'Up to 20 event hooks are supported.');
    const program = checkedProgram(request.program);
    if (!await this.confirm({ event: request.event, program, args: request.args })) throw new HubError('HOOK_DECLINED', 'The event hook was not saved.');
    const value: EventHook = { id: randomUUID(), event: request.event, program, args: request.args, createdAt: new Date().toISOString() };
    save(this.root, 'event-hooks.json', { hooks: [...hooks, value] }); return value;
  }

  /** Runs every hook for `event`, without waiting for them. A hook that cannot be read is skipped. */
  fire(event: EventHookEvent, sessionId: string, details: HookDetails) {
    let hooks: EventHook[]; try { hooks = this.hooks(); } catch { return; }
    for (const item of hooks) {
      if (item.event !== event) continue;
      const key = `${item.id}:${sessionId}`; const now = Date.now();
      if (now - (this.last.get(key) ?? 0) < GAP_MS || this.running >= AT_ONCE) continue;
      this.last.set(key, now); void this.run(item, details, false);
    }
  }

  private run(item: EventHook, details: HookDetails, test: boolean) {
    return new Promise<void>((resolve) => {
      const finish = (ok: boolean, note: string) => { this.lastRun.set(item.id, { at: new Date().toISOString(), ok, note: (test ? 'Test: ' : '') + note }); resolve(); };
      let program: string; try { program = checkedProgram(item.program); } catch (error) { finish(false, error instanceof Error ? error.message : 'The program is not there.'); return; }
      this.running++;
      const child = spawn(program, item.args, { shell: false, windowsHide: true, stdio: 'ignore', env: { ...process.env, TRACE_EVENT: test ? 'test' : item.event, TRACE_CHANNEL: String(details.channel), TRACE_CHANNEL_NAME: details.name, TRACE_MESSAGE: details.message.slice(0, 2000), TRACE_FOLDER: details.folder ?? '' } });
      const timer = setTimeout(() => { child.kill(); }, RUN_LIMIT_MS);
      let done = false; const end = (ok: boolean, note: string) => { if (done) return; done = true; clearTimeout(timer); this.running--; finish(ok, note); };
      child.once('error', (error) => end(false, `It could not start: ${error.message}`));
      child.once('exit', (code, signal) => end(code === 0, code === 0 ? 'Ran' : signal ? 'Stopped after 30 seconds' : `Exited with code ${code}`));
    });
  }
}

/** A hook's program: an existing file named by its full path, so what runs never depends on PATH or the current folder. */
function checkedProgram(value: string) {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new HubError('HOOK_PROGRAM', 'Give the program\'s full path, such as C:\\Tools\\notify.exe or /usr/local/bin/notify.');
  let stat: fs.Stats; try { stat = fs.statSync(value); } catch { throw new HubError('HOOK_PROGRAM', `${value} was not found.`); }
  if (!stat.isFile()) throw new HubError('HOOK_PROGRAM', `${value} is not a program file.`);
  return path.normalize(value);
}
