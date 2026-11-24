import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HubError } from '../cli/engine-adapter';
import { hostEnvironment } from '../cli/discovery';
import { listenLoopback } from '../cli/loopback';
import { execFileTree } from '../repository/process-tree';
import { EXTENSION_ID, vsix } from './vscode-extension';

/** Where the extension finds Trace: this computer's address and key, readable by this user only. */
export const connectionFile = (home = os.homedir()) => path.join(home, '.coding-hub', 'editor', 'connection.json');
/** A channel the extension may send to: a running agent's. */
export interface EditorChannel { channel: number; sessionId: string; name: string; engine: string; waiting: boolean }
interface Deps { channels(): EditorChannel[]; send(sessionId: string, text: string): Promise<void>; home?: string }
const sendSchema = z.object({ sessionId: z.string().min(1).max(100), text: z.string().min(1).max(20_000) }).strict();

/**
 * The editor bridge (1.38.0): Trace's VS Code extension (vscode-extension.ts) lists the running agent channels and
 * sends one the code the person selected, as if they had typed it. It listens on loopback with a fresh 32-byte key each
 * time Trace starts, written to connectionFile() for the extension; a request without the key, from a web page (an
 * Origin header) or to another host name (DNS rebinding) is refused. A channel waiting for an approval is not sent
 * to, since the message's Enter could answer it.
 */
export class EditorBridge {
  private server: http.Server | null = null; private token = randomBytes(32); private port: number | null = null;
  constructor(private deps: Deps) {}
  get address() { return this.port === null ? null : `http://127.0.0.1:${this.port}`; }
  async start() {
    const server = http.createServer((request, response) => void this.handle(request, response).catch(() => answer(response, 500, { error: 'Trace could not take it.' })));
    this.port = await listenLoopback(server); this.server = server;
    const file = connectionFile(this.deps.home); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ port: this.port, token: this.token.toString('hex') }), { mode: 0o600 });
  }
  stop() { this.server?.close(); this.server = null; try { fs.rmSync(connectionFile(this.deps.home), { force: true }); } catch { /* Gone already. */ } }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const [, root, key, route] = (request.url ?? '').split('/');
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${this.port}` || root !== 'editor' || !/^[0-9a-f]{64}$/.test(key ?? '') || !timingSafeEqual(Buffer.from(key, 'hex'), this.token)) return answer(response, 403, { error: 'Not allowed.' });
    if (request.method === 'GET' && route === 'channels') return answer(response, 200, this.deps.channels());
    if (request.method !== 'POST' || route !== 'send') return answer(response, 404, { error: 'Not found.' });
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 64 * 1024) return answer(response, 413, { error: 'That is too long to send. Select less code.' }); }
    let parsed: z.infer<typeof sendSchema>; try { parsed = sendSchema.parse(JSON.parse(body)); } catch { return answer(response, 400, { error: 'That is too long to send, or empty. Select less code.' }); }
    const channel = this.deps.channels().find((item) => item.sessionId === parsed.sessionId);
    if (!channel) return answer(response, 409, { error: 'That channel is no longer running in Trace.' });
    if (channel.waiting) return answer(response, 409, { error: `CH${channel.channel} is waiting for you to answer in Trace. Answer it there, then send again.` });
    await this.deps.send(parsed.sessionId, parsed.text); return answer(response, 200, { sent: true });
  }
}
function answer(response: http.ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }

/**
 * VS Code's own command-line tool, run without a shell: its program and the cli.js its `code` launcher runs (named in
 * bin/code.cmd on Windows, where it sits in a versioned folder), with ELECTRON_RUN_AS_NODE as the launcher sets it.
 */
export function findVSCode(env = process.env): { program: string; cli: string } | null {
  const tryInstall = (folder: string, program: string) => {
    let cli = path.join(folder, 'resources', 'app', 'out', 'cli.js');
    try { const launcher = fs.readFileSync(path.join(folder, 'bin', 'code.cmd'), 'utf8'); const named = /%~dp0\.\.\\([^"]+cli\.js)/.exec(launcher)?.[1]; if (named) cli = path.join(folder, ...named.split('\\')); } catch { /* Not Windows, or no launcher. */ }
    return fs.existsSync(program) && fs.existsSync(cli) ? { program, cli } : null;
  };
  if (process.platform === 'win32') {
    const folders = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code'), env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code'), env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code')].filter(Boolean) as string[];
    for (const folder of folders) { const found = tryInstall(folder, path.join(folder, 'Code.exe')); if (found) return found; }
    return null;
  }
  if (process.platform === 'darwin') {
    for (const app of ['/Applications/Visual Studio Code.app', path.join(os.homedir(), 'Applications', 'Visual Studio Code.app')]) {
      const macos = path.join(app, 'Contents', 'MacOS'); let program = '';
      try { program = path.join(macos, fs.readdirSync(macos).find((name) => name === 'Code' || name === 'Electron') ?? ''); } catch { continue; }
      const cli = path.join(app, 'Contents', 'Resources', 'app', 'out', 'cli.js'); if (fs.existsSync(program) && fs.existsSync(cli)) return { program, cli };
    }
    return null;
  }
  for (const folder of ['/usr/share/code', '/usr/lib/code', '/opt/visual-studio-code']) { const found = tryInstall(folder, path.join(folder, 'code')); if (found) return found; }
  return null;
}

/** Whether VS Code is here and has Trace's extension (its folder under ~/.vscode/extensions). */
export function vscodeStatus(home = os.homedir()) {
  let installed = false; try { installed = fs.readdirSync(path.join(home, '.vscode', 'extensions')).some((name) => name.startsWith(`${EXTENSION_ID}-`)); } catch { /* No extensions yet. */ }
  return { found: Boolean(findVSCode()), installed };
}

/** Installs (or updates) the extension with VS Code's own installer. VS Code picks it up in open windows within moments. */
export async function installVSCodeExtension(version: string, folder: string) {
  const code = findVSCode(); if (!code) throw new HubError('VSCODE_MISSING', 'VS Code was not found on this computer. Install it from code.visualstudio.com, then press Connect VS Code again.');
  fs.mkdirSync(folder, { recursive: true }); const file = path.join(folder, `trace-vscode-${version}.vsix`); fs.writeFileSync(file, vsix(version));
  try { await execFileTree(code.program, [code.cli, '--install-extension', file, '--force'], { env: { ...hostEnvironment(), ELECTRON_RUN_AS_NODE: '1' }, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true }); }
  catch (error) { const output = `${(error as { stdout?: Buffer }).stdout ?? ''}${(error as { stderr?: Buffer }).stderr ?? ''}`.trim(); throw new HubError('VSCODE_INSTALL', `VS Code did not install Trace’s extension${output ? `: ${output.slice(-300)}` : '.'}`); }
  finally { fs.rmSync(file, { force: true }); }
}
