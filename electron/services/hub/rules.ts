import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SharedRules, RulesTargetReference } from '../../../shared/hub';
import { HubError } from '../cli/engine-adapter';

const START = '<!-- coding-hub-rules:start -->';
const END = '<!-- coding-hub-rules:end -->';
const hash = (text: string | null) => createHash('sha256').update(text === null ? 'absent' : 'file:' + text).digest('hex');
const stateSchema = z.object({ version: z.literal(1), content: z.string().max(60000), directories: z.array(z.string().min(1).max(4096)).max(200) }).strict();
interface FileState { file: string; text: string | null; fingerprint: string; mode: number }

export function replaceRules(text: string, content: string): string {
  if (content.includes(START) || content.includes(END)) throw new HubError('RULES_MARKERS', 'Rules cannot contain the reserved Coding Hub section markers.');
  const start = text.indexOf(START); const end = text.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || text.indexOf(START, start + START.length) >= 0 || text.indexOf(END, end + END.length) >= 0))) throw new HubError('RULES_SECTION', 'An instruction file contains incomplete or duplicate shared-rules markers. Repair that section before applying rules.');
  const block = content.trim() ? `${START}\n## Shared rules for Claude Code and Codex\n\n${content}\n${END}` : '';
  if (start >= 0) return text.slice(0, start) + block + text.slice(end + END.length);
  return block ? text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block + '\n' : text;
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
  private transientRoot: string;
  constructor(root: string) { this.file = path.join(root, 'shared-rules.json'); this.transientRoot = path.join(root, 'coaching'); }
  /** Prepared coaching/design-feedback folders are registered but do not count as user projects. */
  private transient(directory: string) {
    let root = this.transientRoot; try { root = fs.realpathSync(root); } catch { /* Not created yet. */ }
    return path.dirname(directory) === root;
  }
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
    if (!path.isAbsolute(input)) throw new HubError('RULES_DIRECTORY', 'Select an absolute project directory.');
    try { const directory = fs.realpathSync(input); if (!fs.statSync(directory).isDirectory()) throw new Error(); return directory; }
    catch { throw new HubError('RULES_DIRECTORY', 'A selected rules project is missing or inaccessible. Remove it from the selection or restore its directory.'); }
  }
  read(directories: string[]): SharedRules {
    const { source, state } = this.state(); const seen = new Set<string>();
    const targets = [...new Set(directories)].map((input) => {
      try {
      const directory = this.directory(input);
      // Different spellings (symlinks, junctions, raw vs resolved roots) can name one project.
      if (seen.has(directory)) return null; seen.add(directory);
      const claude = this.readFile(path.join(directory, 'CLAUDE.md')); const codex = this.readFile(path.join(directory, 'AGENTS.md'));
      return { directory, claudeHash: claude.fingerprint, codexHash: codex.fingerprint, applied: state.directories.includes(directory) && applied(claude.text ?? '', state.content) && applied(codex.text ?? '', state.content) };
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
        if (text?.includes(START) || text?.includes(END)) throw new HubError('RULES_NOT_APPLIED', 'Shared rules were cleared, but this project still has the old rules. Apply the change in Shared rules before starting a session.');
      }
      return;
    }
    const target = this.read([directory]).targets[0];
    if (!target.applied) throw new HubError('RULES_NOT_APPLIED', 'Apply the current Shared rules to this project before starting a session. Both engines must receive the same saved rules.');
  }
  save(content: string, revision: string, targets: RulesTargetReference[]): SharedRules {
    const { source, state } = this.state(); if (source.fingerprint !== revision) throw new HubError('RULES_CHANGED', 'Shared rules changed since you opened the editor. Reload before saving.');
    // Validate even when saving a draft without selected projects.
    replaceRules('', content);
    const selected = targets.map((target) => ({ ...target, directory: this.directory(target.directory) }));
    if (new Set(selected.map((t) => t.directory)).size !== selected.length) throw new HubError('RULES_DIRECTORY', 'Select each project once.');
    const writes: { before: FileState; after: string }[] = [];
    for (const target of selected) for (const [name, expected] of [['CLAUDE.md', target.claudeHash], ['AGENTS.md', target.codexHash]]) {
      const before = this.readFile(path.join(target.directory, name)); if (before.fingerprint !== expected) throw new HubError('RULES_CHANGED', 'Project instructions changed since inspection. Reload to preserve those changes. Your unsaved rules remain in the editor.');
      const after = replaceRules(before.text ?? '', content); if (Buffer.byteLength(after) > 1024 * 1024) throw new HubError('RULES_FILE', 'Applying rules would exceed the 1 MiB instruction-file limit.');
      if (before.text !== after && !(before.text === null && after === '')) writes.push({ before, after });
    }
    // Drop deleted prepared coaching folders so they cannot fill the registry. Never prune user projects:
    // a network share or removable drive can be briefly unreachable.
    const directories = [...new Set([...state.directories.filter((directory) => !this.transient(directory) || fs.existsSync(directory)), ...selected.map((t) => t.directory)])];
    if (directories.filter((directory) => !this.transient(directory)).length > 100 || directories.length > 200) throw new HubError('RULES_LIMIT', 'At most 100 projects can be registered for shared rules.');
    const afterState = JSON.stringify({ version: 1, content, directories }, null, 2) + '\n';
    writes.push({ before: source, after: afterState });
    const completed: typeof writes = [];
    try {
      for (const write of writes) {
        if (this.readFile(write.before.file).fingerprint !== write.before.fingerprint) throw new HubError('RULES_CHANGED', 'A file changed during save. Reload and retry.');
        if (write.before.text !== null) fs.writeFileSync(write.before.file + '.coding-hub-backup-' + randomUUID(), write.before.text, { mode: 0o600, flag: 'wx' });
        this.replace(write.before.file, write.after, write.before.mode); completed.push(write);
      }
    } catch (error) {
      let incomplete = false;
      for (const write of [...completed].reverse()) try { if (this.readFile(write.before.file).fingerprint !== hash(write.after)) { incomplete = true; continue; } if (write.before.text === null) fs.unlinkSync(write.before.file); else this.replace(write.before.file, write.before.text, write.before.mode); } catch { incomplete = true; }
      if (incomplete) throw new HubError('RULES_RESTORE', 'Save failed; another change or file lock prevented full restoration. Review the instruction files and their private backups.');
      if (error instanceof HubError) throw error;
      throw new HubError('RULES_SAVE', 'Rules could not be saved. Changes from this save were restored. Check file permissions and retry.');
    }
    return this.read(selected.map((t) => t.directory));
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
    if (source.text !== null) fs.writeFileSync(this.file + '.coding-hub-backup-' + randomUUID(), source.text, { mode: 0o600, flag: 'wx' });
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.replace(this.file, JSON.stringify({ version: 1, content, directories: state.directories }, null, 2) + '\n', source.mode);
  }
  private replace(file: string, text: string, mode: number) {
    const temporary = file + '.coding-hub-' + randomUUID();
    try { fs.writeFileSync(temporary, text, { mode, flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or absent. */ } }
  }
}
