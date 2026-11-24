import type { RemoteChannel } from '../shared/remote';

/** The switcher's order (herdr's agents-first switch): channels that need you, then running ones, then the rest, each by number. */
export function switcherOrder(list: RemoteChannel[]) {
  const rank = (item: RemoteChannel) => item.attention ? 0 : item.running ? 1 : 2;
  return [...list].sort((a, b) => rank(a) - rank(b) || a.channel - b.channel);
}
