import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { savedWorkspaceSchema } from '../../../shared/schemas';
import type { ConversationLabel, ProjectTemplate, SearchHit, SearchResults } from '../../../shared/productivity';
import type { SavedWorkspace } from '../../../shared/types';
import type { NativeSessions } from './native-sessions';
import type { Verification } from './verification';
import type { RulesService } from '../hub/rules';
import type { WorkspaceStorage } from '../storage/workspace-storage';
import { load, save, directory } from './local-store';
import { HubError } from '../cli/engine-adapter';
const label = z.object({ key: z.string().min(1).max(200), name: z.string().trim().min(1).max(100), pinned: z.boolean() }).strict();
const check = z.object({ name: z.string().trim().min(1).max(100), steps: z.array(z.object({ label: z.string().trim().min(1).max(60), tool: z.enum(['npm','pnpm','yarn','python','cargo','go','dotnet']), args: z.array(z.string().max(500).refine((value) => !value.includes('\0'))).min(1).max(30) }).strict()).min(1).max(8), timeoutSeconds: z.number().int().min(5).max(300) }).strict();
const template = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(100), description: z.string().max(1000), workspace: savedWorkspaceSchema, rules: z.string().max(50000), checks: z.array(check).max(20), createdAt: z.iso.datetime() }).strict();
const schema = z.discriminatedUnion('action', [
 z.object({ action: z.literal('flow-conversations') }).strict(), label.extend({ action: z.literal('flow-conversation-save') }).strict(),
 z.object({ action: z.literal('flow-failures') }).strict(),
 z.object({ action: z.literal('flow-search'), query: z.string().trim().min(2).max(200), directory: z.string().max(4096).nullable(), includeOutput: z.boolean() }).strict(),
 z.object({ action: z.literal('flow-templates') }).strict(),
 z.object({ action: z.literal('flow-template-save'), name: template.shape.name, description: template.shape.description, workspace: savedWorkspaceSchema, includeRules: z.boolean(), includeChecks: z.boolean() }).strict(),
 z.object({ action: z.literal('flow-template-apply'), id: z.uuid(), directory: z.string().max(4096), applyRules: z.boolean(), applyChecks: z.boolean() }).strict(),
 z.object({ action: z.literal('flow-template-delete'), id: z.uuid() }).strict(),
]);
export class Workflows {
 private busy = false;
 get running() { return this.busy; }
 constructor(private root: string, private native: NativeSessions, private verification: Verification, private rules: RulesService, private storage: WorkspaceStorage, private confirm: (title: string, detail: string) => Promise<boolean>) {}
 labels(): ConversationLabel[] { return load(this.root, 'conversation-labels.json', z.array(label).max(500), []); }
 templates(): ProjectTemplate[] { return load(this.root, 'project-templates.json', z.array(template).max(50), []); }
 async execute(input: unknown) {
  const request = schema.parse(input);
  if (request.action === 'flow-conversations') return this.labels();
  if (request.action === 'flow-conversation-save') {
   if (!this.native.list().some((item) => item.key === request.key)) throw new HubError('CONVERSATION_MISSING', 'Refresh native conversations before saving this reference.');
   const labels = this.labels(); const value = { key: request.key, name: request.name, pinned: request.pinned };
   if (labels.length >= 500 && !labels.some((item) => item.key === request.key)) throw new HubError('CONVERSATION_LIMIT', 'Up to 500 conversation labels are supported.');
   save(this.root, 'conversation-labels.json', [...labels.filter((item) => item.key !== request.key), value]); return value;
  }
  if (request.action === 'flow-failures') return this.storage.history().filter((run) => run.status !== 'running' && run.exitCode !== null && run.exitCode !== 0).slice(0, 20).map((run) => ({ ...run, diagnostic: this.log(run.runId).slice(-2000) }));
  if (request.action === 'flow-search') return this.search(request.query, request.directory, request.includeOutput);
  const templates = this.templates();
  if (request.action === 'flow-templates') return templates;
  if (request.action === 'flow-template-delete') { save(this.root, 'project-templates.json', templates.filter((item) => item.id !== request.id)); return null; }
  if (request.action === 'flow-template-save') {
   if (templates.length >= 50) throw new HubError('TEMPLATE_LIMIT', 'Up to 50 templates are supported.');
   const workspace = structuredClone(request.workspace);
   for (const session of workspace.sessions) { delete session.config.resumeId; delete session.preparedRequest; }
   const value: ProjectTemplate = { id: randomUUID(), name: request.name, description: request.description, workspace, rules: request.includeRules ? this.rules.read([]).content : '', checks: request.includeChecks ? this.verification.data().profiles.filter((profile) => profile.directory === workspace.rootDirectory).slice(0, 20).map(({ name, steps, timeoutSeconds }) => ({ name, steps, timeoutSeconds })) : [], createdAt: new Date().toISOString() };
   template.parse(value); save(this.root, 'project-templates.json', [value, ...templates]); return value;
  }
  if (this.busy) throw new HubError('TEMPLATE_BUSY', 'A template operation is already running.');
  const selected = templates.find((item) => item.id === request.id); if (!selected) throw new HubError('TEMPLATE_MISSING', 'Select an available template.');
  const cwd = directory(request.directory); this.busy = true;
  try {
   const instructions = this.rules.read([cwd]);
   const checks = request.applyChecks ? selected.checks : [];
   if (checks.length + this.verification.data().profiles.length > 100) throw new HubError('TEMPLATE_CHECKS', 'There is no room for these verification profiles.');
   const detail = `${selected.name}\nProject: ${cwd}\nAll template tiles will use this project. No CLI launches or checks run automatically.\n${request.applyRules ? 'This replaces the canonical shared rules and applies them to this project. Other registered projects may require reapplication.\n' + selected.rules : 'Existing shared rules are retained and applied to this project.'}\nVerification profiles: ${checks.map((item) => item.name).join(', ') || 'None'}`;
   if (!await this.confirm('Apply project template', detail)) return null;
   if (JSON.stringify(this.templates().find((item) => item.id === selected.id)) !== JSON.stringify(selected)) throw new HubError('TEMPLATE_CHANGED', 'The template changed after review.');
   this.rules.save(request.applyRules ? selected.rules : instructions.content, instructions.revision, instructions.targets);
   for (const item of checks) await this.verification.execute({ action: 'verification-save', ...item, directory: cwd });
   const workspace = structuredClone(selected.workspace); workspace.rootDirectory = cwd; workspace.focusedSessionId = null;
   const ids = new Map<string, string>();
   workspace.sessions = workspace.sessions.map((session) => { const id = randomUUID(); ids.set(session.id, id); return { ...session, id, binding: session.binding.mode === 'workspace' ? { mode: 'workspace' as const } : { mode: 'independent' as const, cwd }, createdAt: new Date().toISOString() }; });
   workspace.tiles = workspace.tiles.map((tile) => ({ ...tile, sessionId: ids.get(tile.sessionId)! })); return savedWorkspaceSchema.parse(workspace) as SavedWorkspace;
  } finally { this.busy = false; }
 }
 private log(id: string) { try { return this.storage.readLog({ runId: id }).text; } catch { return 'Recorded output is unavailable.'; } }
 private search(query: string, project: string | null, output: boolean): SearchResults {
  const needle = query.toLowerCase(); const hits: SearchHit[] = []; let visited = 0; let bytes = 0; let limited = false;
  const add = (kind: SearchHit['kind'], title: string, location: string, text: string, view: SearchHit['view'], snapshotId?: string) => {
   const index = text.toLowerCase().indexOf(needle); if (index < 0 && !`${title} ${location}`.toLowerCase().includes(needle)) return;
   if (hits.length >= 100) { limited = true; return; }
   hits.push({ id: randomUUID(), kind, title, location, snippet: text.slice(Math.max(0, index - 100), Math.max(0, index - 100) + 350), view, ...(snapshotId ? { snapshotId } : {}) });
  };
  const scan = (folder: string, depth: number, callback: (file: string) => void) => {
   if (depth > 10 || visited >= 3000 || bytes >= 8 * 1024 * 1024) { limited = true; return; }
   let entries: fs.Dirent[]; try { if (fs.lstatSync(folder).isSymbolicLink()) return; entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
   for (const entry of entries) {
    if (++visited > 3000 || bytes >= 8 * 1024 * 1024) { limited = true; break; }
    if (entry.isSymbolicLink() || /^(node_modules|\.git|\.claude|\.codex|\.ssh|\.aws|\.cache|dist|dist-electron|release|vendor|target|\.venv|venv|coverage)$/i.test(entry.name) || /^(\.env|auth\.json|credentials|\.credentials|.*\.(pem|key|pfx|p12))/i.test(entry.name)) continue;
    const file = path.join(folder, entry.name); if (entry.isDirectory()) scan(file, depth + 1, callback); else if (entry.isFile()) callback(file);
   }
  };
  const read = (file: string) => { try { const size = fs.statSync(file).size; if (size > 131072 || bytes + size > 8 * 1024 * 1024) { limited = true; return ''; } bytes += size; const text = fs.readFileSync(file, 'utf8'); return text.includes('\0') ? '' : text; } catch { return ''; } };
  if (project) { const cwd = directory(project); scan(cwd, 0, (file) => { if (/\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|rs|py|toml|yaml|yml|txt|go|cs)$/i.test(file)) add('file', path.basename(file), file, read(file), 'files'); }); }
  scan(path.join(this.root, 'memory'), 0, (file) => { if (!file.endsWith('.json')) return; try { const note = JSON.parse(read(file)); if (typeof note.content === 'string') add('memory', String(note.title ?? 'Handoff'), String(note.project ?? ''), note.content, 'memory'); } catch {} });
  add('rules', 'Shared rules', 'Canonical local document', this.rules.read([]).content, 'rules');
  const annotations = load(this.root, 'design-annotations.json', z.array(z.object({ snapshotId: z.string(), text: z.string() }).passthrough()).max(1000), []);
  for (const item of annotations) add('annotation', 'Design annotation', item.snapshotId, item.text, 'design', item.snapshotId);
  if (output) for (const run of this.storage.history().slice(0, 100)) { if (bytes >= 8 * 1024 * 1024) { limited = true; break; } const text = this.log(run.runId).slice(-65536); bytes += Buffer.byteLength(text); add('output', `${run.engine} · ${new Date(run.startedAt).toLocaleString()}`, run.cwd, text, 'history'); }
  return { hits, limited };
 }
}
