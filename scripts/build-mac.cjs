// Builds the Mac disk images (Apple silicon and Intel) into release/mac and checks each packaged app: the renderer,
// the phone app, the terminal binding for its processor, and an executable spawn-helper (without it every channel
// fails to start on macOS). Run on a Mac: electron-builder cannot make a .dmg elsewhere.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { releaseVersion } = require('./release-paths.cjs');
const root = path.resolve(__dirname, '..');
const run = (file, args) => { const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', shell: false }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`${path.basename(file)} failed with exit ${result.status ?? result.signal}.`); };

/** Checks one packaged app folder (AI Coding Hub.app on a Mac); returns its executable. */
function verifyApp(app, arch) {
  const resources = path.join(app, 'Contents/Resources/app');
  for (const relative of ['dist/index.html', 'dist/phone/index.html', 'dist-electron/electron/main.js', 'dist-electron/electron/preload.js', 'dist-electron/electron/services/cli/native-pty.js', 'node_modules/node-pty/lib/index.js', 'node_modules/@xterm/headless/package.json', 'node_modules/@xterm/addon-serialize/package.json'])
    assert.ok(fs.existsSync(path.join(resources, relative)), `${arch}: missing ${relative}`);
  const prebuild = path.join(resources, 'node_modules/node-pty/prebuilds', `darwin-${arch}`);
  assert.ok(fs.existsSync(path.join(prebuild, 'pty.node')), `${arch}: missing the terminal binding`);
  const helper = fs.statSync(path.join(prebuild, 'spawn-helper'));
  assert.equal(helper.mode & 0o111, 0o111, `${arch}: spawn-helper is not executable, so terminals would not start`);
  assert.equal(fs.existsSync(path.join(resources, 'node_modules/node-pty/prebuilds/win32-x64')), false, `${arch}: Windows binding leaked into the Mac app`);
  const executable = path.join(app, 'Contents/MacOS', fs.readdirSync(path.join(app, 'Contents/MacOS'))[0]);
  if (process.platform === 'darwin') run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  return executable;
}

if (require.main === module) {
  try {
    if (process.platform !== 'darwin') throw new Error('Build the Mac disk images on a Mac (the release workflow uses a macOS runner).');
    const version = releaseVersion(require('../package.json').version);
    const output = path.join(root, 'release/mac');
    fs.rmSync(output, { recursive: true, force: true });
    const builder = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'out/cli/cli.js');
    run(process.execPath, [builder, '--config', 'electron-builder.cjs', '--mac', '--publish', 'never', `--config.directories.output=${output}`, `--config.extraMetadata.version=${version}`]);
    for (const [arch, folder] of [['arm64', 'mac-arm64'], ['x64', 'mac']]) {
      verifyApp(path.join(output, folder, 'AI Coding Hub.app'), arch);
      const image = path.join(output, `AI-Coding-Hub-${version}-macOS-${arch}.dmg`);
      assert.ok(fs.statSync(image).size > 50_000_000, `${arch}: disk image is missing or unexpectedly small`);
    }
    console.log(`Verified Mac disk images: ${output}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verifyApp };
