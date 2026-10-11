const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { load } = require('js-yaml');
const { lastBuild, releaseVersion } = require('./release-paths.cjs');
const { createRequire } = require('node:module');
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');

const args = process.argv.slice(2);
let directory = null; let expectedVersion = require('../package.json').version;
for (let i = 0; i < args.length; i += 2) {
  assert.ok(args[i + 1], 'Missing verification argument');
  if (args[i] === '--directory') directory = path.resolve(args[i + 1]);
  else if (args[i] === '--version') expectedVersion = releaseVersion(args[i + 1]);
  else throw new Error('Unknown package verification argument');
}
const output = directory ?? lastBuild(path.resolve(__dirname, '../release'), expectedVersion);
const app = path.join(output, 'win-unpacked');
const resources = path.join(app, 'resources/app');
const packageRequire = createRequire(path.join(resources, 'package.json'));
assert.equal(JSON.parse(fs.readFileSync(path.join(resources, 'package.json'), 'utf8')).version, expectedVersion, 'Packaged app version mismatch');

function verifyPE(relativePath, machine) {
  const buffer = fs.readFileSync(path.join(app, relativePath));
  assert.equal(buffer.toString('ascii', 0, 2), 'MZ', relativePath);
  const header = buffer.readUInt32LE(0x3c);
  assert.equal(buffer.toString('ascii', header, header + 4), 'PE\0\0', relativePath);
  if (machine) assert.equal(buffer.readUInt16LE(header + 4), machine, relativePath);
  return buffer;
}

const executable = verifyPE('AI Coding Hub.exe', 0x8664);
const entries = NtExecutableResource.from(NtExecutable.from(executable, { ignoreCert: true })).entries;
const version = Resource.VersionInfo.fromEntries(entries)[0];
assert.equal(version.getStringValues({ lang: 1033, codepage: 1200 }).ProductName, 'AI Coding Hub');
assert.ok(entries.some((entry) => entry.type === 14), 'Application icon is missing');

const pty = 'resources/app/node_modules/node-pty';
for (const name of ['conpty', 'conpty_console_list', 'pty']) {
  const binary = verifyPE(`${pty}/prebuilds/win32-x64/${name}.node`, 0x8664);
  assert.ok(binary.includes(Buffer.from('napi_register_module_v1')), `${name} is not a Node-API binding`);
}
for (const name of ['winpty-agent.exe', 'winpty.dll', 'conpty/OpenConsole.exe', 'conpty/conpty.dll']) {
  verifyPE(`${pty}/prebuilds/win32-x64/${name}`, 0x8664);
}
for (const relative of [
  'dist-electron/electron/main.js',
  'dist-electron/electron/preload.js',
  'dist-electron/electron/services/cli/pty-manager.js',
  'dist-electron/shared/schemas.js',
  'node_modules/node-pty/lib/worker/conoutSocketWorker.js',
  'node_modules/node-pty/lib/conpty_console_list_agent.js',
]) assert.ok(fs.existsSync(path.join(resources, relative)), `Missing runtime file: ${relative}`);
assert.ok(packageRequire.resolve('node-pty').startsWith(resources));
assert.ok(packageRequire.resolve('zod').startsWith(resources));
assert.ok(packageRequire.resolve('electron-updater').startsWith(resources));
const feed = load(fs.readFileSync(path.join(app, 'resources/app-update.yml'), 'utf8'));
assert.equal(feed.provider, 'github');
assert.equal(feed.owner, 'KGeary1995');
assert.equal(feed.repo, 'Coding-Hub');
assert.equal(fs.existsSync(path.join(resources, 'node_modules/node-pty/build/Release/pty.node')), false, 'Linux binding leaked into Windows package');
const html = fs.readFileSync(path.join(resources, 'dist/index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="(\.\/assets\/[^"?#]+)"/g)) {
  assert.ok(fs.existsSync(path.join(resources, 'dist', match[1])), `Missing renderer asset: ${match[1]}`);
}
const artifact = `AI-Coding-Hub-${expectedVersion}-Windows-x64-Portable.exe`;
assert.ok(fs.existsSync(path.join(output, artifact)), 'Current-version portable Windows executable is missing');
const artifactBuffer = fs.readFileSync(path.join(output, artifact));
assert.equal(artifactBuffer.toString('ascii', 0, 2), 'MZ');
assert.ok(artifactBuffer.length > 10_000_000, 'Executable payload is unexpectedly small');
const metadata = load(fs.readFileSync(path.join(output, 'latest.yml'), 'utf8'));
assert.equal(metadata.version, expectedVersion);
assert.ok(metadata.files.length > 0);
for (const file of metadata.files) {
  assert.match(file.url, /Windows-x64-Setup\.exe$/);
  assert.equal(path.basename(file.url), file.url);
  const installer = fs.readFileSync(path.join(output, file.url));
  assert.equal(installer.toString('ascii', 0, 2), 'MZ');
  assert.ok(installer.length > 10_000_000);
  assert.equal(installer.length, file.size);
  assert.equal(createHash('sha512').update(installer).digest('base64'), file.sha512);
  assert.ok(fs.statSync(path.join(output, file.url + '.blockmap')).size > 0);
}
console.log('PASS: installer/update metadata/checksums and portable Windows executable, x64 application metadata/icon, Node-API terminal bindings and helpers, host/preload, dependencies, and renderer assets. Windows execution still requires a native Windows check.');
