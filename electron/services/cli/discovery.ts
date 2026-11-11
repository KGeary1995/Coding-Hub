import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CLIEngine } from '../../../shared/types';
import type { EngineInfo } from '../../../shared/ipc';
import { classifyAuthentication, type ProbeResult } from './auth-status';
import { HubError } from './engine-adapter';
import { GEMINI_COMMAND } from '../../../shared/gemini';

export interface Executable { file: string; prefixArgs: string[]; extraEnv: Record<string, string>; displayPath: string }
export interface DiscoveredEngine { info: EngineInfo; executable: Executable | null }

/**
 * The PATH a login shell sets up. A Mac app opened from Finder or the Dock starts with only the system folders, so a
 * CLI (or the Node.js it runs on) installed through nvm, asdf, Volta or a shell profile would not be found. The PATH is
 * printed between markers so anything a profile prints is ignored. Returns null when the shell does not answer.
 */
export function loginShellPath(shell = process.env.SHELL || '/bin/zsh', run: (file: string, args: string[]) => string = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })): string | null {
  try {
    const output = run(shell, ['-ilc', 'printf "__TRACE_PATH__%s__TRACE_PATH__" "$PATH"']);
    const value = /__TRACE_PATH__(.*?)__TRACE_PATH__/s.exec(output)?.[1]?.trim();
    return value && value.includes('/') ? value : null;
  } catch { return null; }
}

/** Adds the login shell's PATH folders after the current ones, once, for a Mac app opened outside a terminal. */
export function adoptLoginShellPath(env: NodeJS.ProcessEnv = process.env, read: () => string | null = loginShellPath) {
  const shellPath = read(); if (!shellPath) return;
  // A login shell PATH is always colon-separated (macOS and Linux), whatever platform runs this.
  env.PATH = [...new Set([...(env.PATH ?? '').split(':'), ...shellPath.split(':')].filter(Boolean))].join(':');
}

/** Variables Claude Code sets for the processes it starts, naming its own session, account and host app. */
const AGENT_SESSION = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_AGENT_SDK_.*|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|HOST_SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|DESKTOP_APP_VERSION|TERMINAL_MCP_TOOLS|SDK_.*|OAUTH_.*|ACCOUNT_UUID|USER_EMAIL|EAGER_FLUSH|EMIT_STARTUP_TIMING|ENABLE_ASK_USER_QUESTION_TOOL|SIMPLE|DISABLE_CRON))$/;
/**
 * Trace started from inside a Claude session (the desktop app or a terminal agent asked to open or update it) inherits
 * that session's variables. Passed on, they make every Claude Code channel act as part of that other session: it did
 * not save its conversation, so a restart resumed from before them. Only those variables go, and only when Claude Code
 * set them (CLAUDECODE or CLAUDE_CODE_ENTRYPOINT is present); settings the person exported, such as a model or
 * provider, stay.
 */
export function withoutAgentSession(env: Record<string, string>): Record<string, string> {
  if (!env.CLAUDECODE && !env.CLAUDE_CODE_ENTRYPOINT) return env;
  return Object.fromEntries(Object.entries(env).filter(([key]) => !AGENT_SESSION.test(key)));
}

const REGISTRY_PATHS = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'];
/** Reads one `Path` value with reg.exe; null when it is missing or reg.exe fails. */
function readRegistryPath(key: string): string | null {
  try {
    const output = execFileSync('reg.exe', ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output)?.[1]?.trim() || null;
  } catch { return null; }
}

/**
 * Windows' current PATH, machine folders then the person's, as a new terminal would get it. Trace's own PATH is fixed
 * when it starts, so without this a CLI or tool installed while Trace runs (Node.js, winget, an npm with its own prefix,
 * a folder added in System Properties) is not found until Trace restarts. `%NAME%` references are expanded from `env`.
 */
export function windowsRegistryPath(env: Record<string, string>, read: (key: string) => string | null = readRegistryPath): string[] {
  const lookup = new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  return REGISTRY_PATHS.flatMap((key) => (read(key) ?? '').split(';'))
    .map((folder) => folder.trim().replace(/%([^%]+)%/g, (whole, name: string) => lookup.get(name.toUpperCase()) ?? whole)).filter(Boolean);
}

/** Adds each folder once (Windows compares paths without case), keeping the first copy's position. */
export function mergePath(folders: string[], windows = process.platform === 'win32'): string[] {
  const seen = new Set<string>(); const result: string[] = [];
  for (const folder of folders) {
    if (!folder) continue;
    const key = windows ? folder.replace(/^"|"$/g, '').replace(/[\\/]+$/, '').toLowerCase() : folder;
    if (!seen.has(key)) { seen.add(key); result.push(folder); }
  }
  return result;
}

/** The registry is read at most every few seconds; a burst of launches shares one read. */
let registryCache: { at: number; folders: string[] } | null = null;
function currentRegistryPath(env: Record<string, string>) {
  if (registryCache && Date.now() - registryCache.at < 5000) return registryCache.folders;
  registryCache = { at: Date.now(), folders: windowsRegistryPath(env) };
  return registryCache.folders;
}

export function hostEnvironment(registry: (env: Record<string, string>) => string[] = currentRegistryPath): Record<string, string> {
  const env = withoutAgentSession(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const extra = process.platform === 'win32'
    ? [...registry(env), path.join(os.homedir(), '.local', 'bin'), ...(env.APPDATA ? [path.join(env.APPDATA, 'npm')] : [])]
    : [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  env[pathKey] = mergePath([...(env[pathKey] ?? '').split(path.delimiter), ...extra]).join(path.delimiter);
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
  throw new HubError('CLI_NOT_FOUND', `${engine === 'claude' ? 'Claude Code' : 'Codex'} was not found on PATH. Install the official CLI and restart Trace from a terminal where it runs.`);
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
    info.supportsChrome = engine === 'claude' && advertisesFlag(help, '--chrome');
    info.supportsPermissions =engine === 'claude' ? advertisesFlag(help, '--permission-mode') && advertisesFlag(help, '--allow-dangerously-skip-permissions') : advertisesFlag(help, '--ask-for-approval') && advertisesFlag(help, '--sandbox');
    info.authentication = await checkAuthentication(engine, executable, help, env);
    info.available = true;
    return { info, executable };
  } catch (error) {
    info.error = error instanceof HubError ? error.message : 'CLI discovery failed. Check the local installation.';
    return { info, executable: null };
  }
}

/**
 * Gemini CLI (agy) on PATH. It is a native program (agy.exe on Windows), never an npm shim, so only executables are
 * taken: .exe and .com on Windows, an executable file elsewhere.
 */
export async function findGeminiExecutable(env = hostEnvironment()): Promise<Executable> {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const extensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const directory of (env[pathKey] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), GEMINI_COMMAND + extension);
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return { file: candidate, prefixArgs: [], extraEnv: {}, displayPath: candidate };
      } catch { /* Keep looking. */ }
    }
  }
  throw new HubError('CLI_NOT_FOUND', 'Gemini CLI (agy) was not found on PATH. Install it, sign in to it, then refresh Local engines.');
}

/**
 * Gemini CLI's version and the flags a Gemini channel uses. agy lists no login status command, so authentication stays
 * unknown and agy handles its own sign-in.
 */
export async function discoverGemini(env = hostEnvironment(), find: typeof findGeminiExecutable = findGeminiExecutable): Promise<DiscoveredEngine> {
  const info: EngineInfo = { engine: 'gemini', available: false, executable: null, version: null, supportsModel: false, supportsConfig: false, supportsNoDaemon: false, error: null, checkedAt: new Date().toISOString() };
  try {
    const executable = await find(env);
    info.executable = executable.displayPath;
    const [version, help] = await Promise.all([probe(executable, '--version', env), probe(executable, '--help', env)]);
    info.version = version.trim().split(/\r?\n/)[0]?.trim().slice(0, 120) || null;
    info.supportsModel = advertisesFlag(help, '--model');
    info.supportsMode = advertisesFlag(help, '--mode');
    info.supportsSkipPermissions = advertisesFlag(help, '--dangerously-skip-permissions');
    // Listed under "Available subcommands" as `  acp   Start the Agent Client Protocol (ACP) stdio server`.
    info.supportsAcp = /^\s+acp\s/m.test(help);
    info.authentication = { state: 'unknown', checkedAt: new Date().toISOString(), message: 'Gemini CLI has no sign-in check that Trace can run; agy handles its own sign-in.' };
    info.available = true;
    return { info, executable };
  } catch (error) {
    info.error = error instanceof HubError ? error.message : 'Gemini CLI discovery failed. Check the local installation.';
    return { info, executable: null };
  }
}
