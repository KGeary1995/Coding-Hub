import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcRenderer: { on: () => {}, send: () => {} } }));
const { tileRuns } = await import('./screen-capture-preload');

describe('the parts of the shared screen sent as pictures', () => {
  it('joins each row’s neighbouring tiles into one picture', () => {
    // 4 × 2 tiles of 64: tiles 0, 1 and 3 in the first row; 6 in the second.
    expect(tileRuns(new Set([0, 1, 3, 6]), 256, 128)).toEqual([{ x: 0, y: 0, width: 128, height: 64 }, { x: 192, y: 0, width: 64, height: 64 }, { x: 128, y: 64, width: 64, height: 64 }]);
  });
  it('sends a run that reaches the right edge when the width is not a multiple of the tile', () => {
    // 1366 wide: 22 tiles, the last 22 pixels wide. Before, a run ending there was never sent.
    expect(tileRuns(new Set([20, 21]), 1366, 64)).toEqual([{ x: 1280, y: 0, width: 86, height: 64 }]);
    expect(tileRuns(new Set([0, 1]), 100, 50)).toEqual([{ x: 0, y: 0, width: 100, height: 50 }]);
  });
  it('covers the whole picture when every tile is asked for', () => {
    const all = new Set(Array.from({ length: 3 * 2 }, (_, index) => index));
    expect(tileRuns(all, 130, 70)).toEqual([{ x: 0, y: 0, width: 130, height: 64 }, { x: 0, y: 64, width: 130, height: 6 }]);
  });
});
