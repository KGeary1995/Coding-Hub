import { Terminal } from '@xterm/headless';
import type { AgentDefinition } from '../../../shared/agent-definition';
import { measureLikeTheCLIs } from '../../../shared/terminal-width';
import { cleanMessage, OscSequences } from '../cli/attention';

/** How many of the screen's last lines with text a `waiting` pattern is tried on. */
const RECENT_LINES = 6;
export type CustomStatusChange = { kind: 'waiting'; message: string } | { kind: 'resolved' } | { kind: 'turn-ended' };

/**
 * A custom agent's run read for Needs you and Done (docs/custom-agents.md), from the signals its definition names:
 * OSC 9, 777 and 99 notifications; `waiting` patterns over the screen's last six lines with text; `turnEnd` patterns over the line the
 * cursor sits on (else the last line with text); and `quietSeconds` without output. A turn can end only after the person
 * (or Trace for them) pressed Enter in the channel and the agent printed something after that, so the program's own start
 * screen is never read as a finished turn. The screen is an off-screen copy, as for ScreenReader.
 */
export class CustomStatusReader {
  private terminal: Terminal;
  private osc: { code: '9' | '777' | '99'; sequences: OscSequences }[];
  private waiting: RegExp[]; private turnEnd: RegExp[]; private quietMs: number;
  /** Enter was pressed and that turn has not ended yet; `answered` is when, and `output` says the agent printed since. */
  private armed = false; private answered = 0; private output = false;
  private asking: string | null = null;
  private quiet?: ReturnType<typeof setTimeout>; private reading?: ReturnType<typeof setTimeout>; private disposed = false;
  constructor(status: AgentDefinition['status'], cols: number, rows: number, private report: (change: CustomStatusChange) => void, private options: { checkMs?: number; quietMs?: number } = {}) {
    this.terminal = new Terminal({ cols, rows, scrollback: 1, allowProposedApi: true }); measureLikeTheCLIs(this.terminal);
    this.osc = status?.osc ? (['9', '777', '99'] as const).map((code) => ({ code, sequences: new OscSequences(code) })) : [];
    // The schema compiled each one already; a pattern that still fails is left out rather than stopping the run.
    const compile = (patterns: string[] | undefined) => (patterns ?? []).flatMap((value) => { try { return [new RegExp(value)]; } catch { return []; } });
    this.waiting = compile(status?.waiting); this.turnEnd = compile(status?.turnEnd);
    this.quietMs = options.quietMs ?? (status?.quietSeconds ?? 0) * 1000;
  }

  /** What the person typed in the channel: Enter starts a turn (and answers a question the agent asked). */
  input(data: string) { if (/[\r\n]/.test(data)) this.begin(); }
  /** A turn starts: Enter in the channel, or a run started with its first request as arguments (`firstRequest`). */
  begin() { this.armed = true; this.answered = Date.now(); this.output = false; this.wait(); }

  push(data: string) {
    if (this.disposed) return;
    for (const { code, sequences } of this.osc) for (const body of sequences.push(data)) {
      // OSC 9 is the text; OSC 777 is notify;title;body; OSC 99 (kitty) is metadata;payload. OSC 9;4 is a progress bar.
      if (code === '9' && /^4;/.test(body)) continue;
      const message = cleanMessage(code === '777' ? body.split(';').slice(1).join(' ') : code === '99' ? body.slice(body.indexOf(';') + 1) : body);
      if (this.waiting.some((pattern) => pattern.test(message))) this.ask(message || 'Waiting for your answer');
      else if (this.armed) this.ended();
    }
    this.terminal.write(data);
    // The echo of the Enter that started the turn is not the agent's answer.
    if (this.armed && Date.now() - this.answered > 250) this.output = true;
    if (!this.reading) this.reading = setTimeout(() => { this.reading = undefined; this.check(); }, this.options.checkMs ?? 300);
    this.wait();
  }
  resize(cols: number, rows: number) { this.terminal.write('', () => { if (!this.disposed && (cols !== this.terminal.cols || rows !== this.terminal.rows)) this.terminal.resize(cols, rows); }); }
  dispose() { this.disposed = true; clearTimeout(this.quiet); clearTimeout(this.reading); this.terminal.dispose(); }

  /** Quiet time starts again with each output, only while a turn is open. */
  private wait() { clearTimeout(this.quiet); if (this.quietMs > 0 && this.armed) { this.quiet = setTimeout(() => { if (this.armed && this.output && !this.asking) this.ended(); }, this.quietMs); this.quiet.unref?.(); } }
  private ask(message: string) { if (this.asking === message) return; this.asking = message; this.report({ kind: 'waiting', message }); }
  private ended() { this.armed = false; this.output = false; clearTimeout(this.quiet); this.report({ kind: 'turn-ended' }); }

  private check() {
    if (this.disposed) return;
    this.terminal.write('', () => {
      if (this.disposed) return;
      const buffer = this.terminal.buffer.active; const lines: string[] = [];
      for (let row = 0; row < this.terminal.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
      // Only the bottom of the screen: a question answered earlier can still be visible higher up.
      const question = this.waiting.length ? lines.filter((line) => line.trim()).slice(-RECENT_LINES).find((line) => this.waiting.some((pattern) => pattern.test(line))) : undefined;
      if (question !== undefined) { this.ask(cleanMessage(question) || 'Waiting for your answer'); return; }
      if (this.asking) { this.asking = null; this.report({ kind: 'resolved' }); }
      if (!this.armed || !this.output || !this.turnEnd.length) return;
      // The prompt line as typed up to the cursor keeps its trailing space ("> "); the last line with text, without it.
      const cursor = buffer.getLine(buffer.viewportY + buffer.cursorY)?.translateToString(false, 0, buffer.cursorX) ?? '';
      const last = [...lines].reverse().find((line) => line.trim()) ?? '';
      if (this.turnEnd.some((pattern) => (cursor.trim() && pattern.test(cursor)) || pattern.test(last))) this.ended();
    });
  }
}
