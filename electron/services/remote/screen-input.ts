import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { keyAction } from './keysyms';
import type { ScreenInput } from './rfb-server';

/**
 * Presses keys and moves the mouse on Windows for a linked computer's viewer, with SendInput, through Windows
 * PowerShell (part of every Windows install): its Add-Type compiles this small C# loop, so Trace needs no native module.
 * Lines on stdin: `m <x> <y> <flags> <data>` (x, y 0–65535 across the main display), `k <vk> <down> <extended>`, and
 * `c <code point> <down>` (a character: its key on this layout, else typed as Unicode).
 */
const HELPER = String.raw`
using System; using System.Runtime.InteropServices;
public static class TraceInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScanW(char ch);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint type);
  static void Send(INPUT input) { SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))); }
  static void Key(ushort vk, bool down, bool extended) { var input = new INPUT { type = 1 }; input.u.ki = new KEYBDINPUT { wVk = vk, wScan = (ushort)MapVirtualKeyW(vk, 0), dwFlags = (down ? 0u : 2u) | (extended ? 1u : 0u) }; Send(input); }
  static void Unicode(ushort unit, bool down) { var input = new INPUT { type = 1 }; input.u.ki = new KEYBDINPUT { wScan = unit, dwFlags = 4u | (down ? 0u : 2u) }; Send(input); }
  public static void Run() {
    Console.Out.WriteLine("ready"); Console.Out.Flush(); string line;
    while ((line = Console.In.ReadLine()) != null) {
      var p = line.Split(' ');
      try {
        if (p[0] == "m") { var input = new INPUT { type = 0 }; input.u.mi = new MOUSEINPUT { dx = int.Parse(p[1]), dy = int.Parse(p[2]), dwFlags = uint.Parse(p[3]), mouseData = unchecked((uint)int.Parse(p[4])) }; Send(input); }
        else if (p[0] == "k") Key(ushort.Parse(p[1]), p[2] == "1", p[3] == "1");
        else if (p[0] == "c") {
          var text = char.ConvertFromUtf32(int.Parse(p[1])); bool down = p[2] == "1";
          short scan = text.Length == 1 ? VkKeyScanW(text[0]) : (short)-1;
          if (scan != -1 && (scan & 0xff) != 0xff) Key((ushort)(scan & 0xff), down, false);
          else foreach (char unit in text) Unicode(unit, down);
        }
      } catch (Exception) { }
    }
  }
}`;
const SCRIPT = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition @'\n${HELPER}\n'@; [TraceInput]::Run()`;
/** How the helper is started (exported so a Windows test can check that it compiles). */
export const helperArguments = () => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')];
const MOVE = 0x0001; const ABSOLUTE = 0x8000; const WHEEL = 0x0800; const HWHEEL = 0x1000;
/** VNC button bit → [down flag, up flag]: left, middle, right. */
const BUTTONS: [number, number, number][] = [[1, 0x0002, 0x0004], [2, 0x0020, 0x0040], [4, 0x0008, 0x0010]];

/** The commands for one VNC pointer event, given the buttons held before it (pure, for tests). */
export function pointerCommands(x: number, y: number, buttons: number, before: number, width: number, height: number): string[] {
  const ax = Math.round(x * 65535 / Math.max(1, width - 1)); const ay = Math.round(y * 65535 / Math.max(1, height - 1));
  const commands = [`m ${ax} ${ay} ${MOVE | ABSOLUTE} 0`];
  for (const [bit, down, up] of BUTTONS) if ((buttons & bit) !== (before & bit)) commands.push(`m ${ax} ${ay} ${ABSOLUTE | (buttons & bit ? down : up)} 0`);
  // Wheel "buttons" are pressed and released for each notch; act on the press.
  if (buttons & 8 && !(before & 8)) commands.push(`m 0 0 ${WHEEL} 120`);
  if (buttons & 16 && !(before & 16)) commands.push(`m 0 0 ${WHEEL} -120`);
  if (buttons & 32 && !(before & 32)) commands.push(`m 0 0 ${HWHEEL} -120`);
  if (buttons & 64 && !(before & 64)) commands.push(`m 0 0 ${HWHEEL} 120`);
  return commands;
}
export function keyCommand(keysym: number, down: boolean): string | null {
  const action = keyAction(keysym); if (!action) return null;
  return 'vk' in action ? `k ${action.vk} ${down ? 1 : 0} ${action.extended ? 1 : 0}` : `c ${action.char} ${down ? 1 : 0}`;
}

/**
 * Input for one viewer. Keys still held when the viewer leaves are released, so nothing stays pressed here.
 * Windows refuses input to windows running as administrator (and the sign-in screen) from a normal app.
 */
export class WindowsInput implements ScreenInput {
  private helper: ChildProcessWithoutNullStreams | null = null; private buttons = 0; private held = new Set<number>();
  constructor(private width: number, private height: number, private setClipboard: (text: string) => void, private spawnHelper = () => spawn('powershell.exe', helperArguments(), { windowsHide: true })) {}

  pointer(x: number, y: number, buttons: number) { for (const command of pointerCommands(x, y, buttons, this.buttons, this.width, this.height)) this.send(command); this.buttons = buttons; }
  key(keysym: number, down: boolean) {
    const command = keyCommand(keysym, down); if (!command) return;
    if (down) this.held.add(keysym); else this.held.delete(keysym);
    this.send(command);
  }
  clipboard(text: string) { this.setClipboard(text); }
  close() {
    for (const keysym of this.held) { const command = keyCommand(keysym, false); if (command) this.send(command); } this.held.clear();
    if (this.buttons) this.pointer(0, 0, 0);
    this.helper?.stdin.end(); this.helper = null;
  }
  private send(command: string) {
    if (!this.helper) {
      const helper = this.spawnHelper(); this.helper = helper;
      helper.on('error', () => { if (this.helper === helper) this.helper = null; }); helper.on('exit', () => { if (this.helper === helper) this.helper = null; });
      helper.stdout.resume(); helper.stderr.resume(); helper.stdin.on('error', () => {});
    }
    // Lines written before Add-Type finishes wait in the pipe, in order.
    this.helper.stdin.write(command + '\n');
  }
}
