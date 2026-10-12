import { expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { stopProcess } from './stop-process';
function fixture() { let resolve!: () => void; const exited = new Promise<void>((done) => { resolve = done; }); const pty = { pid: 99999999, kill: vi.fn() } as unknown as IPty; return { pty, exited, resolve }; }
it('terminates Windows descendants before closing the terminal and checks the root actually exited', async () => {
  const { pty, exited, resolve } = fixture(); const order: string[] = []; (pty.kill as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push('pty'); resolve(); });
  await stopProcess(pty, exited, { platform: 'win32', killTree: async (pid) => { expect(pid).toBe(pty.pid); order.push('tree'); }, isAlive: () => false }); expect(order).toEqual(['tree', 'pty']);
});
it('reports Windows kill failure without claiming success or orphaning children via a terminal-first kill', async () => {
  const { pty, exited } = fixture(); await expect(stopProcess(pty, exited, { platform: 'win32', killTree: async () => { throw new Error('Denied'); }, isAlive: () => true })).rejects.toMatchObject({ code: 'STOP_FAILED' }); expect(pty.kill).not.toHaveBeenCalled();
});
it('recovers a missing PTY exit only after verifying the process disappeared; refuses a still-running root', async () => {
  const { pty, exited } = fixture(); expect(await stopProcess(pty, exited, { platform: 'win32', killTree: async () => {}, isAlive: () => false, waitMilliseconds: 1 })).toBe(true);
  await expect(stopProcess(pty, exited, { platform: 'win32', killTree: async () => {}, isAlive: () => true, waitMilliseconds: 1 })).rejects.toMatchObject({ code: 'STOP_FAILED' });
});
it('escalates Unix process groups and refuses invalid or host-owned PIDs', async () => {
  const { pty, exited, resolve } = fixture(); const signals: string[] = []; (pty.kill as ReturnType<typeof vi.fn>).mockImplementation((signal) => { if (signal === 'SIGKILL') resolve(); });
  await stopProcess(pty, exited, { platform: 'linux', signalGroup: (_pid, signal) => { signals.push(signal); }, waitMilliseconds: 1 }); expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  await expect(stopProcess({ ...pty, pid: process.pid } as IPty, exited)).rejects.toMatchObject({ code: 'STOP_FAILED' });
});

it('kills remaining Unix descendants even when the root exits during SIGTERM', async () => {
 const {pty,exited,resolve}=fixture(); const signals:string[]=[];
 await stopProcess(pty,exited,{platform:'linux',signalGroup:(_pid,signal)=>{signals.push(signal);if(signal==='SIGTERM')resolve();},waitMilliseconds:1});
 expect(signals).toEqual(['SIGTERM','SIGKILL']);
});
