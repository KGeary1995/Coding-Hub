import { describe, expect, it } from 'vitest';
import { legacyWorkspaceSchema, savedWorkspaceSchema } from './schemas';
import { arrangeChannels, migrateWorkspace, widenShortRow } from './workspace-migration';

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
    expect(arrangeChannels(['a', 'b', 'c', 'd', 'e'], 'grid').map(({ x, y, w }) => [x, y, w])).toEqual([[0, 0, 4], [4, 0, 4], [8, 0, 4], [0, 12, 6], [6, 12, 6]]);
    expect(arrangeChannels(['a', 'b'], 'rows').map(({ x, y, w }) => [x, y, w])).toEqual([[0, 0, 12], [0, 12, 12]]);
  });
});

describe('the grid arrangement', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `c${index + 1}`);
  /** Each row's tile widths, top to bottom (twelve columns). */
  const rows = (count: number, mode: 'grid' | 'columns' | 'rows') => { const out: number[][] = []; for (const tile of arrangeChannels(ids(count), mode)) (out[tile.y / 12] ??= []).push(tile.w); return out; };
  it('gives a short last row the whole width, for one to eight channels', () => {
    expect(Array.from({ length: 8 }, (_, index) => rows(index + 1, 'grid'))).toEqual([
      [[12]], [[6, 6]], [[6, 6], [12]], [[6, 6], [6, 6]],
      [[4, 4, 4], [6, 6]], [[4, 4, 4], [4, 4, 4]], [[3, 3, 3, 3], [4, 4, 4]], [[3, 3, 3, 3], [3, 3, 3, 3]],
    ]);
  });
  it('leaves no part of a row empty and no tiles overlapping', () => {
    for (let count = 1; count <= 8; count++) {
      const tiles = arrangeChannels(ids(count), 'grid');
      expect(tiles.map((tile) => tile.sessionId)).toEqual(ids(count));
      for (const y of new Set(tiles.map((tile) => tile.y))) {
        const row = tiles.filter((tile) => tile.y === y);
        // Side by side from the left edge to the right, each starting where the one before ends.
        expect(row.map((tile) => tile.x)).toEqual(row.map((_, index) => row.slice(0, index).reduce((sum, tile) => sum + tile.w, 0)));
        expect(row.reduce((sum, tile) => sum + tile.w, 0)).toBe(12);
      }
      expect(tiles.every((tile) => Number.isInteger(tile.w) && tile.w >= tile.minW && tile.h === 12)).toBe(true);
    }
  });
  describe('a grid arranged by the older rule, whose short second row kept the upper row’s width', () => {
    /** As Trace arranged a grid up to 1.23: every tile at the upper row's width. */
    const older = (count: number) => { const columns = count <= 2 ? count : Math.ceil(count / 2); return ids(count).map((sessionId, index) => ({ sessionId, x: (index % columns) * (12 / columns), y: Math.floor(index / columns) * 12, w: 12 / columns, h: 12, minW: 3, minH: 10 })); };
    it('is laid out by today’s rule for three, five and seven channels, and is the same already for the others', () => {
      for (const count of [3, 5, 7]) { expect(older(count)).not.toEqual(arrangeChannels(ids(count), 'grid')); expect(widenShortRow(older(count), 'grid')).toEqual(arrangeChannels(ids(count), 'grid')); }
      for (const count of [1, 2, 4, 6, 8]) { const tiles = older(count); expect(tiles).toEqual(arrangeChannels(ids(count), 'grid')); expect(widenShortRow(tiles, 'grid')).toBe(tiles); }
    });
    it('is left alone once the person moved or resized a tile, and in columns and rows', () => {
      const resized = older(3).map((tile, index) => index === 2 ? { ...tile, w: 8 } : tile); expect(widenShortRow(resized, 'grid')).toBe(resized);
      const taller = older(3).map((tile, index) => index === 0 ? { ...tile, h: 14 } : tile); expect(widenShortRow(taller, 'grid')).toBe(taller);
      // Two tiles swapped by dragging: every size is the older rule's, but not every place.
      const [a, b, c] = older(3); const swapped = [{ ...a, x: b.x }, { ...b, x: a.x }, c]; expect(widenShortRow(swapped, 'grid')).toBe(swapped);
      // Five columns-arranged tiles have a short second row too, which that arrangement keeps.
      const columns = arrangeChannels(ids(5), 'columns'); expect(widenShortRow(columns, 'columns')).toBe(columns);
      const stacked = arrangeChannels(ids(3), 'rows'); expect(widenShortRow(stacked, 'rows')).toBe(stacked);
    });
  });
  it('leaves columns and rows as they were: columns wrap after four at one width, rows stack', () => {
    expect(rows(3, 'columns')).toEqual([[4, 4, 4]]);
    expect(rows(5, 'columns')).toEqual([[3, 3, 3, 3], [3]]);
    expect(rows(7, 'columns')).toEqual([[3, 3, 3, 3], [3, 3, 3]]);
    expect(rows(3, 'rows')).toEqual([[12], [12], [12]]);
  });
});
