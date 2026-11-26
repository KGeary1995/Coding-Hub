import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUNNER_PROTOCOL } from './protocol';

/**
 * The background runner's own copy of what it needs (docs/background-runner.md, section 3). Trace's Windows installer
 * stops every process running from the install folder and cannot replace a file one holds, so the runner never runs
 * from there: Electron's executable and the four files it needs as Node, the runner's scripts and node-pty are copied
 * into Trace's storage folder, into a folder named by their contents, once for each version of them.
 */
const RUNNER_SCRIPTS = ['runner-main.js', 'runner.js', 'protocol.js', 'tail.js', 'journal.js', 'jobs.js'];
/** Electron as Node needs only these beside its executable (checked 2026-11-24 with node-pty under Electron 39). */
const WINDOWS_RUNTIME = ['ffmpeg.dll', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin'];
export const RUNNER_EXECUTABLE = 'Trace Runner.exe';

export interface RunnerPlace { address: string; secretFile: string; kits: string }

/** Where this Trace's runner listens, and its secret. The address depends on the storage folder, so a test's or a
 * second install's runner never answers another's Trace. */
export function runnerPlace(storageRoot: string, platform: NodeJS.Platform = process.platform): RunnerPlace {
  const folder = path.join(storageRoot, 'runner');
  const address = platform === 'win32' ? `\\\\.\\pipe\\trace-runner-v${RUNNER_PROTOCOL}-${createHash('sha256').update(path.resolve(storageRoot).toLowerCase()).digest('hex').slice(0, 16)}` : path.join(folder, `v${RUNNER_PROTOCOL}.sock`);
  return { address, secretFile: path.join(folder, 'secret'), kits: path.join(folder, 'kits') };
}

/** The secret a Trace says hello with, made once and readable only by this user. */
export function runnerSecret(place: RunnerPlace): string {
  try { const saved = fs.readFileSync(place.secretFile, 'utf8').trim(); if (saved.length >= 32) return saved; } catch { /* Made below. */ }
  fs.mkdirSync(path.dirname(place.secretFile), { recursive: true, mode: 0o700 });
  const made = randomBytes(32).toString('base64url'); fs.writeFileSync(place.secretFile, made, { mode: 0o600 }); return made;
}

interface KitFile { from: string; to: string }

/** What a kit holds, from the app's folder (`app.getAppPath()`; Trace ships unpacked, asar is off) and Electron's. */
export function kitFiles(appPath: string, execPath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): KitFile[] {
  const files: KitFile[] = [];
  const built = path.join(appPath, 'dist-electron', 'electron', 'services');
  for (const name of RUNNER_SCRIPTS) files.push({ from: path.join(built, 'runner', name), to: path.join('app', 'dist-electron', 'electron', 'services', 'runner', name) });
  files.push({ from: path.join(built, 'cli', 'native-pty.js'), to: path.join('app', 'dist-electron', 'electron', 'services', 'cli', 'native-pty.js') });
  files.push({ from: path.join(built, 'chat', 'chat-process.js'), to: path.join('app', 'dist-electron', 'electron', 'services', 'chat', 'chat-process.js') });
  // node-pty finds its binary in build/Release (a local build) or prebuilds/<platform>-<arch>.
  const pty = path.join(appPath, 'node_modules', 'node-pty');
  for (const part of ['package.json', 'lib', path.join('prebuilds', `${platform}-${arch}`), path.join('build', 'Release')]) for (const file of walk(path.join(pty, part))) files.push({ from: file, to: path.join('app', 'node_modules', 'node-pty', path.relative(pty, file)) });
  if (platform === 'win32') {
    // The job-object helper (scripts/build-jobs-helper.cjs), when it was built: a source run without C++ tools has none.
    const helper = path.join(appPath, 'dist-electron', 'native', 'trace-jobs.exe'); if (fs.existsSync(helper)) files.push({ from: helper, to: path.join('app', 'dist-electron', 'native', 'trace-jobs.exe') });
    files.push({ from: execPath, to: RUNNER_EXECUTABLE });
    for (const name of WINDOWS_RUNTIME) files.push({ from: path.join(path.dirname(execPath), name), to: name });
  }
  return files.filter((file) => !file.from.endsWith('.pdb'));
}

function walk(target: string): string[] {
  let stat: fs.Stats; try { stat = fs.statSync(target); } catch { return []; }
  if (stat.isFile()) return [target];
  return fs.readdirSync(target).flatMap((name) => walk(path.join(target, name)));
}

export interface Kit { folder: string; program: string; script: string }

/**
 * The kit for this Trace, copied when it is not there yet. Its folder is named by the size and time of each file and
 * Electron's version, so a new Trace with changed runner files gets a new kit, and an unchanged one reuses it. A kit is
 * finished by renaming it into place, so a half-copied one is never used.
 */
export function ensureKit(place: RunnerPlace, appPath: string, execPath: string, platform: NodeJS.Platform = process.platform): Kit {
  const files = kitFiles(appPath, execPath, platform);
  const missing = files.find((file) => !fs.existsSync(file.from)); if (missing) throw new Error(`The background runner's file ${missing.from} is missing.`);
  const hash = createHash('sha256').update(`${process.versions.electron ?? process.version}|${RUNNER_PROTOCOL}`);
  for (const file of files) { const stat = fs.statSync(file.from); hash.update(`${file.to}|${stat.size}|${stat.mtimeMs}`); }
  const folder = path.join(place.kits, `kit-${hash.digest('hex').slice(0, 16)}`);
  const kit = { folder, program: platform === 'win32' ? path.join(folder, RUNNER_EXECUTABLE) : execPath, script: path.join(folder, 'app', 'dist-electron', 'electron', 'services', 'runner', 'runner-main.js') };
  if (fs.existsSync(kit.script)) return kit;
  const staging = `${folder}.${process.pid}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  for (const file of files) { const to = path.join(staging, file.to); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(file.from, to); }
  try { fs.renameSync(staging, folder); } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); if (!fs.existsSync(kit.script)) throw error; }
  return kit;
}

/**
 * Removes kits no runner uses: every one but `keep` (this Trace's, and the one the answering runner runs from). Each is
 * renamed first, which Windows refuses while a program in it runs (a runner on an older protocol, still draining), so
 * a kit in use is never half deleted: its runner loads node-pty's files again for each terminal it starts.
 */
export function removeOldKits(place: RunnerPlace, keep: string[]) {
  let names: string[]; try { names = fs.readdirSync(place.kits); } catch { return; }
  const kept = new Set(keep.map((folder) => path.resolve(folder).toLowerCase()));
  for (const name of names) {
    const folder = path.join(place.kits, name); if (kept.has(path.resolve(folder).toLowerCase())) continue;
    const trash = name.endsWith('.trash') ? folder : `${folder}.${process.pid}.trash`;
    try { if (trash !== folder) fs.renameSync(folder, trash); fs.rmSync(trash, { recursive: true, force: true }); } catch { /* In use: removed another time. */ }
  }
}

/** Starts the runner from its kit, detached: it outlives this Trace and is never in its process tree's way. */
export function startRunner(kit: Kit, place: RunnerPlace) {
  const child = spawn(kit.program, [kit.script], { cwd: kit.folder, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODING_HUB_RUNNER_ADDRESS: place.address, CODING_HUB_RUNNER_SECRET_FILE: place.secretFile } });
  child.on('error', () => {}); child.unref();
}

/** The ports Trace's hook and channel-tool servers had, so they come back on them (agents still running call there). */
export interface SavedPorts { attention?: number | null; tools?: number | null }
export function readPorts(place: RunnerPlace): SavedPorts {
  try { const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(place.secretFile), 'ports.json'), 'utf8')) as SavedPorts; return { attention: Number(saved.attention) || null, tools: Number(saved.tools) || null }; } catch { return {}; }
}
export function writePorts(place: RunnerPlace, ports: SavedPorts) {
  fs.mkdirSync(path.dirname(place.secretFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(path.dirname(place.secretFile), 'ports.json'), JSON.stringify(ports), { mode: 0o600 });
}
