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

/** A ScreenShare on Windows terms, with PowerShell and schtasks stood in for: schtasks /Run starts a "service" (a health page). */
/** `left`: a service an update left running, answering with that version ("" for one from before it told its version). */
async function share(options: { refuse?: boolean; left?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-share-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = await freePort(); const calls: { file: string; args: string[] }[] = []; let service: http.Server | null = null;
  const run = async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (file === 'powershell.exe' && options.refuse) return { code: 1, output: 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.' };
    if (file === 'schtasks.exe' && args[0] === '/End' && service) { const ended = service; service = null; await new Promise<void>((resolve) => { ended.close(() => resolve()); ended.closeAllConnections(); }); }
    if (file === 'schtasks.exe' && args[0] === '/Run' && !service) await serve('1.27.0');
    return { code: 0, output: '' };
  };
  const serve = async (version: string) => {
    const started = http.createServer((_request, response) => { response.writeHead(200); response.end(JSON.stringify(version ? { ok: true, version } : { ok: true })); }); service = started;
    await new Promise<void>((resolve) => started.listen(port, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>((resolve) => { started.close(() => resolve()); started.closeAllConnections(); }));
  };
  if (options.left !== undefined) await serve(options.left);
  const screen = new ScreenShare(root, () => 'Obsidian-Halo', async () => '', port, run);
  Object.defineProperty(screen, 'supported', { get: () => true });
  return { screen, root, calls, setting: () => JSON.parse(fs.readFileSync(path.join(root, SHARE_FILE), 'utf8')) };
}

describe('sharing the screen as administrator', () => {
  it('asks the service whether it can capture, and says once why it cannot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-share-')); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const port = await freePort(); let answer: unknown = { ok: false, error: 'Could not start video source' }; const asked: (string | undefined)[] = [];
    const server = http.createServer((request, response) => { if (request.url === '/check') asked.push(request.headers.authorization); response.writeHead(200); response.end(JSON.stringify(request.url === '/check' ? answer : { ok: true, version: '1.27.0' })); });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true, elevated: true })); fs.writeFileSync(path.join(root, 'screen-service-local.json'), JSON.stringify({ token: 't'.repeat(43) }));
    const screen = new ScreenShare(root, () => 'Obsidian-Halo', async () => '', port, async () => ({ code: 0, output: '' })); Object.defineProperty(screen, 'supported', { get: () => true });
    const told: string[] = []; screen.onProblem = (message) => told.push(message);
    await screen.ensure();
    // Trace's own key is what it asks with; the reason names the setting that shares the screen without administrator rights.
    expect(asked).toEqual([`Bearer ${'t'.repeat(43)}`]);
    expect(told).toHaveLength(1); expect(told[0]).toContain('Could not start video source'); expect(told[0]).toContain('Also control apps running as administrator');
    expect((await screen.status()).problem).toBe(told[0]);
    // The same reason again is not said again; once it captures, the problem is gone.
    await screen.verify(); expect(told).toHaveLength(1);
    answer = { ok: true }; expect(await screen.verify()).toBeNull(); expect((await screen.status()).problem).toBeNull();
  });

  it('replaces an administrator service an update left behind, once, and leaves this version\'s alone', async () => {
    for (const left of ['1.24.2', '']) {
      const { screen, root, calls } = await share({ left }); fs.writeFileSync(path.join(root, SHARE_FILE), JSON.stringify({ enabled: true, elevated: true }));
      await screen.ensure();
      // The old one's task is ended and run again; no permission is asked (no PowerShell).
      expect(calls.filter((call) => call.file === 'schtasks.exe').map((call) => call.args[0])).toEqual(['/End', '/Run']); expect(calls.some((call) => call.file === 'powershell.exe')).toBe(false);
      expect((await screen.status()).running).toBe(true);
      await screen.ensure(); expect(calls.filter((call) => call.file === 'schtasks.exe')).toHaveLength(2);
    }
    const current = await share({ left: '1.27.0' }); fs.writeFileSync(path.join(current.root, SHARE_FILE), JSON.stringify({ enabled: true, elevated: true }));
    await current.screen.ensure(); expect(current.calls.filter((call) => call.file === 'schtasks.exe')).toEqual([]);
    // The ordinary service is closed by the update itself; Trace has no task to end for it.
    const ordinary = await share({ left: '1.24.2' }); fs.writeFileSync(path.join(ordinary.root, SHARE_FILE), JSON.stringify({ enabled: true }));
    await ordinary.screen.ensure(); expect(ordinary.calls.filter((call) => call.file === 'schtasks.exe')).toEqual([]);
  });

  it('registers a task for this user, with their highest rights, never stopped for running long', () => {
    const script = registerTaskScript('C:\\Program Files\\Trace\\Trace.exe', ['--screen-service', '--storage=C:\\Users\\o\'neil\\data', '--elevated'], 'PC\\o\'neil');
    expect(script).toContain("-Execute 'C:\\Program Files\\Trace\\Trace.exe'");
    expect(script).toContain(`-Argument '"--screen-service" "--storage=C:\\Users\\o''neil\\data" "--elevated"'`);
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
    for (const script of [registerTaskScript('C:\\Trace\\Trace.exe', ['--screen-service', '--storage=C:\\x y'], 'PC\\me'), removeTaskScript(), elevatedScript(removeTaskScript())]) {
      const check = `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf16le').toString('base64')}')), [ref]$null, [ref]$errors); $errors.Count`;
      expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8' }).trim()).toBe('0');
    }
  }, 60000);

  it('turning it on registers the task with permission, drops the sign-in entry, and starts the service through the task', async () => {
    const { screen, calls, setting } = await share();
    const status = await screen.set(true, true);
    expect(status).toMatchObject({ enabled: true, elevated: true, running: true }); expect(setting()).toEqual({ enabled: true, elevated: true });
    const elevate = calls.find((call) => call.file === 'powershell.exe')!; expect(decode(elevate.args)).toContain('-Verb RunAs');
    expect(Buffer.from(/'-EncodedCommand','([^']+)'/.exec(decode(elevate.args))![1], 'base64').toString('utf16le')).toContain('--elevated');
    expect(calls.at(-1)).toEqual({ file: 'schtasks.exe', args: ['/Run', '/TN', TASK_NAME] }); expect(login.at(-1)!.openAtLogin).toBe(false);
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
