import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SharedRules, RulesTargetReference } from '../../../shared/hub';
import { HubError } from '../cli/engine-adapter';
import { keepBackup } from './file-backups';

const START = '<!-- coding-hub-rules:start -->';
const END = '<!-- coding-hub-rules:end -->';
const hash = (text: string | null) => createHash('sha256').update(text === null ? 'absent' : 'file:' + text).digest('hex');
const stateSchema = z.object({ version: z.literal(1), content: z.string().max(60000), directories: z.array(z.string().min(1).max(4096)).max(200) }).strict();
interface FileState { file: string; text: string | null; fingerprint: string; mode: number }
/** One folder however it is spelled: Windows and macOS compare folder names without regard to letter case. */
const folderKey = (directory: string) => process.platform === 'win32' || process.platform === 'darwin' ? directory.toLowerCase() : directory;
/** The native resolver gives the spelling launches use (fs/promises realpath); the JavaScript one keeps the typed case. */
function realDirectory(input: string) { try { return fs.realpathSync.native(input); } catch { return fs.realpathSync(input); } }
/**
 * Anything at the path, or a path that cannot be checked (no permission, an unreachable share): only "not found" counts
 * as deleted. A drive that is not connected also answers "not found" for every path on it, so forget() checks that apart.
 */
function present(directory: string) { try { fs.lstatSync(directory); return true; } catch (e) { const code = (e as NodeJS.ErrnoException).code; return code !== 'ENOENT' && code !== 'ENOTDIR'; } }
/** The drive (Windows letter or share) or macOS /Volumes disk a folder is on; null where the platform has none to check. */
function volume(directory: string) {
  if (process.platform === 'win32') return path.win32.parse(directory).root || null;
  return process.platform === 'darwin' ? /^\/Volumes\/[^/]+/.exec(directory)?.[0] ?? null : null;
}

export function replaceRules(text: string, content: string): string {
  if (content.includes(START) || content.includes(END)) throw new HubError('RULES_MARKERS', 'Rules cannot contain the reserved Coding Hub section markers.');
  const start = text.indexOf(START); const end = text.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || text.indexOf(START, start + START.length) >= 0 || text.indexOf(END, end + END.length) >= 0))) throw new HubError('RULES_SECTION', 'An instruction file contains incomplete or duplicate shared-rules markers. Repair that section before applying rules.');
  // The block takes the file's own line ending (CRLF in a Git for Windows checkout), so the file does not end up mixed.
  // Bare line breaks next to an existing block are left out of the count: older versions always wrote them bare (two in
  // front when the file had no final line break).
  const rest = start >= 0 ? text.slice(0, start).replace(/((?<!\r)\n){1,2}$/, '') + text.slice(end + END.length).replace(/^\r?\n/, '') : text; const crlf = rest.match(/\r\n/g)?.length ?? 0;
  const eol = crlf > (rest.match(/\n/g)?.length ?? 0) - crlf ? '\r\n' : '\n';
  const block = content.trim() ? `${START}\n## Shared rules for Claude Code and Codex\n\n${content}\n${END}`.replace(/\r?\n/g, eol) : '';
  if (start >= 0 && block) return text.slice(0, start).replace(/(\r?\n){1,2}$/, (breaks) => eol.repeat(breaks.split('\n').length - 1)) + block + text.slice(end + END.length).replace(/^\r?\n/, eol);
  // Removing the rules takes away what adding them put in: the blank line in front and the line break after, so a
  // file goes back to how it was (and one Trace created ends up empty, which save() then deletes).
  if (start >= 0) return text.slice(0, start).replace(/(\r?\n)\r?\n$/, '$1') + text.slice(end + END.length).replace(/^\r?\n/, '');
  return block ? text + (text && !text.endsWith('\n') ? eol : '') + (text ? eol : '') + block + eol : text;
}
function applied(text: string, content: string) {
  if (!content.trim()) return !text.includes(START) && !text.includes(END);
  // Git for Windows (core.autocrlf) checks instruction files out with CRLF; that is still the applied block.
  text = text.replace(/\r\n/g, '\n'); content = content.replace(/\r\n/g, '\n');
  const block = `${START}\n## Shared rules for Claude Code and Codex\n\n${content}\n${END}`;
  return text.includes(block) && text.indexOf(START) === text.lastIndexOf(START) && text.indexOf(END) === text.lastIndexOf(END);
}

/** One source of rules; changes replace only the managed block in both engine files. */
export class RulesService {
  private file: string;
  private transientRoots: string[];
  constructor(root: string) { this.file = path.join(root, 'shared-rules.json'); this.transientRoots = [path.join(root, 'coaching'), path.join(root, 'worktrees')]; }
  /**
   * Prepared coaching folders and Trace's own task worktrees are registered but do not count as user projects, and are
   * dropped once deleted: each new worktree registers itself, so they would otherwise fill the registry.
   */
  private transient(directory: string, roots = this.transientKeys()) { return roots.includes(folderKey(path.dirname(directory))); }
  private transientKeys() { return this.transientRoots.map((root) => { try { return folderKey(realDirectory(root)); } catch { return folderKey(root); /* Not created yet. */ } }); }
  private readFile(file: string): FileState {
    let cursor = file;
    for (;;) { try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new HubError('RULES_LINK', 'Shared rules cannot edit paths containing symbolic links.'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
    let text: string | null = null; let mode = 0o600;
    try { const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 1024 * 1024) throw new HubError('RULES_FILE', 'Shared rules require regular instruction files under 1 MiB.'); mode = stat.mode & 0o777; text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { if (e instanceof HubError) throw e; throw new HubError('RULES_FILE', 'Cannot read an instruction file as UTF-8. Existing contents were preserved.'); } }
    return { file, text, fingerprint: hash(text), mode };
  }
  private state() {
    const source = this.readFile(this.file);
    try { const state = source.text === null ? { version: 1 as const, content: '', directories: [] } : stateSchema.parse(JSON.parse(source.text)); return { source, state }; }
    catch { throw new HubError('RULES_STATE', 'Saved shared rules could not be read. The existing file was preserved.'); }
  }
  private directory(input: string) {
    if (!path.isAbsolute(input)) throw new HubError('RULES_DIRECTORY', 'Select an absolute project folder.');
    try { const directory = realDirectory(input); if (!fs.statSync(directory).isDirectory()) throw new Error(); return directory; }
    catch { throw new HubError('RULES_DIRECTORY', 'A selected rules project is missing or inaccessible. Remove it from the selection or restore its folder.'); }
  }
  read(directories: string[]): SharedRules {
    const { source, state } = this.state(); const seen = new Set<string>();
    const targets = [...new Set(directories)].map((input) => {
      try {
      const directory = this.directory(input);
      // Different spellings (symlinks, junctions, raw vs resolved roots) can name one project.
      if (seen.has(directory)) return null; seen.add(directory);
      const claude = this.readFile(path.join(directory, 'CLAUDE.md')); const codex = this.readFile(path.join(directory, 'AGENTS.md'));
      return { directory, claudeHash: claude.fingerprint, codexHash: codex.fingerprint, applied: state.directories.some((item) => folderKey(item) === folderKey(directory)) && applied(claude.text ?? '', state.content) && applied(codex.text ?? '', state.content) };
      } catch (e) { return { directory: input, claudeHash: hash(null), codexHash: hash(null), applied: false, error: e instanceof HubError ? e.message : 'Project rules could not be inspected.' }; }
    }).filter((target) => target !== null);
    return { content: state.content, revision: source.fingerprint, directories: state.directories, targets };
  }
  verifyLaunch(directory: string) {
    const { state } = this.state();
    if (!state.content.trim()) {
      // No shared rules now, but a project can still carry an old block (for example after rules were cleared on another
      // computer); its removal must be applied first so both engines start from the same instructions.
      for (const name of ['CLAUDE.md', 'AGENTS.md']) {
        let text: string | null = null; try { text = this.readFile(path.join(directory, name)).text; } catch { continue; }
        if (text?.includes(START) || text?.includes(END)) throw new HubError('RULES_NOT_APPLIED', 'Shared rules were cleared, but this project still has the old rules. Apply the change in Shared rules before starting a channel.');
      }
      return;
    }
    const target = this.read([directory]).targets[0];
    if (!target.applied) throw new HubError('RULES_NOT_APPLIED', 'Apply the current Shared rules to this project before starting a channel. Both engines must receive the same saved rules.');
  }
  save(content: string, revision: string, targets: RulesTargetReference[]): SharedRules {
    const { source, state } = this.state(); if (source.fingerprint !== revision) throw new HubError('RULES_CHANGED', 'Shared rules changed since you opened the editor. Reload before saving.');
    // Validate even when saving a draft without selected projects.
    replaceRules('', content);
    const selected = targets.map((target) => ({ ...target, directory: this.directory(target.directory) }));
    if (new Set(selected.map((t) => t.directory)).size !== selected.length) throw new HubError('RULES_DIRECTORY', 'Select each project once.');
    // `after` null: the file is deleted (it held only the rules, which were removed).
    const writes: { before: FileState; after: string | null }[] = [];
    for (const target of selected) for (const [name, expected] of [['CLAUDE.md', target.claudeHash], ['AGENTS.md', target.codexHash]]) {
      const before = this.readFile(path.join(target.directory, name)); if (before.fingerprint !== expected) throw new HubError('RULES_CHANGED', 'Project instructions changed since inspection. Reload to preserve those changes. Your unsaved rules remain in the editor.');
      const result = replaceRules(before.text ?? '', content); if (Buffer.byteLength(result) > 1024 * 1024) throw new HubError('RULES_FILE', 'Applying rules would exceed the 1 MiB instruction-file limit.');
      const after = before.text !== null && before.text.includes(START) && !result.trim() ? null : result;
      if (before.text !== after && !(before.text === null && after === '')) writes.push({ before, after });
    }
    // Drop deleted prepared coaching folders and worktrees so they cannot fill the registry. Never prune user projects:
    // a network share or removable drive can be briefly unreachable. A project saved again replaces its older spelling.
    const chosen = new Map(selected.map((t) => [folderKey(t.directory), t.directory])); const roots = this.transientKeys();
    const directories = [...new Set([...state.directories.map((directory) => chosen.get(folderKey(directory)) ?? directory).filter((directory) => !this.transient(directory, roots) || fs.existsSync(directory)), ...selected.map((t) => t.directory)])];
    if (directories.filter((directory) => !this.transient(directory, roots)).length > 100 || directories.length > 200) throw new HubError('RULES_LIMIT', 'At most 100 projects can be registered for shared rules.');
    const afterState = JSON.stringify({ version: 1, content, directories }, null, 2) + '\n';
    writes.push({ before: source, after: afterState });
    const completed: typeof writes = [];
    try {
      for (const write of writes) {
        if (this.readFile(write.before.file).fingerprint !== write.before.fingerprint) throw new HubError('RULES_CHANGED', 'A file changed during save. Reload and retry.');
        if (write.before.text !== null) keepBackup(write.before.file, write.before.text);
        if (write.after === null) fs.unlinkSync(write.before.file); else this.replace(write.before.file, write.after, write.before.mode);
        completed.push(write);
      }
    } catch (error) {
      let incomplete = false;
      for (const write of [...completed].reverse()) try { if (this.readFile(write.before.file).fingerprint !== hash(write.after)) { incomplete = true; continue; } if (write.before.text === null) fs.unlinkSync(write.before.file); else this.replace(write.before.file, write.before.text, write.before.mode); } catch { incomplete = true; }
      if (incomplete) throw new HubError('RULES_RESTORE', 'Save failed; another change or file lock prevented full restoration. Review the instruction files; earlier versions are kept under config-backups in the Trace data folder.');
      if (error instanceof HubError) throw error;
      throw new HubError('RULES_SAVE', 'Rules could not be saved. Changes from this save were restored. Check file permissions and retry.');
    }
    return this.read(selected.map((t) => t.directory));
  }
  /**
   * Takes a project whose folder was deleted out of the registry, at the person's request (save() never prunes user
   * projects, since a share or drive can be briefly unreachable). Only the registry changes: no project file is touched.
   */
  forget(input: string) {
    if (!path.isAbsolute(input)) throw new HubError('RULES_DIRECTORY', 'Select an absolute project folder.');
    const { source, state } = this.state(); const key = folderKey(input); const matches = state.directories.filter((directory) => folderKey(directory) === key);
    if (!matches.length) throw new HubError('RULES_UNKNOWN', 'That project is not registered for shared rules. Reload Shared rules to see the current list.');
    if ([input, ...matches].some((directory) => present(directory))) throw new HubError('RULES_PRESENT', 'That project folder still exists, so Trace keeps it. Only a project whose folder was deleted can be removed here.');
    // An unplugged USB or mapped drive, or an unmounted disk, hides a folder that still exists: keep the project.
    const offline = [input, ...matches].map(volume).find((root) => root !== null && !fs.existsSync(root));
    if (offline) throw new HubError('RULES_OFFLINE', `The drive ${offline} is not connected, so Trace cannot tell whether the project folder was deleted. Connect the drive and check again, or leave the project registered.`);
    if (this.readFile(this.file).fingerprint !== source.fingerprint) throw new HubError('RULES_CHANGED', 'Shared rules changed while removing the project. Reload and retry.');
    if (source.text !== null) keepBackup(this.file, source.text);
    this.replace(this.file, JSON.stringify({ version: 1, content: state.content, directories: state.directories.filter((directory) => folderKey(directory) !== key) }, null, 2) + '\n', source.mode);
  }
  /** The saved rules text, without project targets (device sync compares and carries only this). */
  content() { return this.state().state.content; }
  /**
   * Replaces the saved rules text with a version from another computer. Project files are not touched: until the person
   * applies the new rules to a project, that project shows as not applied and its sessions do not start.
   */
  adopt(content: string) {
    replaceRules('', content);
    const { source, state } = this.state(); if (state.content === content) return;
    if (this.readFile(this.file).fingerprint !== source.fingerprint) throw new HubError('RULES_CHANGED', 'Shared rules changed during sync. It will retry.');
    if (source.text !== null) keepBackup(this.file, source.text);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.replace(this.file, JSON.stringify({ version: 1, content, directories: state.directories }, null, 2) + '\n', source.mode);
  }
  private replace(file: string, text: string, mode: number) {
    const temporary = file + '.coding-hub-' + randomUUID();
    try { fs.writeFileSync(temporary, text, { mode, flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or absent. */ } }
  }
}
