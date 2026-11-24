import { describe, expect, it } from 'vitest';
import { layoutGraph, type GraphLine } from './commit-graph';

const commit = (sha: string, ...parents: string[]) => ({ sha, parents });
const top = (lines: GraphLine[]) => lines.filter((line) => line.half === 'top').map(({ from, to }) => [from, to]);
const bottom = (lines: GraphLine[]) => lines.filter((line) => line.half === 'bottom').map(({ from, to }) => [from, to]);

describe('commit graph lanes', () => {
  it('keeps a straight history in one lane and one colour', () => {
    const { rows, width } = layoutGraph([commit('c', 'b'), commit('b', 'a'), commit('a')]);
    expect(width).toBe(1); expect(rows.map((row) => row.column)).toEqual([0, 0, 0]); expect(new Set(rows.map((row) => row.colour)).size).toBe(1);
    expect(top(rows[0].lines)).toEqual([]); expect(bottom(rows[0].lines)).toEqual([[0, 0]]);
    expect(top(rows[1].lines)).toEqual([[0, 0]]); expect(bottom(rows[1].lines)).toEqual([[0, 0]]);
    // The first commit has no parent: nothing leaves its dot.
    expect(top(rows[2].lines)).toEqual([[0, 0]]); expect(bottom(rows[2].lines)).toEqual([]);
    expect(rows.some((row) => row.merge)).toBe(false);
  });

  it('opens a lane for a merged branch and closes it where the branch started', () => {
    // m merges f into main; f and c both come from a.
    const { rows, width } = layoutGraph([commit('m', 'c', 'f'), commit('c', 'a'), commit('f', 'a'), commit('a')]);
    expect(width).toBe(2); expect(rows.map((row) => row.column)).toEqual([0, 0, 1, 0]);
    expect(rows[0].merge).toBe(true); expect(bottom(rows[0].lines)).toEqual([[0, 0], [0, 1]]);
    expect(rows[0].lines.find((line) => line.to === 1)!.colour).not.toBe(rows[0].colour);
    // c passes the branch lane straight down; f keeps its lane's colour; at a the two lanes meet.
    expect(top(rows[1].lines)).toEqual([[0, 0], [1, 1]]); expect(bottom(rows[1].lines)).toEqual([[0, 0], [1, 1]]);
    expect(rows[2].colour).toBe(rows[0].lines.find((line) => line.to === 1)!.colour);
    expect(top(rows[3].lines)).toEqual([[0, 0], [1, 0]]); expect(bottom(rows[3].lines)).toEqual([]);
  });

  it('opens a lane for each extra parent of an octopus merge', () => {
    const { rows, width } = layoutGraph([commit('o', 'a', 'b', 'c'), commit('a', 'r'), commit('b', 'r'), commit('c', 'r'), commit('r')]);
    expect(width).toBe(3); expect(rows.map((row) => row.column)).toEqual([0, 0, 1, 2, 0]);
    expect(bottom(rows[0].lines)).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(new Set(rows[0].lines.map((line) => line.colour)).size).toBe(3);
    expect(top(rows[4].lines)).toEqual([[0, 0], [1, 0], [2, 0]]);
  });

  it('gives a second branch tip its own lane with nothing above it', () => {
    // main (x) and topic (y) both start from a; neither is merged.
    const { rows, width } = layoutGraph([commit('x', 'a'), commit('y', 'a'), commit('a')]);
    expect(width).toBe(2); expect(rows.map((row) => row.column)).toEqual([0, 1, 0]);
    expect(top(rows[1].lines)).toEqual([[0, 0]]); expect(bottom(rows[1].lines)).toEqual([[1, 1], [0, 0]]);
    expect(rows[1].colour).not.toBe(rows[0].colour);
    expect(top(rows[2].lines)).toEqual([[0, 0], [1, 0]]);
  });

  it('gives unrelated histories separate lanes', () => {
    const { rows } = layoutGraph([commit('x', 'w'), commit('y'), commit('w')]);
    expect(rows.map((row) => row.column)).toEqual([0, 1, 0]);
    expect(bottom(rows[1].lines)).toEqual([[0, 0]]);
  });

  it('runs a lane to the last row for a parent past the read limit', () => {
    // m's second parent (old) was not read: its lane goes on below the last row, so the history visibly continues.
    const { rows } = layoutGraph([commit('m', 'b', 'old'), commit('b', 'a'), commit('a', 'older')]);
    expect(rows.map((row) => row.column)).toEqual([0, 0, 0]);
    expect(bottom(rows[1].lines)).toEqual([[0, 0], [1, 1]]);
    expect(bottom(rows[2].lines)).toEqual([[0, 0], [1, 1]]);
  });

  it('joins a merge parent another lane already waits for instead of opening a lane', () => {
    // t and m both come from f: m's second parent joins t's lane.
    const { rows, width } = layoutGraph([commit('t', 'f'), commit('m', 'a', 'f'), commit('f', 'a'), commit('a')]);
    expect(rows.map((row) => row.column)).toEqual([0, 1, 0, 0]); expect(width).toBe(2);
    expect(bottom(rows[1].lines)).toEqual([[1, 1], [1, 0], [0, 0]]);
    expect(rows[1].lines.find((line) => line.half === 'bottom' && line.to === 0 && line.from === 1)!.colour).toBe(rows[0].colour);
  });

  it('reuses a freed column for the next new lane', () => {
    const { rows, width } = layoutGraph([commit('m', 'a', 'f'), commit('f', 'a'), commit('a', 'r'), commit('t', 'r'), commit('r')]);
    expect(rows.map((row) => row.column)).toEqual([0, 1, 0, 1, 0]); expect(width).toBe(2);
  });

  it('draws nothing for an empty history', () => { expect(layoutGraph([])).toEqual({ rows: [], width: 0 }); });
});
