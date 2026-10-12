const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createStage, releaseVersion, promote } = require('./release-paths.cjs');
const root = path.resolve(__dirname, '..');
function run(file, args) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Release command failed with exit ${result.status ?? result.signal}.`);
}
try {
  const args = process.argv.slice(2);
  const signed = args.includes('--signed'); if (signed) args.splice(args.indexOf('--signed'), 1);
  if (signed && (process.platform !== 'win32' || !process.env.CSC_LINK || !process.env.WINDOWS_PUBLISHER_NAME)) throw new Error('Signed builds require native Windows, CSC_LINK, and the public WINDOWS_PUBLISHER_NAME. Configure certificate/password securely in build settings.');
  let output = path.join(root, 'release'); let version = require('../package.json').version;
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error('Missing release argument value.');
    if (args[i] === '--output') output = path.resolve(root, args[i + 1]);
    else if (args[i] === '--version') version = releaseVersion(args[i + 1]);
    else throw new Error('Supported arguments: --output <folder>, --version <stable-version>.');
  }
  releaseVersion(version);
  const stage = createStage(output);
  console.log(`Build staging directory: ${stage}`);
  const builder = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'out/cli/cli.js');
  run(process.execPath, [builder, '--config', 'electron-builder.cjs', '--win', '--x64', '--publish', 'never', `--config.directories.output=${stage}`, `--config.extraMetadata.version=${version}`]);
  run(process.execPath, [path.join(__dirname, 'verify-windows-package.cjs'), '--directory', stage, '--version', version]);
  if (signed) run(process.execPath, [path.join(__dirname, 'verify-windows-signatures.cjs'), '--directory', stage]);
  promote(stage, output, version);
  if (signed) fs.copyFileSync(path.join(stage, 'windows-signature-report.json'), path.join(output, 'windows-signature-report.json'));
  console.log(`Verified Windows release files: ${output}`);
  console.log('Open the Setup.exe to install. Staging directories are retained for verification; old builds and user data are never deleted automatically.');
} catch (error) {
  console.error(error.message);
  console.error('Existing builds were preserved. If a Setup.exe itself is locked, close that installer and retry.');
  process.exitCode = 1;
}
