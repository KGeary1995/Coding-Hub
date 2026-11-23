import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveResume, takeResume } from './resume-list';

const roots: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-resume-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('the channels to start again', () => {
  it('are given once, without repeats, then forgotten', () => {
    const dir = root(); saveResume(dir, ['a', 'b', 'a']);
    expect(takeResume(dir)).toEqual(['a', 'b']); expect(takeResume(dir)).toEqual([]);
  });
  it('quitting with none running leaves none from an earlier quit', () => {
    const dir = root(); saveResume(dir, ['a']); saveResume(dir, []);
    expect(takeResume(dir)).toEqual([]);
  });
  it('a damaged list starts nothing and is removed', () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'resume-on-start.json'), '{not json');
    expect(takeResume(dir)).toEqual([]); expect(fs.existsSync(path.join(dir, 'resume-on-start.json'))).toBe(false);
  });
});
