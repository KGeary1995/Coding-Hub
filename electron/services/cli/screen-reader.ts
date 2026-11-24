import { Terminal } from '@xterm/headless';
import { measureLikeTheCLIs } from '../../../shared/terminal-width';
import { screenState, ScreenWatch } from './screen-state';

/**
 * A terminal run's screen, kept off screen in the main process (1.35.3), read about once a second while output arrives:
 * the cross-check of screen-state.ts. `report` hears an approval the screen shows that the CLI's own signal did not
 * announce, and a "needs you" the screen shows is over.
 */
export class ScreenReader {
  private terminal: Terminal; private watch = new ScreenWatch(); private timer: ReturnType<typeof setInterval>;
  private wrote = 0; private toldAt = 0;
  constructor(private engine: string, cols: number, rows: number, private title: () => string, private report: (change: 'blocked' | 'resolved', message?: string) => void) {
    // scrollback 1, not 0: with none, xterm 6.0.0 can throw in its write timer after a resize (lineFeed, 'isWrapped'),
    // an uncaught error that froze Trace behind Electron's error box (seen in the phone smoke test, 2026-11-24).
    this.terminal = new Terminal({ cols, rows, scrollback: 1, allowProposedApi: true }); measureLikeTheCLIs(this.terminal);
    this.timer = setInterval(() => this.check(), 700); this.timer.unref?.();
  }
  write(data: string) { this.terminal.write(data); this.wrote = Date.now(); }
  resize(cols: number, rows: number) { this.terminal.write('', () => { if (cols !== this.terminal.cols || rows !== this.terminal.rows) this.terminal.resize(cols, rows); }); }
  /** The CLI's own signal said it asks: the screen does not announce it again, and a working screen after it clears it. */
  asked() { this.toldAt = Date.now(); this.watch.asked(); }
  private check() {
    // Only while output arrives, and a little after, so a form drawn last is read twice and then left alone.
    if (Date.now() - this.wrote > 3000) return;
    this.terminal.write('', () => {
      const buffer = this.terminal.buffer.active; const lines: string[] = [];
      for (let row = 0; row < this.terminal.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
      const reading = screenState(this.engine, lines, this.title()); const change = this.watch.push(reading);
      if (change === 'blocked' && Date.now() - this.toldAt > 5000) this.report('blocked', reading.message);
      else if (change === 'resolved') this.report('resolved');
    });
  }
  dispose() { clearInterval(this.timer); this.terminal.dispose(); }
}
