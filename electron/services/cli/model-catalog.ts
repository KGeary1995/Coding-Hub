import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { z } from 'zod';
import { StringDecoder } from 'node:string_decoder';
import type { CodexModelCatalog } from '../../../shared/workbench';
import { findExecutable, hostEnvironment } from './discovery';
import { HubError } from './engine-adapter';
import { directory } from '../workbench/local-store';

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const pageSchema = z.object({ data: z.array(z.object({
  model: identifier, displayName: z.string().max(300), description: z.string().max(10000).default(''),
  hidden: z.boolean().default(false), isDefault: z.boolean().default(false),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/) }).passthrough()).max(100).default([]),
}).passthrough()).max(1000), nextCursor: z.string().max(4096).nullable().optional() }).passthrough();

/** Ask the official local CLI for its catalog. No direct provider API, prompt,
 * thread creation, shell interpolation, or credential-file reads. */
export class ModelCatalog {
  private active = new Map<string, Promise<CodexModelCatalog>>();
  private children = new Set<ChildProcess>();
  private closing = false;
  constructor(private dependencies: { find?: typeof findExecutable; spawn?: typeof spawn; timeout?: number; clientVersion?: string } = {}) {}
  private stop(child: ChildProcess) {
    child.stdin?.end(); child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref();
    child.once('close', () => clearTimeout(force));
  }

  execute(input: unknown): Promise<CodexModelCatalog> {
    const request = z.object({ action: z.literal('codex-models'), directory: z.string().max(4096).nullable() }).strict().parse(input);
    if (this.closing) throw new HubError('HOST_CLOSING', 'The application is shutting down.');
    const cwd = directory(request.directory || homedir());
    const existing = this.active.get(cwd); if (existing) return existing;
    if (this.active.size >= 4) throw new HubError('MODEL_BUSY', 'Wait for the current model discovery requests to finish.');
    const pending = this.query(cwd).finally(() => { this.active.delete(cwd); });
    this.active.set(cwd, pending); return pending;
  }

  private async query(cwd: string): Promise<CodexModelCatalog> {
    const env = hostEnvironment(); const executable = await (this.dependencies.find ?? findExecutable)('codex', env);
    if (this.closing) throw new HubError('HOST_CLOSING', 'The application is shutting down.');
    return new Promise((resolve, reject) => {
      const child = (this.dependencies.spawn ?? spawn)(executable.file, [...executable.prefixArgs, 'app-server'], {
        cwd, env: { ...env, ...executable.extraEnv }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.children.add(child);
      let settled = false; let partial = ''; let received = 0; let pages = 0; let expected = 1; let initialized = false;
      const decoder = new StringDecoder('utf8'); const models = new Map<string, CodexModelCatalog['models'][number]>(); const cursors = new Set<string>();
      const finish = (error?: HubError) => {
        if (settled) return; settled = true; clearTimeout(timer);
        this.stop(child);
        // app-server has no coding thread, so only its owned metadata process is stopped.
        if (error) reject(error); else resolve({ models: [...models.values()], checkedAt: new Date().toISOString(), source: 'codex-app-server', directory: cwd });
      };
      const fail = () => finish(new HubError('MODEL_CATALOG', 'Codex model discovery failed. Update Codex, check its local login/configuration, and refresh. You can still enter an exact model ID or use CLI defaults.'));
      const timer = setTimeout(() => finish(new HubError('MODEL_TIMEOUT', 'Codex model discovery timed out. Check its connection and local configuration, then refresh.')), this.dependencies.timeout ?? 20000);
      const send = (method: string, params?: unknown, id?: number) => { if (!settled) child.stdin?.write(JSON.stringify({ ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) + '\n'); };
      child.stdin?.on('error', fail); child.on('error', fail);
      child.on('close', () => { this.children.delete(child); if (!settled) fail(); });
      child.stderr?.on('data', () => {}); // Never forward server diagnostics/auth material.
      child.stdout?.on('data', (bytes: Buffer) => {
        if (settled) return;
        received += bytes.length; if (received > 16 * 1024 * 1024) { fail(); return; }
        partial += decoder.write(bytes); if (Buffer.byteLength(partial) > 4 * 1024 * 1024) { fail(); return; }
        let newline: number;
        while (!settled && (newline = partial.indexOf('\n')) >= 0) {
          const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
          try {
            const response = JSON.parse(line); if (!response || typeof response !== 'object' || response.id !== expected) continue;
            if (response.error) { fail(); return; }
            if (!initialized) { initialized = true; send('initialized'); expected++; send('model/list', { limit: 100, includeHidden: true }, expected); continue; }
            const page = pageSchema.parse(response.result);
            for (const item of page.data) models.set(item.model, { model: item.model, displayName: item.displayName, description: item.description, hidden: item.hidden, isDefault: item.isDefault, reasoningEfforts: [...new Set(item.supportedReasoningEfforts.map((effort) => effort.reasoningEffort))] });
            if (models.size > 1000 || ++pages > 50) { fail(); return; }
            if (!page.nextCursor) { finish(); return; }
            if (cursors.has(page.nextCursor)) { fail(); return; } cursors.add(page.nextCursor);
            expected++; send('model/list', { limit: 100, includeHidden: true, cursor: page.nextCursor }, expected);
          } catch { fail(); return; }
        }
      });
      send('initialize', { clientInfo: { name: 'ai_coding_hub', title: 'AI Coding Hub', version: this.dependencies.clientVersion ?? '1.0.0' }, capabilities: null }, expected);
    });
  }
  close() { this.closing = true; for (const child of this.children) this.stop(child); }
}
