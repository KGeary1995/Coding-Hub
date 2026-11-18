import type { ChatEvent } from '../../../shared/chat';

/** A single line this large is not something a chat CLI sends; it is dropped rather than kept growing without bound. */
export const MAX_LINE = 64 * 1024 * 1024;

/**
 * Splits a CLI's output into lines. Only each new chunk is searched for a line break, and an unfinished line is kept
 * as its pieces, joined once when it ends: a multi-megabyte line costs time in proportion to its size, not its square.
 */
export class Lines {
  private parts: string[] = []; private size = 0;
  /** A line past the limit was dropped: the rest of it, up to its line break, is skipped too. */
  private skipping = false;
  constructor(private limit = MAX_LINE) {}
  /** The complete lines this chunk ends (without the line break), and whether a line past the limit was dropped. */
  push(data: string): { lines: string[]; dropped: boolean } {
    const lines: string[] = []; let dropped = false; let start = 0; let end;
    while ((end = data.indexOf('\n', start)) >= 0) {
      if (!this.skipping) { this.parts.push(data.slice(start, end)); lines.push(this.parts.length === 1 ? this.parts[0] : this.parts.join('')); }
      this.parts = []; this.size = 0; this.skipping = false; start = end + 1;
    }
    if (start < data.length && !this.skipping) {
      const rest = data.slice(start); this.size += rest.length;
      if (this.size > this.limit) { this.parts = []; this.size = 0; this.skipping = true; dropped = true; } else this.parts.push(rest);
    }
    return { lines, dropped };
  }
}

/**
 * Output from a chat CLI, one JSON object per line: complete lines are parsed and read, a partial line waits for the
 * rest. Only JSON objects are messages; a line that is not one (or one that cannot be handled) is skipped, never let
 * out of the output listener, where it would bring down the app.
 */
export function readLines(lines: Lines, data: string, who: string, emit: (event: ChatEvent) => void, read: (message: Record<string, unknown>) => void) {
  const { lines: complete, dropped } = lines.push(data);
  for (const raw of complete) {
    const line = raw.trim(); if (!line) continue;
    let message: unknown; try { message = JSON.parse(line); } catch { continue; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    try { read(message as Record<string, unknown>); } catch { /* Skipped. */ }
  }
  if (dropped) emit({ type: 'notice', text: `Trace skipped a message from ${who} larger than ${MAX_LINE / 1024 / 1024} MB.` });
}
