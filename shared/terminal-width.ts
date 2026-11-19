import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';

/**
 * Counts characters' widths as the CLIs do. xterm's built-in table is Unicode 6, where ✅, ❌ and ⚠️ take one column;
 * Claude Code draws them in two, so each such character put xterm's cursor a column off the CLI's and its redraws left
 * stray letters behind (a table with ✅ in each row came out garbled). Load before anything is written; needs
 * allowProposedApi.
 */
export function measureLikeTheCLIs(terminal: { loadAddon(addon: UnicodeGraphemesAddon): void }): void {
  terminal.loadAddon(new UnicodeGraphemesAddon());
}
