import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { HubError } from '../cli/engine-adapter';
import { nodeScriptCommand } from '../cli/discovery';

/** A command ready to start: the program, its arguments and its environment. */
export interface Launch { file: string; args: string[]; env: Record<string, string> }

const SCRIPT = /\.(?:js|cjs|mjs)$/i;
/** Windows' npm, npx, pnpm and yarn are .cmd files, which never start without a shell: their Node scripts run instead. */
const NODE_TOOLS: Record<string, string[]> = { npm: ['node_modules/npm/bin/npm-cli.js'], npx: ['node_modules/npm/bin/npx-cli.js'], pnpm: ['node_modules/pnpm/bin/pnpm.cjs'], yarn: ['node_modules/yarn/bin/yarn.js'] };

/**
 * Where a plugin command's program is (docs/plugins.md, section 2), never through a shell: a path (it has a slash or
 * starts with a dot) inside the plugin's folder, or a program name on PATH. A .js script runs with Node. On Windows a
 * .cmd or .bat cannot start without a shell, so it is refused with what to use instead.
 */
export function resolveCommand(folder: string, command: string[], env: Record<string, string>, platform: NodeJS.Platform = process.platform): Launch {
  const [first, ...rest] = command; const root = path.resolve(folder);
  if (/[\\/]/.test(first) || first.startsWith('.')) {
    const file = path.resolve(root, first); const inside = path.relative(root, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new HubError('PLUGIN_COMMAND', `${first} is outside the plugin's folder.`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HubError('PLUGIN_COMMAND', `${first} is not in the plugin's folder.`);
    return program(file, rest, env, platform);
  }
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const folders = (env[key] ?? '').split(path.delimiter).filter(Boolean).map((item) => item.replace(/^"|"$/g, ''));
  if (platform === 'win32' && NODE_TOOLS[first.toLowerCase()]) for (const base of folders) for (const entry of NODE_TOOLS[first.toLowerCase()]) { const file = path.join(base, entry); if (fs.existsSync(file)) return program(file, rest, env, platform); }
  const names = platform === 'win32' ? (/\.\w+$/.test(first) ? [first] : [`${first}.exe`, `${first}.com`, first]) : [first];
  for (const base of folders) for (const name of names) { const file = path.join(base, name); try { if (fs.statSync(file).isFile()) return program(file, rest, env, platform); } catch { /* Not here. */ } }
  throw new HubError('PLUGIN_COMMAND', `${first} was not found on this computer's PATH. Install it, or give the plugin's own program by its path in the plugin folder.`);
}

function program(file: string, args: string[], env: Record<string, string>, platform: NodeJS.Platform): Launch {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) throw new HubError('PLUGIN_COMMAND', `${path.basename(file)} is a batch file, which Windows starts only through a shell. Run a .exe, or a script with its interpreter (node, python, pwsh).`);
  if (SCRIPT.test(file)) { const node = nodeScriptCommand(file, env, platform); return { ...node, args: [...node.args, ...args] }; }
  return { file, args, env };
}

export interface RunResult { code: number | null; signal: string | null; output: string; timedOut: boolean; error?: string }
const KEEP = 64 * 1024;
/** Runs a launch to its end (or `timeoutMs`), keeping the last 64 KB of its output. `started` gets the process, to stop it. */
export function runLaunch(launch: Launch, cwd: string, timeoutMs: number, started?: (child: ChildProcess) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = ''; let timedOut = false; let settled = false;
    const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-KEEP); };
    let child: ChildProcess;
    try { child = spawn(launch.file, launch.args, { cwd, env: launch.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: null, signal: null, output: '', timedOut: false, error: error instanceof Error ? error.message : 'It could not start.' }); return; }
    started?.(child);
    child.stdout?.on('data', keep); child.stderr?.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const end = (result: RunResult) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    child.once('error', (error) => end({ code: null, signal: null, output, timedOut, error: `It could not start: ${error.message}` }));
    child.once('close', (code, signal) => end({ code, signal, output, timedOut }));
  });
}
