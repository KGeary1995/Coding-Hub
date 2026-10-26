import type { ChannelEngine } from './types';

/** The names new channels start with. A channel still called this is named after its folder instead. */
export const DEFAULT_TITLES: Record<ChannelEngine, string> = { claude: 'Claude Code', codex: 'Codex', shell: 'Terminal' };

const folderName = (directory: string) => directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;

/**
 * What a channel is called: the name the person gave it, or, while it still has its engine's default name, the folder
 * (repository) it works in. The engine is shown separately (badge colour and model), so it need not be in the name.
 */
export function channelName(channel: { engine: ChannelEngine; title: string; cwd: string | null }): string {
  return channel.title === DEFAULT_TITLES[channel.engine] && channel.cwd ? folderName(channel.cwd) : channel.title;
}

/**
 * What the session is about, from the title the CLI gives its terminal (OSC 0/2). Claude Code sets it to a summary of
 * the current task; idle, or for Codex, it is just the program or folder name, which says nothing new. Spinner and
 * status symbols in front are dropped. Shell titles (user@host:path) are not topics.
 */
export function sessionTopic(raw: string, engine: ChannelEngine, name: string): string | null {
  if (engine === 'shell') return null;
  // Spinners (braille, ✳ ✢ · *), other symbols and spaces in front; letters, digits and common punctuation stay.
  const text = raw.replace(/[\x00-\x1f\x7f]/g, '').replace(/^[^\p{L}\p{N}"'(\[]+/u, '').trim().slice(0, 80);
  if (!text) return null;
  const plain = text.toLowerCase();
  if ([DEFAULT_TITLES[engine], 'claude', 'codex', name].some((item) => item.toLowerCase() === plain)) return null;
  return text;
}
