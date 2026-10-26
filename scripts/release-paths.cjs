const { product } = require('./product.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { load } = require('js-yaml');
const { createHash } = require('node:crypto');

function releaseVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('Use a stable release version such as 1.2.1.');
  return value;
}
function artifactNames(version, prefix = product().prefix) {
  releaseVersion(version);
  return [`${prefix}-${version}-Windows-x64-Setup.exe`, `${prefix}-${version}-Windows-x64-Setup.exe.blockmap`, `${prefix}-${version}-Windows-x64-Portable.exe`, 'latest.yml'];
}
function installBaselineVersion(environment = process.env) {
  return releaseVersion(environment.CODING_HUB_BASELINE_VERSION ?? '1.2.0');
}
function createStage(output) {
  fs.mkdirSync(output, { recursive: true });
  const root = fs.realpathSync(output);
  return fs.mkdtempSync(path.join(root, '.build-'));
}
function verifyMetadata(directory, version) {
  releaseVersion(version);
  const metadata = load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'));
  if (!metadata || metadata.version !== version || !Array.isArray(metadata.files) || !metadata.files.length) throw new Error('Update metadata must describe this release version.');
  const installerName = artifactNames(version)[0];
  for (const item of metadata.files) {
    if (item.url !== installerName) throw new Error('Update metadata must reference the current-version Setup executable.');
    const bytes = fs.readFileSync(path.join(directory, item.url));
    if (bytes.length !== item.size || createHash('sha512').update(bytes).digest('base64') !== item.sha512) throw new Error('Update installer integrity check failed.');
  }
  return metadata;
}
function promote(stage, output, version) {
  verifyMetadata(stage, version);
  const names = artifactNames(version);
  for (const name of names) if (!fs.statSync(path.join(stage, name)).isFile()) throw new Error(`Missing release artifact: ${name}`);
  // Copy to temporary files first. Publish metadata last so it references completed artifacts.
  const copies = names.map((name) => ({ name, temporary: path.join(output, '.' + name + '.' + randomUUID() + '.tmp') }));
  try {
    for (const item of copies) fs.copyFileSync(path.join(stage, item.name), item.temporary, fs.constants.COPYFILE_EXCL);
    for (const item of copies) fs.renameSync(item.temporary, path.join(output, item.name));
    // Real paths on both sides: an aliased output folder (macOS /var -> /private/var) would record ../private/... here.
    const manifest = { version, stage: path.relative(fs.realpathSync(output), fs.realpathSync(stage)), builtAt: new Date().toISOString() };
    const temporary = path.join(output, '.last-build-' + randomUUID() + '.json');
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2));
    fs.renameSync(temporary, path.join(output, 'last-build.json'));
  } finally {
    for (const item of copies) try { fs.unlinkSync(item.temporary); } catch { /* Already promoted. */ }
  }
}
function lastBuild(output, version) {
  const manifestFile = path.join(output, 'last-build.json');
  if (!fs.existsSync(manifestFile)) return output; // Older builds used release/win-unpacked.
  const record = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (record.version !== version || typeof record.stage !== 'string' || !/^\.build-[A-Za-z0-9]+$/.test(record.stage)) throw new Error('Build manifest is invalid or belongs to another version. Rebuild before verification.');
  const stage = path.join(fs.realpathSync(output), record.stage);
  if (fs.realpathSync(stage) !== stage) throw new Error('Build staging directory cannot be a link.');
  return stage;
}
module.exports = { releaseVersion, artifactNames, installBaselineVersion, createStage, verifyMetadata, promote, lastBuild };
