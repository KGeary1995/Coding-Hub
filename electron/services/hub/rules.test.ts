import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RulesService, replaceRules } from './rules';
import { hubRequestSchema } from './service';
const roots: string[] = [];
const setup = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-')); roots.push(root); const project = path.join(root, 'project'); fs.mkdirSync(project); return { root, project, rules: new RulesService(root) }; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true }); });
describe('one shared rules source for both engine instructions', () => {
  it('preserves existing instructions and memory, updates only its section, and survives restart', () => {
    const { root, project, rules } = setup(); const old = '# Existing\r\nKeep this convention.\r\n<!-- coding-hub-memory:start -->\r\nHandoff instruction\r\n<!-- coding-hub-memory:end -->\r\n'; fs.writeFileSync(path.join(project, 'CLAUDE.md'), old); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Codex instructions\n');
    const initial = rules.read([project]); const saved = rules.save('Run relevant tests.\nPreserve Unicode: 🧪', initial.revision, initial.targets); expect(saved.targets[0].applied).toBe(true); const claude = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8'); const codex = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'); expect(claude.startsWith(old)).toBe(true); expect(codex.startsWith('# Codex instructions\n')).toBe(true); expect(claude).toContain('Run relevant tests.\nPreserve Unicode: 🧪'); expect(codex).toContain('Run relevant tests.\nPreserve Unicode: 🧪'); expect(fs.readdirSync(project).some((f) => f.includes('backup'))).toBe(true);
    const changed = rules.save('New shared instructions', saved.revision, saved.targets); for (const file of ['CLAUDE.md', 'AGENTS.md']) { const text = fs.readFileSync(path.join(project, file), 'utf8'); expect(text.match(/coding-hub-rules:start/g)).toHaveLength(1); expect(text).not.toContain('Run relevant tests.'); expect(text).toContain('New shared instructions'); } expect(new RulesService(root).read([project]).content).toBe(changed.content);
  });
  it('blocks launches in unconfigured or externally changed projects and allows both after apply', () => {
    const { project, root, rules } = setup(); const initial = rules.read([]); rules.save('Test every meaningful change.', initial.revision, []); expect(() => rules.verifyLaunch(project)).toThrow('Apply'); const current = rules.read([project]); rules.save(current.content, current.revision, current.targets); expect(() => rules.verifyLaunch(project)).not.toThrow(); fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Replaced by editor\n'); expect(() => rules.verifyLaunch(project)).toThrow('Apply'); const second = path.join(root, 'second'); fs.mkdirSync(second); expect(() => rules.verifyLaunch(second)).toThrow('Apply');
  });
  it('rejects stale project files or a stale saved-rule revision without modifying either engine', () => {
    const { project, rules } = setup(); const initial = rules.read([project]); fs.writeFileSync(path.join(project, 'AGENTS.md'), '# New external convention\n'); expect(() => rules.save('Draft', initial.revision, initial.targets)).toThrow('changed'); expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(false); const fresh = rules.read([project]); rules.save('First version', fresh.revision, fresh.targets); expect(() => rules.save('Stale version', fresh.revision, [])).toThrow('changed'); expect(rules.read([]).content).toBe('First version');
  });
  it('clearing rules removes only managed sections and releases launch requirements', () => {
    const { project, rules } = setup(); fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Original\n'); const initial = rules.read([project]); const saved = rules.save('Temporary shared instructions', initial.revision, initial.targets); rules.save('', saved.revision, saved.targets); expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toContain('# Original\n'); expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).not.toContain('coding-hub-rules'); expect(() => rules.verifyLaunch(project)).not.toThrow();
  });
  it('rolls back earlier file changes if a later write is locked', () => {
    const { project, rules } = setup(); fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Original\n'); const initial = rules.read([project]); const rename = fs.renameSync; let failed = false; vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (String(to).endsWith('AGENTS.md') && !failed) { failed = true; throw new Error('Fixture file lock'); } rename(from, to); }); expect(() => rules.save('New rules', initial.revision, initial.targets)).toThrow('restored'); expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('# Original\n'); expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(false); expect(rules.read([]).content).toBe('');
  });
  it('preserves malformed state and refuses broken markers, links, and invalid payloads', () => {
    const { project, root, rules } = setup(); expect(() => replaceRules('<!-- coding-hub-rules:start -->broken', 'Rules')).toThrow('incomplete'); expect(() => replaceRules('', '<!-- coding-hub-rules:end -->')).toThrow('reserved'); fs.symlinkSync(path.join(root, 'other.md'), path.join(project, 'CLAUDE.md')); expect(rules.read([project]).targets[0].error).toContain('symbolic'); fs.writeFileSync(path.join(root, 'shared-rules.json'), '{broken'); expect(() => rules.read([])).toThrow('preserved'); expect(fs.readFileSync(path.join(root, 'shared-rules.json'), 'utf8')).toBe('{broken'); expect(hubRequestSchema.safeParse({ action: 'rules-save', content: 'x'.repeat(60001), revision: '0'.repeat(64), targets: [] }).success).toBe(false); expect(hubRequestSchema.safeParse({ action: 'rules-read', directories: [], executable: 'arbitrary' }).success).toBe(false);
  });
  it('applies the identical revision to multiple repositories without alias duplication', () => {
    const { root, project, rules } = setup(); const second = path.join(root, 'second'); fs.mkdirSync(second); const initial = rules.read([project, second]); const saved = rules.save('Use the same conventions.', initial.revision, initial.targets); expect(saved.targets.every((t) => t.applied)).toBe(true); expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe(fs.readFileSync(path.join(second, 'CLAUDE.md'), 'utf8')); expect(() => rules.save('Duplicate', saved.revision, [saved.targets[0], saved.targets[0]])).toThrow('once');
  });
});
