import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { helperArguments, keyCommand, pointerCommands, WindowsInput } from './screen-input';
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
