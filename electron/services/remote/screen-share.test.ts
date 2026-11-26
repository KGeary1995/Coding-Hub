import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const login: { openAtLogin: boolean; args: string[] }[] = [];
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '1.27.0', getAppPath: () => '', setLoginItemSettings: (settings: { openAtLogin: boolean; args: string[] }) => login.push(settings) } }));
const { commandLine, elevatedScript, registerTaskScript, removeTaskScript, ScreenShare, TASK_NAME } = await import('./screen-share');
const { SHARE_FILE } = await import('./screen-service-server');

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); login.length = 0; });
const decode = (args: string[]) => Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
const freePort = () => new Promise<number>((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });

const stop = (server: http.Server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
const health = async (port: number, version: string) => {
  const server = http.createServer((_request, response) => { response.writeHead(200); response.end(JSON.stringify(version ? { ok: true, version } : { ok: true })); });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)); cleanup.push(() => stop(server)); return server;
};
/**
 * A ScreenShare on Windows terms, with PowerShell and schtasks stood in for. The ordinary service (a health page) runs,
 * as the sign-in entry starts it; schtasks /Run starts the administrator side (another health page), and /End ends what
 * the task started.
 * `left`: instead, a whole service the task started as administrator, as up to 1.28.0, answering with that version ("" for
 * one from before it told its version); once it is ended the ordinary one starts. `input`: an administrator side already
 * running, of that version.
 */
async function share(options: { refuse?: boolean; left?: string; input?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-share-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = await freePort(); const inputPort = await freePort(); const calls: { file: string; args: string[] }[] = [];
  let whole: http.Server | null = options.left !== undefined ? await health(port, options.left) : null; if (!whole) await health(port, '1.27.0');
  let side: http.Server | null = options.input !== undefined ? await health(inputPort, options.input) : null; let piped = false;
  const run = async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (file === 'powershell.exe' && options.refuse) return { code: 1, output: 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.' };
    if (file === 'schtasks.exe' && args[0] === '/End') { piped = false; if (whole) { await stop(whole); whole = null; await health(port, '1.27.0'); } if (side) { await stop(side); side = null; } }
    // The task runs the protected helper (1.46), which answers on its pipe; a relay on the input port is one set up before it.
    if (file === 'schtasks.exe' && args[0] === '/Run' && !side && !whole) piped = true;
    return { code: 0, output: '' };
  };
  const screen = new ScreenShare(root, () => 'Obsidian-Halo', async () => '', port, run, undefined, inputPort);
  Object.defineProperty(screen, 'supported', { get: () => true });
  screen.pipeAnswers = async () => piped; screen.helper = () => ({ file: 'C:\\Trace\\resources\\app\\dist-electron\\native\\trace-input.exe', sha256: 'ab12' });
  return { screen, root, calls, inputPort, setting: () => JSON.parse(fs.readFileSync(path.join(root, SHARE_FILE), 'utf8')) };
}

describe('sharing the screen as administrator', () => {
  it('asks the service whether it can capture, and says once why it cannot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-share-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const port = await freePort(); const inputPort = await freePort(); let answer: unknown = { ok: false, error: 'Could not start video source' }; const asked: (string | undefined)[] = [];
    const server = http.createServer((request, response) => { if (request.url === '/check') asked.push(request.headers.authorization); response.writeHead(200); response.end(JSON.stringify(request.url === '/check' ? answer : { ok: true, version: '1.27.0' })); });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)); cleanup.push(() => stop(server)); const side = await health(inputPort, '1.27.0');
    fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true, elevated: true })); fs.writeFileSync(path.join(root, 'screen-service-local.json'), JSON.stringify({ token: 't'.repeat(43) }));
    const screen = new ScreenShare(root, () => 'Obsidian-Halo', async () => '', port, async () => ({ code: 0, output: '' }), undefined, inputPort); Object.defineProperty(screen, 'supported', { get: () => true });
    let piped = true; screen.pipeAnswers = async () => piped;
    const told: string[] = []; screen.onProblem = (message) => told.push(message);
    await screen.ensure();
    // Trace's own key is what it asks with. The capture is the ordinary service's, so the reason does not send the person to the administrator option.
    expect(asked).toEqual([`Bearer ${'t'.repeat(43)}`]);
    expect(told).toHaveLength(1); expect(told[0]).toContain('Could not start video source'); expect(told[0]).toContain('Share this screen'); expect(told[0]).not.toContain('administrator');
    expect((await screen.status()).problem).toBe(told[0]);
    // The same reason again is not said again; once it captures, the problem is gone.
    await screen.verify(); expect(told).toHaveLength(1);
    answer = { ok: true }; expect(await screen.verify()).toBeNull(); expect((await screen.status()).problem).toBeNull();
    // Captured, but the administrator side is gone: said too, and it names its option. Without the option it is no problem.
    // Only a relay from before 1.46 answers: it works, but the person is told to set it up again for the protected helper.
    piped = false; expect(await screen.verify()).toContain('older part of Trace'); expect(told).toHaveLength(2);
    await stop(side); expect(await screen.verify()).toContain('apps running as administrator cannot be controlled'); expect(told).toHaveLength(3); expect(told[2]).toContain('Also control apps running as administrator');
    fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true })); expect(await screen.verify()).toBeNull();
  });

  it('replaces what an update left running as administrator, once, and leaves this version\'s alone', async () => {
    // Up to 1.28.0 the task ran the whole service: it is ended, the ordinary one takes its place, and the task is run again for the administrator side.
    for (const left of ['1.24.2', '']) {
      const { screen, root, calls } = await share({ left }); fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true, elevated: true }));
      await screen.ensure();
      // No permission is asked (no PowerShell).
      expect(calls.filter((call) => call.file === 'schtasks.exe').map((call) => call.args[0])).toEqual(['/End', '/Run']); expect(calls.some((call) => call.file === 'powershell.exe')).toBe(false);
      expect((await screen.status()).running).toBe(true); expect((await screen.status()).problem).toBeNull();
      await screen.ensure(); expect(calls.filter((call) => call.file === 'schtasks.exe')).toHaveLength(2);
    }
    // An administrator side of another version, beside this version's service: ended and run again, once.
    const side = await share({ input: '1.24.2' }); fs.writeFileSync(path.join(side.root, SHARE_FILE), JSON.stringify({ enabled: true, elevated: true }));
    await side.screen.ensure(); expect(side.calls.filter((call) => call.file === 'schtasks.exe').map((call) => call.args[0])).toEqual(['/End', '/Run']);
    await side.screen.ensure(); expect(side.calls.filter((call) => call.file === 'schtasks.exe')).toHaveLength(2);
    const current = await share({ input: '1.27.0' }); fs.writeFileSync(path.join(current.root, SHARE_FILE), JSON.stringify({ enabled: true, elevated: true }));
    await current.screen.ensure(); expect(current.calls.filter((call) => call.file === 'schtasks.exe')).toEqual([]);
    // Not there at all (it was ended, or has not started since sign-in): the task is run, nothing is ended.
    const absent = await share(); fs.writeFileSync(path.join(absent.root, SHARE_FILE), JSON.stringify({ enabled: true, elevated: true }));
    await absent.screen.ensure(); expect(absent.calls.filter((call) => call.file === 'schtasks.exe').map((call) => call.args)).toEqual([['/Run', '/TN', TASK_NAME]]);
    // Without the option, the ordinary service is closed by the update itself; Trace has no task to end or run for it.
    const ordinary = await share({ left: '1.24.2' }); fs.writeFileSync(path.join(ordinary.root, SHARE_FILE), JSON.stringify({ enabled: true }));
    await ordinary.screen.ensure(); expect(ordinary.calls.filter((call) => call.file === 'schtasks.exe')).toEqual([]);
  });

  it('registers a task for this user, with their highest rights, never stopped for running long, that runs the protected helper', () => {
    const script = registerTaskScript('C:\\Users\\o\'neil\\AppData\\Local\\Programs\\Trace\\resources\\app\\dist-electron\\native\\trace-input.exe', 'ab12', 'PC\\o\'neil');
    // Copied into Program Files\Trace Input (administrators only), checked against the hash measured before Windows asked, and run from there.
    expect(script).toContain("$folder = Join-Path $env:ProgramFiles 'Trace Input'"); expect(script).toContain("/inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX'");
    expect(script).toContain("Copy-Item -LiteralPath 'C:\\Users\\o''neil\\AppData\\Local\\Programs\\Trace\\resources\\app\\dist-electron\\native\\trace-input.exe' -Destination $target -Force");
    expect(script).toContain("-Algorithm SHA256).Hash -ne 'AB12'"); expect(script.indexOf('Get-FileHash')).toBeLessThan(script.indexOf('Register-ScheduledTask'));
    expect(script).toContain("New-ScheduledTaskAction -Execute $target -Argument 'o_neil'"); expect(script).not.toContain('Trace.exe');
    expect(removeTaskScript()).toContain('Remove-Item -LiteralPath $folder -Recurse -Force');
    expect(script).toContain("-AtLogOn -User 'PC\\o''neil'"); expect(script).toContain('-LogonType Interactive -RunLevel Highest');
    expect(script).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)'); expect(script).toContain('-RestartCount 3');
    expect(script).toContain(`-TaskName '${TASK_NAME}'`); expect(removeTaskScript()).toContain(`Unregister-ScheduledTask -TaskName '${TASK_NAME}'`);
    expect(commandLine(['a b', 'c'])).toBe('"a b" "c"');
    // A data folder at a drive root: its backslash is doubled so it does not escape the closing quote.
    expect(commandLine(['--storage=D:\\', '--elevated'])).toBe('"--storage=D:\\\\" "--elevated"'); expect(commandLine(['C:\\x\\y'])).toBe('"C:\\x\\y"');
    // Run as administrator: Windows asks; the inner script goes encoded, so nothing in it needs quoting again.
    const outer = elevatedScript('Write-Output 1'); expect(outer).toContain('-Verb RunAs'); expect(outer).toContain('exit $process.ExitCode');
    expect(Buffer.from(/'-EncodedCommand','([^']+)'/.exec(outer)![1], 'base64').toString('utf16le')).toBe('Write-Output 1');
  });

  it.runIf(process.platform === 'win32')('builds a command line Windows splits back into the same arguments, even after a drive root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argv-')); cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, 'argv.js'); fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const args = ['--screen-service', '--storage=D:\\', '--name=Obsidian Halo', '--storage=C:\\Users\\a b\\data', '--elevated'];
    // Verbatim: the arguments go to Windows exactly as commandLine wrote them (argv0 without the space in Program Files).
    // spawnSync, whose options type has windowsVerbatimArguments (execFileSync passes it through, but its type omits it).
    const run = spawnSync(process.execPath, [`"${script}"`, commandLine(args)], { encoding: 'utf8', windowsVerbatimArguments: true, argv0: 'node' });
    expect(run.status).toBe(0); expect(JSON.parse(run.stdout)).toEqual(args);
  });
  it.runIf(process.platform === 'win32')('writes scripts PowerShell can read (parsed only, not run)', () => {
    for (const script of [registerTaskScript('C:\\Trace\\resources\\app\\dist-electron\\native\\trace-input.exe', 'ab12', 'PC\\me'), removeTaskScript(), elevatedScript(removeTaskScript())]) {
      const check = `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf16le').toString('base64')}')), [ref]$null, [ref]$errors); $errors.Count`;
      expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8' }).trim()).toBe('0');
    }
  }, 60000);

  it('turning it on registers the task with permission, keeps the sign-in entry for the service, and starts the administrator side through the task', async () => {
    const { screen, calls, setting } = await share();
    const status = await screen.set(true, true);
    expect(status).toMatchObject({ enabled: true, elevated: true, running: true }); expect(setting()).toEqual({ enabled: true, elevated: true });
    const elevate = calls.find((call) => call.file === 'powershell.exe')!; expect(decode(elevate.args)).toContain('-Verb RunAs');
    // The task is set up to run the protected helper, copied from this Trace (1.46), not Trace itself.
    const registered = Buffer.from(/'-EncodedCommand','([^']+)'/.exec(decode(elevate.args))![1], 'base64').toString('utf16le'); expect(registered).toContain('trace-input.exe'); expect(registered).toContain("-Hash -ne 'AB12'".replace('-Hash', 'Hash'));
    // The service itself captures, so it still starts at sign-in; the task starts only the side that presses the keys.
    expect(calls.at(-1)).toEqual({ file: 'schtasks.exe', args: ['/Run', '/TN', TASK_NAME] }); expect(login.at(-1)!.openAtLogin).toBe(true); expect(login.at(-1)!.args).not.toContain('--elevated'); expect(status.problem).toBeNull();
    // Already as administrator: turning sharing off and on again asks nothing more.
    const asked = calls.length; await screen.set(false); await screen.set(true);
    expect(calls.slice(asked).some((call) => call.file === 'powershell.exe')).toBe(false); expect(setting()).toEqual({ enabled: true, elevated: true });
  });

  it('changes nothing when Windows is refused permission, and says so', async () => {
    const { screen, calls, root } = await share({ refuse: true });
    fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true }));
    await expect(screen.set(true, true)).rejects.toThrow(/did not give permission/);
    expect(JSON.parse(fs.readFileSync(path.join(root, SHARE_FILE), 'utf8'))).toEqual({ enabled: true }); expect(calls.some((call) => call.file === 'schtasks.exe')).toBe(false);
  });

  it('turning only the administrator option off, with sharing on, removes the task and the ordinary service takes over', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-share-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true, elevated: true }));
    const port = await freePort(); const calls: { file: string; args: string[] }[] = [];
    const health = () => { const server = http.createServer((_request, response) => { response.writeHead(200); response.end('{}'); }); server.listen(port, '127.0.0.1'); return server; };
    // The administrator service runs; removing its task makes it quit (it sees the setting), and the ordinary one starts.
    let running: http.Server | null = health(); cleanup.push(() => { running?.close(); });
    const run = async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === 'powershell.exe') { running?.close(); running = null; setTimeout(() => { running = health(); }, 300); }
      return { code: 0, output: '' };
    };
    const screen = new ScreenShare(root, () => 'Obsidian-Halo', async () => '', port, run); Object.defineProperty(screen, 'supported', { get: () => true });
    expect(await screen.set(true, false)).toMatchObject({ enabled: true, elevated: false, running: true });
    expect(calls).toHaveLength(1); expect(Buffer.from(/'-EncodedCommand','([^']+)'/.exec(decode(calls[0].args))![1], 'base64').toString('utf16le')).toContain('Unregister-ScheduledTask');
    expect(JSON.parse(fs.readFileSync(path.join(root, SHARE_FILE), 'utf8'))).toEqual({ enabled: true }); expect(login.at(-1)!.openAtLogin).toBe(true);
  }, 20000);
  it('turning it off removes the task with permission and brings back the ordinary sign-in entry', async () => {
    const { screen, calls, root, setting } = await share();
    fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: false, elevated: true }));
    await screen.set(false, false);
    expect(Buffer.from(/'-EncodedCommand','([^']+)'/.exec(decode(calls[0].args))![1], 'base64').toString('utf16le')).toContain('Unregister-ScheduledTask');
    expect(setting()).toEqual({ enabled: false }); expect(login.at(-1)!.openAtLogin).toBe(false);
  });
});
