import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CLIEngine } from '../../../shared/types';
import type { EngineInfo } from '../../../shared/ipc';
import { classifyAuthentication, type ProbeResult } from './auth-status';
import { HubError } from './engine-adapter';

export interface Executable { file: string; prefixArgs: string[]; extraEnv: Record<string, string>; displayPath: string }
export interface DiscoveredEngine { info: EngineInfo; executable: Executable | null }

export function hostEnvironment(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const extra = process.platform === 'win32'
    ? [path.join(os.homedir(), '.local', 'bin'), ...(env.APPDATA ? [path.join(env.APPDATA, 'npm')] : [])]
    : [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  env[pathKey] = [...(env[pathKey] ?? '').split(path.delimiter), ...extra].filter(Boolean).join(path.delimiter);
  return env;
}

/**
 * ELECTRON_RUN_AS_NODE is read once at startup. Remove it before the CLI runs so it does not leak into
 * every command the agent spawns (an Electron app started from an agent would otherwise run as Node).
 */
export const CLEAR_RUN_AS_NODE = '--import=data:text/javascript,delete%20process.env.ELECTRON_RUN_AS_NODE';

/** Resolve Windows npm shims to JavaScript; never interpolate argv into cmd.exe. */
export async function npmEntryForShim(shim: string, engine: CLIEngine, architecture: string = process.arch, node: string | null = null): Promise<Executable> {
  const packageName = engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
  const packageRoot = path.join(path.dirname(shim), 'node_modules', ...packageName.split('/'));
  let entry: string;
  try {
    const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const relative = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[engine];
    if (!relative) throw new Error('Missing CLI entry');
    entry = path.resolve(packageRoot, relative);
    if (!entry.startsWith(packageRoot + path.sep) || !(await stat(entry)).isFile()) throw new Error('Invalid CLI entry');
  } catch {
    throw new HubError('UNSUPPORTED_WINDOWS_SHIM', `Cannot resolve ${engine}'s npm launcher. Reinstall its official CLI, or use the native executable.`);
  }
  if (/\.exe$/i.test(entry)) return { file: entry, prefixArgs: [], extraEnv: {}, displayPath: entry };
  // Codex is a native console program. Attach ConPTY directly to that binary,
  // avoiding an Electron/Node wrapper between the terminal and the Rust TUI.
  if (engine === 'codex' && ['x64', 'arm64'].includes(architecture)) {
    const triple = architecture === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
    const vendors = [path.join(packageRoot, 'vendor')];
    try { vendors.unshift(path.join(path.dirname(createRequire(path.join(packageRoot, 'package.json')).resolve(`@openai/codex-win32-${architecture}/package.json`)), 'vendor')); } catch { /* Older releases bundle vendor directly. */ }
    for (const vendor of vendors) for (const folder of ['bin', 'codex']) {
      const binary = path.join(vendor, triple, folder, 'codex.exe');
      try { if ((await stat(binary)).isFile()) return { file: binary, prefixArgs: [], extraEnv: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: packageRoot }, displayPath: binary }; } catch { /* Keep the JS fallback for older/fixture packages. */ }
    }
  }
  // electron.exe is a Windows GUI program: in a pseudoconsole it shows no output at all. npm shims imply an
  // installed Node.js, a console program, so run the JavaScript entry with it and keep Electron as a fallback.
  if (node) return { file: node, prefixArgs: [entry], extraEnv: {}, displayPath: shim };
  return { file: process.execPath, prefixArgs: [CLEAR_RUN_AS_NODE, entry], extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, displayPath: shim };
}

/** The first regular `node.exe` on PATH (Windows only; elsewhere npm shims are runnable scripts). */
async function findNode(directories: string[]): Promise<string | null> {
  for (const directory of directories) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), 'node.exe');
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* Keep looking. */ }
  }
  return null;
}

export async function findExecutable(engine: CLIEngine, env = hostEnvironment()): Promise<Executable> {
  let shimError: unknown = null;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  let node: Promise<string | null> | null = null;
  // Windows cannot run extensionless files (npm/pnpm/yarn put POSIX sh shims there), so never pick one.
  const extensions = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  for (const directory of (env[pathKey] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), engine + extension);
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
      } catch { continue; }
      // A yarn/pnpm shim earlier on PATH must not hide a working executable later on PATH.
      if (/\.(cmd|bat)$/i.test(candidate)) {
        node ??= findNode((env[pathKey] ?? '').split(path.delimiter).filter(Boolean));
        try { return await npmEntryForShim(candidate, engine, process.arch, await node); } catch (error) { shimError ??= error; continue; }
      }
      return { file: candidate, prefixArgs: [], extraEnv: {}, displayPath: candidate };
    }
  }
  if (shimError) throw shimError;
  throw new HubError('CLI_NOT_FOUND', `${engine === 'claude' ? 'Claude Code' : 'Codex'} was not found on PATH. Install the official CLI and restart Coding Hub from a terminal where it runs.`);
}

export function probeCLI(executable: Executable, args: string[], env: Record<string, string>): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(executable.file, [...executable.prefixArgs, ...args], { env: { ...env, ...executable.extraEnv }, timeout: 8000, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0, timedOut: Boolean(error?.killed) });
    });
  });
}
function probe(executable: Executable, flag: string, env: Record<string, string>): Promise<string> {
  return probeCLI(executable, [flag], env).then((result) => {
    if (result.exitCode !== 0) throw new HubError('CLI_PROBE_FAILED', 'CLI version/help check failed or timed out. Run the CLI in a terminal to resolve installation issues.');
    return result.stdout + '\n' + result.stderr;
  });
}
export function advertisesFlag(help: string, flag: string): boolean {
  return new RegExp(`(?:^|[\\s,])${flag}(?=[\\s=,]|$)`, 'm').test(help);
}
export async function checkAuthentication(engine: CLIEngine, executable: Executable, help: string, env: Record<string, string>) {
  const command = engine === 'claude' ? 'auth' : 'login';
  const unknown = () => classifyAuthentication(engine, { stdout: '', stderr: '', exitCode: null, timedOut: false });
  if (!new RegExp(`^\\s*${command}\\b`, 'm').test(help)) return unknown();
  const subhelp = await probeCLI(executable, [command, '--help'], env);
  if (subhelp.exitCode !== 0 || !/^\s*status\b/m.test(subhelp.stdout + '\n' + subhelp.stderr)) return unknown();
  const result = await probeCLI(executable, [command, 'status'], env);
  return classifyAuthentication(engine, result);
}

export async function discoverEngine(engine: CLIEngine, env = hostEnvironment()): Promise<DiscoveredEngine> {
  const info: EngineInfo = { engine, available: false, executable: null, version: null, supportsModel: false, supportsConfig: false, supportsNoDaemon: false, error: null, checkedAt: new Date().toISOString() };
  try {
    const executable = await findExecutable(engine, env);
    info.executable = executable.displayPath;
    const [version, help] = await Promise.all([probeCLI(executable, ['--version'], env), probe(executable, '--help', env)]);
    if (version.exitCode !== 0) throw new HubError('CLI_PROBE_FAILED', 'CLI version/help check failed or timed out. Run the CLI in a terminal to resolve installation issues.');
    // Runtime warnings go to stderr; prefer the first stdout line so launch checks parse the real version.
    info.version = (version.stdout.trim() || version.stderr.trim()).split(/\r?\n/)[0]?.trim().slice(0, 120) || null;
    info.supportsResume = engine === 'claude' ? advertisesFlag(help, '--resume') : /^\s*resume\b/m.test(help);
    info.supportsModel = advertisesFlag(help, '--model');
    info.supportsConfig = advertisesFlag(help, '--config');
    info.supportsNoDaemon = advertisesFlag(help, '--no-daemon');
    info.supportsSessionId = advertisesFlag(help, '--session-id');
    info.supportsAppendSystemPrompt = advertisesFlag(help, '--append-system-prompt');
    info.supportsMcpConfig = advertisesFlag(help, '--mcp-config');
    info.supportsSettings = advertisesFlag(help, '--settings');
    info.authentication = await checkAuthentication(engine, executable, help, env);
    info.available = true;
    return { info, executable };
  } catch (error) {
    info.error = error instanceof HubError ? error.message : 'CLI discovery failed. Check the local installation.';
    return { info, executable: null };
  }
}
