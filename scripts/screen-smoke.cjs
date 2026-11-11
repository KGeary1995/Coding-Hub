const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
// A linked computer's screen end to end: the Screen button on its tab connects noVNC, through the host, to a stand-in
// screen-sharing server on loopback (CODING_HUB_TEST_SCREEN_PORT). It checks sign-in with a saved password, the
// picture, the note and unlock when that Mac is locked (or when Trace there cannot say), Ctrl sent as ⌘, Ctrl+V handing this computer's text over first,
// reconnecting by itself after the server ends it, and giving up (Disconnected, Reconnect) when the server keeps refusing.
const MAC = '6c119c8a-b055-4476-b16f-b3e50e873bb8'; const WIDTH = 64; const HEIGHT = 48;

/** Just enough of a VNC server (RFB 3.8, VNC password security, raw pixels), recording what the viewer sends. */
function vncServer() {
  const keys = []; const cutText = []; const sockets = []; let connections = 0; const state = { refuse: false };
  const server = net.createServer((socket) => {
    connections++; if (state.refuse) { socket.destroy(); return; } sockets.push(socket); let buffer = Buffer.alloc(0); let stage = 'version'; let sentPicture = false;
    socket.write('RFB 003.008\n');
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (stage === 'version') { if (buffer.length < 12) return; buffer = buffer.subarray(12); socket.write(Buffer.from([1, 2])); stage = 'security'; continue; }
        if (stage === 'security') { if (buffer.length < 1) return; buffer = buffer.subarray(1); socket.write(Buffer.alloc(16, 7)); stage = 'response'; continue; }
        // Any answer to the challenge is accepted: the viewer's DES is noVNC's own, tested there.
        if (stage === 'response') { if (buffer.length < 16) return; buffer = buffer.subarray(16); socket.write(Buffer.alloc(4)); stage = 'init'; continue; }
        if (stage === 'init') {
          if (buffer.length < 1) return; buffer = buffer.subarray(1);
          const name = Buffer.from('Test-Mac'); const init = Buffer.alloc(24);
          init.writeUInt16BE(WIDTH, 0); init.writeUInt16BE(HEIGHT, 2); Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4); init.writeUInt32BE(name.length, 20);
          socket.write(Buffer.concat([init, name])); stage = 'messages'; continue;
        }
        if (!buffer.length) return;
        const type = buffer[0]; const size = { 0: 20, 3: 10, 4: 8, 5: 6 }[type] ?? (type === 2 ? (buffer.length >= 4 ? 4 + 4 * buffer.readUInt16BE(2) : Infinity) : type === 6 ? (buffer.length >= 8 ? 8 + buffer.readUInt32BE(4) : Infinity) : undefined);
        if (size === undefined) { socket.destroy(); return; }
        if (buffer.length < size) return;
        const message = buffer.subarray(0, size); buffer = buffer.subarray(size);
        if (type === 4) keys.push({ down: message[1] === 1, key: message.readUInt32BE(4) });
        if (type === 6) cutText.push(message.subarray(8).toString('latin1'));
        // The first request gets the whole screen in white; later ones wait, as an unchanged screen does.
        if (type === 3 && !sentPicture) {
          sentPicture = true; const header = Buffer.alloc(16); header.writeUInt16BE(1, 2); header.writeUInt16BE(WIDTH, 8); header.writeUInt16BE(HEIGHT, 10);
          socket.write(Buffer.concat([header, Buffer.alloc(WIDTH * HEIGHT * 4, 255)]));
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, keys, cutText, sockets, state, connections: () => connections })));
}
/** Just enough of the other computer's remote to say whether its screen is locked; the rest is not there. */
function remote() {
  // `old`: Trace there is older than the lock check, so it cannot say.
  const state = { locked: false, old: false };
  const server = http.createServer((request, response) => {
    const known = !state.old && request.url === '/api/screen-state' && request.headers.authorization === 'Bearer ' + 'a'.repeat(43);
    response.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(known ? { locked: state.locked } : { error: 'Not found.' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/` })));
}
const until = async (check, what) => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error('Timed out waiting for ' + what); };

(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-screen-'))); const storage = path.join(root, 'storage');
  await fs.mkdir(storage, { recursive: true });
  // Linked already; its remote answers only whether it is locked, which is all the screen asks it.
  const other = await remote();
  await fs.writeFile(path.join(storage, 'linked-computers.json'), JSON.stringify([{ id: MAC, name: 'Test-Mac', url: other.url, token: 'a'.repeat(43), linkedAt: new Date().toISOString() }]));
  const vnc = await vncServer();
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: storage, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), CODING_HUB_TEST_SCREEN_PORT: String(vnc.port) }; delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  let app;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args, env }); const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    // The smoke checks Ctrl as ⌘, which only a computer other than a Mac offers: on a Mac, the window runs as a PC's would.
    await page.waitForSelector('.tr-empty, .session-tile');
    if (process.platform === 'darwin') {
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'); window.webContents.reload(); } });
      await page.waitForFunction(() => !navigator.userAgent.includes('Mac')); await page.waitForSelector('.tr-empty, .session-tile');
    }
    await page.locator('.tr-computer-tab', { hasText: 'Test-Mac' }).click();
    await page.getByRole('button', { name: 'Screen', exact: true }).click();
    const panel = page.locator('.linked-screen');

    // Sign in (this server asks for a password only) and save it.
    await panel.getByLabel('Password').fill('hunter2');
    await panel.getByRole('button', { name: 'Sign in', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Controlling' }).waitFor();
    const canvas = panel.locator('.linked-screen-view canvas');
    await until(() => canvas.evaluate((element) => { const pixel = element.getContext('2d').getImageData(10, 10, 1, 1).data; return pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255; }), 'the white screen');
    const encryption = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    if (encryption) {
      await panel.getByRole('button', { name: 'Forget password', exact: true }).waitFor();
      assert.doesNotMatch(await fs.readFile(path.join(storage, 'screen-sharing.json'), 'utf8'), /hunter2/, 'Only the encrypted password is stored');
    } else console.log('safeStorage is unavailable here: saving the password is not checked');

    // Locked: a note instead of a black screen, and the password typed at its lock screen after a Shift tap to wake it.
    other.state.locked = true;
    await panel.getByText('Test-Mac is locked').waitFor({ timeout: 10000 });
    vnc.keys.length = 0; await panel.getByLabel('Password for Test-Mac').fill('Pw1!');
    await panel.getByRole('button', { name: 'Wake and unlock', exact: true }).click();
    await until(() => vnc.keys.some((key) => key.key === 0xff0d && !key.down), 'Return after the password');
    other.state.locked = false;
    assert.deepEqual(vnc.keys.map((key) => `${key.down ? '+' : '-'}${key.key.toString(16)}`).join(' '), '+ffe1 -ffe1 +ffe1 +50 -50 -ffe1 +77 -77 +31 -31 +ffe1 +21 -21 -ffe1 +ff0d -ff0d', 'Shift to wake, then the password with Shift where it needs it, then Return');
    await panel.locator('.linked-screen-unlock').waitFor({ state: 'detached', timeout: 10000 });

    // Unknown (Trace there too old to say): Unlock in the bar opens the same form, and it closes once the keys are sent.
    other.state.old = true;
    const unlockButton = panel.getByRole('button', { name: 'Unlock', exact: true });
    await unlockButton.waitFor({ timeout: 10000 }); await unlockButton.click();
    await panel.getByText('If Test-Mac is locked').waitFor();
    vnc.keys.length = 0; await panel.getByLabel('Password for Test-Mac').fill('Pw1!');
    await panel.getByRole('button', { name: 'Wake and unlock', exact: true }).click();
    await until(() => vnc.keys.some((key) => key.key === 0xff0d && !key.down), 'Return after the password, lock state unknown');
    await panel.locator('.linked-screen-unlock').waitFor({ state: 'detached', timeout: 10000 });
    other.state.old = false;
    await unlockButton.waitFor({ state: 'detached', timeout: 10000 });

    // Keys: Ctrl goes as ⌘ (Super_L), down and up, and letters as themselves.
    // On by default only on Windows, where the Windows key cannot be sent.
    await panel.getByLabel('Ctrl as ⌘').check(); await canvas.click(); vnc.keys.length = 0;
    await page.keyboard.down('Control'); await page.keyboard.up('Control'); await page.keyboard.press('a');
    await until(() => vnc.keys.length >= 4, 'the key events');
    assert.deepEqual(vnc.keys.slice(0, 4), [{ down: true, key: 0xffeb }, { down: false, key: 0xffeb }, { down: true, key: 0x61 }, { down: false, key: 0x61 }]);
    // Ctrl+V: this computer's text reaches the other clipboard, then ⌘V pastes it.
    // Only Windows and Linux paste on Ctrl+V; a Mac's browser does not, whatever it is called.
    if (process.platform !== 'darwin') {
      await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('hello mac'); });
      vnc.keys.length = 0; await page.keyboard.press('Control+V');
      await until(() => vnc.cutText.includes('hello mac') && vnc.keys.some((key) => key.key === 0x76 && !key.down), 'the paste');
      assert.deepEqual(vnc.keys.map((key) => key.key), [0xffeb, 0x76, 0x76, 0xffeb], 'V is sent once, inside ⌘');
    } else console.log('Ctrl+V pastes only on Windows and Linux: the paste is not checked on a Mac');

    // View only sends nothing.
    await panel.getByRole('button', { name: 'Control', exact: true }).click(); await panel.getByRole('status').filter({ hasText: 'Viewing' }).waitFor();
    vnc.keys.length = 0; await canvas.click(); await page.keyboard.press('b'); await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(vnc.keys.length, 0, 'View only sends no keys');
    await panel.getByRole('button', { name: 'View only', exact: true }).click();

    // The other computer ends it: the screen connects again by itself, signing in with the saved password, without asking.
    vnc.sockets.at(-1).end();
    await panel.getByRole('status').filter({ hasText: 'Reconnecting…' }).waitFor();
    if (encryption) {
      await panel.getByRole('status').filter({ hasText: 'Controlling' }).waitFor();
      assert.equal(await panel.locator('.linked-screen-signin').count(), 0, 'The saved password is used');
    } else await panel.getByLabel('Password').waitFor();
    assert.equal(vnc.connections(), 2);

    if (encryption) {
      // It keeps refusing: the tries run out (the first was used above, less than 30 s ago), then Disconnected and the
      // reason, until Reconnect, which starts the count again.
      vnc.state.refuse = true; const before = vnc.connections(); vnc.sockets.at(-1).end();
      await panel.getByRole('status').filter({ hasText: 'Disconnected' }).waitFor({ timeout: 30000 });
      await panel.getByRole('alert').waitFor(); assert.equal(vnc.connections() - before, 2, 'The two tries left were made');
      await new Promise((resolve) => setTimeout(resolve, 1500)); assert.equal(vnc.connections() - before, 2, 'No more tries after Disconnected');
      vnc.state.refuse = false; await panel.getByRole('button', { name: 'Reconnect', exact: true }).click();
      await panel.getByRole('status').filter({ hasText: 'Controlling' }).waitFor();

      // No saved password: the screen drops, the retry asks for the sign-in, and the computer closes the connection while
      // the form waits. The viewer stops there (Disconnected, and why) rather than retrying and hiding the form.
      await panel.getByRole('button', { name: 'Forget password', exact: true }).click();
      await panel.getByRole('button', { name: 'Forget password', exact: true }).waitFor({ state: 'detached' });
      const tries = vnc.connections(); vnc.sockets.at(-1).end();
      await panel.getByLabel('Password', { exact: true }).waitFor(); assert.equal(vnc.connections() - tries, 1, 'One retry, which asks for the sign-in');
      vnc.sockets.at(-1).end();
      await panel.getByRole('status').filter({ hasText: 'Disconnected' }).waitFor();
      await panel.getByRole('alert').filter({ hasText: 'closed the connection while waiting for the sign-in' }).waitFor();
      await new Promise((resolve) => setTimeout(resolve, 7000)); assert.equal(vnc.connections() - tries, 1, 'No retry after the sign-in was lost');
    }

    // Back to the channels: the screen connection closes.
    await page.getByRole('button', { name: 'Channels', exact: true }).click();
    await until(() => vnc.sockets.every((socket) => socket.destroyed || socket.readableEnded), 'the connection to close');
    console.log('screen smoke passed');
  } finally {
    await app?.close().catch(() => {}); vnc.server.close(); other.server.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
})().catch((error) => { console.error(error); process.exit(1); });
