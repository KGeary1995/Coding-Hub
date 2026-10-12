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
