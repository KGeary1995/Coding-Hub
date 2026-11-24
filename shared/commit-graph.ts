/**
 * Lanes for Changes → History. Each row is a commit; a lane is a column that waits for one commit (the parent the row above
 * it named). A commit takes the leftmost lane waiting for it, or the first free column; its first parent carries on in that
 * lane and each other parent opens a lane (or joins one already waiting for it). Lanes never move sideways, so a line that
 * passes a row is straight and only lines into or out of a commit's dot slant. Commits must come children first (`git log
 * --date-order` or `--topo-order`); a parent missing from the list (past the read limit) keeps its lane to the last row.
 */

/** A line in one row: `top` runs from the row's top edge (column `from`) to its middle (column `to`), `bottom` from the middle to its bottom edge. */
export interface GraphLine { half: 'top' | 'bottom'; from: number; to: number; colour: number }
export interface GraphRow { sha: string; column: number; colour: number; merge: boolean; lines: GraphLine[] }
/** `width`: the most columns any row uses, so every row's graph cell is as wide. */
export interface CommitGraph { rows: GraphRow[]; width: number }

interface Lane { sha: string; colour: number }

export function layoutGraph(commits: readonly { sha: string; parents: readonly string[] }[]): CommitGraph {
  const lanes: (Lane | null)[] = []; const rows: GraphRow[] = []; let colours = 0; let width = 0;
  const free = (except = -1) => { const index = lanes.findIndex((lane, at) => !lane && at !== except); return index < 0 ? lanes.length : index; };
  for (const commit of commits) {
    const waiting = lanes.flatMap((lane, index) => lane?.sha === commit.sha ? [index] : []);
    const column = waiting.length ? waiting[0] : free(); const colour = waiting.length ? lanes[column]!.colour : colours++;
    const lines: GraphLine[] = [];
    // Into the dot: every lane waiting for this commit slants to it; the others pass straight down.
    lanes.forEach((lane, index) => { if (lane) lines.push({ half: 'top', from: index, to: lane.sha === commit.sha ? column : index, colour: lane.colour }); });
    for (const index of waiting) lanes[index] = null;
    const passing = new Set(lanes.flatMap((lane, index) => lane ? [index] : []));
    const [first, ...others] = commit.parents;
    if (first !== undefined) { lanes[column] = { sha: first, colour }; lines.push({ half: 'bottom', from: column, to: column, colour }); }
    for (const parent of others) {
      const existing = lanes.findIndex((lane) => lane?.sha === parent);
      if (existing >= 0) { lines.push({ half: 'bottom', from: column, to: existing, colour: lanes[existing]!.colour }); continue; }
      const index = free(column); lanes[index] = { sha: parent, colour: colours++ };
      lines.push({ half: 'bottom', from: column, to: index, colour: lanes[index]!.colour });
    }
    // Out of the row: lanes that were not touched carry straight on.
    for (const index of passing) lines.push({ half: 'bottom', from: index, to: index, colour: lanes[index]!.colour });
    width = Math.max(width, column + 1, lanes.length);
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    rows.push({ sha: commit.sha, column, colour, merge: commit.parents.length > 1, lines });
  }
  return { rows, width };
}
