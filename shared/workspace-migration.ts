import type { SavedChain } from './chat';
import type { LegacySavedWorkspace } from './schemas';
import { LEGACY_CHAIN_STEPS } from './schemas';
import type { GridTile, SavedWorkspace } from './types';

/**
 * What a saved workspace becomes now that Trace runs no Gemini (removed after 1.20): Gemini channels and hidden Gemini
 * seats are dropped, with their tiles; a hierarchy table forgets its Gemini seat, and a chain saved at a Gemini step
 * (second-reviewing, comparing) is at 'reviewing'. `removedChannels`: the Gemini channels the person saw (tiles), so
 * the window can say why they are gone. `workspace` is null when no channel is left; `rootDirectory` is the saved
 * project folder either way, so it is not lost with the channels.
 */
export function migrateWorkspace(saved: LegacySavedWorkspace | SavedWorkspace): { workspace: SavedWorkspace | null; removedChannels: number; rootDirectory: string | null } {
  const gemini = new Set(saved.sessions.filter((session) => session.config.engine === 'gemini').map((session) => session.id));
  const tiled = new Set(saved.tiles.map((tile) => tile.sessionId));
  const removedChannels = [...gemini].filter((id) => tiled.has(id)).length;
  const sessions = saved.sessions.filter((session) => !gemini.has(session.id)).map((session) => {
    if (!session.roundTable) return session as SavedWorkspace['sessions'][number];
    const { challenger: _challenger, chain, ...table } = session.roundTable as typeof session.roundTable & { challenger?: string };
    return { ...session, roundTable: { ...table, ...(chain ? { chain: migrateChain(chain as unknown as Record<string, unknown>) } : {}) } } as SavedWorkspace['sessions'][number];
  });
  if (!sessions.length) return { workspace: null, removedChannels, rootDirectory: saved.rootDirectory };
  const ids = new Set(sessions.map((session) => session.id));
  // A removed tile would leave a gap the grid never closes (it only moves tiles up), so the rest are laid out again.
  const kept = saved.tiles.filter((tile) => ids.has(tile.sessionId));
  const tiles: GridTile[] = removedChannels ? arrangeChannels([...kept].sort((a, b) => a.y - b.y || a.x - b.x).map((tile) => tile.sessionId), saved.layoutMode) : kept;
  return {
    workspace: { ...saved, sessions, tiles, focusedSessionId: saved.focusedSessionId && ids.has(saved.focusedSessionId) ? saved.focusedSessionId : null },
    removedChannels, rootDirectory: saved.rootDirectory,
  };
}

/**
 * Tiles for channels in order, as a layout lays them out: columns wrap after four, rows stack, and the grid keeps two
 * rows (five to eight channels sit three or four across). A grid's second row with fewer channels than the first shares
 * the whole width (three channels: two above, one wide below), so no part of the window stays empty; in columns every
 * tile keeps one width. The window's arrangeTiles calls this.
 */
export function arrangeChannels(ids: string[], mode: SavedWorkspace['layoutMode']): GridTile[] {
  const columns = mode === 'rows' ? 1 : mode === 'columns' ? Math.min(4, ids.length) : ids.length <= 2 ? ids.length : Math.ceil(ids.length / 2);
  // The channels of a grid's short last row (one fewer than the row above, so 12 always divides evenly).
  const short = mode === 'grid' ? ids.length % columns : 0;
  return ids.map((sessionId, index) => { const width = 12 / (index < ids.length - short ? columns : short); return { sessionId, x: (index % columns) * width, y: Math.floor(index / columns) * 12, w: width, h: 12, minW: 3, minH: 10 }; });
}

/**
 * A grid as Trace arranged it up to 1.23, when a short second row kept the upper row's width (three channels: the
 * bottom-right quarter empty), laid out by today's rule. Only tiles that still stand exactly as that rule put them (the
 * person moved or resized none); any other layout is the person's and comes back as it is.
 */
export function widenShortRow(tiles: GridTile[], mode: SavedWorkspace['layoutMode']): GridTile[] {
  const columns = Math.ceil(tiles.length / 2); const width = 12 / columns;
  if (mode !== 'grid' || tiles.length < 3 || tiles.length % columns === 0) return tiles;
  return tiles.every((tile, index) => tile.x === (index % columns) * width && tile.y === Math.floor(index / columns) * 12 && tile.w === width && tile.h === 12) ? arrangeChannels(tiles.map((tile) => tile.sessionId), mode) : tiles;
}

/** A chain without Trace 1.20's Gemini steps and flags. */
function migrateChain(chain: Record<string, unknown>): SavedChain {
  const { geminiReviewed: _reviewed, compared: _compared, firstFinding: _first, blocked, step, stoppedAt, ...rest } = chain;
  const legacy = (value: unknown) => (LEGACY_CHAIN_STEPS as readonly unknown[]).includes(value) ? 'reviewing' : value;
  return { ...rest, step: legacy(step), ...(stoppedAt !== undefined ? { stoppedAt: legacy(stoppedAt) } : {}), ...(blocked && blocked !== 'challenger' ? { blocked } : {}) } as SavedChain;
}
