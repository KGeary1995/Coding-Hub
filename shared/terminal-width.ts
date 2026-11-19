import { Unicode11Addon } from '@xterm/addon-unicode11';

/**
 * Counts characters' widths as the CLIs do, as far as Unicode 11 goes. xterm's built-in table is Unicode 6, where ✅ and
 * ❌ take one column; Claude Code draws them in two, so each such character put xterm's cursor a column off the CLI's
 * and its redraws left stray letters behind (a table with ✅ in each row came out garbled). An emoji made wide by a
 * variation selector (⚠️, ✔️) still counts as one column here. The graphemes add-on, which counts those too, would not
 * load in the test runner on Node 22 (CI, 2026-11-19), so the stable add-on was chosen. Load before anything is
 * written; needs allowProposedApi.
 */
export function measureLikeTheCLIs(terminal: { loadAddon(addon: Unicode11Addon): void; unicode: { activeVersion: string } }): void {
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
}
