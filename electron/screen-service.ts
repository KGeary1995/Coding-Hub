import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, Menu, Notification, Tray } from 'electron';
import { SCREEN_SERVICE_PORT } from '../shared/screen';
import { ScreenCapture } from './services/remote/screen-capture';
import { ScreenService, shareEnabled } from './services/remote/screen-service-server';
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

// Its own profile, so it neither shares Trace's single-instance lock nor touches Trace's window state.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'AI Coding Hub', 'screen-service'));
app.setAppUserModelId('com.codinghub.desktop');
if (!root || !path.isAbsolute(root) || !app.requestSingleInstanceLock()) app.exit(0);
else {
  // With no window open the app must keep running; the capture window comes and goes with each viewer.
  app.on('window-all-closed', () => {});
  void app.whenReady().then(async () => {
    let tray: Tray | null = null; const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    const service = new ScreenService(root, () => computer, {
      open: async () => {
        const capture = await ScreenCapture.start(path.join(app.getAppPath(), 'dist', 'capture.html'));
        const write = (text: string) => void Promise.resolve(clipboard.writeText(text)).catch(() => {});
        const input = inputLog ? testInput(inputLog) : new WindowsInput(capture.width, capture.height, write);
        return { source: capture, input, stop: () => capture.stop() };
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
    // Turned off in Trace's settings (or the setting is gone): disconnect and quit.
    setInterval(() => { if (!shareEnabled(root)) { void service.close().finally(() => app.exit(0)); } }, 3000);
  });
}

/** For the screen smoke test: each command on its own line in a file, nothing pressed. */
function testInput(file: string) {
  const log = (line: string) => fs.appendFileSync(file, line + '\n');
  return { pointer: (x: number, y: number, buttons: number) => log(`pointer ${x} ${y} ${buttons}`), key: (keysym: number, down: boolean) => log(`key ${keysym} ${down ? 1 : 0}`), clipboard: (text: string) => log(`clipboard ${text}`), close: () => log('close') };
}
