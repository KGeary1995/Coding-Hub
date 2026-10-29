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

test('signed upgrade build and installation check use the same validated baseline', () => {
  const { installBaselineVersion } = require('./release-paths.cjs');
  const { load } = require('js-yaml');
  const workflow = load(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/signed-release.yml'), 'utf8'));
  const job = workflow.jobs['signed-windows'];
  assert.equal(installBaselineVersion({}), '1.2.0');
  assert.equal(installBaselineVersion(job.env), '1.6.1');
  const baselineStep = job.steps.find((step) => step.name === 'Build signed upgrade baseline');
  assert.ok(baselineStep.run.includes('${{ env.CODING_HUB_BASELINE_VERSION }}'));
  // windows-install-smoke looks for the baseline under the legacy name.
  assert.equal(baselineStep.env?.TRACE_LEGACY_PRODUCT_NAME, '1');
  assert.throws(() => installBaselineVersion({ CODING_HUB_BASELINE_VERSION: '../escape' }));
});
test('a Developer ID Mac build makes the update zips and marks the app as able to update itself', async () => {
  const load = (identity) => {
    const saved = process.env.MAC_SIGNING_IDENTITY; const file = require.resolve('../electron-builder.cjs');
    if (identity) process.env.MAC_SIGNING_IDENTITY = identity; else delete process.env.MAC_SIGNING_IDENTITY;
    try { delete require.cache[file]; return require(file); } finally { if (saved === undefined) delete process.env.MAC_SIGNING_IDENTITY; else process.env.MAC_SIGNING_IDENTITY = saved; delete require.cache[file]; }
  };
  const signed = load('Test Developer (TEAMID1234)'); const adhoc = load('');
  assert.deepEqual(signed.mac.target.map((item) => item.target), ['dmg', 'zip']);
  assert.deepEqual(signed.extraMetadata, { traceMacUpdates: true });
  assert.equal(signed.mac.notarize, Boolean(process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_API_KEY || process.env.APPLE_ID));
  assert.match(signed.mac.artifactName, /-\$\{version\}-macOS-\$\{arch\}\.\$\{ext\}$/);
  // Ad-hoc builds cannot be installed over a signed one by macOS's updater: disk images only, and no update flag.
  assert.deepEqual(adhoc.mac.target.map((item) => item.target), ['dmg']);
  assert.equal(adhoc.extraMetadata, undefined); assert.equal(adhoc.mac.identity, '-');
  // electron-builder's own schema check, which the build runs first: an unknown key fails every build, Windows too.
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config'); const { DebugLogger } = require('builder-util');
  for (const config of [signed, adhoc]) await validateConfiguration(config, new DebugLogger(false));
});
