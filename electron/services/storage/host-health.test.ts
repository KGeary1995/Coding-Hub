import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gpuCrashWindows, HostHealth } from './host-health';
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
