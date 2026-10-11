import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { HubError } from '../cli/engine-adapter';
import type { CheckName, CheckResult, ProjectAudit } from '../../../shared/project-checks';
import { hostEnvironment } from '../cli/discovery';
const schema = z.discriminatedUnion('action', [z.object({ action: z.literal('inspect'), directory: z.string().max(4096) }).strict(), z.object({ action: z.literal('run'), directory: z.string().max(4096), script: z.enum(['test', 'typecheck', 'lint']) }).strict()]);
export class ProjectChecks {
  private child: ChildProcess | null = null;
  get running() { return Boolean(this.child); }
  constructor(private rules: (directory: string) => void) {}
  inspect(selected: string): ProjectAudit {
    if (!path.isAbsolute(selected)) throw new HubError('PROJECT_PATH', 'Choose an absolute project directory.');
    const directory = fs.realpathSync(selected); if (!fs.statSync(directory).isDirectory()) throw new HubError('PROJECT_PATH', 'Choose a project directory.');
    const report: ProjectAudit = { directory, instructions: [], truncated: false, scripts: [], rulesApplied: false, warnings: [] }; let visited = 0;
    const scan = (root: string, depth: number) => {
      if (depth > 6 || visited > 500) { report.truncated = true; return; }
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (++visited > 500) { report.truncated = true; return; }
        if (entry.isSymbolicLink() || ['.git', 'node_modules', 'dist', 'dist-electron', 'release', '.cache'].includes(entry.name)) continue;
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) { try { scan(target, depth + 1); } catch { report.truncated = true; } }
        else if (entry.isFile() && ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md'].includes(entry.name)) report.instructions.push({ path: path.relative(directory, target), engine: entry.name.startsWith('CLAUDE') ? 'claude' : 'codex', scope: root === directory ? 'root' : 'nested' });
      }
    };
    scan(directory, 0);
    if (report.instructions.some((file) => file.scope === 'nested' || file.path.endsWith('override.md') || file.path === 'CLAUDE.local.md')) report.warnings.push('Nested, local, or override instructions may change agent behavior. Inspect them for conflicts; semantic agreement cannot be guaranteed by this scan.');
    if (report.truncated) report.warnings.push('Instruction scan was bounded or encountered an unreadable directory. Additional instructions may exist.');
    report.warnings.push('User-level instructions, CLI configuration, and higher-priority provider instructions also apply. This scan covers this project only.');
    try { this.rules(directory); report.rulesApplied = true; } catch { report.warnings.push('The current shared rules have not been applied to both engine files.'); }
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file) && fs.lstatSync(file).isFile() && fs.statSync(file).size <= 1024 * 1024) {
      try { const metadata = JSON.parse(fs.readFileSync(file, 'utf8')); report.scripts = (['test', 'typecheck', 'lint'] as CheckName[]).filter((name) => typeof metadata.scripts?.[name] === 'string'); } catch { report.warnings.push('package.json could not be parsed.'); }
    }
    return report;
  }
  private npmCLI(): string {
    const env = hostEnvironment(); const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    for (const directory of env[pathKey].split(path.delimiter).filter(Boolean)) {
      const candidates = process.platform === 'win32' ? [path.join(directory.replace(/^"|"$/g, ''), 'node_modules/npm/bin/npm-cli.js')] : [path.join(directory, 'npm')];
      for (const candidate of candidates) try { const resolved = fs.realpathSync(candidate); if (fs.statSync(resolved).isFile() && (process.platform === 'win32' || resolved.endsWith('npm-cli.js'))) return resolved; } catch { /* Try the next PATH entry. */ }
    }
    throw new HubError('NPM_UNAVAILABLE', 'npm was not found. Run project checks in your system terminal or install Node.js and restart the app.');
  }
  async execute(input: unknown, confirm: () => Promise<boolean>): Promise<ProjectAudit | CheckResult> {
    const parsed = schema.safeParse(input); if (!parsed.success) throw new HubError('INVALID_CHECK_REQUEST', 'Invalid project check request.'); const request = parsed.data;
    const report = this.inspect(request.directory); if (request.action === 'inspect') return report;
    if (this.running) throw new HubError('CHECK_BUSY', 'A project check is already running.');
    if (!report.scripts.includes(request.script)) throw new HubError('CHECK_UNAVAILABLE', 'This project does not define that npm script.');
    if (!await confirm()) return { script: request.script, exitCode: null, output: 'Check cancelled.', truncated: false, timedOut: false, cancelled: true };
    if (this.running) throw new HubError('CHECK_BUSY', 'A project check is already running.');
    const npm = this.npmCLI();
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [npm, 'run', request.script], { cwd: report.directory, env: { ...hostEnvironment(), ELECTRON_RUN_AS_NODE: '1' }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); this.child = child;
      let output = ''; let truncated = false; let timedOut = false;
      const append = (value: Buffer) => { const text = value.toString(); if (output.length + text.length > 512000) truncated = true; output = (output + text).slice(0, 512000); };
      child.stdout?.on('data', append); child.stderr?.on('data', append);
      const timer = setTimeout(() => { timedOut = true; this.stop(); }, 60_000);
      child.on('error', () => { clearTimeout(timer); if (this.child === child) this.child = null; reject(new HubError('CHECK_FAILED', 'The project check could not start.')); });
      child.on('close', (exitCode) => { clearTimeout(timer); if (this.child === child) this.child = null; resolve({ script: request.script, exitCode, output, truncated, timedOut }); });
    });
  }
  stop() { if (!this.child?.pid) return; try { if (process.platform === 'win32') execFile('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true }, () => {}); else process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill(); } }
}
