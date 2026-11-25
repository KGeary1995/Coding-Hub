import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { app } from 'electron';
import { HubError } from '../cli/engine-adapter';
import { save } from '../workbench/local-store';
import { INPUT_HELPER_FOLDER, inputPipeName, inputPipePath, SCREEN_INPUT_PORT, SCREEN_SERVICE_PATH, SCREEN_SERVICE_PORT, type ScreenShareStatus } from '../../../shared/screen';
import { localScreenToken, SHARE_FILE, shareSetting } from './screen-service-server';
import type { RunTailscale } from './tailscale';

/** The name of the sign-in entry (Settings → Apps → Startup lists it). */
const LOGIN_NAME = 'Trace screen sharing';
/** The scheduled task that starts the service's administrator side at sign-in (Task Scheduler lists it). */
export const TASK_NAME = 'Trace screen sharing (administrator)';
/** How often Trace, while open, checks that the service it shares the screen with is still running. */
const WATCH_MS = 60_000;
/** How long a service that is no longer wanted may take to see the switch and quit (it looks every 3 s). */
const GIVE_WAY_MS = 8000;

/** Runs a program; resolves with its exit code and what it wrote (for tests, a stand-in). */
export type RunProgram = (file: string, args: string[]) => Promise<{ code: number; output: string }>;
const runProgram: RunProgram = (file, args) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}` })));

/** A PowerShell single-quoted string. */
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
/**
 * One Windows command line from arguments, each in double quotes (paths may have spaces; none has quotes). Backslashes
 * right before the closing quote are doubled, as Windows reads arguments: `"D:\"` would escape the quote and run into the
 * next argument, so a data folder at a drive root lost --elevated.
 */
export const commandLine = (args: string[]) => args.map((arg) => `"${arg.replace(/"/g, '').replace(/(\\+)$/, '$1$1')}"`).join(' ');
const encode = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

/** Where the protected helper is copied, and its process ended, as PowerShell lines (Program Files: administrators only). */
const HELPER_PLACE = [`$folder = Join-Path $env:ProgramFiles ${quote(INPUT_HELPER_FOLDER)}`, "$target = Join-Path $folder 'trace-input.exe'"];
const STOP_HELPER = "Get-Process -Name 'trace-input' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target } | Stop-Process -Force -ErrorAction SilentlyContinue";
/**
 * The script that registers the task, run as administrator: at sign-in of this Windows user, with their highest rights,
 * only while they are signed in (it needs their desktop), never stopped for running long, started again if it fails.
 * The task runs the protected helper (native/trace-input.c, from 1.46), not Trace: it is copied from this Trace into
 * Program Files\Trace Input, a folder only administrators and SYSTEM may change, and checked against the SHA-256 Trace
 * measured before asking Windows' permission, so a file swapped in between is not set up. Trace's updates never touch it.
 */
export function registerTaskScript(helper: string, sha256: string, user: string) {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...HELPER_PLACE,
    'New-Item -ItemType Directory -Force -Path $folder | Out-Null',
    // Administrators and SYSTEM may change it; users may read and run it, and nothing is inherited from above.
    "& icacls.exe $folder /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw 'The helper folder could not be protected.' }",
    `Stop-ScheduledTask -TaskName ${quote(TASK_NAME)} -ErrorAction SilentlyContinue`, STOP_HELPER,
    `Copy-Item -LiteralPath ${quote(helper)} -Destination $target -Force`,
    `if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne ${quote(sha256.toUpperCase())}) { Remove-Item -LiteralPath $target -Force; throw 'The helper changed before it could be copied, so nothing was set up.' }`,
    `$action = New-ScheduledTaskAction -Execute $target -Argument ${quote(inputPipeName(user.split('\\').pop() ?? user))}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${quote(user)}`,
    `$principal = New-ScheduledTaskPrincipal -UserId ${quote(user)} -LogonType Interactive -RunLevel Highest`,
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    `Register-ScheduledTask -TaskName ${quote(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
  ].join('\n');
}
/** Removes the task, ends the helper and deletes its folder (and a task from before 1.46, which ran Trace itself). */
export const removeTaskScript = () => ["$ErrorActionPreference = 'Stop'", `Unregister-ScheduledTask -TaskName ${quote(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`, ...HELPER_PLACE, STOP_HELPER, 'Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue'].join('\n');
/** The helper this Trace ships (dist-electron/native, built by scripts/build-jobs-helper.cjs) and its SHA-256, or null. */
export function shippedHelper(appPath: string): { file: string; sha256: string } | null {
  const file = path.join(appPath, 'dist-electron', 'native', 'trace-input.exe');
  try { return { file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }; } catch { return null; }
}
/** Whether the protected helper's pipe answers (it accepts and closes at once; nothing is sent). */
export function pipeAnswers(pipe: string, wait = 1500) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(pipe); const timer = setTimeout(() => { socket.destroy(); resolve(false); }, wait);
    socket.on('connect', () => { clearTimeout(timer); socket.end(); resolve(true); }); socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}
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
 * With **Also control apps running as administrator**, a scheduled task also starts the service's administrator side
 * (input-relay.ts: Windows lets only a program running as administrator control those apps), which presses the keys
 * and moves the mouse for the service; registering and removing the task asks Windows' permission once each, and
 * starting it does not. Up to 1.28.0 the task ran the whole service as administrator, which Windows refuses the screen
 * capture, so nothing could be viewed with the option on.
 */
export class ScreenShare {
  /** `outdated`: whether a service that reports this version (none, before 1.27) is not this Trace's. Only an installed Trace says so: a source run beside it must not replace its service. */
  constructor(private root: string, private name: () => string, private runTailscale: RunTailscale, private port = SCREEN_SERVICE_PORT, private run: RunProgram = runProgram, private outdated: (version: string | undefined) => boolean = (version) => app.isPackaged && version !== app.getVersion(), private inputPort = SCREEN_INPUT_PORT) {}
  /** Why the service could not capture the screen when last asked (`verify`); told once per reason through `onProblem`. */
  private problem: string | null = null; onProblem: (message: string) => void = () => {};
  /** Versions of a service already replaced once, so one that comes back the same is not ended every minute. */
  private replaced = new Set<string>();
  get supported() { return process.platform === 'win32'; }

  async status(): Promise<ScreenShareStatus> {
    const setting = shareSetting(this.root);
    return { supported: this.supported, enabled: this.supported && setting.enabled, elevated: this.supported && setting.elevated === true, running: this.supported && await this.running(), problem: this.supported && setting.enabled ? this.problem : null };
  }

  /** `elevated` left out keeps what it was. */
  async set(enabled: boolean, elevated?: boolean): Promise<ScreenShareStatus> {
    if (!this.supported) throw new HubError('SCREEN_UNSUPPORTED', 'Trace shares the screen on Windows. On a Mac, turn on System Settings → General → Sharing → Screen Sharing instead.');
    const before = shareSetting(this.root); const admin = elevated ?? before.elevated === true;
    if (enabled) await this.serve();
    // The task first: if Windows' permission is refused, nothing else changes.
    if (admin !== (before.elevated === true)) {
      let script = removeTaskScript();
      if (admin) { const helper = this.helper(); if (!helper) throw new HubError('SCREEN_HELPER', 'This copy of Trace has no administrator helper (it was built without the Windows C++ build tools), so apps running as administrator cannot be controlled.'); script = registerTaskScript(helper.file, helper.sha256, this.user()); }
      await this.elevate(script, admin);
    }
    save(this.root, SHARE_FILE, { enabled, ...(admin ? { elevated: true } : {}) }); this.login(enabled);
    // An administrator service from before 1.28.1 holds the screen port: with its option off it quits by itself, and the ordinary one can start.
    if (enabled) { if (!admin && before.elevated === true && this.outdated((await this.health())?.version)) await this.gone(); await this.start(); }
    else await this.runTailscale(['serve', '--https=443', `--set-path=${SCREEN_SERVICE_PATH}`, 'off']).catch(() => {});
    // Turned on, or the administrator option changed: does it capture, and is the administrator side there?
    await this.verify();
    return this.status();
  }

  /** When Trace starts: the service runs again (an update closes it), and the Tailscale path is put back if it went. */
  async ensure() {
    const setting = shareSetting(this.root); if (!this.supported || !setting.enabled) return;
    this.login(true); await this.serve().catch(() => {}); await this.start(); await this.verify();
  }

  /**
   * Asks the running service to capture the screen once (nobody is shown as watching) and keeps why it could not. A
   * service from before 1.27 has no such check: nothing is known, and nothing is reported. With the administrator
   * option on, a screen that is captured but whose administrator side is not running is a problem too.
   */
  async verify(): Promise<string | null> {
    const setting = shareSetting(this.root); const token = localScreenToken(this.root); if (!this.supported || !setting.enabled || !token) return this.problem = null;
    const answer = await new Promise<{ ok?: unknown; error?: unknown } | null>((resolve) => {
      const request = http.request({ host: '127.0.0.1', port: this.port, path: '/check', method: 'POST', timeout: 30000, headers: { Authorization: `Bearer ${token}` } }, (response) => {
        let body = ''; response.setEncoding('utf8'); response.on('data', (chunk: string) => { if (body.length < 4096) body += chunk; });
        response.on('end', () => { if (response.statusCode !== 200) { resolve(null); return; } try { resolve(JSON.parse(body) as { ok?: unknown; error?: unknown }); } catch { resolve(null); } });
      });
      request.on('error', () => resolve(null)); request.on('timeout', () => { request.destroy(); resolve(null); }); request.end();
    });
    const before = this.problem;
    this.problem = answer && answer.ok === false ? `This computer’s screen cannot be shared: ${typeof answer.error === 'string' && answer.error ? answer.error.slice(0, 300) : 'the screen could not be captured'}. Turn “Share this screen” off and on again under Settings → Other computers.`
      : setting.elevated && !(await this.pipeAnswers(this.pipe)) ? (await this.health(this.inputPort)
        // A task from before 1.46 runs Trace itself as administrator, from files this account can change: still working, but replaced once the option is set up again.
        ? 'Apps running as administrator are controlled through an older part of Trace that runs from files your account can change. Turn “Also control apps running as administrator” off and on again under Settings → Other computers to use the protected helper instead.'
        : 'This computer’s screen is shared, but apps running as administrator cannot be controlled: the part of Trace that runs as administrator is not running. Turn “Also control apps running as administrator” off and on again under Settings → Other computers.') : null;
    if (this.problem && this.problem !== before) try { this.onProblem(this.problem); } catch { /* Telling the person must not stop the check. */ }
    return this.problem;
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

  /** The service's answer to /health (`version` from 1.27), or its administrator side's, or null when none answers. */
  private health(port = this.port) {
    return new Promise<{ version?: string } | null>((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (response) => {
        let body = ''; response.setEncoding('utf8'); response.on('data', (chunk: string) => { if (body.length < 4096) body += chunk; });
        response.on('end', () => { if (response.statusCode !== 200) { resolve(null); return; } try { const version = (JSON.parse(body) as { version?: unknown }).version; resolve(typeof version === 'string' ? { version } : {}); } catch { resolve({}); } });
      });
      request.on('error', () => resolve(null)); request.on('timeout', () => { request.destroy(); resolve(null); });
    });
  }
  private async running() { return (await this.health()) !== null; }
  /** Waits for whatever answers on a port to quit (it saw the switch, or its task was ended). */
  private async gone(port = this.port) { for (let waited = 0; waited < GIVE_WAY_MS && await this.health(port); waited += 250) await new Promise((resolve) => setTimeout(resolve, 250)); }
  private async start() {
    const elevated = shareSetting(this.root).elevated === true; const health = await this.health();
    // A service from another version of Trace: an update replaced Trace's files under it, and it can no longer capture
    // the screen though it still answers. The ordinary one is closed by the update, and from 1.27 makes way by itself.
    // One started by the task (up to 1.28.0 the whole service ran as administrator, on this port) is not closed by an
    // update: its task is ended (this user may end their own task without Windows asking), once for each version.
    if (health && elevated && this.outdated(health.version) && !this.replaced.has(health.version ?? '')) { this.replaced.add(health.version ?? ''); await this.run('schtasks.exe', ['/End', '/TN', TASK_NAME]); await this.gone(); }
    if (!(health && await this.running())) {
      spawn(process.execPath, this.args(false), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      for (let i = 0; i < 40 && !(await this.running()); i++) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (elevated) await this.startInput();
  }
  /**
   * The administrator side: its task starts it (no prompt; the task was registered with permission) when it is not
   * answering. One an update left behind is ended first, once for each version, as above.
   */
  private async startInput() {
    // The protected helper (1.46) answers on its pipe: nothing to start.
    if (await this.pipeAnswers(this.pipe)) return;
    const health = await this.health(this.inputPort);
    if (health) {
      const version = `input ${health.version ?? ''}`; if (!this.outdated(health.version) || this.replaced.has(version)) return;
      this.replaced.add(version); await this.run('schtasks.exe', ['/End', '/TN', TASK_NAME]); await this.gone(this.inputPort);
      if (await this.health(this.inputPort)) return;
    }
    const result = await this.run('schtasks.exe', ['/Run', '/TN', TASK_NAME]);
    if (result.code !== 0) throw new HubError('SCREEN_TASK', `The part of Trace that controls apps running as administrator could not be started (${result.output.trim() || `schtasks ${result.code}`}). Turn “Also control apps running as administrator” off and on again.`);
    for (let i = 0; i < 40 && !(await this.pipeAnswers(this.pipe, 250)) && !(await this.health(this.inputPort)); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  /** The protected helper's pipe for this Windows user, and how it is asked (a stand-in for tests). */
  pipe = inputPipePath(os.userInfo().username); pipeAnswers = pipeAnswers;
  /** The helper this Trace ships, set up in Program Files when the option is turned on (a stand-in for tests). */
  helper = () => shippedHelper(app.getAppPath());
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
  /** The sign-in entry starts the service; the task starts its administrator side beside it. */
  private login(enabled: boolean) { app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: this.args(false), name: LOGIN_NAME }); }
  private async serve() {
    try { await this.runTailscale(['serve', '--bg', '--https=443', `--set-path=${SCREEN_SERVICE_PATH}`, `http://127.0.0.1:${this.port}`]); }
    catch (error) { throw new HubError('SCREEN_TAILSCALE', `Tailscale could not pass the screen on (${(error as Error).message}). Set up Phone access with Tailscale HTTPS above first.`); }
  }
}
