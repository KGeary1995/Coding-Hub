import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelProblem } from './seat-model';

describe('a seat model field', () => {
  it('takes a model identifier or blank', () => {
    expect(modelProblem(' claude-opus-5-5 ')).toBe(''); expect(modelProblem('')).toBe(''); expect(modelProblem('   ')).toBe('');
  });
  it('refuses a display name the workspace could not be saved with, and says why', () => {
    expect(modelProblem('Opus 5.5')).toContain('"Opus 5.5" is not a model identifier'); expect(modelProblem('x'.repeat(200))).toContain('not a model identifier');
  });
});

/** Every file the phone app loads, by following relative imports from phone/main.ts (packages are not followed). */
function phoneGraph() {
  const root = resolve(__dirname, '../../..'); const seen = new Map<string, string[]>(); const pending = [join(root, 'phone', 'main.ts')];
  const file = (base: string) => ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((end) => base + end).find((path) => existsSync(path) && !path.endsWith('/') && /\.tsx?$/.test(path));
  while (pending.length) {
    const path = pending.pop()!; if (seen.has(path)) continue;
    const specifiers = [...readFileSync(path, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]); seen.set(path, specifiers);
    for (const specifier of specifiers) if (specifier.startsWith('.')) { const next = file(resolve(dirname(path), specifier)); if (next) pending.push(next); }
  }
  return seen;
}

describe('the phone app', () => {
  it('does not load zod or the workspace schemas, which only the desktop\'s Models fields need', () => {
    const graph = phoneGraph();
    expect([...graph.keys()].some((path) => path.endsWith(join('chat', 'ChatParts.tsx')))).toBe(true);
    const offenders = [...graph].filter(([path, specifiers]) => path.endsWith(join('shared', 'schemas.ts')) || specifiers.includes('zod')).map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
