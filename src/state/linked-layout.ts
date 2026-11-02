import type { Layout } from 'react-grid-layout';

/** A tile's place in the grid: twelve columns, rows of ROW_HEIGHT pixels. */
export type Place = { x: number; y: number; w: number; h: number };
export const ROW_HEIGHT = 30; const TILE = { w: 6, h: 12 };
const layoutKey = (computerId: string) => `coding-hub-linked-layout:${computerId}`;

/**
 * Where another computer's channels sit in its tab here. The arrangement is this computer's own (the other computer's
 * screen is another size, and its own layout stays as it is), saved in this window's storage per linked computer.
 */
export function loadPlaces(computerId: string): Record<string, Place> {
  try {
    const value = JSON.parse(localStorage.getItem(layoutKey(computerId)) ?? 'null') as Record<string, Place> | null;
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value).filter(([, place]) => place && [place.x, place.y, place.w, place.h].every((n) => Number.isInteger(n) && n >= 0 && n < 1000)));
  } catch { return {}; }
}
export function savePlaces(computerId: string, places: Record<string, Place>) { try { localStorage.setItem(layoutKey(computerId), JSON.stringify(places)); } catch { /* Kept for this visit only. */ } }
/** Saved places for the channels that still exist; new channels go two to a row below them. */
export function arrangeLinked(sessionIds: string[], saved: Record<string, Place>): Layout[] {
  const placed = sessionIds.filter((id) => saved[id]).map((id) => ({ i: id, ...saved[id], minW: 3, minH: 6 }));
  let bottom = placed.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0);
  const added = sessionIds.filter((id) => !saved[id]).map((id, index) => {
    const tile = { i: id, x: (index % 2) * TILE.w, y: bottom, ...TILE, minW: 3, minH: 6 };
    if (index % 2 === 1) bottom += TILE.h; return tile;
  });
  return [...placed, ...added];
}
