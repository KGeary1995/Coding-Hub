/**
 * What an agent's screen says it is doing (1.35.3), from the rules herdr uses for Claude Code and Codex
 * (herdrdev/herdr src/detect/manifests/claude.toml, codex.toml, Apache-2.0; a subset). Trace still learns most states
 * from the CLIs' own signals (hooks, OSC 9, OSC 7501); this is the cross-check that catches an approval those missed
 * and clears a "needs you" left behind once the agent is working again. Blocked is read strictly, as herdr does: only
 * a known approval or question form counts, and anything unknown is not blocked.
 */
import { CODEX_HOOK_QUESTION, CODEX_TRUST_QUESTION } from '../../../shared/start-order';

export type ScreenState = 'working' | 'blocked' | 'unknown';
const BRAILLE = /^[⠀-⣿◐-◓] /;
const CODEX_SPINNER = /(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/;
const RULE = /^\s*[─━]{3,}/;
/** The non-empty lines at the bottom of the screen, last `count`. */
const bottom = (lines: string[], count: number) => lines.filter((line) => line.trim()).slice(-count);

export function screenState(engine: string, lines: string[], title: string): { state: ScreenState; message?: string } {
  const lower = (items: string[]) => items.join('\n').toLowerCase();
  if (engine === 'claude') {
    // A form after the last horizontal rule: "esc to cancel" with "enter to confirm", or "enter to select" and a way to move.
    const ruleAt = lines.map((line, index) => RULE.test(line) ? index : -1).filter((index) => index >= 0).at(-1) ?? -1;
    const form = lower(lines.slice(ruleAt + 1));
    if (form.includes('esc to cancel') && (form.includes('enter to confirm') || (form.includes('enter to select') && /(?:tab\/arrow keys|arrow keys|arrows|↑\/↓|↑↓) to navigate/.test(form)))) {
      const question = lines.slice(ruleAt + 1).find((line) => /\?\s*$/.test(line.trim()))?.trim();
      return { state: 'blocked', message: question ?? 'Claude Code is waiting for your answer' };
    }
    if (BRAILLE.test(title)) return { state: 'working' };
    if (bottom(lines, 12).some((line) => /^\s*[⏸⏵].*esc to interrupt(?:\s|·|$)/.test(line) || /^\s*[*·✢✳✶✻✽]\s+\S.*…(?:\s+\(\d+[smh](?:\s|·)|\s*$)/.test(line))) return { state: 'working' };
    return { state: 'unknown' };
  }
  if (engine === 'codex') {
    if (title.includes('Action Required')) return { state: 'blocked', message: 'Codex is waiting for your approval' };
    // After the last prompt marker (›): Codex's own approval and question forms.
    const at = lines.map((line, index) => /^›/.test(line) ? index : -1).filter((index) => index >= 0).at(-1) ?? -1;
    const after = lower(lines.slice(at + 1));
    // Its startup questions (codex-cli 0.172, seen 2026-11-25): trust this folder, and review a hook before it runs. Read
    // as asking, so nothing is typed into them (Start in order's first request waits): Enter there trusts the folder,
    // and "t" trusts every hook.
    if (after.includes('enter continue') && after.includes('esc back') && lower(lines).includes('trust this folder')) return { state: 'blocked', message: CODEX_TRUST_QUESTION };
    if (after.includes('enter review') && after.includes('esc close') && lower(lines).includes('needs review')) return { state: 'blocked', message: CODEX_HOOK_QUESTION };
    if (['allow command?', 'press enter to confirm or esc to cancel', 'enter to submit answer', 'enter to submit all'].some((text) => after.includes(text))) return { state: 'blocked', message: lines.slice(at + 1).find((line) => /\?\s*$/.test(line.trim()))?.trim() ?? 'Codex is waiting for your answer' };
    if (CODEX_SPINNER.test(title)) return { state: 'working' };
    return { state: 'unknown' };
  }
  return { state: 'unknown' };
}

/**
 * Turns screen readings into changes worth reporting: a state counts once it has been read twice in a row (herdr confirms
 * before trusting a change). `blocked` is reported when the screen first shows an approval form; `resolved`, when a
 * screen that showed one, or a run Trace marked as asking, shows the agent working again; `working`, when it starts
 * working otherwise; and `settled` (1.43.0), when a working screen shows the agent working no more, the cross-check of
 * a turn's end that its own signal may have missed (pty-manager confirms it once the run has stayed quiet).
 */
export class ScreenWatch {
  private last: ScreenState = 'unknown'; private pending: ScreenState = 'unknown'; private seen = 0; private stable: ScreenState = 'unknown';
  push(reading: { state: ScreenState }): 'blocked' | 'resolved' | 'working' | 'settled' | null {
    if (reading.state === this.pending) this.seen++; else { this.pending = reading.state; this.seen = 1; }
    if (this.seen < 2 || reading.state === this.stable) return null;
    const before = this.stable; this.stable = reading.state; this.last = before;
    if (reading.state === 'blocked') return 'blocked';
    if (reading.state === 'working') return before === 'blocked' ? 'resolved' : 'working';
    if (before === 'working') return 'settled';
    return null;
  }
  /** Trace was told by the CLI itself that it asks: a working screen after it clears that, too. */
  asked() { this.stable = 'blocked'; this.pending = 'blocked'; this.seen = 2; }
  get state() { return this.stable; }
  get previous() { return this.last; }
}
