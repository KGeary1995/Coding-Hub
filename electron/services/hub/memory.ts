import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MemoryNote } from '../../../shared/hub';
import { HubError } from '../cli/engine-adapter';
import { readConfig, updateConfig } from './config';
import { keepBackup } from './file-backups';
import { isItemNote } from '../../../shared/memory-items';

/** Notes a project keeps listed; past it, the oldest handoffs move to its archive folder. */
export const MAX_NOTES = 5000;
const ARCHIVE = 'archive';
const NOTE_FILE = /^[0-9a-f-]{36}\.json$/;
export const projectSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const noteSchema = z.object({ id: z.uuid(), project: projectSchema, title: z.string().trim().min(1).max(200), content: z.string().min(1).max(60000), author: z.enum(['claude', 'codex', 'human']), createdAt: z.iso.datetime(), supersedes: z.uuid().optional() }).loose();
export class MemoryService {
  /** `limit`: notes a project keeps listed (MAX_NOTES; smaller in tests). */
  constructor(readonly root: string, private readonly limit = MAX_NOTES) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); this.checkRoot(); }
  private checkRoot() { if (!fs.lstatSync(this.root).isDirectory() || fs.lstatSync(this.root).isSymbolicLink()) throw new HubError('MEMORY_PATH', 'Memory storage must be a real directory, not a symbolic link.'); }
  directory(project: string) { this.checkRoot(); projectSchema.parse(project); const target = path.join(this.root, project); if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new HubError('MEMORY_PATH', 'Memory project cannot be a symbolic link.'); return target; }
  /** The memory projects with notes, newest first: key, how many notes, and when the newest was written. */
  projects(): { key: string; notes: number; latest: string }[] {
    this.checkRoot(); const out: { key: string; notes: number; latest: string }[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !projectSchema.safeParse(entry.name).success) continue;
      try { const notes = this.list(entry.name); if (notes.length) out.push({ key: entry.name, notes: notes.length, latest: notes[0].createdAt }); } catch { /* Skipped. */ }
    }
    return out.sort((a, b) => b.latest.localeCompare(a.latest)).slice(0, 200);
  }
  /**
   * A project's notes by id, with each file's size, archived ones included: from the folder listings and file sizes
   * alone (no note is read).
   */
  sizes(project: string): Map<string, number> {
    const dir = this.directory(project); const sizes = new Map<string, number>();
    for (const folder of [dir, path.join(dir, ARCHIVE)]) {
      if (!fs.existsSync(folder)) continue;
      for (const e of fs.readdirSync(folder, { withFileTypes: true })) if (e.isFile() && NOTE_FILE.test(e.name)) sizes.set(e.name.slice(0, -5), fs.statSync(path.join(folder, e.name)).size);
    }
    return sizes;
  }
  /** The ids of a project's archived notes (moved aside to keep it under the limit; kept, but no longer listed). */
  archived(project: string): Set<string> {
    const folder = path.join(this.directory(project), ARCHIVE); if (!fs.existsSync(folder)) return new Set();
    return new Set(fs.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile() && NOTE_FILE.test(e.name)).map((e) => e.name.slice(0, -5)));
  }
  /**
   * Room for one more note in a full project: the oldest handoff or summary (never an open item or decision, which stay
   * in effect until resolved or retired) moves to the project's archive folder. Nothing is deleted.
   */
  private makeRoom(project: string, dir: string) {
    const oldest = this.list(project).filter((note) => !isItemNote(note)).at(-1);
    if (!oldest) throw new HubError('MEMORY_LIMIT', `This project holds ${this.limit.toLocaleString('en-US')} notes and none can move to its archive: they are open items, decisions or files Trace cannot read. Resolve or retire some open items before adding more.`);
    fs.mkdirSync(path.join(dir, ARCHIVE), { recursive: true, mode: 0o700 });
    fs.renameSync(path.join(dir, oldest.id + '.json'), path.join(dir, ARCHIVE, oldest.id + '.json'));
  }
  list(project: string): MemoryNote[] {
    const dir = this.directory(project); if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /^[0-9a-f-]{36}\.json$/.test(e.name));
    if (files.length > this.limit) throw new HubError('MEMORY_LIMIT', `This project exceeds ${this.limit.toLocaleString('en-US')} notes.`);
    const notes: MemoryNote[] = [];
    for (const file of files) { const target = path.join(dir, file.name); if (fs.statSync(target).size > 512000) continue; try { const note = noteSchema.parse(JSON.parse(fs.readFileSync(target, 'utf8'))); if (note.project === project && note.id + '.json' === file.name) notes.push(note); } catch { /* Invalid records are preserved, never executed. */ } }
    return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  import(input: unknown): boolean {
    const note = noteSchema.parse(input); const dir = this.directory(note.project); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Full: the oldest handoff moves to the archive (kept), so new notes, the automatic summaries among them, still land.
    if (!fs.existsSync(path.join(dir, note.id + '.json')) && fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && NOTE_FILE.test(entry.name)).length >= this.limit) this.makeRoom(note.project, dir);
    // Write a temporary file and rename it into place so a crash never leaves a truncated note behind
    // (a partial file would block Drive sync for that ID forever). Notes are immutable, so never replace one.
    const target = path.join(dir, note.id + '.json'); const temporary = path.join(dir, `.${randomUUID()}.tmp`);
    try {
      if (fs.existsSync(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      try { fs.writeFileSync(temporary, JSON.stringify(note, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, target); }
      finally { try { fs.unlinkSync(temporary); } catch { /* Renamed. */ } }
      return true;
    }
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
    // readConfig strips a UTF-8 BOM, so compare configuration files without it.
    const unmarked = (file: string) => (originals.get(file) ?? '').replace(/^\uFEFF/, '');
    const written = new Map<string, string>();
    const replace = (file: string, text: string) => { const temp = file + '.coding-hub-' + randomUUID(); try { fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch { /* Already renamed. */ } } };
    try {
      for (const file of targets) { const inspected = readConfig(file); if (inspected.text !== unmarked(file)) throw new HubError('CONFIG_CHANGED', 'Configuration changed during installation.'); updateConfig(file, inspected.hash, (data) => { const key = file.endsWith('.toml') ? 'mcp_servers' : 'mcpServers'; data[key] ??= {}; data[key]['coding-hub-memory'] = { command: executable, args, env: { ELECTRON_RUN_AS_NODE: '1' } }; }); written.set(file, fs.readFileSync(file, 'utf8')); }
      for (const name of ['AGENTS.md', 'CLAUDE.md']) { const file = path.join(directory, name); const existing = originals.get(file) ?? ''; if (!existing.includes('<!-- coding-hub-memory:start -->')) { if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== existing) throw new HubError('CONFIG_CHANGED', 'Instructions changed during installation.'); if (existing) keepBackup(file, existing); replace(file, existing + instruction); written.set(file, existing + instruction); } }
    } catch {
      let incomplete = false;
      for (const [file, text] of [...written].reverse()) try { if (fs.readFileSync(file, 'utf8') !== text) { incomplete = true; continue; } const original = originals.get(file); if (original === null) fs.unlinkSync(file); else replace(file, original!); } catch { incomplete = true; }
      throw new HubError('MEMORY_INSTALL_FAILED', incomplete ? 'Installation failed and another change or file lock prevented full restoration. Review the MCP and instruction files; private backups were preserved.' : 'Installation failed. Files changed by this installation were restored; private backups were preserved. Check project file permissions and retry.');
    }
  }
}
