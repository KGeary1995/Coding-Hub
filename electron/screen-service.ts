import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, Menu, Notification, Tray } from 'electron';
import { SCREEN_SERVICE_PORT } from '../shared/screen';
import { ScreenCapture } from './services/remote/screen-capture';
import { ScreenService, shareElevated, shareEnabled } from './services/remote/screen-service-server';
import { WindowsInput } from './services/remote/screen-input';

/**
 * Trace started with --screen-service: shares this Windows computer's screen with linked computers, while Trace itself
 * is closed too. Trace's settings turn it on, start it, and register it to start at sign-in; it quits once they turn it
 * off. It has no window: a tray icon shows while someone is watching, with a way to disconnect them.
 */
const argument = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = argument('storage'); const computer = argument('name') || 'this computer';
// Source runs only: a test service on its own port, and input written to a file instead of pressed.
const port = !app.isPackaged && process.env.CODING_HUB_TEST_SCREEN_SERVICE_PORT ? Number(process.env.CODING_HUB_TEST_SCREEN_SERVICE_PORT) : SCREEN_SERVICE_PORT;
const inputLog = !app.isPackaged ? process.env.CODING_HUB_TEST_SCREEN_INPUT_LOG : undefined;
/** A service that fails sooner than this after starting is not started again by itself. */
const RELAUNCH_AFTER = 60_000;
/**
 * Started by the scheduled task that runs it as administrator (Settings: also control apps running as administrator).
 * A service of the other kind than the setting asks for gives way: it quits, and Trace starts the right one.
 */
const elevatedRun = process.argv.includes('--elevated');
const wanted = () => !!root && shareEnabled(root) && shareElevated(root) === elevatedRun;

// Its own profile, so it neither shares Trace's single-instance lock nor touches Trace's window state.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'AI Coding Hub', 'screen-service'));
app.setAppUserModelId('com.codinghub.desktop');
// Off, or the other kind is wanted: quit before taking the lock, so the right one can start.
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
  void app.whenReady().then(async () => {
    let tray: Tray | null = null; const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    const service = new ScreenService(root, () => computer, {
      open: async (display) => {
        const capture = await ScreenCapture.start(path.join(app.getAppPath(), 'dist', 'capture.html'), display);
        // Returned, so a paste waits for the text to be on the clipboard (writeText finishes later); a failure is swallowed.
        const write = (text: string) => Promise.resolve(clipboard.writeText(text)).catch(() => {});
        const input = inputLog ? testInput(inputLog) : new WindowsInput(capture.width, capture.height, write, undefined, capture.region);
        return { source: capture, input, stop: () => capture.stop(), displays: capture.displays, display: capture.display };
      },
      readClipboard: async () => String(await clipboard.readText()),
      viewing: (name, disconnect) => {
        tray?.destroy(); tray = null; if (!name) return;
        tray = new Tray(icon);
        tray.setToolTip(`${name} is viewing and controlling this screen (Trace)`);
        tray.setContextMenu(Menu.buildFromTemplate([{ label: `${name} is viewing and controlling this screen`, enabled: false }, { type: 'separator' }, { label: `Disconnect ${name}`, click: disconnect }]));
        if (Notification.isSupported()) new Notification({ title: 'Trace', body: `${name} is viewing and controlling this screen. Disconnect from the Trace icon by the clock.` }).show();
      },
    });
    try { await service.listen(port); } catch { app.exit(0); return; }
    // Turned off in Trace's settings (or the setting is gone), or the other kind (administrator or not) is wanted: quit.
    setInterval(() => { if (!wanted()) { void service.close().finally(() => app.exit(0)); } }, 3000);
  });
}

/** For the screen smoke test: each command on its own line in a file, nothing pressed. */
function testInput(file: string) {
  const log = (line: string) => fs.appendFileSync(file, line + '\n');
  return { pointer: (x: number, y: number, buttons: number) => log(`pointer ${x} ${y} ${buttons}`), key: (keysym: number, down: boolean) => log(`key ${keysym} ${down ? 1 : 0}`), clipboard: (text: string) => log(`clipboard ${text}`), close: () => log('close') };
}
