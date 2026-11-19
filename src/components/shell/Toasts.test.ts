import { describe, expect, it } from 'vitest';
import { noticePlace, type TileUnder } from './Toasts';

// A 1100 x 800 window: the status bar starts at 772, tiles are 352 tall in a grid, one notice is 110 tall.
const bar = 772; const gap = 12;
const terminal = (top: number, focused = false): TileUnder => ({ top, bottom: top + 352, rowsEnd: top + 64, focused });
/** A chat: its bars end 100 px down, its composer sits over the 24 px footer. */
const chat = (top: number, focused = false): TileUnder => ({ top, bottom: top + 352, rowsEnd: top + 100, composer: { top: top + 263, bottom: top + 328 }, focused });
const place = (tiles: TileUnder[], height = 110, stands: { top: number; raised: boolean } = { top: bar - gap - height, raised: false }) => noticePlace({ tiles, height, gap, barTop: bar, top: stands.top, standsRaised: stands.raised });

describe('where the notices stand', () => {
  it('is the bottom right over terminals nobody types in, and on a page with no tiles', () => {
    expect(place([terminal(52), terminal(412)])).toEqual({ raised: false, under: null, room: null });
    expect(place([])).toEqual({ raised: false, under: null, room: null });
    expect(place([chat(412)], 0)).toEqual({ raised: false, under: null, room: null });
  });
  it('is raised when a chat’s composer is under that corner, whoever has the focus', () => {
    expect(place([terminal(52), chat(412)])).toEqual({ raised: true, under: 116, room: null });
    expect(place([terminal(52), chat(412, true)]).raised).toBe(true);
  });
  it('is raised over a chat whose message row is scrolled under the status bar, for its header and bars', () => {
    // Rows in a small window: the third tile starts at 596 and its composer is below the bar's top.
    const below = { ...chat(596), bottom: 860, composer: { top: 780, bottom: 845 } };
    expect(place([terminal(52), terminal(324), below]).raised).toBe(true);
    // One that starts under the status bar is under nothing.
    expect(place([terminal(52), terminal(324), { ...chat(780), composer: { top: 1043, bottom: 1108 } }]).raised).toBe(false);
  });
  it('is raised while the focus is in a terminal under that corner', () => {
    expect(place([terminal(52), terminal(412, true)])).toEqual({ raised: true, under: 116, room: null });
    // The focus in a tile the corner does not reach changes nothing.
    expect(place([terminal(52, true), terminal(412)]).raised).toBe(false);
  });
  it('stays at the bottom over a terminal while the stack ends clear of the chat above it', () => {
    expect(place([chat(52), terminal(412)], 346).raised).toBe(false);
    // Four notices would reach that chat's composer (it ends at 380).
    expect(place([chat(52), terminal(412)], 464).raised).toBe(true);
  });
  it('starts under a conversation’s bars where one is in the first row', () => {
    expect(place([chat(52), chat(412)]).under).toBe(152);
    // Columns: the lowest of the first row's edges.
    expect(place([terminal(52), { ...chat(52), bottom: 764, composer: { top: 675, bottom: 740 } }]).under).toBe(152);
  });
  it('is cut short above the next composer down, once it stands raised and would reach it', () => {
    const tiles = [chat(52), chat(412)];
    // Not yet moved: how far it may reach is measured from the raised place.
    expect(place(tiles, 346).room).toBeNull();
    expect(place(tiles, 346, { top: 164, raised: true })).toEqual({ raised: true, under: 152, room: 151 });
    // One notice ends 12 px clear of the composer at 315: no limit.
    expect(place(tiles, 110, { top: 164, raised: true }).room).toBeNull();
    expect(place(tiles, 140, { top: 164, raised: true }).room).toBe(151);
  });
  it('ends above a chat that starts under it, so that chat’s header and bars stay in reach', () => {
    const tiles = [terminal(52), chat(412)];
    // Three notices from 128 would end at 474, over the chat's header at 412: they end half a gap above it.
    expect(place(tiles, 346, { top: 128, raised: true })).toEqual({ raised: true, under: 116, room: 290 });
    // Two end at 356, clear of it.
    expect(place(tiles, 228, { top: 128, raised: true }).room).toBeNull();
    // A terminal under it sets no limit.
    expect(place([terminal(52), terminal(412, true)], 346, { top: 128, raised: true }).room).toBeNull();
  });
  it('steps aside where the message being written leaves less than a notice’s title and first line', () => {
    // The first chat's message box has grown up to 240: 76 px under the stack's top, 64 with the gap.
    const grown = [{ ...chat(52), composer: { top: 240, bottom: 380 } }, chat(412)];
    expect(place(grown, 110, { top: 164, raised: true })).toEqual({ raised: true, under: 152, room: 0 });
    // 84 px with the gap off is enough for one cut short.
    expect(place([{ ...chat(52), composer: { top: 260, bottom: 380 } }, chat(412)], 110, { top: 164, raised: true }).room).toBe(96);
  });
});
