/**
 * Typed or pasted text in pieces of at most `size` UTF-16 units, in order, never splitting a surrogate pair: a paste
 * reaches xterm as one data event, and the host takes only so much input per request.
 */
export function inputPieces(data: string, size: number): string[] {
  const pieces: string[] = [];
  for (let offset = 0; offset < data.length;) {
    let end = Math.min(offset + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && end - offset > 1 && last >= 0xD800 && last <= 0xDBFF) end--;
    pieces.push(data.slice(offset, end)); offset = end;
  }
  return pieces;
}
