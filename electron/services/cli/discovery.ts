import { createRequire } from 'node:module';
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { constants, mkdirSync, statSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CLIEngine } from '../../../shared/types';
import type { EngineInfo } from '../../../shared/ipc';
import { classifyAuthentication, type ProbeResult } from './auth-status';
import { atLeast } from './attention';
import { HubError } from './engine-adapter';

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
/** Reads one `Path` value with reg.exe, without blocking the main process; null when it is missing or reg.exe fails. */
function readRegistryPath(key: string): Promise<string | null> {
  return new Promise((resolve) => execFile('reg.exe', ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 3000, windowsHide: true }, (error, output) => {
    resolve(error ? null : /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output)?.[1]?.trim() || null);
  }));
}

/**
 * Windows' current PATH, machine folders then the person's, as a new terminal would get it. Trace's own PATH is fixed
 * when it starts, so without this a CLI or tool installed while Trace runs (Node.js, winget, an npm with its own prefix,
 * a folder added in System Properties) is not found until Trace restarts. `%NAME%` references are expanded from `env`.
 */
export async function windowsRegistryPath(env: Record<string, string>, read: (key: string) => string | null | Promise<string | null> = readRegistryPath): Promise<string[]> {
  const lookup = new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  const values = await Promise.all(REGISTRY_PATHS.map(async (key) => { try { return await read(key); } catch { return null; } }));
  return values.flatMap((value) => (value ?? '').split(';'))
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

/**
 * The registry PATH, read in the background so no caller waits for reg.exe on the main process (Git calls, plan limits
 * and task checks ask for an environment often). `current()` answers with the last read and starts a new one once it is
 * older than `freshMilliseconds`; `refresh()` waits for a read that new, as a channel start does, so a CLI installed a
 * moment ago is still found. A burst of callers shares one read.
 */
export class RegistryPath {
  private value: { at: number; folders: string[] } | null = null;
  private reading: Promise<string[]> | null = null;
  constructor(private read: (env: Record<string, string>) => Promise<string[]> = (env) => windowsRegistryPath(env), private freshMilliseconds = 5000, private now: () => number = () => Date.now()) {}
  /** The folders last read (none before the first read finishes: Trace's own PATH has them from its start). */
  current(env: Record<string, string>): string[] { if (!this.fresh()) void this.refresh(env); return this.value?.folders ?? []; }
  refresh(env: Record<string, string>): Promise<string[]> {
    if (this.fresh()) return Promise.resolve(this.value!.folders);
    this.reading ??= this.read(env).then((folders) => { this.value = { at: this.now(), folders }; return folders; }, () => this.value?.folders ?? []).finally(() => { this.reading = null; });
    return this.reading;
  }
  private fresh() { return this.value !== null && this.now() - this.value.at < this.freshMilliseconds; }
}
const registryPath = new RegistryPath();

/**
 * Variables Chromium sets for its own processes. CHROME_CRASHPAD_PIPE_NAME names Trace's crash handler: an Electron or
 * Chromium program started in a channel (a dev build, a smoke test) would send its crash dumps into Trace's folder.
 */
const CHROMIUM_INTERNAL = /^CHROME_CRASHPAD_PIPE_NAME$/i;
/** Trace's own environment, without what belongs to the session or app that started it. */
function inheritedEnvironment(): Record<string, string> {
  return withoutAgentSession(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !CHROMIUM_INTERNAL.test(entry[0]))));
}

export function hostEnvironment(registry: (env: Record<string, string>) => string[] = (env) => registryPath.current(env)): Record<string, string> {
  const env = inheritedEnvironment();
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const extra = process.platform === 'win32'
    ? [...registry(env), path.join(os.homedir(), '.local', 'bin'), ...(env.APPDATA ? [path.join(env.APPDATA, 'npm')] : [])]
    : [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  env[pathKey] = mergePath([...(env[pathKey] ?? '').split(path.delimiter), ...extra]).join(path.delimiter);
  return env;
}

/**
 * hostEnvironment() with a registry PATH read no more than a few seconds ago: what a channel start and every "is this
 * CLI installed" check uses, so installing a tool and pressing Refresh finds it the first time.
 */
export async function freshHostEnvironment(registry: RegistryPath = registryPath): Promise<Record<string, string>> {
  if (process.platform === 'win32') await registry.refresh(inheritedEnvironment());
  return hostEnvironment((env) => registry.current(env));
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
export function findNodeSync(directories: string[]): string | null {
  for (const directory of directories) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), 'node.exe');
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* Keep looking. */ }
  }
  return null;
}
export async function findNode(directories: string[]): Promise<string | null> { return findNodeSync(directories); }

/**
 * How to run a package manager's JavaScript entry. Trace.exe has no console to hand down, so the cmd.exe npm starts for a
 * script would open a visible one: on Windows a console `node.exe` from PATH runs it instead, and Trace itself as Node is the fallback.
 */
export function nodeScriptCommand(entry: string, env: Record<string, string>, platform: NodeJS.Platform = process.platform): { file: string; args: string[]; env: Record<string, string> } {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const node = platform === 'win32' ? findNodeSync((env[key] ?? '').split(path.delimiter).filter(Boolean)) : null;
  return node ? { file: node, args: [entry], env } : { file: process.execPath, args: [CLEAR_RUN_AS_NODE, entry], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

/** The program each engine is: Gemini CLI installs as `agy`. */
export const ENGINE_COMMAND: Record<CLIEngine, string> = { claude: 'claude', codex: 'codex', gemini: 'agy' };
/** Each engine's name in messages. */
export const ENGINE_NAME: Record<CLIEngine, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini (agy)' };

export async function findExecutable(engine: CLIEngine, environment?: Record<string, string>): Promise<Executable> {
  // Smoke tests start Trace with this set: their fixtures have no agy, and the person's own must not run (or be asked
  // for its sign-in) from a test.
  if (engine === 'gemini' && process.env.CODING_HUB_TEST_NO_GEMINI === '1') throw new HubError('CLI_NOT_FOUND', `${ENGINE_NAME.gemini} was not found on PATH. Install the official CLI and restart Trace from a terminal where it runs.`);
  const env = environment ?? await freshHostEnvironment();
  let shimError: unknown = null;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  let node: Promise<string | null> | null = null;
  // Windows cannot run extensionless files (npm/pnpm/yarn put POSIX sh shims there), so never pick one.
  const extensions = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  for (const directory of (env[pathKey] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), ENGINE_COMMAND[engine] + extension);
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
      } catch { continue; }
      // A yarn/pnpm shim earlier on PATH must not hide a working executable later on PATH.
      if (/\.(cmd|bat)$/i.test(candidate)) {
        // agy is a native program; a script by its name is not one Trace knows how to run without a shell.
        if (engine === 'gemini') continue;
        node ??= findNode((env[pathKey] ?? '').split(path.delimiter).filter(Boolean));
        try { return await npmEntryForShim(candidate, engine, process.arch, await node); } catch (error) { shimError ??= error; continue; }
      }
      return { file: candidate, prefixArgs: [], extraEnv: {}, displayPath: candidate };
    }
  }
  if (shimError) throw shimError;
  throw new HubError('CLI_NOT_FOUND', `${ENGINE_NAME[engine]} was not found on PATH. Install the official CLI and restart Trace from a terminal where it runs.`);
}

/**
 * Set for every background question to a CLI. Any run of agy checks for its own update, at most every 15 minutes: it
 * starts a detached `agy --bg-updater`, and that one's `agy --version` opened a console window on Windows each time
 * (agy 1.5.14, 2026-11-21: a window flashed with the usage check, over a full-screen game). agy reads only the value
 * `true` ("1" changes nothing). A channel's own agy is started without it and still updates itself.
 */
export const PROBE_ENVIRONMENT = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };

/** An empty folder of Trace's own for background questions: agy opens its working folder as a workspace and watches its files, so it must not be the folder Trace started in. */
export function probeDirectory(): string {
  const directory = path.join(os.tmpdir(), 'trace-cli-probe');
  try { mkdirSync(directory, { recursive: true }); return directory; } catch { return os.tmpdir(); }
}
/** A question has no input to give: closing stdin ends the wait `claude -p` makes for it (3 seconds). */
export function closeInput(child: ChildProcess) { child.stdin?.on('error', () => {}); child.stdin?.end(); }

export function probeCLI(executable: Executable, args: string[], env: Record<string, string>): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = execFile(executable.file, [...executable.prefixArgs, ...args], { cwd: probeDirectory(), env: { ...env, ...executable.extraEnv, ...PROBE_ENVIRONMENT }, timeout: 8000, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0, timedOut: Boolean(error?.killed) });
    });
    closeInput(child);
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
/**
 * agy 1.1.11 answers `-p "/usage"` itself (no model turn, no quota). An older agy would send the text to the model as a
 * prompt, so the check runs only from that version.
 */
export const GEMINI_USAGE_COMMAND = [1, 1, 11] as const;
export const GEMINI_USAGE_ARGS = ['-p', '/usage', '--output-format', 'json'];
export async function checkAuthentication(engine: CLIEngine, executable: Executable, help: string, env: Record<string, string>, version: string | null = null, probe: typeof probeCLI = probeCLI) {
  if (engine === 'gemini') return atLeast(version, ...GEMINI_USAGE_COMMAND) ? classifyAuthentication(engine, await probe(executable, GEMINI_USAGE_ARGS, env)) : classifyAuthentication(engine, { stdout: '', stderr: '', exitCode: null, timedOut: false });
  const command = engine === 'claude' ? 'auth' : 'login';
  const unknown = () => classifyAuthentication(engine, { stdout: '', stderr: '', exitCode: null, timedOut: false });
  if (!new RegExp(`^\\s*${command}\\b`, 'm').test(help)) return unknown();
  const subhelp = await probeCLI(executable, [command, '--help'], env);
  // A CLI too slow to answer says nothing about the login; reported as such, not as an unsupported check.
  if (subhelp.timedOut) return classifyAuthentication(engine, subhelp);
  if (subhelp.exitCode !== 0 || !/^\s*status\b/m.test(subhelp.stdout + '\n' + subhelp.stderr)) return unknown();
  const result = await probeCLI(executable, [command, 'status'], env);
  return classifyAuthentication(engine, result);
}

/**
 * `authentication: false` skips the two sign-in probes (`auth --help`, `auth status`); a channel start needs them only
 * for a named Claude profile, and without them a start waits for two CLI runs instead of four.
 */
export async function discoverEngine(engine: CLIEngine, environment?: Record<string, string>, options: { authentication?: boolean } = {}): Promise<DiscoveredEngine> {
  const env = environment ?? await freshHostEnvironment();
  const info: EngineInfo = { engine, available: false, executable: null, version: null, supportsModel: false, supportsConfig: false, supportsNoDaemon: false, error: null, checkedAt: new Date().toISOString() };
  try {
    const executable = await findExecutable(engine, env);
    info.executable = executable.displayPath;
    const [version, help] = await Promise.all([probeCLI(executable, ['--version'], env), probe(executable, '--help', env)]);
    if (version.exitCode !== 0) throw new HubError('CLI_PROBE_FAILED', 'CLI version/help check failed or timed out. Run the CLI in a terminal to resolve installation issues.');
    // Runtime warnings go to stderr; prefer the first stdout line so launch checks parse the real version.
    info.version = (version.stdout.trim() || version.stderr.trim()).split(/\r?\n/)[0]?.trim().slice(0, 120) || null;
    info.supportsResume = engine === 'claude' ? advertisesFlag(help, '--resume') : engine === 'gemini' ? advertisesFlag(help, '--conversation') : /^\s*resume\b/m.test(help);
    info.supportsModel = advertisesFlag(help, '--model');
    info.supportsConfig = advertisesFlag(help, '--config');
    info.supportsNoDaemon = advertisesFlag(help, '--no-daemon');
    info.supportsSessionId = advertisesFlag(help, '--session-id');
    info.supportsAppendSystemPrompt = advertisesFlag(help, '--append-system-prompt');
    info.supportsMcpConfig = advertisesFlag(help, '--mcp-config');
    info.supportsSettings = advertisesFlag(help, '--settings');
    info.supportsChrome = engine === 'claude' && advertisesFlag(help, '--chrome');
    info.supportsPermissions = engine === 'claude' ? advertisesFlag(help, '--permission-mode') && advertisesFlag(help, '--allow-dangerously-skip-permissions')
      : engine === 'gemini' ? advertisesFlag(help, '--mode') && advertisesFlag(help, '--dangerously-skip-permissions') && advertisesFlag(help, '--settings')
      : advertisesFlag(help, '--ask-for-approval') && advertisesFlag(help, '--sandbox');
    if (options.authentication !== false) info.authentication = await checkAuthentication(engine, executable, help, env, info.version);
    info.available = true;
    return { info, executable };
  } catch (error) {
    info.error = error instanceof HubError ? error.message : 'CLI discovery failed. Check the local installation.';
    return { info, executable: null };
  }
}
