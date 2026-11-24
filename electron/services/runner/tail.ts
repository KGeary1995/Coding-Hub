/**
 * A terminal's last output, kept by the runner (1 MB by default) so a Trace that opens again draws the screen as it is.
 * Only whole UTF-8 characters are returned: a cut through a character at the start is skipped.
 */
export class Tail {
  private chunks: Buffer[] = []; private size = 0;
  constructor(private capacity = 1024 * 1024) {}
  append(data: Buffer) {
    if (data.length >= this.capacity) { this.chunks = [Buffer.from(data.subarray(data.length - this.capacity))]; this.size = this.capacity; return; }
    this.chunks.push(data); this.size += data.length;
    while (this.size > this.capacity) {
      const first = this.chunks[0]; const over = this.size - this.capacity;
      if (first.length <= over) { this.chunks.shift(); this.size -= first.length; } else { this.chunks[0] = first.subarray(over); this.size -= over; }
    }
  }
  read(): Buffer {
    const all = Buffer.concat(this.chunks); let start = 0;
    // UTF-8 continuation bytes are 10xxxxxx; at most three can open a cut character.
    while (start < Math.min(3, all.length) && (all[start] & 0xc0) === 0x80) start++;
    return start ? all.subarray(start) : all;
  }
  get length() { return this.size; }
}
