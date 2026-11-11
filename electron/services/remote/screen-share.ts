import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import { app } from 'electron';
import { HubError } from '../cli/engine-adapter';
import { save } from '../workbench/local-store';
import { SCREEN_SERVICE_PATH, SCREEN_SERVICE_PORT, type ScreenShareStatus } from '../../../shared/screen';
import { SHARE_FILE, shareSetting } from './screen-service-server';
import type { RunTailscale } from './tailscale';

/** The name of the sign-in entry (Settings → Apps → Startup lists it). */
const LOGIN_NAME = 'Trace screen sharing';
/** The scheduled task that starts the service as administrator at sign-in (Task Scheduler lists it). */
export const TASK_NAME = 'Trace screen sharing (administrator)';
/** How often Trace, while open, checks that the service it shares the screen with is still running. */
const WATCH_MS = 60_000;
/** How long a service of the other kind (administrator or not) may take to see the switch and quit (it looks every 3 s). */
const GIVE_WAY_MS = 8000;

/** Runs a program; resolves with its exit code and what it wrote (for tests, a stand-in). */
export type RunProgram = (file: string, args: string[]) => Promise<{ code: number; output: string }>;
const runProgram: RunProgram = (file, args) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}` })));

/** A PowerShell single-quoted string. */
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
/** One Windows command line from arguments, each in double quotes (paths may have spaces; none has quotes). */
export const commandLine = (args: string[]) => args.map((arg) => `"${arg.replace(/"/g, '')}"`).join(' ');
const encode = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

/**
 * The script that registers the task, run as administrator: at sign-in of this Windows user, with their highest rights,
 * only while they are signed in (it needs their desktop), never stopped for running long, started again if it fails.
 */
export function registerTaskScript(executable: string, args: string[], user: string) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${quote(executable)} -Argument ${quote(commandLine(args))}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${quote(user)}`,
    `$principal = New-ScheduledTaskPrincipal -UserId ${quote(user)} -LogonType Interactive -RunLevel Highest`,
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    `Register-ScheduledTask -TaskName ${quote(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
  ].join('\n');
}
export const removeTaskScript = () => `$ErrorActionPreference = 'Stop'\nUnregister-ScheduledTask -TaskName ${quote(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`;
/** Runs a script as administrator: Windows asks the person first. Its exit code comes back; a refusal fails. */
export function elevatedScript(script: string) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${quote(encode(script))}`,
    'exit $process.ExitCode',
  ].join('\n');
}

/**
 * Settings → Other computers → Share this screen, on Windows: starts the screen service (Trace with --screen-service),
 * registers it to start at sign-in, and has `tailscale serve` pass https://<name>.ts.net/api/screen to it. Off undoes
 * all three (the service sees the switch and quits).
 * With **Also control apps running as administrator**, a scheduled task starts it as administrator instead (Windows
 * lets only a program running as administrator control those); registering and removing the task asks Windows'
 * permission once each, and starting it does not.
 */
export class ScreenShare {
  constructor(private root: string, private name: () => string, private runTailscale: RunTailscale, private port = SCREEN_SERVICE_PORT, private run: RunProgram = runProgram) {}
  get supported() { return process.platform === 'win32'; }

  async status(): Promise<ScreenShareStatus> {
    const setting = shareSetting(this.root);
    return { supported: this.supported, enabled: this.supported && setting.enabled, elevated: this.supported && setting.elevated === true, running: this.supported && await this.running() };
  }

  /** `elevated` left out keeps what it was. */
  async set(enabled: boolean, elevated?: boolean): Promise<ScreenShareStatus> {
    if (!this.supported) throw new HubError('SCREEN_UNSUPPORTED', 'Trace shares the screen on Windows. On a Mac, turn on System Settings → General → Sharing → Screen Sharing instead.');
    const before = shareSetting(this.root); const admin = elevated ?? before.elevated === true;
    if (enabled) await this.serve();
    // The task first: if Windows' permission is refused, nothing else changes.
    if (admin !== (before.elevated === true)) await this.elevate(admin ? registerTaskScript(process.execPath, this.args(true), this.user()) : removeTaskScript(), admin);
    save(this.root, SHARE_FILE, { enabled, ...(admin ? { elevated: true } : {}) }); this.login(enabled && !admin);
    if (enabled) { if (admin !== (before.elevated === true)) await this.gone(); await this.start(); }
    else await this.runTailscale(['serve', '--https=443', `--set-path=${SCREEN_SERVICE_PATH}`, 'off']).catch(() => {});
    return this.status();
  }

  /** When Trace starts: the service runs again (an update closes it), and the Tailscale path is put back if it went. */
  async ensure() {
    const setting = shareSetting(this.root); if (!this.supported || !setting.enabled) return;
    this.login(!setting.elevated); await this.serve().catch(() => {}); await this.start();
  }

  /**
   * While Trace is open: starts the service again if it has gone (a crash it could not restart itself from, or someone
   * ended it), so sharing that is on stays on. Returns a function that stops watching.
   */
  watch(every = WATCH_MS) {
    let checking = false;
    const timer = setInterval(() => {
      if (checking || !this.supported || !shareSetting(this.root).enabled) return; checking = true;
      void this.start().catch(() => {}).finally(() => { checking = false; });
    }, every);
    timer.unref?.(); return () => clearInterval(timer);
  }

  private running() {
    return new Promise<boolean>((resolve) => {
      const request = http.get({ host: '127.0.0.1', port: this.port, path: '/health', timeout: 1500 }, (response) => { response.resume(); resolve(response.statusCode === 200); });
      request.on('error', () => resolve(false)); request.on('timeout', () => { request.destroy(); resolve(false); });
    });
  }
  /** Waits for a service of the other kind to see the switch and quit. */
  private async gone() { for (let waited = 0; waited < GIVE_WAY_MS && await this.running(); waited += 250) await new Promise((resolve) => setTimeout(resolve, 250)); }
  private async start() {
    if (await this.running()) return;
    // As administrator: the task starts it (no prompt; the task was registered with permission). Otherwise directly.
    if (shareSetting(this.root).elevated) {
      const result = await this.run('schtasks.exe', ['/Run', '/TN', TASK_NAME]);
      if (result.code !== 0) throw new HubError('SCREEN_TASK', `The administrator screen service could not be started (${result.output.trim() || `schtasks ${result.code}`}). Turn “Also control apps running as administrator” off and on again.`);
    } else spawn(process.execPath, this.args(false), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 40 && !(await this.running()); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  private async elevate(script: string, adding: boolean) {
    const result = await this.run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(elevatedScript(script))]);
    if (result.code === 0) return;
    const refused = /cancel/i.test(result.output);
    throw new HubError('SCREEN_ELEVATE', refused
      ? `Windows did not give permission, so ${adding ? 'apps running as administrator still cannot be controlled' : 'the administrator screen service is still set up'}. Try again and choose Yes when Windows asks.`
      : `Windows could not ${adding ? 'set up' : 'remove'} the administrator screen service (${result.output.trim().split('\n').at(-1) || `code ${result.code}`}).`);
  }
  /** This Windows user, as the task names them (DOMAIN\name), so it runs for them even if another account approved it. */
  private user() { const name = os.userInfo().username; return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name; }
  private args(elevated: boolean) { return [...(app.isPackaged ? [] : [app.getAppPath()]), '--screen-service', `--storage=${this.root}`, `--name=${this.name()}`, ...(elevated ? ['--elevated'] : [])]; }
  /** The sign-in entry starts the ordinary service; as administrator, the task does instead. */
  private login(enabled: boolean) { app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: this.args(false), name: LOGIN_NAME }); }
  private async serve() {
    try { await this.runTailscale(['serve', '--bg', '--https=443', `--set-path=${SCREEN_SERVICE_PATH}`, `http://127.0.0.1:${this.port}`]); }
    catch (error) { throw new HubError('SCREEN_TAILSCALE', `Tailscale could not pass the screen on (${(error as Error).message}). Set up Phone access with Tailscale HTTPS above first.`); }
  }
}
