import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gpuCrashWindows, HostHealth, MainStalls, pruneCrashDumps, STALL_LIMIT, type LoopDelay, type StallRecord } from './host-health';
import type { HostHealthReport } from '../../../shared/workbench';
import { webLink, windowHealthSchema } from '../../../shared/schemas';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
function root(){const value=fs.mkdtempSync(path.join(os.tmpdir(),'hub-health-'));roots.push(value);return value;}
it('records an unclean preceding run and distinguishes a clean shutdown across restart',()=>{
 const directory=root();const first=new HostHealth(directory);first.record('cli-started','claude');expect(first.report().previousShutdown).toBe('unknown');
 const afterCrash=new HostHealth(directory);expect(afterCrash.report().previousShutdown).toBe('unclean');afterCrash.record('renderer-process-gone','crashed',-1);afterCrash.close();
 const clean=new HostHealth(directory);expect(clean.report().previousShutdown).toBe('clean');expect(clean.report().events.some(event=>event.reason==='crashed')).toBe(true);clean.close();
});
it('bounds records and does not let an unwritable health store abort sessions',()=>{
 const directory=root();const health=new HostHealth(directory);for(let i=0;i<130;i++)health.record('cli-exited',null,i);expect(health.report().events).toHaveLength(100);
 fs.writeFileSync(path.join(directory,'blocked'),'file');expect(()=>new HostHealth(path.join(directory,'blocked')).record('cli-started','claude')).not.toThrow();
});
it('says each window state when the GPU process crashed, in a reason short enough to keep', () => {
  const win = (visible: boolean, minimized: boolean, focused: boolean) => ({ isVisible: () => visible, isMinimized: () => minimized, isFocused: () => focused });
  expect(gpuCrashWindows([win(true, false, true), win(true, true, false), win(false, false, false)])).toBe('w1 visible focused; w2 minimized; w3 hidden');
  expect(gpuCrashWindows([])).toBe('no windows');
  const many = gpuCrashWindows(Array.from({ length: 20 }, () => win(true, false, false))); expect(many.length).toBe(120); expect(many.endsWith('...')).toBe(true);
  const directory = root(); const health = new HostHealth(directory); health.record('gpu-crash-windows', many); expect(health.report().events.at(-1)).toMatchObject({ event: 'gpu-crash-windows', reason: many });
});
it('records at most ten of the window\'s own reports a minute, in the stall list, so they cannot push the host\'s events out', () => {
  const health = new HostHealth(root()); const start = Date.now();
  const kept = Array.from({ length: 25 }, (_, index) => health.recordFromWindow('context-lost', null, null, start + index)).filter(Boolean).length;
  expect(kept).toBe(10); expect(health.report().stalls.filter((stall) => stall.kind === 'context-lost')).toHaveLength(10);
  expect(health.report().events.map((event) => event.event)).toEqual(['host-start']);
  expect(health.recordFromWindow('stall', 1200, 'visible', start + 61000)).toBe(true);
  expect(health.report().stalls.at(-1)).toMatchObject({ side: 'window', kind: 'stall', ms: 1200, job: 'visible' });
  expect(windowHealthSchema.safeParse({ kind: 'context-lost' }).success).toBe(true);
  expect(windowHealthSchema.safeParse({ kind: 'stall', ms: 1200, detail: 'terminal write' }).success).toBe(true);
  for (const bad of [{ kind: 'other' }, { kind: 'stall', ms: -1 }, { kind: 'stall', ms: 1.5 }, { kind: 'stall', detail: '<script>' }, { kind: 'stall', detail: 'x'.repeat(61) }, { kind: 'stall', extra: 1 }]) expect(windowHealthSchema.safeParse(bad).success).toBe(false);
});
it('does not record a window "stall" over a minute, which is the computer sleeping', () => {
  const health = new HostHealth(root());
  expect(health.recordFromWindow('stall', 600_000, 'visible')).toBe(false); expect(health.recordFromWindow('long-task', 600_000, 'self')).toBe(true);
  expect(health.report().stalls.map((stall) => stall.kind)).toEqual(['long-task']);
});
describe('the stall record', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('keeps the last 200 stalls apart from the 100 lifecycle events, so channel starts cannot push them out', () => {
    const directory = root(); const health = new HostHealth(directory);
    health.stall('gpu', 'gpu-gone', null, 'crashed'); for (let i = 0; i < 150; i++) health.record('cli-started', 'claude');
    expect(health.report().events).toHaveLength(100); expect(health.report().stalls).toEqual([expect.objectContaining({ side: 'gpu', kind: 'gpu-gone', job: 'crashed' })]);
    for (let i = 0; i < 250; i++) health.stall('main', 'main-stall', 300 + i, 'workbench usage-today');
    expect(health.report().stalls).toHaveLength(STALL_LIMIT); expect(health.report().stalls.at(-1)?.ms).toBe(549); health.close();
    // Kept across a restart, with the lifecycle events.
    expect(new HostHealth(directory).report().stalls).toHaveLength(STALL_LIMIT);
  });
  it('writes stalls a second later, together, never while recording them', () => {
    vi.useFakeTimers(); const directory = root(); const health = new HostHealth(directory); const file = path.join(directory, 'host-health.json');
    const saved = () => (JSON.parse(fs.readFileSync(file, 'utf8')) as { stalls?: unknown[] }).stalls ?? [];
    health.stall('main', 'main-stall', 1800, 'after hub-tick'); health.stall('main', 'main-stall', 400, null);
    expect(saved()).toHaveLength(0);
    vi.advanceTimersByTime(1000); expect(saved()).toHaveLength(2);
    // A lifecycle event writes everything at once, and the pending write is dropped.
    health.stall('window', 'long-task', 300, null); health.record('cli-started', 'codex'); expect(saved()).toHaveLength(3);
  });
  it('reaches the window with the shared report type, field for field', () => {
    expectTypeOf<NonNullable<HostHealthReport['stalls']>[number]>().toEqualTypeOf<StallRecord>();
    const shared: HostHealthReport = new HostHealth(root()).report(); expect(shared.stalls).toEqual([]);
  });
  it('refuses entries that are too long or negative instead of storing them', () => {
    const health = new HostHealth(root()); health.stall('main', 'main-stall', -5, null); health.stall('main', 'x'.repeat(41), 300, null); health.stall('main', 'main-stall', 300, 'y'.repeat(81));
    expect(health.report().stalls).toHaveLength(0);
  });
  it('names the job that took most of a main-process stall, or the last one before it', () => {
    let clock = 0; const stalls = new MainStalls(() => clock); const found: [number, string | null][] = []; const report = (ms: number, job: string | null) => found.push([ms, job]);
    stalls.sample(1000, report); expect(found).toEqual([[1000, null]]);
    stalls.timed('workbench usage-today', () => { clock += 900; }); stalls.timed('hub-tick', () => { clock += 5; });
    stalls.sample(1200, report); expect(found.at(-1)).toEqual([1200, 'workbench usage-today 900 ms']);
    // The longest job is per sample; a stall with no long job names the last one that ran.
    stalls.sample(2000, report); expect(found.at(-1)).toEqual([2000, 'after hub-tick']);
    // Under 250 ms is no stall, and minutes are a computer that slept.
    stalls.sample(249, report); stalls.sample(120000, report); stalls.sample(Number.NaN, report); expect(found).toHaveLength(3);
    // A job that throws is still timed, and its error reaches the caller.
    expect(() => stalls.timed('start-session', () => { clock += 600; throw new Error('x'); })).toThrow('x');
    stalls.sample(700, report); expect(found.at(-1)).toEqual([700, 'start-session 600 ms']);
  });
  it('samples the event loop about once a second, and drops what was measured across a sleep', () => {
    vi.useFakeTimers(); const delays = [10, 300, 1500, 900]; let stopped = false;
    const delay: LoopDelay = { read: () => delays.shift() ?? 0, stop: () => { stopped = true; } };
    const stalls = new MainStalls(); const found: number[] = []; stalls.start((ms) => found.push(ms), delay);
    vi.advanceTimersByTime(2000); expect(found).toEqual([300]);
    // The 1500 ms read across the sleep is dropped; the next second is measured again.
    stalls.skip(); vi.advanceTimersByTime(1000); expect(found).toEqual([300, 900]);
    stalls.stop(); expect(stopped).toBe(true); vi.advanceTimersByTime(5000); expect(found).toEqual([300, 900]);
  });
});
it('removes only crash dumps older than two weeks, from every Crashpad folder', async () => {
  const directory = root(); const now = Date.now(); const day = 86_400_000;
  const dump = (folder: string, name: string, age: number) => { fs.mkdirSync(path.join(directory, folder), { recursive: true }); const file = path.join(directory, folder, name); fs.writeFileSync(file, 'x'); const at = new Date(now - age); fs.utimesSync(file, at, at); return file; };
  const old = [dump('reports', 'a.dmp', 20 * day), dump('completed', 'b.dmp', 15 * day)]; const fresh = [dump('reports', 'c.dmp', day), dump('pending', 'd.dmp', 13 * day), dump('other', 'e.dmp', 30 * day)];
  expect(await pruneCrashDumps(directory, 14, now)).toBe(2);
  for (const file of old) expect(fs.existsSync(file)).toBe(false);
  for (const file of fresh) expect(fs.existsSync(file)).toBe(true);
  expect(await pruneCrashDumps(path.join(directory, 'missing'), 14, now)).toBe(0);
});
it('opens only web links from a chat: http and https, never javascript:, file: or text that is no address', () => {
  expect(webLink('https://example.com/a?b=1')).toEqual({ href: 'https://example.com/a?b=1' });
  expect(webLink('http://localhost:3000')).toEqual({ href: 'http://localhost:3000/' });
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'vscode://file/x', 'data:text/html,hi']) expect(webLink(url)).toEqual({ refused: 'scheme' });
  for (const url of ['not a link', '', '//example.com']) expect(webLink(url)).toEqual({ refused: 'invalid' });
});
