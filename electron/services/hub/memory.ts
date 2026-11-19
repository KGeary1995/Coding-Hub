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
const MAX_NOTE_BYTES = 512000;
/** Notes read or written at once by the asynchronous paths: enough to overlap a slow Drive folder, few enough to leave the process free. */
const AT_ONCE = 8;
const CONFLICT = 'A remote handoff conflicts with a local ID. Both files were preserved; inspect the remote note before importing.';
const newestFirst = (a: MemoryNote, b: MemoryNote) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
/** A note file's text as the note `id` of `project`, or null when list() would leave it out. */
function parseNote(text: string, project: string, id: string): MemoryNote | null { try { const note = noteSchema.parse(JSON.parse(text)); return note.project === project && note.id === id ? note : null; } catch { return null; } }
async function readNote(file: string, project: string, id: string): Promise<MemoryNote | null> { try { if ((await fs.promises.stat(file)).size > MAX_NOTE_BYTES) return null; return parseNote(await fs.promises.readFile(file, 'utf8'), project, id); } catch { return null; } }
export class MemoryService {
  /** `limit`: notes a project keeps listed (MAX_NOTES; smaller in tests). */
  constructor(readonly root: string, private readonly limit = MAX_NOTES) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); this.checkRoot(); }
  private checkRoot() { if (!fs.lstatSync(this.root).isDirectory() || fs.lstatSync(this.root).isSymbolicLink()) throw new HubError('MEMORY_PATH', 'Memory storage must be a real folder, not a symbolic link.'); }
  directory(project: string) { this.checkRoot(); projectSchema.parse(project); const target = path.join(this.root, project); if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new HubError('MEMORY_PATH', 'Memory project cannot be a symbolic link.'); return target; }
  /** Each project's count and newest date as last read, by the folder's modification time: notes are added or archived, never edited. */
  private counted = new Map<string, { stamp: number; notes: number; latest: string }>();
  /**
   * The memory projects with notes, newest first: key, how many notes, and when the newest was written. Without holding
   * the process (a channel's Settings asks for it each time it opens), and a project's notes are read again only when
   * its folder changed since the last ask.
   */
  async projectsLater(): Promise<{ key: string; notes: number; latest: string }[]> {
    await this.checkRootLater(); const out: { key: string; notes: number; latest: string }[] = [];
    for (const entry of await fs.promises.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !projectSchema.safeParse(entry.name).success) continue;
      try {
        const stamp = (await fs.promises.stat(path.join(this.root, entry.name))).mtimeMs; let known = this.counted.get(entry.name);
        if (known?.stamp !== stamp) { const notes = await this.listLater(entry.name); known = { stamp, notes: notes.length, latest: notes[0]?.createdAt ?? '' }; this.counted.set(entry.name, known); }
        if (known.notes) out.push({ key: entry.name, notes: known.notes, latest: known.latest });
      } catch { /* Skipped. */ }
    }
    return out.sort((a, b) => b.latest.localeCompare(a.latest)).slice(0, 200);
  }
  /** checkRoot() without holding the process on a slow folder such as Google Drive (lstat does not follow a link, so a linked root is no directory here). */
  private async checkRootLater() { if (!(await fs.promises.lstat(this.root)).isDirectory()) throw new HubError('MEMORY_PATH', 'Memory storage must be a real folder, not a symbolic link.'); }
  /** directory() without holding the process on a slow folder. */
  async directoryLater(project: string): Promise<string> {
    projectSchema.parse(project); await this.checkRootLater(); const target = path.join(this.root, project);
    if ((await fs.promises.lstat(target).catch(() => null))?.isSymbolicLink()) throw new HubError('MEMORY_PATH', 'Memory project cannot be a symbolic link.');
    return target;
  }
  /**
   * A project's notes by id, with each file's size, archived ones included, and the ids of the archived ones: from the
   * folder listings and file sizes alone (no note is read), without holding the process while a slow folder (Google
   * Drive answers each file in about half a millisecond) is read.
   */
  async listing(project: string): Promise<{ sizes: Map<string, number>; archived: Set<string> }> {
    const dir = await this.directoryLater(project); const sizes = new Map<string, number>(); const archived = new Set<string>();
    for (const folder of [dir, path.join(dir, ARCHIVE)]) {
      let entries: fs.Dirent[]; try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); } catch { continue; }
      const names = entries.filter((e) => e.isFile() && NOTE_FILE.test(e.name)).map((e) => e.name);
      if (folder !== dir) for (const name of names) archived.add(name.slice(0, -5));
      for (let i = 0; i < names.length; i += 32) await Promise.all(names.slice(i, i + 32).map(async (name) => { sizes.set(name.slice(0, -5), (await fs.promises.stat(path.join(folder, name))).size); }));
    }
    return { sizes, archived };
  }
  /** One listed note, or null when list() would leave it out: missing, archived, too large, or not a valid note of this project. */
  note(project: string, id: string): MemoryNote | null {
    const target = path.join(this.directory(project), id + '.json');
    try { if (fs.statSync(target).size > MAX_NOTE_BYTES) return null; return parseNote(fs.readFileSync(target, 'utf8'), project, id); } catch { return null; }
  }
  /** note() for each of `ids`, read `atOnce` at a time without holding the process. */
  async notesLater(project: string, ids: string[], atOnce = AT_ONCE): Promise<Map<string, MemoryNote | null>> {
    const dir = await this.directoryLater(project); const notes = new Map<string, MemoryNote | null>();
    for (let i = 0; i < ids.length; i += atOnce) await Promise.all(ids.slice(i, i + atOnce).map(async (id) => { notes.set(id, await readNote(path.join(dir, id + '.json'), project, id)); }));
    return notes;
  }
  /**
   * Room for `count` more notes in a full project: the oldest handoffs or summaries (never an open item or decision, which
   * stay in effect until resolved or retired) move to the project's archive folder. Nothing is deleted. A project past
   * its limit (another writer added a note while Drive sync copied some) is read anyway, so the next write brings it back.
   */
  private makeRoom(project: string, dir: string, count: number) {
    const oldest = this.read(project, false).filter((note) => !isItemNote(note)).slice(-count);
    if (oldest.length) fs.mkdirSync(path.join(dir, ARCHIVE), { recursive: true, mode: 0o700 });
    for (const note of oldest) fs.renameSync(path.join(dir, note.id + '.json'), path.join(dir, ARCHIVE, note.id + '.json'));
    if (oldest.length < count) throw new HubError('MEMORY_LIMIT', this.fullMessage());
  }
  list(project: string): MemoryNote[] { return this.read(project, true); }
  /** list(); `limited` false also reads a project past its limit, for making room in it. */
  private read(project: string, limited: boolean): MemoryNote[] {
    const dir = this.directory(project); if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /^[0-9a-f-]{36}\.json$/.test(e.name));
    if (limited && files.length > this.limit) throw new HubError('MEMORY_LIMIT', `This project exceeds ${this.limit.toLocaleString('en-US')} notes.`);
    const notes: MemoryNote[] = [];
    // Invalid records are preserved, never executed. A file locked or archived since the listing is left out, as listLater does.
    for (const file of files) {
      const target = path.join(dir, file.name); let text: string;
      try { if (fs.statSync(target).size > MAX_NOTE_BYTES) continue; text = fs.readFileSync(target, 'utf8'); } catch { continue; }
      const note = parseNote(text, project, file.name.slice(0, -5)); if (note) notes.push(note);
    }
    return notes.sort(newestFirst);
  }
  /** list(), without holding the process: the files are read a few dozen at a time. */
  listLater(project: string): Promise<MemoryNote[]> { return this.readLater(project, true); }
  private async readLater(project: string, limited: boolean): Promise<MemoryNote[]> {
    const dir = await this.directoryLater(project); let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const ids = entries.filter((e) => e.isFile() && NOTE_FILE.test(e.name)).map((e) => e.name.slice(0, -5));
    if (limited && ids.length > this.limit) throw new HubError('MEMORY_LIMIT', `This project exceeds ${this.limit.toLocaleString('en-US')} notes.`);
    return [...(await this.notesLater(project, ids, 32)).values()].filter((note): note is MemoryNote => note !== null).sort(newestFirst);
  }
  import(input: unknown): boolean {
    const note = noteSchema.parse(input); const dir = this.directory(note.project); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Full: the oldest handoff moves to the archive (kept), so new notes, the automatic summaries among them, still land.
    const count = fs.existsSync(path.join(dir, note.id + '.json')) ? 0 : fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && NOTE_FILE.test(entry.name)).length;
    if (count >= this.limit) this.makeRoom(note.project, dir, count - this.limit + 1);
    // Write a temporary file and rename it into place so a crash never leaves a truncated note behind
    // (a partial file would block Drive sync for that ID forever). Notes are immutable, so never replace one.
    const target = path.join(dir, note.id + '.json'); const temporary = path.join(dir, `.${randomUUID()}.tmp`);
    try {
      if (fs.existsSync(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      try { fs.writeFileSync(temporary, JSON.stringify(note, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, target); }
      finally { try { fs.unlinkSync(temporary); } catch { /* Renamed. */ } }
      return true;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { const original = this.note(note.project, note.id); if (original && JSON.stringify(original) === JSON.stringify(note)) return false; throw new HubError('MEMORY_CONFLICT', CONFLICT); } throw error; }
  }
  /**
   * import() for notes of one project, without holding the process (Drive sync copies hundreds at times): the folder is
   * listed once rather than once per note, room is made once for all of them, and a few are written at a time. One
   * that fails does not stop the rest; the first failure is returned with the count of notes written.
   */
  async importLater(project: string, input: unknown[]): Promise<{ imported: number; failure: unknown }> {
    const dir = await this.directoryLater(project); await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    let imported = 0; let failure: unknown = null; const notes: MemoryNote[] = [];
    // Checked and normalised as import() does: these files land in the shared Drive folder too.
    for (const each of input) { const parsed = noteSchema.safeParse(each); if (!parsed.success) failure ??= new HubError('MEMORY_INVALID', 'A note was not copied because it is not a valid note. The other notes were copied.'); else if (parsed.data.project !== project) failure ??= new HubError('MEMORY_CONFLICT', CONFLICT); else notes.push(parsed.data as MemoryNote); }
    const listed = async () => new Set((await fs.promises.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && NOTE_FILE.test(e.name)).map((e) => e.name.slice(0, -5)));
    let present = await listed(); const fresh = (some: MemoryNote[]) => some.filter((note) => !present.has(note.id)).length;
    /** Free places for `count` notes, after moving handoffs to the archive when there are too few. */
    const room = async (count: number) => { const free = this.limit - present.size; if (count <= free) return free; try { return free + await this.makeRoomLater(project, dir, count - free); } catch (error) { failure ??= error; return free; } };
    // Near the limit, another writer (a session summary, the memory server) can add a note while these are written:
    // count again before each batch. Far from it, a few such notes cannot pass the limit.
    const tight = present.size + fresh(notes) > this.limit - AT_ONCE;
    if (tight) await room(fresh(notes));
    for (let i = 0; i < notes.length; i += AT_ONCE) {
      const batch = notes.slice(i, i + AT_ONCE); let free = Infinity; let slot = 0;
      if (tight) { present = await listed(); free = await room(fresh(batch)); }
      await Promise.all(batch.map(async (note) => {
        // A slot is taken before the first await, so notes written together never pass the limit.
        if (!present.has(note.id) && slot++ >= free) { failure ??= new HubError('MEMORY_LIMIT', this.fullMessage()); return; }
        try { if (await this.writeLater(dir, note)) imported++; } catch (error) { failure ??= error; }
      }));
    }
    return { imported, failure };
  }
  /** One note written as import() writes it: false when the same note is there already; a different one there is a conflict. */
  private async writeLater(dir: string, note: MemoryNote): Promise<boolean> {
    const target = path.join(dir, note.id + '.json'); const temporary = path.join(dir, `.${randomUUID()}.tmp`);
    const there = async () => { if (!await fs.promises.lstat(target).then(() => true, () => false)) return false; const original = await readNote(target, note.project, note.id); if (original && JSON.stringify(original) === JSON.stringify(note)) return true; throw new HubError('MEMORY_CONFLICT', CONFLICT); };
    if (await there()) return false;
    try { await fs.promises.writeFile(temporary, JSON.stringify(note, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); if (await there()) return false; await fs.promises.rename(temporary, target); return true; }
    finally { await fs.promises.unlink(temporary).catch(() => { /* Renamed. */ }); }
  }
  /** makeRoom() for `count` notes at once, without holding the process: how many handoffs moved to the archive. */
  private async makeRoomLater(project: string, dir: string, count: number): Promise<number> {
    const oldest = (await this.readLater(project, false)).filter((note) => !isItemNote(note)).slice(-count);
    if (!oldest.length) throw new HubError('MEMORY_LIMIT', this.fullMessage());
    await fs.promises.mkdir(path.join(dir, ARCHIVE), { recursive: true, mode: 0o700 });
    for (const note of oldest) await fs.promises.rename(path.join(dir, note.id + '.json'), path.join(dir, ARCHIVE, note.id + '.json'));
    return oldest.length;
  }
  private fullMessage() { return `This project holds ${this.limit.toLocaleString('en-US')} notes and none can move to its archive: they are open items, decisions or files Trace cannot read. Resolve or retire some open items before adding more.`; }
  write(project: string, title: string, content: string, author: MemoryNote['author'], supersedes?: string): MemoryNote { if (supersedes && !this.note(project, supersedes)) throw new HubError('MEMORY_REVISION', 'The original handoff is unavailable. Refresh before saving a revision.'); const note = noteSchema.parse({ id: randomUUID(), project, title, content, author, createdAt: new Date().toISOString(), ...(supersedes ? { supersedes } : {}) }); this.import(note); return note; }
  install(directory: string, project: string, server: string, executable: string) {
    projectSchema.parse(project); if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory() || fs.realpathSync(directory) !== path.resolve(directory)) throw new HubError('PROJECT_PATH', 'Use the canonical project folder for memory installation.');
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
