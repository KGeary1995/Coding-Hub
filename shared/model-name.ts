const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A model id as people say it: "claude-opus-5-5" → "Opus 5.5", "claude-haiku-5-5-20260101" → "Haiku 5.5",
 * "gpt-6.1-sol" → "GPT-6.1 Sol", "opus" → "Opus", "sonnet[1m]" → "Sonnet (1M)". Anything else is shown as it is.
 */
export function modelLabel(id: string): string {
  const value = id.trim(); if (!value) return value;
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8}|-latest)?(\[1m\])?$/i.exec(value);
  if (claude) return `${capital(claude[1].toLowerCase())} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}${claude[4] ? ' (1M)' : ''}`;
  const gpt = /^gpt-([\d.]+)(?:-([a-z][\w-]*))?$/i.exec(value);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].toLowerCase().split('-').map(capital).join(' ') : ''}`;
  const alias = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i.exec(value); if (alias) return `${capital(alias[1].toLowerCase())}${alias[2] ? ' (1M)' : ''}`;
  return value;
}

/**
 * Claude Code's current models, most capable first, for pickers: chosen by name, never typed. The full IDs, not the
 * aliases: Claude Code runs the alias `haiku` on Sonnet in plan mode.
 */
export const CLAUDE_MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
