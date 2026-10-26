const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A model id as people say it: "claude-opus-5-5" → "Opus 5.5", "claude-haiku-5-5-20260101" → "Haiku 5.5",
 * "gpt-6.1-sol" → "GPT-6.1 Sol", "opus" → "Opus". Anything else is shown as it is.
 */
export function modelLabel(id: string): string {
  const value = id.trim(); if (!value) return value;
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8}|-latest)?(\[1m\])?$/i.exec(value);
  if (claude) return `${capital(claude[1].toLowerCase())} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}${claude[4] ? ' (1M)' : ''}`;
  const gpt = /^gpt-([\d.]+)(?:-([a-z][\w-]*))?$/i.exec(value);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].split('-').map(capital).join(' ') : ''}`;
  if (/^(opus|sonnet|haiku|fable)$/i.test(value)) return capital(value.toLowerCase());
  return value;
}
