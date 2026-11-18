import { MAC } from './platform';

/** The channel shortcut as the person presses it on this computer: Option types characters on a Mac, so it uses Cmd there. */
export const CHANNEL_KEYS = MAC ? 'Cmd+1–8' : 'Alt+1–8';

/**
 * The channel (0 for the first) a key press focuses, or null. Alt+1–8 on Windows and Linux; Cmd+1–8 on a Mac, where
 * Option+digit types characters (# on a UK keyboard, [ ] | { on a German one) that must reach the terminal or field.
 * Top-row digits only: Alt+numpad digits are Windows character entry (Alt+0169).
 */
export function channelKey(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'code'>, mac = MAC): number | null {
  if (!/^Digit[1-8]$/.test(event.code)) return null;
  const pressed = mac ? event.metaKey && !event.altKey && !event.ctrlKey : event.altKey && !event.ctrlKey && !event.metaKey;
  return pressed ? Number(event.code.slice(5)) - 1 : null;
}
