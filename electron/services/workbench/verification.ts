import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { VerificationData, VerificationProfile, VerificationResult, VerificationTool } from '../../../shared/workbench';
import { load, save, directory } from './local-store';
import { hostEnvironment } from '../cli/discovery';
import { HubError } from '../cli/engine-adapter';
const step = z.object({ label: z.string().trim().min(1).max(60), tool: z.enum(['npm', 'pnpm', 'yarn', 'python', 'cargo', 'go', 'dotnet']), args: z.array(z.string().max(500).refine((s) => !s.includes('\0'))).min(1).max(30) }).strict();
const profile = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(100), directory: z.string().max(4096), steps: z.array(step).min(1).max(8), timeoutSeconds: z.number().int().min(5).max(300), createdAt: z.iso.datetime() }).strict();
const result = z.object({ id: z.uuid(), profileId: z.uuid(), directory: z.string(), profileName: z.string(), startedAt: z.iso.datetime(), endedAt: z.iso.datetime(), passed: z.boolean(), cancelled: z.boolean(), steps: z.array(z.object({ label: z.string(), exitCode: z.number().int().nullable(), output: z.string().max(512000), timedOut: z.boolean(), truncated: z.boolean() }).strict()).max(8) }).strict();
const dataSchema = z.object({ profiles: z.array(profile).max(100), results: z.array(result).max(50) }).strict();
const schema = z.discriminatedUnion('action', [z.object({ action: z.literal('verification-list') }).strict(), z.object({ action: z.literal('verification-save'), id: z.uuid().optional(), name: profile.shape.name, directory: profile.shape.directory, steps: profile.shape.steps, timeoutSeconds: profile.shape.timeoutSeconds }).strict(), z.object({ action: z.literal('verification-run'), id: z.uuid() }).strict(), z.object({ action: z.literal('verification-cancel') }).strict()]);
export class Verification {
  private child: ChildProcess | null = null;
  private busy = false; private cancelled = false;
  get running() { return this.busy; }
  constructor(private root: string, private confirm: (profile: VerificationProfile) => Promise<boolean>) {}
  data(): VerificationData { return { ...load(this.root, 'verification.json', dataSchema, { profiles: [], results: [] }), running: this.busy }; }
  private executable(tool: VerificationTool): { file: string; args: string[]; env: Record<string, string> } {
    const env = hostEnvironment(); const key = Object.keys(env).find((s) => s.toUpperCase() === 'PATH') ?? 'PATH';
    for (const folder of env[key].split(path.delimiter).filter(Boolean)) {
      const base = folder.replace(/^"|"$/g, '');
      if (['npm', 'pnpm', 'yarn'].includes(tool)) {
        const entries = tool === 'npm' ? ['node_modules/npm/bin/npm-cli.js', 'npm'] : tool === 'pnpm' ? ['node_modules/pnpm/bin/pnpm.cjs', 'pnpm'] : ['node_modules/yarn/bin/yarn.js', 'yarn'];
        for (const name of entries) try { const file = fs.realpathSync(path.join(base, name)); if (fs.statSync(file).isFile() && /\.(?:js|cjs|mjs)$/.test(file)) return { file: process.execPath, args: [file], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }; } catch {}
      } else for (const name of tool === 'python' ? process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'] : [tool + (process.platform === 'win32' ? '.exe' : '')]) try { const file = path.join(base, name); if (fs.statSync(file).isFile()) return { file, args: [], env }; } catch {}
    }
    throw new HubError('CHECK_TOOL', `${tool} was not found on PATH. Install it or use another verification command.`);
  }
  async execute(input: unknown): Promise<VerificationData | VerificationProfile | VerificationResult | null> {
    const request = schema.parse(input); const data = this.data();
    if (request.action === 'verification-list') return data;
    if (request.action === 'verification-cancel') { this.cancel(); return null; }
    if (request.action === 'verification-save') {
      if (this.busy) throw new HubError('CHECK_BUSY', 'Finish or cancel verification before editing profiles.');
      if (!request.id && data.profiles.length >= 100) throw new HubError('CHECK_LIMIT', 'Up to 100 verification profiles are supported.');
      if (request.id && !data.profiles.some((p) => p.id === request.id)) throw new HubError('CHECK_PROFILE', 'Verification profile is unavailable.');
      const next: VerificationProfile = { id: request.id ?? randomUUID(), name: request.name, directory: directory(request.directory), steps: request.steps, timeoutSeconds: request.timeoutSeconds, createdAt: data.profiles.find((p) => p.id === request.id)?.createdAt ?? new Date().toISOString() };
      save(this.root, 'verification.json', { profiles: [...data.profiles.filter((p) => p.id !== next.id), next], results: data.results }); return next;
    }
    if (this.busy) throw new HubError('CHECK_BUSY', 'Verification is already running.');
    const selected = data.profiles.find((p) => p.id === request.id); if (!selected) throw new HubError('CHECK_PROFILE', 'Verification profile is unavailable.');
    const cwd = directory(selected.directory);
    this.busy = true; this.cancelled = false;
    const completed: VerificationResult = { id: randomUUID(), profileId: selected.id, directory: cwd, profileName: selected.name, startedAt: new Date().toISOString(), endedAt: '', passed: false, cancelled: false, steps: [] };
    try {
      if (!await this.confirm(selected)) { completed.cancelled = true; return null; }
      if (this.cancelled) return null;
      if (JSON.stringify(this.data().profiles.find((p) => p.id === selected.id)) !== JSON.stringify(selected)) throw new HubError('CHECK_CHANGED', 'The profile changed after review. Run it again.');
      for (const command of selected.steps) {
        if (this.cancelled) break;
        const program = this.executable(command.tool);
        const outcome = await new Promise<VerificationResult['steps'][number]>((resolve, reject) => {
          const child = spawn(program.file, [...program.args, ...command.args], { cwd: completed.directory, env: program.env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); this.child = child;
          let output = ''; let truncated = false; let timedOut = false;
          const append = (bytes: Buffer) => { if (output.length + bytes.length > 512000) truncated = true; output = (output + bytes.toString()).slice(0, 512000); };
          child.stdout?.on('data', append); child.stderr?.on('data', append);
          const timer = setTimeout(() => { timedOut = true; this.kill(); }, selected.timeoutSeconds * 1000);
          child.on('error', () => { clearTimeout(timer); this.child = null; reject(new HubError('CHECK_START', 'The verification command could not start.')); });
          child.on('close', (exitCode) => { clearTimeout(timer); this.child = null; resolve({ label: command.label, exitCode, output, truncated, timedOut }); });
        });
        completed.steps.push(outcome); if (outcome.exitCode !== 0 || outcome.timedOut) break;
      }
      completed.endedAt = new Date().toISOString(); completed.cancelled = this.cancelled; completed.passed = !this.cancelled && completed.steps.length === selected.steps.length && completed.steps.every((s) => s.exitCode === 0 && !s.timedOut);
      const current = this.data(); const results = [completed, ...current.results].slice(0, 50); while (results.length > 1 && Buffer.byteLength(JSON.stringify(results)) > 3 * 1024 * 1024) results.pop(); save(this.root, 'verification.json', { profiles: current.profiles, results }); return completed;
    } finally { this.busy = false; }
  }
  private kill() { if (!this.child?.pid) return; if (process.platform === 'win32') execFile(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => {}); else try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill(); } }
  cancel() { this.cancelled = true; this.kill(); }
}
