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

/** Resolve Windows npm shims to JavaScript; never interpolate argv into cmd.exe. */
export async function npmEntryForShim(shim: string, engine: CLIEngine): Promise<Executable> {
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
  return { file: process.execPath, prefixArgs: [entry], extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, displayPath: shim };
}

export async function findExecutable(engine: CLIEngine, env = hostEnvironment()): Promise<Executable> {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const extensions = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat', ''] : [''];
  for (const directory of (env[pathKey] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), engine + extension);
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
      } catch { continue; }
      if (/\.(cmd|bat)$/i.test(candidate)) return npmEntryForShim(candidate, engine);
      return { file: candidate, prefixArgs: [], extraEnv: {}, displayPath: candidate };
    }
  }
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
    const [version, help] = await Promise.all([probe(executable, '--version', env), probe(executable, '--help', env)]);
    info.version = version.trim().split('\n').at(-1)?.slice(0, 120) ?? null;
    info.supportsModel = advertisesFlag(help, '--model');
    info.supportsConfig = advertisesFlag(help, '--config');
    info.supportsNoDaemon = advertisesFlag(help, '--no-daemon');
    info.supportsSessionId = advertisesFlag(help, '--session-id');
    info.authentication = await checkAuthentication(engine, executable, help, env);
    info.available = true;
    return { info, executable };
  } catch (error) {
    info.error = error instanceof HubError ? error.message : 'CLI discovery failed. Check the local installation.';
    return { info, executable: null };
  }
}
