import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

const SCROLLBACK = 1000;

/**
 * A copy of one channel's terminal, drawn from the same output and resized at the same points as the desktop's, so a
 * phone that opens the channel is shown the screen as it is now (full-screen CLIs, modes and all) rather than a tail
 * of raw output that may have been drawn at other sizes.
 */
export class ScreenMirror {
  private terminal: Terminal; private serializer = new SerializeAddon();
  constructor(readonly runId: string, cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer);
  }
  write(data: string) { this.terminal.write(data); }
  /** Resizes after everything written so far has been drawn, keeping the order the output and the resize came in. */
  resize(cols: number, rows: number) { this.terminal.write('', () => { if (cols !== this.terminal.cols || rows !== this.terminal.rows) this.terminal.resize(cols, rows); }); }
  /** Calls back with the screen once everything written so far has been drawn, before anything written after. */
  snapshot(callback: (screen: { cols: number; rows: number; data: string }) => void) {
    this.terminal.write('', () => callback({ cols: this.terminal.cols, rows: this.terminal.rows, data: this.serializer.serialize({ scrollback: SCROLLBACK }) }));
  }
  dispose() { this.terminal.dispose(); }
}
