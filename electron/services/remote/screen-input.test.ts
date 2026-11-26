import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { helperArguments, keyCommand, pipeHelper, pointerCommands, WindowsInput } from './screen-input';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { keyAction } from './keysyms';

describe('input from a viewer of the Windows screen', () => {
  it('maps keysyms to keys, and characters to whatever key types them', () => {
    expect(keyAction(0xff0d)).toEqual({ vk: 0x0d }); expect(keyAction(0xff51)).toEqual({ vk: 0x25, extended: true });
    expect(keyAction(0xffe3)).toEqual({ vk: 0xa2 }); expect(keyAction(0xffc9)).toEqual({ vk: 0x7b });
    expect(keyAction(0x61)).toEqual({ char: 0x61 }); expect(keyAction(0x010020ac)).toEqual({ char: 0x20ac });
    // A Mac viewer's Option keys.
    expect(keyAction(0xff7e)).toEqual({ vk: 0xa4 }); expect(keyAction(0x12345)).toBeNull();
    expect(keyCommand(0x61, true)).toBe('c 97 1'); expect(keyCommand(0xffff, false)).toBe('k 46 0 1');
  });

  it('moves in absolute units across every display, and presses only buttons that changed', () => {
    expect(pointerCommands(0, 0, 0, 0, 1920, 1080)).toEqual(['m 0 0 49153 0']);
    expect(pointerCommands(1919, 1079, 1, 0, 1920, 1080)).toEqual(['m 65535 65535 49153 0', 'm 65535 65535 49154 0']);
    expect(pointerCommands(10, 10, 0, 1, 1920, 1080).at(-1)).toMatch(/ 49156 0$/);
    expect(pointerCommands(10, 10, 8, 0, 1920, 1080).at(-1)).toBe('m 0 0 2048 120');
    expect(pointerCommands(10, 10, 0, 8, 1920, 1080)).toHaveLength(1);
  });

  it('starts its helper with the viewer, ends it on close without any input, and starts it again after it exits', () => {
    const helpers: (EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough })[] = [];
    const spawnHelper = () => { const helper = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }); helpers.push(helper); return helper as unknown as ChildProcessWithoutNullStreams; };
    const idle = new WindowsInput(1920, 1080, () => {}, spawnHelper); expect(helpers).toHaveLength(1);
    idle.close(); expect(helpers[0].stdin.writableEnded).toBe(true);
    const busy = new WindowsInput(1920, 1080, () => {}, spawnHelper); expect(helpers).toHaveLength(2);
    busy.key(0x61, true); expect(helpers).toHaveLength(2);
    helpers[1].emit('exit', 1); busy.key(0x61, false); expect(helpers).toHaveLength(3);
    busy.close();
  });

  it.runIf(process.platform === 'win32')('compiles its helper with the PowerShell every Windows has', async () => {
    const helper = spawn('powershell.exe', helperArguments(), { windowsHide: true });
    const ready = await new Promise<string>((resolve) => { let out = ''; helper.stdout.on('data', (data) => { out += data; if (out.includes('ready')) resolve(out); }); helper.on('exit', () => resolve(out)); });
    helper.stdin.end(); expect(ready).toContain('ready');
  }, 30000);
});

describe('the protected helper\'s pipe (1.46)', () => {
  // A Unix socket here stands in for Windows' named pipe: Node connects to both the same way.
  const place = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-')); return { dir, pipe: process.platform === 'win32' ? `\\\\.\\pipe\\trace-input-test-${process.pid}` : path.join(dir, 'p.sock') }; };
  it('sends the lines written while it connects, in order, and reports the end of the connection as an exit', async () => {
    const { dir, pipe } = place(); let got = ''; const server = net.createServer((socket) => { socket.on('data', (data) => { got += data.toString(); }); socket.on('end', () => socket.end()); });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    const fallback = { pressed: [] as string[] }; let exited = false;
    const helper = pipeHelper(pipe, () => { throw new Error('the fallback is not used while the pipe answers'); });
    helper.on('exit', () => { exited = true; }); helper.stdin.write('k 13 1 0\n'); helper.stdin.write('k 13 0 0\n');
    await new Promise((resolve) => setTimeout(resolve, 200)); helper.stdin.end(); await new Promise((resolve) => setTimeout(resolve, 200));
    expect(got).toBe('k 13 1 0\nk 13 0 0\n'); expect(exited).toBe(true); expect(fallback.pressed).toEqual([]);
    await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true });
  });
  it('presses through the fallback when no helper listens', async () => {
    const { dir, pipe } = place(); const written: string[] = [];
    const fake = Object.assign(new EventEmitter(), { stdin: Object.assign(new PassThrough(), { write: (line: string) => { written.push(line); return true; } }), stdout: new PassThrough(), stderr: new PassThrough() });
    const helper = pipeHelper(pipe, () => fake as never); helper.stdin.write('c 65 1\n');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(written).toEqual(['c 65 1\n']); fs.rmSync(dir, { recursive: true, force: true });
  });
});
