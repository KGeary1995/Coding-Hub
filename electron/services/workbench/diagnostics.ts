import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import TOML from '@iarna/toml';
import { z } from 'zod';
import type { DiagnosticReport } from '../../../shared/workbench';
import { discoverEngine, hostEnvironment } from '../cli/discovery';
import type { ClaudeProfiles } from '../cli/claude-profiles';
import { directory } from './local-store';
import { HubError } from '../cli/engine-adapter';
export class Diagnostics {
  constructor(private profiles: ClaudeProfiles) {}
  async execute(input: unknown): Promise<DiagnosticReport> {
    const request = z.object({ action: z.literal('diagnose'), engine: z.enum(['claude', 'codex']), directory: z.string().max(4096).nullable(), profileId: z.uuid().optional() }).strict().parse(input);
    if (request.engine !== 'claude' && request.profileId) throw new HubError('INVALID_REQUEST', 'Profiles are supported for Claude only.');
    const env = this.profiles.environment(hostEnvironment(), request.profileId);
    const engine = await discoverEngine(request.engine, env);
    const report: DiagnosticReport = { engine: request.engine, checkedAt: new Date().toISOString(), steps: [] };
    report.steps.push({ name: 'CLI installation and flags', state: engine.info.available ? 'passed' : 'failed', message: engine.info.available ? `${engine.info.version} · ${engine.info.executable}` : engine.info.error ?? 'CLI not detected.', recovery: 'Install or repair the official CLI and restart the app from a terminal where it works.' });
    const auth = engine.info.authentication;
    report.steps.push({ name: 'Local authentication', state: auth?.state === 'authenticated' ? 'passed' : auth?.state === 'not-authenticated' ? 'failed' : 'unverified', message: auth?.message ?? 'Authentication was not verified.', recovery: 'Use Accounts & connections to log in. Login does not verify model access or billing.' });
    const configHome = request.engine === 'claude' ? env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude') : env.CODEX_HOME ?? path.join(homedir(), '.codex');
    const files = request.engine === 'claude' ? [path.join(configHome, 'settings.json'), ...(request.directory ? [path.join(request.directory, '.claude/settings.json')] : [])] : [path.join(configHome, 'config.toml'), ...(request.directory ? [path.join(request.directory, '.codex/config.toml')] : [])];
    let error = ''; let count = 0;
    for (const file of files) try { if (fs.existsSync(file)) { if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1048576) throw new Error(); const text = fs.readFileSync(file, 'utf8'); request.engine === 'claude' ? JSON.parse(text) : TOML.parse(text); count++; } } catch { error = `Configuration could not be parsed: ${path.basename(path.dirname(file))}/${path.basename(file)}. Contents are not included in diagnostics.`; }
    report.steps.push({ name: 'Local configuration syntax', state: error ? 'failed' : 'passed', message: error || `${count} configuration files parsed. Semantic model/provider settings are checked by the CLI.`, recovery: 'Fix the local JSON/TOML file; clear app model/reasoning overrides to test CLI defaults.' });
    let cwd = homedir(); let valid = true;
    try { if (request.directory) cwd = directory(request.directory); } catch { valid = false; }
    report.steps.push({ name: 'Working directory', state: valid ? 'passed' : 'failed', message: valid ? request.directory ? cwd : 'No project selected; terminal test uses the home directory.' : 'Project directory is missing or unreadable.', recovery: 'Choose an existing folder in Projects or use an independent session directory.' });
    let terminal = false;
    if (valid) terminal = await new Promise<boolean>((resolve) => {
      let done = false; let output = ''; let pty: import('node-pty').IPty | undefined;
      const finish = (result: boolean) => { if (done) return; done = true; clearTimeout(timer); try { pty?.kill(); } catch {} resolve(result); };
      const timer = setTimeout(() => finish(false), 5000);
      // Electron is a GUI program and prints nothing inside a Windows pseudoconsole, so probe there with the console shell.
      const [file, args] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo HUB_TERMINAL_OK']] : [process.execPath, ['-e', 'process.stdout.write(process.stdin.isTTY && process.stdout.isTTY ? "HUB_TERMINAL_OK" : "HUB_TERMINAL_FAILED");process.exit(0)']];
      // Output can arrive after the exit event on Windows; accept it as soon as it is seen.
      try { pty = (require('node-pty') as typeof import('node-pty')).spawn(file, args, { cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1', TERM: 'xterm-256color' }, cols: 80, rows: 24 }); pty.onData((data) => { output += data; if (output.includes('HUB_TERMINAL_OK')) finish(true); }); pty.onExit(() => setTimeout(() => finish(output.includes('HUB_TERMINAL_OK')), 500)); } catch { finish(false); }
    });
    report.steps.push({ name: 'Interactive terminal transport', state: terminal ? 'passed' : 'failed', message: terminal ? 'A local terminal probe verified stdin/stdout TTY handles. No model request was sent.' : 'The native terminal probe failed or timed out.', recovery: 'Restart the app; repair native terminal dependencies. Use a supported Windows ConPTY system.' });
    report.steps.push({ name: 'Provider and model completion', state: 'unverified', message: 'A paid/model completion is not sent automatically. Start a session and submit a small task to test actual provider access.', recovery: 'Review the session diagnostic if the CLI exits. Check subscription, limits, model availability, and provider settings.' });
    return report;
  }
}
