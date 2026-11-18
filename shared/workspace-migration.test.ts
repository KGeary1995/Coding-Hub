import { describe, expect, it } from 'vitest';
import { legacyWorkspaceSchema, savedWorkspaceSchema } from './schemas';
import { arrangeChannels, migrateWorkspace } from './workspace-migration';

const config = (engine: 'claude' | 'codex' | 'gemini') => engine === 'claude' ? { engine, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } : engine === 'codex' ? { engine, model: '', reasoningEffort: null } : { engine, model: '' };
const session = (id: string, engine: 'claude' | 'codex' | 'gemini') => ({ id, title: id, config: config(engine), binding: { mode: 'workspace' }, createdAt: '2026-11-01T00:00:00.000Z' });
const tile = (sessionId: string, x: number) => ({ sessionId, x, y: 0, w: 4, h: 12, minW: 3, minH: 10 });

describe('a workspace saved with Gemini channels', () => {
  it('lays the channels left out again, so no gap is left where a Gemini tile was', () => {
    const saved = legacyWorkspaceSchema.parse({ version: 1, rootDirectory: '/p', layoutMode: 'columns', focusedSessionId: null, sessions: [session('a', 'claude'), session('g', 'gemini'), session('c', 'codex')], tiles: [tile('a', 0), tile('g', 4), tile('c', 8)] });
    const { workspace } = migrateWorkspace(saved);
    expect(workspace!.tiles.map(({ sessionId, x, w }) => ({ sessionId, x, w }))).toEqual([{ sessionId: 'a', x: 0, w: 6 }, { sessionId: 'c', x: 6, w: 6 }]);
    expect(savedWorkspaceSchema.safeParse(workspace).success).toBe(true);
  });
  it('keeps the tiles as they were when no tile was removed', () => {
    const saved = legacyWorkspaceSchema.parse({ version: 1, rootDirectory: '/p', layoutMode: 'columns', focusedSessionId: null, sessions: [session('a', 'claude'), session('c', 'codex')], tiles: [tile('a', 0), tile('c', 4)] });
    expect(migrateWorkspace(saved).workspace!.tiles).toEqual(saved.tiles);
  });
  it('arranges as each layout does', () => {
    expect(arrangeChannels(['a', 'b', 'c', 'd', 'e'], 'grid').map(({ x, y, w }) => [x, y, w])).toEqual([[0, 0, 4], [4, 0, 4], [8, 0, 4], [0, 12, 4], [4, 12, 4]]);
    expect(arrangeChannels(['a', 'b'], 'rows').map(({ x, y, w }) => [x, y, w])).toEqual([[0, 0, 12], [0, 12, 12]]);
  });
});
