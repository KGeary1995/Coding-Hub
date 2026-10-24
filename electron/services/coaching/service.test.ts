import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoachingService } from './service';
import { RulesService } from '../hub/rules';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
describe('explicit local coaching reports', () => {
  it('stores curated examples, removes them on request, and prepares a separate report folder with shared rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-coaching-')); roots.push(root); const rules = new RulesService(root); const service = new CoachingService(root, rules);
    const item = service.execute({ action: 'add', text: 'Review this function', notes: 'Some rework', outcome: 'partial' }) as any;
    expect(service.execute({ action: 'list' })).toHaveLength(1);
    const prepared = service.execute({ action: 'prepare', report: 'Selected examples only' }) as any;
    expect(prepared.directory.startsWith(path.join(root, 'coaching') + path.sep)).toBe(true); expect(fs.readFileSync(path.join(prepared.directory, 'COACHING_REPORT.md'), 'utf8')).toBe('Selected examples only'); expect(() => rules.verifyLaunch(prepared.directory)).not.toThrow();
    service.execute({ action: 'remove', id: item.id }); expect(service.execute({ action: 'list' })).toEqual([]);
    expect(() => service.execute({ action: 'prepare', report: 'bad\x1b[200~' })).toThrow('Invalid');
  });
});
describe('prepared folder limit', () => {
  it('replaces the oldest unused folder instead of refusing after 100 requests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-coaching-')); roots.push(root); const rules = new RulesService(root);
    let protectedFolder = ''; const service = new CoachingService(root, rules, (directory) => directory === protectedFolder);
    const folders: string[] = [];
    for (let index = 0; index < 100; index++) { const { directory } = service.execute({ action: 'prepare', report: `Report ${index}` }) as { directory: string }; const time = new Date(Date.UTC(2026, 0, 1, 0, index)); fs.utimesSync(directory, time, time); folders.push(directory); }
    protectedFolder = folders[0];
    const next = service.execute({ action: 'prepare', report: 'Report 100' }) as { directory: string };
    expect(fs.existsSync(next.directory)).toBe(true); expect(fs.existsSync(folders[0])).toBe(true); expect(fs.existsSync(folders[1])).toBe(false); expect(fs.existsSync(folders[2])).toBe(true);
    expect(rules.read([]).directories).not.toContain(folders[1]); expect(() => rules.verifyLaunch(next.directory)).not.toThrow();
  });
});
