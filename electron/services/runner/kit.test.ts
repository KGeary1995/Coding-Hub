import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureKit, kitFiles, removeOldKits, runnerPlace, runnerSecret, RUNNER_EXECUTABLE } from './kit';
import { canSymlink } from '../hub/symlink.fixture';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-kit-')); roots.push(root); return root; }
function write(file: string, text = 'x') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

/** A stand-in app folder and Electron folder with the files a kit takes, and some it must not. */
function fakeApp(platform: NodeJS.Platform) {
  const root = temp(); const app = path.join(root, 'app'); const electron = path.join(root, 'electron');
  for (const name of ['runner-main.js', 'runner.js', 'protocol.js', 'tail.js', 'journal.js', 'jobs.js', 'client.js']) write(path.join(app, 'dist-electron', 'electron', 'services', 'runner', name));
  write(path.join(app, 'dist-electron', 'electron', 'services', 'cli', 'native-pty.js')); write(path.join(app, 'dist-electron', 'electron', 'services', 'chat', 'chat-process.js')); write(path.join(app, 'dist-electron', 'electron', 'main.js'));
  const pty = path.join(app, 'node_modules', 'node-pty');
  write(path.join(pty, 'package.json'), '{}'); write(path.join(pty, 'lib', 'index.js')); write(path.join(pty, 'lib', 'worker', 'conoutSocketWorker.js'));
  write(path.join(pty, 'prebuilds', `${platform}-x64`, 'pty.node')); write(path.join(pty, 'prebuilds', `${platform}-x64`, 'pty.pdb')); write(path.join(pty, 'prebuilds', 'darwin-arm64', 'pty.node')); write(path.join(pty, 'src', 'unix', 'pty.cc'));
  const exec = path.join(electron, platform === 'win32' ? 'Trace.exe' : 'Trace');
  write(exec); for (const name of ['ffmpeg.dll', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'resources.pak']) write(path.join(electron, name));
  return { app, exec, storage: path.join(root, 'storage') };
}

describe('runner kit', () => {
  it('takes only the runner, node-pty for this computer, and Electron as Node', () => {
    const { app, exec } = fakeApp('win32');
    const taken = kitFiles(app, exec, 'win32', 'x64').map((file) => file.to.split(path.sep).join('/')).sort();
    expect(taken).toEqual([
      'Trace Runner.exe', 'app/dist-electron/electron/services/chat/chat-process.js', 'app/dist-electron/electron/services/cli/native-pty.js',
      ...['jobs.js', 'journal.js', 'protocol.js', 'runner-main.js', 'runner.js', 'tail.js'].map((name) => `app/dist-electron/electron/services/runner/${name}`),
      'app/node_modules/node-pty/lib/index.js', 'app/node_modules/node-pty/lib/worker/conoutSocketWorker.js', 'app/node_modules/node-pty/package.json', 'app/node_modules/node-pty/prebuilds/win32-x64/pty.node',
      'ffmpeg.dll', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
    ].sort());
  });

  it('is copied once, outside the app folder, and copied again only when its files change', () => {
    const { app, exec, storage } = fakeApp('win32'); const place = runnerPlace(storage, 'win32');
    const kit = ensureKit(place, app, exec, 'win32');
    expect(kit.program).toBe(path.join(kit.folder, RUNNER_EXECUTABLE)); expect(fs.existsSync(kit.script)).toBe(true);
    expect(path.relative(app, kit.folder).startsWith('..')).toBe(true);
    expect(ensureKit(place, app, exec, 'win32').folder).toBe(kit.folder);
    write(path.join(app, 'dist-electron', 'electron', 'services', 'runner', 'runner.js'), 'changed');
    const next = ensureKit(place, app, exec, 'win32'); expect(next.folder).not.toBe(kit.folder);
    removeOldKits(place, [next.folder]); expect(fs.readdirSync(place.kits)).toEqual([path.basename(next.folder)]);
  });

  it('runs Electron from its own place outside Windows', () => {
    const { app, exec, storage } = fakeApp('linux'); const kit = ensureKit(runnerPlace(storage, 'linux'), app, exec, 'linux');
    expect(kit.program).toBe(exec); expect(fs.existsSync(path.join(kit.folder, RUNNER_EXECUTABLE))).toBe(false);
  });

  it('refuses a kit with a file missing', () => {
    const { app, exec, storage } = fakeApp('win32'); fs.rmSync(path.join(app, 'dist-electron', 'electron', 'services', 'runner', 'tail.js'));
    expect(() => ensureKit(runnerPlace(storage, 'win32'), app, exec, 'win32')).toThrow(/tail\.js is missing/);
  });

  it('has an address for each storage folder, and one secret kept for this user', () => {
    const first = runnerPlace('C:\\Users\\a\\.coding-hub', 'win32'); const again = runnerPlace('c:\\users\\A\\.coding-hub', 'win32'); const other = runnerPlace('C:\\temp\\test-storage', 'win32');
    expect(first.address).toMatch(/^\\\\\.\\pipe\\trace-runner-v1-[0-9a-f]{16}$/); expect(again.address).toBe(first.address); expect(other.address).not.toBe(first.address);
    expect(runnerPlace('/home/a/.coding-hub', 'linux').address).toBe(path.join('/home/a/.coding-hub', 'runner', 'v1.sock'));
    const place = runnerPlace(temp()); const secret = runnerSecret(place); expect(secret.length).toBeGreaterThanOrEqual(32); expect(runnerSecret(place)).toBe(secret);
  });
  it.skipIf(!canSymlink)('keeps the kit its runner runs from when the storage folder is reached through a link (a Mac\'s /var)', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-kit-real-')); const link = `${real}-link`; fs.symlinkSync(real, link, 'dir');
    try {
      const place = runnerPlace(link); fs.mkdirSync(path.join(place.kits, 'kit-used'), { recursive: true }); fs.mkdirSync(path.join(place.kits, 'kit-old'));
      // The runner says where it runs from as its own path resolves: through the real folder.
      removeOldKits(place, [path.join(fs.realpathSync(place.kits), 'kit-used')]);
      expect(fs.readdirSync(place.kits)).toEqual(['kit-used']);
    } finally { fs.rmSync(link, { force: true }); fs.rmSync(real, { recursive: true, force: true }); }
  });
});

