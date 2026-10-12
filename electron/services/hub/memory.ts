import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MemoryNote } from '../../../shared/hub';
import { HubError } from '../cli/engine-adapter';
import { readConfig, updateConfig } from './config';

export const projectSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const noteSchema = z.object({ id: z.uuid(), project: projectSchema, title: z.string().trim().min(1).max(200), content: z.string().min(1).max(60000), author: z.enum(['claude', 'codex', 'human']), createdAt: z.iso.datetime(), supersedes: z.uuid().optional() }).strict();
export class MemoryService {
  constructor(readonly root: string) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); this.checkRoot(); }
  private checkRoot() { if (!fs.lstatSync(this.root).isDirectory() || fs.lstatSync(this.root).isSymbolicLink()) throw new HubError('MEMORY_PATH', 'Memory storage must be a real directory, not a symbolic link.'); }
  directory(project: string) { this.checkRoot(); projectSchema.parse(project); const target = path.join(this.root, project); if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new HubError('MEMORY_PATH', 'Memory project cannot be a symbolic link.'); return target; }
  list(project: string): MemoryNote[] {
    const dir = this.directory(project); if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /^[0-9a-f-]{36}\.json$/.test(e.name));
    if (files.length > 5000) throw new HubError('MEMORY_LIMIT', 'This project exceeds 5,000 handoffs. Archive older notes before syncing.');
    const notes: MemoryNote[] = [];
    for (const file of files) { const target = path.join(dir, file.name); if (fs.statSync(target).size > 512000) continue; try { const note = noteSchema.parse(JSON.parse(fs.readFileSync(target, 'utf8'))); if (note.project === project && note.id + '.json' === file.name) notes.push(note); } catch { /* Invalid records are preserved, never executed. */ } }
    return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  import(input: unknown): boolean {
    const note = noteSchema.parse(input); const dir = this.directory(note.project); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(dir, note.id + '.json')) && fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/.test(entry.name)).length >= 5000) throw new HubError('MEMORY_LIMIT', 'This project already contains 5,000 handoffs. Archive older notes before adding more.');
    try { fs.writeFileSync(path.join(dir, note.id + '.json'), JSON.stringify(note, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { const original = this.list(note.project).find((s) => s.id === note.id); if (original && JSON.stringify(original) === JSON.stringify(note)) return false; throw new HubError('MEMORY_CONFLICT', 'A remote handoff conflicts with a local ID. Both files were preserved; inspect the remote note before importing.'); } throw error; }
  }
  write(project: string, title: string, content: string, author: MemoryNote['author'], supersedes?: string): MemoryNote { if (supersedes && !this.list(project).some((note) => note.id === supersedes)) throw new HubError('MEMORY_REVISION', 'The original handoff is unavailable. Refresh before saving a revision.'); const note = noteSchema.parse({ id: randomUUID(), project, title, content, author, createdAt: new Date().toISOString(), ...(supersedes ? { supersedes } : {}) }); this.import(note); return note; }
  install(directory: string, project: string, server: string, executable: string) {
    projectSchema.parse(project); if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory() || fs.realpathSync(directory) !== path.resolve(directory)) throw new HubError('PROJECT_PATH', 'Use the canonical project directory for memory installation.');
    const args = [server, this.root, project];
    // Refuse any partial replacement of an existing server with this reserved name.
    const targets = [path.join(directory, '.mcp.json'), path.join(directory, '.codex', 'config.toml')];
    for (const file of targets) {
      const data = readConfig(file).data;
      if ((data.mcpServers ?? data.mcp_servers)?.['coding-hub-memory']) throw new HubError('MEMORY_EXISTS', 'coding-hub-memory is already configured. Inspect the MCP page before reinstalling.');
    }
    const instruction = '\n<!-- coding-hub-memory:start -->\nUse the coding-hub-memory MCP server to read_memory at the start of a coding session. Before finishing, use write_handoff to record decisions, changed files, validation, remaining work, and blockers. Never include credentials or raw terminal logs in shared handoffs.\n<!-- coding-hub-memory:end -->\n';
    // Validate instruction files before mutating configuration.
    for (const name of ['AGENTS.md', 'CLAUDE.md']) { const file = path.join(directory, name); if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1024 * 1024)) throw new HubError('MEMORY_INSTRUCTIONS', 'Instruction files must be regular files under 1 MiB.'); }
    const all = [...targets, ...['AGENTS.md', 'CLAUDE.md'].map((name) => path.join(directory, name))];
    const originals = new Map(all.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null]));
    const written = new Map<string, string>();
    const replace = (file: string, text: string) => { const temp = file + '.coding-hub-' + randomUUID(); try { fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch { /* Already renamed. */ } } };
    try {
      for (const file of targets) { const inspected = readConfig(file); if (inspected.text !== (originals.get(file) ?? '')) throw new HubError('CONFIG_CHANGED', 'Configuration changed during installation.'); updateConfig(file, inspected.hash, (data) => { const key = file.endsWith('.toml') ? 'mcp_servers' : 'mcpServers'; data[key] ??= {}; data[key]['coding-hub-memory'] = { command: executable, args, env: { ELECTRON_RUN_AS_NODE: '1' } }; }); written.set(file, fs.readFileSync(file, 'utf8')); }
      for (const name of ['AGENTS.md', 'CLAUDE.md']) { const file = path.join(directory, name); const existing = originals.get(file) ?? ''; if (!existing.includes('<!-- coding-hub-memory:start -->')) { if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== existing) throw new HubError('CONFIG_CHANGED', 'Instructions changed during installation.'); if (existing) fs.writeFileSync(file + '.coding-hub-backup-' + randomUUID(), existing, { flag: 'wx', mode: 0o600 }); replace(file, existing + instruction); written.set(file, existing + instruction); } }
    } catch {
      let incomplete = false;
      for (const [file, text] of [...written].reverse()) try { if (fs.readFileSync(file, 'utf8') !== text) { incomplete = true; continue; } const original = originals.get(file); if (original === null) fs.unlinkSync(file); else replace(file, original!); } catch { incomplete = true; }
      throw new HubError('MEMORY_INSTALL_FAILED', incomplete ? 'Installation failed and another change or file lock prevented full restoration. Review the MCP and instruction files; private backups were preserved.' : 'Installation failed. Files changed by this installation were restored; private backups were preserved. Check project file permissions and retry.');
    }
  }
}
