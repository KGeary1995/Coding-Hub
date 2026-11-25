import { Unicode11Addon } from '@xterm/addon-unicode11';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';

/**
 * Counts characters' widths as the CLIs do. xterm's built-in table is Unicode 6, where ✅ and ❌ take one column;
 * Claude Code draws them in two, so each such character put xterm's cursor a column off the CLI's and its redraws left
 * stray letters behind (a table with ✅ in each row came out garbled). From 1.43.0 the graphemes add-on (Unicode 15 and
 * grapheme clusters) also counts an emoji made wide by a variation selector (⚠️, ✔️) in two columns, as the CLIs do;
 * up to 1.42 Unicode 11 counted those in one, because the add-on would not load in the test runner on Node 22 (CI,
 * 2026-11-19). It loads on Node 22.23 and 24 (checked 2026-11-25). Should it fail to load, Unicode 11 is used, as
 * before. Load before anything is written; needs allowProposedApi.
 */
export function measureLikeTheCLIs(terminal: { loadAddon(addon: Unicode11Addon | UnicodeGraphemesAddon): void; unicode: { activeVersion: string } }): void {
  try { terminal.loadAddon(new UnicodeGraphemesAddon()); terminal.unicode.activeVersion = '15-graphemes'; if (terminal.unicode.activeVersion === '15-graphemes') return; } catch { /* Unicode 11 below. */ }
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
}
