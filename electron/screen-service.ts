import os from 'node:os';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, Menu, Notification, Tray } from 'electron';
import { inputPipePath, SCREEN_INPUT_PORT, SCREEN_SERVICE_PORT } from '../shared/screen';
import { InputRelay } from './services/remote/input-relay';
import { ScreenCapture } from './services/remote/screen-capture';
import { localScreenToken, ScreenService, shareElevated, shareEnabled } from './services/remote/screen-service-server';
import { localHelper, pipeHelper, relayHelper, WindowsInput } from './services/remote/screen-input';

/**
 * Trace started with --screen-service: shares this Windows computer's screen with linked computers, while Trace itself
 * is closed too. Trace's settings turn it on, start it, and register it to start at sign-in; it quits once they turn it
 * off. It has no window: a tray icon shows while someone is watching, with a way to disconnect them.
 */
const argument = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = argument('storage'); const computer = argument('name') || 'this computer';
// Source runs only: a test service on its own port, and input written to a file instead of pressed.
const port = !app.isPackaged && process.env.CODING_HUB_TEST_SCREEN_SERVICE_PORT ? Number(process.env.CODING_HUB_TEST_SCREEN_SERVICE_PORT) : SCREEN_SERVICE_PORT;
const inputPort = !app.isPackaged && process.env.CODING_HUB_TEST_SCREEN_INPUT_PORT ? Number(process.env.CODING_HUB_TEST_SCREEN_INPUT_PORT) : SCREEN_INPUT_PORT;
const inputLog = !app.isPackaged ? process.env.CODING_HUB_TEST_SCREEN_INPUT_LOG : undefined;
/** A service that fails sooner than this after starting is not started again by itself. */
const RELAUNCH_AFTER = !app.isPackaged && process.env.CODING_HUB_TEST_RELAUNCH_AFTER ? Number(process.env.CODING_HUB_TEST_RELAUNCH_AFTER) : 60_000;
/** Source runs only: the screen service smoke test makes the service fail on purpose by creating this file. */
const crashFile = !app.isPackaged ? process.env.CODING_HUB_TEST_SCREEN_SERVICE_CRASH : undefined;
/**
 * Started by the scheduled task that runs it as administrator (Settings: also control apps running as administrator):
 * the input side only (input-relay.ts), beside the ordinary service, which captures and serves the viewer. Up to 1.28.0
 * this run was the whole service instead of the ordinary one, and could not capture the screen: Windows refuses an
 * administrator Electron its screen capture. The task's command is the same, so no new permission is asked.
 */
const elevatedRun = process.argv.includes('--elevated');
const wanted = () => !!root && shareEnabled(root) && (!elevatedRun || shareElevated(root));

// Its own profile, so it neither shares Trace's single-instance lock nor touches Trace's window state; the two sides run together, each with its own.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'AI Coding Hub', elevatedRun ? 'screen-input' : 'screen-service'));
app.setAppUserModelId('com.codinghub.desktop');
// Off (or, for the administrator side, its option is off): quit before taking the lock.
if (!root || !path.isAbsolute(root) || !wanted() || !app.requestSingleInstanceLock()) app.exit(0);
else {
  // With no window open the app must keep running; the capture window comes and goes with each viewer.
  app.on('window-all-closed', () => {});
  // One viewer's failure (a capture or clipboard call nothing waited for) must not take the service down for the next.
  process.on('unhandledRejection', () => {});
  // An error nothing caught leaves the service in an unknown state: start it again, unless it failed this soon after
  // starting (it would only fail again, over and over). Trace, while open, also starts it again when it is gone.
  const startedAt = Date.now();
  process.on('uncaughtException', () => { if (Date.now() - startedAt > RELAUNCH_AFTER) app.relaunch(); app.exit(1); });
  /**
   * An update replaces Trace's files while this runs (the administrator side is not closed by it), and the service then
   * cannot open its capture window: every viewer was refused, for days, while /health still answered (2026-11-22). So
   * once the installed version has differed from this one for half a minute (an update takes a moment to finish) and
   * nobody is viewing, it makes way: the ordinary service starts itself again, and the administrator side quits for
   * its task to be run again by Trace (it starts with the update, and checks every minute).
   * It also quits once it is turned off in Trace's settings (or the setting is gone).
   */
  const keep = (close: () => Promise<void>, busy: () => boolean, tick: () => void = () => {}) => {
    let outdated = 0;
    const installed = () => { try { return String((JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { version?: unknown }).version ?? ''); } catch { return ''; } };
    if (app.isPackaged) setInterval(() => { const version = installed(); outdated = version && version !== app.getVersion() ? outdated + 1 : 0; if (outdated >= 10 && !busy()) { if (!elevatedRun) app.relaunch(); void close().finally(() => app.exit(0)); } }, 3000);
    setInterval(() => { if (!wanted()) { void close().finally(() => app.exit(0)); } else tick(); }, 3000);
  };
  void app.whenReady().then(async () => {
    if (elevatedRun) {
      const relay = new InputRelay(root, localHelper); relay.version = app.getVersion();
      try { await relay.listen(inputPort); } catch { app.exit(0); return; }
      keep(() => relay.close(), () => false); return;
    }
    let tray: Tray | null = null; const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    const service = new ScreenService(root, () => computer, {
      open: async (display) => {
        const capture = await ScreenCapture.start(path.join(app.getAppPath(), 'dist', 'capture.html'), display);
        // Returned, so a paste waits for the text to be on the clipboard (writeText finishes later); a failure is swallowed.
        const write = (text: string) => Promise.resolve(clipboard.writeText(text)).catch(() => {});
        // With the administrator option on, the input goes through that side, so it reaches apps running as administrator too:
        // the protected helper's pipe (1.46), else the older relay a task set up before it, else this process's own rights.
        const key = shareElevated(root) ? localScreenToken(root) : null;
        const input = inputLog ? testInput(inputLog) : new WindowsInput(capture.width, capture.height, write, key ? () => pipeHelper(inputPipePath(os.userInfo().username), () => relayHelper(inputPort, key)) : undefined, capture.region);
        return { source: capture, input, stop: () => capture.stop(), displays: capture.displays, display: capture.display };
      },
      readClipboard: async () => String(await clipboard.readText()),
      // Trace itself, in the tray (--hidden), as the signed-in user this service runs as; a source run starts the same checkout.
      openTrace: () => { spawn(process.execPath, [...(app.isPackaged ? [] : [app.getAppPath()]), '--hidden'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...(app.isPackaged ? {} : { CODING_HUB_STORAGE_DIR: root }) } }).unref(); },
      viewing: (name, disconnect) => {
        tray?.destroy(); tray = null; if (!name) return;
        tray = new Tray(icon);
        tray.setToolTip(`${name} is viewing and controlling this screen (Trace)`);
        tray.setContextMenu(Menu.buildFromTemplate([{ label: `${name} is viewing and controlling this screen`, enabled: false }, { type: 'separator' }, { label: `Disconnect ${name}`, click: disconnect }]));
        if (Notification.isSupported()) new Notification({ title: 'Trace', body: `${name} is viewing and controlling this screen. Disconnect from the Trace icon by the clock.` }).show();
      },
    });
    service.version = app.getVersion();
    try { await service.listen(port); } catch { app.exit(0); return; }
    // The file goes first, so the service started again does not fail at once too.
    if (crashFile) setInterval(() => { if (fs.existsSync(crashFile)) { fs.rmSync(crashFile, { force: true }); setTimeout(() => { throw new Error('Failing on purpose for the smoke test.'); }); } }, 200);
    keep(() => service.close(), () => service.busy, () => service.recheck());
  });
}

/** For the screen smoke test: each command on its own line in a file, nothing pressed. */
function testInput(file: string) {
  const log = (line: string) => fs.appendFileSync(file, line + '\n');
  return { pointer: (x: number, y: number, buttons: number) => log(`pointer ${x} ${y} ${buttons}`), key: (keysym: number, down: boolean) => log(`key ${keysym} ${down ? 1 : 0}`), clipboard: (text: string) => log(`clipboard ${text}`), close: () => log('close') };
}
