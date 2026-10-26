import { COPY_LIMIT } from '../../shared/ipc';

/**
 * Text copied from a channel, with the line breaks the CLI added only to fit the window taken out again.
 *
 * Claude Code and Codex wrap their own text: a long sentence reaches the terminal as several separate lines, so the
 * terminal (and a plain copy) cannot tell them from real line breaks. A break is treated as a wrap, and the two
 * lines joined with a space, when the next line's first word would not have fitted at the end of the line above
 * (that is why the CLI broke there) and the next line continues at the text's indent. Short lines, list items,
 * blank lines and code that stops well before the edge keep their line breaks.
 */
/**
 * The text of an OSC 52 "set the clipboard" request (`ESC ] 52 ; c ; <base64> BEL`, given here without its `52;`), as
 * Claude Code sends when the person selects text in its full-screen view. Requests to read the clipboard (`?`), and
 * anything that is not valid UTF-8 text within the limit, give null.
 */
export function osc52Text(data: string): string | null {
  const split = data.indexOf(';'); if (split < 0) return null;
  const payload = data.slice(split + 1); if (payload === '?' || payload.length > COPY_LIMIT * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))); } catch { return null; }
}

/** `text` is what was selected on a screen row, `startColumn` where on the row it starts, `line` the whole row. */
export interface CopiedRow { text: string; startColumn: number; line?: string }

/** How close to the window's edge a line must reach to have been wrapped there (CLIs keep a small right margin). */
const EDGE = 8;
const MARKER = /^(\s*)([-*+•●⏺>]|\d+[.)])\s+/;

export function unwrapCopied(rows: CopiedRow[], cols: number): string {
  if (rows.length < 2) return rows.map((row) => row.text).join('\n');
  const out: string[] = [rows[0].text.replace(/\s+$/, '')];
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]; const row = rows[index];
    const above = previous.text.replace(/\s+$/, ''); const text = row.text.replace(/\s+$/, '');
    const indent = text.length - text.trimStart().length;
    // Where the text above starts (after its indent and any list marker), which is where its wrapped lines continue.
    // A selection that starts partway along a row takes the indent from the whole row on screen.
    const whole = (previous.line ?? previous.text).replace(/\s+$/, ''); const marker = MARKER.exec(whole);
    const hanging = previous.line !== undefined ? (marker ? marker[0].length : whole.length - whole.trimStart().length) : previous.startColumn + (marker ? marker[0].length : above.length - above.trimStart().length);
    const firstWord = text.trimStart().split(/\s+/)[0] ?? '';
    const reachedEdge = (previous.startColumn + above.length) % (cols + 1) + 1 + firstWord.length > cols - EDGE;
    const continues = above.trim() !== '' && text.trim() !== '' && !MARKER.test(text) && row.startColumn + indent === hanging;
    if (reachedEdge && continues) out[out.length - 1] += ' ' + text.trimStart();
    else out.push(text);
  }
  return out.join('\n');
}
