import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RulesService, replaceRules } from './rules';
import { hubRequestSchema } from './service';
import { backupFolder } from './file-backups';
import { canSymlink } from './symlink.fixture';
const roots: string[] = [];
/** The native spelling, as the service resolves folders: a temp folder reached by a short name (RUNNER~1) is expanded. */
const setup = () => { const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-'))); roots.push(root); const project = path.join(root, 'project'); fs.mkdirSync(project); return { root, project, rules: new RulesService(root) }; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true }); });
describe('one shared rules source for both engine instructions', () => {
  it('preserves existing instructions and memory, updates only its section, and survives restart', () => {
    const { root, project, rules } = setup(); const old = '# Existing\r\nKeep this convention.\r\n<!-- coding-hub-memory:start -->\r\nHandoff instruction\r\n<!-- coding-hub-memory:end -->\r\n'; fs.writeFileSync(path.join(project, 'CLAUDE.md'), old); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Codex instructions\n');
    const initial = rules.read([project]); const saved = rules.save('Run relevant tests.\nPreserve Unicode: 🧪', initial.revision, initial.targets); expect(saved.targets[0].applied).toBe(true); const claude = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8'); const codex = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'); expect(claude.startsWith(old)).toBe(true); expect(codex.startsWith('# Codex instructions\n')).toBe(true); /* The block takes each file's own line ending. */ expect(claude).toContain('Run relevant tests.\r\nPreserve Unicode: 🧪'); expect(claude.replace(/\r\n/g, '')).not.toContain('\n'); expect(codex).toContain('Run relevant tests.\nPreserve Unicode: 🧪'); expect(fs.readdirSync(project).some((f) => f.includes('backup'))).toBe(false); expect(fs.readdirSync(backupFolder(path.join(project, 'CLAUDE.md'))).length).toBeGreaterThan(1);
    const changed = rules.save('New shared instructions', saved.revision, saved.targets); for (const file of ['CLAUDE.md', 'AGENTS.md']) { const text = fs.readFileSync(path.join(project, file), 'utf8'); expect(text.match(/coding-hub-rules:start/g)).toHaveLength(1); expect(text).not.toContain('Run relevant tests.'); expect(text).toContain('New shared instructions'); } expect(new RulesService(root).read([project]).content).toBe(changed.content);
  });
  it('blocks launches in unconfigured or externally changed projects and allows both after apply', () => {
    const { project, root, rules } = setup(); const initial = rules.read([]); rules.save('Test every meaningful change.', initial.revision, []); expect(() => rules.verifyLaunch(project)).toThrow('Apply'); const current = rules.read([project]); rules.save(current.content, current.revision, current.targets); expect(() => rules.verifyLaunch(project)).not.toThrow(); fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Replaced by editor\n'); expect(() => rules.verifyLaunch(project)).toThrow('Apply'); const second = path.join(root, 'second'); fs.mkdirSync(second); expect(() => rules.verifyLaunch(second)).toThrow('Apply');
  });
  it('rejects stale project files or a stale saved-rule revision without modifying either engine', () => {
    const { project, rules } = setup(); const initial = rules.read([project]); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# New external convention\n'); expect(() => rules.save('Draft', initial.revision, initial.targets)).toThrow('changed'); expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(false); const fresh = rules.read([project]); rules.save('First version', fresh.revision, fresh.targets); expect(() => rules.save('Stale version', fresh.revision, [])).toThrow('changed'); expect(rules.read([]).content).toBe('First version');
  });
  it('rules cleared on another computer block launches until their removal is applied here', () => {
    const { project, rules } = setup(); const initial = rules.read([project]); const saved = rules.save('Shared instructions', initial.revision, initial.targets);
    rules.adopt(''); expect(rules.content()).toBe('');
    expect(() => rules.verifyLaunch(project)).toThrow('Shared rules were cleared');
    const current = rules.read([project]); expect(current.targets[0].applied).toBe(false); rules.save('', current.revision, current.targets);
    expect(() => rules.verifyLaunch(project)).not.toThrow(); expect(saved.targets[0].applied).toBe(true);
  });
  it('clearing rules removes only managed sections and releases launch requirements', () => {
    const { project, rules } = setup(); fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Original\n'); const initial = rules.read([project]); const saved = rules.save('Temporary shared instructions', initial.revision, initial.targets); rules.save('', saved.revision, saved.targets); expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('# Original\n'); /* AGENTS.md held only the rules Trace added: it is gone, not left with a stray line. */ expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(false); expect(() => rules.verifyLaunch(project)).not.toThrow();
  });
  it('rolls back earlier file changes if a later write is locked', () => {
    const { project, rules } = setup(); fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Original\n'); const initial = rules.read([project]); const rename = fs.renameSync; let failed = false; vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (String(to).endsWith('AGENTS.md') && !failed) { failed = true; throw new Error('Fixture file lock'); } rename(from, to); }); expect(() => rules.save('New rules', initial.revision, initial.targets)).toThrow('restored'); expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('# Original\n'); expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(false); expect(rules.read([]).content).toBe('');
  });
  it.skipIf(!canSymlink)('refuses instruction files reached through symbolic links', () => {
    const { project, root, rules } = setup(); fs.symlinkSync(path.join(root, 'other.md'), path.join(project, 'CLAUDE.md')); expect(rules.read([project]).targets[0].error).toContain('symbolic');
  });
  it('preserves malformed state and refuses broken markers and invalid payloads', () => {
    const { root, rules } = setup(); expect(() => replaceRules('<!-- coding-hub-rules:start -->broken', 'Rules')).toThrow('incomplete'); expect(() => replaceRules('', '<!-- coding-hub-rules:end -->')).toThrow('reserved'); fs.writeFileSync(path.join(root, 'shared-rules.json'), '{broken'); expect(() => rules.read([])).toThrow('preserved'); expect(fs.readFileSync(path.join(root, 'shared-rules.json'), 'utf8')).toBe('{broken'); expect(hubRequestSchema.safeParse({ action: 'rules-save', content: 'x'.repeat(60001), revision: '0'.repeat(64), targets: [] }).success).toBe(false); expect(hubRequestSchema.safeParse({ action: 'rules-read', directories: [], executable: 'arbitrary' }).success).toBe(false);
  });
  it('applies the identical revision to multiple repositories without alias duplication', () => {
    const { root, project, rules } = setup(); const second = path.join(root, 'second'); fs.mkdirSync(second); const initial = rules.read([project, second]); const saved = rules.save('Use the same conventions.', initial.revision, initial.targets); expect(saved.targets.every((t) => t.applied)).toBe(true); expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe(fs.readFileSync(path.join(second, 'CLAUDE.md'), 'utf8')); expect(() => rules.save('Duplicate', saved.revision, [saved.targets[0], saved.targets[0]])).toThrow('once');
  });
});
describe('shared rules regressions', () => {
  it('accepts instruction files checked out with CRLF line endings', () => {
    const { project, rules } = setup(); const initial = rules.read([project]); rules.save('Line one\nLine two', initial.revision, initial.targets);
    for (const file of ['CLAUDE.md', 'AGENTS.md']) { const target = path.join(project, file); fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\n/g, '\r\n')); }
    expect(() => rules.verifyLaunch(project)).not.toThrow();
  });
  it.skipIf(!canSymlink)('returns one target for different spellings of the same project', () => {
    const { root, project, rules } = setup(); const alias = path.join(root, 'alias'); fs.symlinkSync(project, alias);
    const initial = rules.read([alias, project]); expect(initial.targets).toHaveLength(1);
    expect(() => rules.save('Shared', initial.revision, initial.targets)).not.toThrow();
  });
  it('drops deleted folders and does not count prepared coaching folders toward the project limit', () => {
    const { root, project, rules } = setup(); let state = rules.read([]);
    for (let index = 0; index < 100; index++) { const folder = path.join(root, 'coaching', `report-${index}`); fs.mkdirSync(folder, { recursive: true }); state = rules.read([folder]); state = rules.save(state.content, state.revision, state.targets); }
    const gone = path.join(root, 'coaching', 'report-0'); fs.rmSync(gone, { recursive: true });
    state = rules.read([project]); state = rules.save(state.content, state.revision, state.targets);
    expect(state.directories).toContain(project); expect(state.directories).not.toContain(gone);
    // 100 rule saves take about 2 s alone; with the whole suite running they passed vitest's default 5 s and failed.
  }, 30_000);
  it('keeps user projects registered while their folder is temporarily unreachable', () => {
    const { root, project, rules } = setup(); let state = rules.read([project]); state = rules.save('Shared', state.revision, state.targets);
    const away = project + '-offline'; fs.renameSync(project, away);
    const other = path.join(root, 'other'); fs.mkdirSync(other); state = rules.read([other]); state = rules.save(state.content, state.revision, state.targets);
    fs.renameSync(away, project); expect(() => rules.verifyLaunch(project)).not.toThrow();
  });
  it('forgets a registered project only once its folder is gone, and touches no project file', () => {
    const { root, project, rules } = setup(); const other = path.join(root, 'other'); fs.mkdirSync(other);
    let state = rules.read([project, other]); state = rules.save('Shared', state.revision, state.targets);
    const claude = fs.readFileSync(path.join(other, 'CLAUDE.md'), 'utf8');
    expect(() => rules.forget(project)).toThrow(expect.objectContaining({ code: 'RULES_PRESENT' }));
    fs.rmSync(project, { recursive: true }); expect(rules.read(state.directories).targets.find((target) => target.directory === project)?.error).toMatch(/missing/);
    expect(hubRequestSchema.parse({ action: 'rules-forget', directory: project })).toEqual({ action: 'rules-forget', directory: project });
    rules.forget(project.toUpperCase() === project || process.platform === 'linux' ? project : project.toUpperCase());
    const after = rules.read([]); expect(after.directories).toEqual([other]); expect(after.content).toBe('Shared');
    expect(fs.readFileSync(path.join(other, 'CLAUDE.md'), 'utf8')).toBe(claude); expect(() => rules.verifyLaunch(other)).not.toThrow();
    expect(() => rules.forget(project)).toThrow(expect.objectContaining({ code: 'RULES_UNKNOWN' }));
    expect(() => rules.forget('relative')).toThrow(expect.objectContaining({ code: 'RULES_DIRECTORY' }));
  });
  /** A registry that names `directory`, written as an older Trace (or another computer's sync) leaves it. */
  const registered = (root: string, directory: string) => { const file = path.join(root, 'shared-rules.json'); fs.writeFileSync(file, JSON.stringify({ version: 1, content: 'Shared', directories: [directory] })); return fs.readFileSync(file, 'utf8'); };
  it.runIf(process.platform === 'win32')('keeps a project on a drive letter that is not connected', () => {
    const { root, rules } = setup(); const letter = 'ZYXWVUTSRQPONMLKJIHGFED'.split('').find((item) => !fs.existsSync(`${item}:\\`));
    if (!letter) return; const directory = `${letter}:\\work\\project`; const before = registered(root, directory);
    expect(() => rules.forget(directory)).toThrow(expect.objectContaining({ code: 'RULES_OFFLINE' }));
    expect(fs.readFileSync(path.join(root, 'shared-rules.json'), 'utf8')).toBe(before);
  });
  it('keeps a project on a Mac disk that is not mounted', () => {
    const { root, rules } = setup(); const directory = `/Volumes/trace-absent-${process.pid}/project`; const before = registered(root, directory);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!; Object.defineProperty(process, 'platform', { value: 'darwin' });
    try { expect(() => rules.forget(directory)).toThrow(expect.objectContaining({ code: 'RULES_OFFLINE' })); }
    finally { Object.defineProperty(process, 'platform', platform); }
    expect(fs.readFileSync(path.join(root, 'shared-rules.json'), 'utf8')).toBe(before);
  });
  it('does not create empty instruction files when saving empty rules', () => {
    const { project, rules } = setup(); const initial = rules.read([project]); rules.save('', initial.revision, initial.targets);
    expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(false); expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
  });
});

it('removing the rules gives back the file as it was before they were added', () => {
  const NL = String.fromCharCode(10);
  for (const original of ['# Original' + NL, '# Original', '']) {
    const withRules = replaceRules(original, 'Shared rules');
    expect(replaceRules(withRules, '')).toBe(original.endsWith(NL) || !original ? original : original + NL);
  }
});
it('writes the block with a CRLF file’s own line ending and removes it without a stray blank line', () => {
  const withRules = replaceRules('# Original\r\nKeep this.\r\n', 'Line one\nLine two');
  expect(withRules.replace(/\r\n/g, '')).not.toContain('\n'); expect(withRules).toContain('Line one\r\nLine two');
  expect(replaceRules(withRules, '')).toBe('# Original\r\nKeep this.\r\n');
  // A block an older Trace wrote with bare line breaks into a CRLF file comes out cleanly too, and is rewritten in CRLF.
  const older = '# Original\r\n\n<!-- coding-hub-rules:start -->\n## Shared rules for Claude Code and Codex\n\nOld\n<!-- coding-hub-rules:end -->\n';
  expect(replaceRules(older, '')).toBe('# Original\r\n'); expect(replaceRules(older, 'New').replace(/\r\n/g, '')).not.toContain('\n');
  expect(replaceRules('# Plain\n', 'Rules')).not.toContain('\r');
  // Older versions put two bare line breaks in front of the block when the file had no final one: both take the file's ending.
  const unterminated = '# A\r\nlast\n\n<!-- coding-hub-rules:start -->\n## Shared rules for Claude Code and Codex\n\nOld\n<!-- coding-hub-rules:end -->\n';
  expect(replaceRules(unterminated, 'New')).toBe('# A\r\nlast\r\n\r\n<!-- coding-hub-rules:start -->\r\n## Shared rules for Claude Code and Codex\r\n\r\nNew\r\n<!-- coding-hub-rules:end -->\r\n');
});
it.runIf(process.platform === 'win32')('a project applied under a differently cased path still starts with the canonical spelling', () => {
  const { project, rules } = setup(); const typed = project.toLowerCase(); expect(typed).not.toBe(project);
  const initial = rules.read([typed]); rules.save('Shared', initial.revision, initial.targets);
  expect(() => rules.verifyLaunch(fs.realpathSync.native(project))).not.toThrow();
  expect(rules.read([]).directories).toEqual([fs.realpathSync.native(project)]);
});
it('does not keep deleted task worktrees registered or count them toward the project limit', () => {
  const { root, project, rules } = setup(); let state = rules.read([]);
  const trees = [0, 1].map((index) => { const folder = path.join(root, 'worktrees', `tree-${index}`); fs.mkdirSync(folder, { recursive: true }); state = rules.read([folder]); state = rules.save('Shared', state.revision, state.targets); return state.directories.at(-1)!; });
  fs.rmSync(path.join(root, 'worktrees', 'tree-0'), { recursive: true });
  state = rules.read([project]); state = rules.save(state.content, state.revision, state.targets);
  expect(state.directories).not.toContain(trees[0]); expect(state.directories).toContain(trees[1]); expect(state.directories).toHaveLength(2);
});
