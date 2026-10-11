const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { artifactNames, createStage, promote, lastBuild, verifyMetadata, releaseVersion } = require('./release-paths.cjs');
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-')); roots.push(output); const stage = createStage(output); const version = '1.2.1'; const names = artifactNames(version);
  names.slice(0, 3).forEach((name) => fs.writeFileSync(path.join(stage, name), 'test-bytes'));
  const bytes = fs.readFileSync(path.join(stage, names[0]));
  fs.writeFileSync(path.join(stage, 'latest.yml'), JSON.stringify({ version, files: [{ url: names[0], size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }] }));
  return { output, stage, version, names };
}
test('new builds use unique staging directories and preserve prior output', () => {
  const { output, stage } = fixture(); fs.mkdirSync(path.join(output, 'win-unpacked')); fs.writeFileSync(path.join(output, 'win-unpacked', 'running-app'), 'preserve');
  assert.notEqual(createStage(output), stage); assert.equal(fs.readFileSync(path.join(output, 'win-unpacked', 'running-app'), 'utf8'), 'preserve');
});
test('promotes all verified artifacts and records the exact staging directory', () => {
  const { output, stage, version, names } = fixture(); promote(stage, output, version); assert.equal(lastBuild(output, version), stage);
  names.forEach((name) => assert.deepEqual(fs.readFileSync(path.join(output, name)), fs.readFileSync(path.join(stage, name))));
});
test('rejects changed installer bytes without replacing existing release output', () => {
  const { output, stage, version, names } = fixture(); fs.writeFileSync(path.join(output, 'latest.yml'), 'previous'); fs.writeFileSync(path.join(stage, names[0]), 'changed');
  assert.throws(() => promote(stage, output, version), /integrity/); assert.equal(fs.readFileSync(path.join(output, 'latest.yml'), 'utf8'), 'previous');
});
test('rejects stale versions, missing artifacts, and metadata path traversal', () => {
  const { output, stage, version, names } = fixture(); assert.throws(() => verifyMetadata(stage, '9.0.0'), /version/);
  fs.unlinkSync(path.join(stage, names[1])); assert.throws(() => promote(stage, output, version)); assert.equal(fs.existsSync(path.join(output, 'latest.yml')), false);
  fs.writeFileSync(path.join(stage, 'latest.yml'), JSON.stringify({ version, files: [{ url: '../outside.exe' }] })); assert.throws(() => verifyMetadata(stage, version), /current-version/);
});
test('does not follow a malicious last-build manifest or mismatched version', () => {
  const { output, stage, version } = fixture(); fs.writeFileSync(path.join(output, 'last-build.json'), JSON.stringify({ version, stage: '../outside' })); assert.throws(() => lastBuild(output, version), /invalid/);
  fs.writeFileSync(path.join(output, 'last-build.json'), JSON.stringify({ version: '9.0.0', stage: path.basename(stage) })); assert.throws(() => lastBuild(output, version), /version/);
  assert.throws(() => releaseVersion('1.0.0 --publish always')); assert.equal(lastBuild(stage, version), stage);
});
