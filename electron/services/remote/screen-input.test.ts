import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { helperArguments, keyCommand, pointerCommands } from './screen-input';
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

  it('moves in absolute units across the main display, and presses only buttons that changed', () => {
    expect(pointerCommands(0, 0, 0, 0, 1920, 1080)).toEqual(['m 0 0 32769 0']);
    expect(pointerCommands(1919, 1079, 1, 0, 1920, 1080)).toEqual(['m 65535 65535 32769 0', 'm 65535 65535 32770 0']);
    expect(pointerCommands(10, 10, 0, 1, 1920, 1080).at(-1)).toMatch(/ 32772 0$/);
    expect(pointerCommands(10, 10, 8, 0, 1920, 1080).at(-1)).toBe('m 0 0 2048 120');
    expect(pointerCommands(10, 10, 0, 8, 1920, 1080)).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')('compiles its helper with the PowerShell every Windows has', async () => {
    const helper = spawn('powershell.exe', helperArguments(), { windowsHide: true });
    const ready = await new Promise<string>((resolve) => { let out = ''; helper.stdout.on('data', (data) => { out += data; if (out.includes('ready')) resolve(out); }); helper.on('exit', () => resolve(out)); });
    helper.stdin.end(); expect(ready).toContain('ready');
  }, 30000);
});
