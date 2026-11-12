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
  const tiles: GridTile[] = saved.tiles.filter((tile) => ids.has(tile.sessionId));
  return {
    workspace: { ...saved, sessions, tiles, focusedSessionId: saved.focusedSessionId && ids.has(saved.focusedSessionId) ? saved.focusedSessionId : null },
    removedChannels, rootDirectory: saved.rootDirectory,
  };
}

/** A chain without Trace 1.20's Gemini steps and flags. */
function migrateChain(chain: Record<string, unknown>): SavedChain {
  const { geminiReviewed: _reviewed, compared: _compared, firstFinding: _first, blocked, step, stoppedAt, ...rest } = chain;
  const legacy = (value: unknown) => (LEGACY_CHAIN_STEPS as readonly unknown[]).includes(value) ? 'reviewing' : value;
  return { ...rest, step: legacy(step), ...(stoppedAt !== undefined ? { stoppedAt: legacy(stoppedAt) } : {}), ...(blocked && blocked !== 'challenger' ? { blocked } : {}) } as SavedChain;
}
