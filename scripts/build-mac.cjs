// Builds the Mac disk images (Apple silicon and Intel) into release/mac and checks each packaged app: the renderer,
// the phone app, the terminal binding for its processor, and an executable spawn-helper (without it every channel
// fails to start on macOS). Run on a Mac: electron-builder cannot make a .dmg elsewhere.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { releaseVersion } = require('./release-paths.cjs');
const { product } = require('./product.cjs');
const root = path.resolve(__dirname, '..');
const run = (file, args) => { const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', shell: false }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`${path.basename(file)} failed with exit ${result.status ?? result.signal}.`); };

const notarizing = () => Boolean(process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_API_KEY || process.env.APPLE_ID);

/** Checks one packaged app folder (Trace.app on a Mac); returns its executable. */
function verifyApp(app, arch) {
  const resources = path.join(app, 'Contents/Resources/app');
  // Only the built app ships: source folders here would publish the private source on the public downloads page.
  assert.deepEqual(fs.readdirSync(resources).sort(), ['dist', 'dist-electron', 'node_modules', 'package.json'], `${arch}: packaged app holds files beyond the built app`);
  for (const relative of ['dist/index.html', 'dist/phone/index.html', 'dist-electron/electron/main.js', 'dist-electron/electron/preload.js', 'dist-electron/electron/services/cli/native-pty.js', 'node_modules/node-pty/lib/index.js', 'node_modules/@xterm/headless/package.json', 'node_modules/@xterm/addon-serialize/package.json'])
    assert.ok(fs.existsSync(path.join(resources, relative)), `${arch}: missing ${relative}`);
  const prebuild = path.join(resources, 'node_modules/node-pty/prebuilds', `darwin-${arch}`);
  assert.ok(fs.existsSync(path.join(prebuild, 'pty.node')), `${arch}: missing the terminal binding`);
  const helper = fs.statSync(path.join(prebuild, 'spawn-helper'));
  assert.equal(helper.mode & 0o111, 0o111, `${arch}: spawn-helper is not executable, so terminals would not start`);
  assert.equal(fs.existsSync(path.join(resources, 'node_modules/node-pty/prebuilds/win32-x64')), false, `${arch}: Windows binding leaked into the Mac app`);
  const executable = path.join(app, 'Contents/MacOS', fs.readdirSync(path.join(app, 'Contents/MacOS'))[0]);
  if (process.platform === 'darwin') run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (process.platform === 'darwin' && process.env.MAC_SIGNING_IDENTITY) {
    // codesign -d reports on stderr.
    const details = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' }).stderr;
    assert.match(details, /Authority=Developer ID Application:/, `${arch}: not signed with a Developer ID`);
    assert.match(details, /flags=0x10000\(runtime\)/, `${arch}: hardened runtime is off, so notarization would fail`);
    // Gatekeeper accepts the app only once Apple has notarized it and the ticket is stapled.
    if (notarizing()) { run('/usr/bin/xcrun', ['stapler', 'validate', app]); run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', app]); }
  }
  return executable;
}

/**
 * latest-mac.yml as a Mac reads it: `version` is this one, and each chip's update zip and disk image is listed with a
 * sha512 (Trace 1.21.0 updates only from a listed zip; later versions from a listed disk image). Throws otherwise.
 */
function checkMacFeed(feed, version, prefix) {
  assert.match(feed, new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm'), 'latest-mac.yml names another version');
  for (const arch of ['arm64', 'x64']) for (const ext of ['zip', 'dmg']) {
    const name = `${prefix}-${version}-macOS-${arch}.${ext}`;
    const entry = new RegExp(`^\\s*-\\s*url:\\s*['"]?${name.replace(/\./g, '\\.')}['"]?\\s*\\n\\s+sha512:\\s*['"]?[A-Za-z0-9+/=]{80,100}['"]?\\s*$`, 'm');
    assert.match(feed, entry, `latest-mac.yml does not list ${name} with its sha512`);
  }
}

if (require.main === module) {
  try {
    if (process.platform !== 'darwin') throw new Error('Build the Mac disk images on a Mac (the release workflow uses a macOS runner).');
    const version = releaseVersion(require('../package.json').version);
    // TRACE_MAC_OUTPUT builds elsewhere (relative to the repository), leaving an app that is running from release/mac alone.
    const output = path.resolve(root, process.env.TRACE_MAC_OUTPUT || 'release/mac');
    fs.rmSync(output, { recursive: true, force: true });
    const builder = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'out/cli/cli.js');
    run(process.execPath, [builder, '--config', 'electron-builder.cjs', '--mac', '--publish', 'never', `--config.directories.output=${output}`, `--config.extraMetadata.version=${version}`]);
    for (const [arch, folder] of [['arm64', 'mac-arm64'], ['x64', 'mac']]) {
      verifyApp(path.join(output, folder, `${product().name}.app`), arch);
      const image = path.join(output, `${product().prefix}-${version}-macOS-${arch}.dmg`);
      assert.ok(fs.statSync(image).size > 50_000_000, `${arch}: disk image is missing or unexpectedly small`);
      // Every build also makes the update zip: signed Macs update themselves from it, and Trace 1.21.0's update from
      // another computer installs only a zip, so a Mac on 1.21.0 has no other way on.
      assert.ok(fs.statSync(path.join(output, `${product().prefix}-${version}-macOS-${arch}.zip`)).size > 50_000_000, `${arch}: update zip is missing or unexpectedly small`);
    }
    // The feed installed Macs read, on every build: this version, and each zip and disk image with its checksum.
    checkMacFeed(fs.readFileSync(path.join(output, 'latest-mac.yml'), 'utf8'), version, product().prefix);
    if (process.env.MAC_SIGNING_IDENTITY) assert.ok(JSON.parse(fs.readFileSync(path.join(output, 'mac-arm64', `${product().name}.app`, 'Contents/Resources/app/package.json'), 'utf8')).traceMacUpdates, 'the signed app does not know it may update itself');
    console.log(`Verified Mac disk images: ${output}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verifyApp, checkMacFeed };
