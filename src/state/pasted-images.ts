import { create } from 'zustand';

/**
 * An image the person pasted or dropped into a channel, shown under its terminal. The CLI attaches its own copy; this
 * is Trace's record of it: attached until the person sends their message (Enter), then sent, with the time.
 */
export interface PastedImage { id: string; label: string; thumbnail: string; full: string; number: number; sentAt: string | null }

/** Images kept per channel, attached and sent together; the oldest sent ones drop off first. */
export const MAX_PASTED_IMAGES = 12;

export const usePastedImages = create<{ images: Record<string, PastedImage[]>; counts: Record<string, number> }>(() => ({ images: {}, counts: {} }));

let counter = 0;
/** Adds an attached image, numbered in the order pasted in this run (as the CLI numbers [Image #1], [Image #2]…). */
export function addPastedImage(sessionId: string, image: Pick<PastedImage, 'label' | 'thumbnail' | 'full'>) {
  const { images, counts } = usePastedImages.getState(); const number = (counts[sessionId] ?? 0) + 1;
  const list = [...(images[sessionId] ?? []), { ...image, id: `pasted-${++counter}`, number, sentAt: null }];
  // Over the limit, sent images go first; attached ones are about to be sent and are kept.
  while (list.length > MAX_PASTED_IMAGES) { const index = list.findIndex((item) => item.sentAt); list.splice(index >= 0 ? index : 0, 1); }
  usePastedImages.setState({ images: { ...images, [sessionId]: list }, counts: { ...counts, [sessionId]: number } });
}

/** The person sent their message: every attached image in that channel is now sent. */
export function markPastedImagesSent(sessionId: string, at = new Date()) {
  const { images } = usePastedImages.getState(); const list = images[sessionId];
  if (!list?.some((image) => !image.sentAt)) return;
  usePastedImages.setState({ images: { ...images, [sessionId]: list.map((image) => image.sentAt ? image : { ...image, sentAt: at.toISOString() }) } });
}

export function removePastedImage(sessionId: string, id: string) {
  const { images } = usePastedImages.getState(); const current = images[sessionId];
  if (!current) return;
  const next = { ...images, [sessionId]: current.filter((image) => image.id !== id) };
  if (!next[sessionId].length) delete next[sessionId];
  usePastedImages.setState({ images: next });
}

/** A channel restarted (a new run numbers its images from 1) or was removed. */
export function clearPastedImages(sessionId: string) {
  const { images, counts } = usePastedImages.getState();
  if (!(sessionId in images) && !(sessionId in counts)) return;
  const nextImages = { ...images }; delete nextImages[sessionId]; const nextCounts = { ...counts }; delete nextCounts[sessionId];
  usePastedImages.setState({ images: nextImages, counts: nextCounts });
}

/** A dropped file's path as typed at a shell prompt, quoted when it holds spaces or shell characters. */
export function quotePath(file: string, windows: boolean): string {
  if (/^[\w@%+=:,./\\-]+$/.test(file)) return file;
  return windows ? `"${file.replace(/"/g, '')}"` : `'${file.replace(/'/g, `'\\''`)}'`;
}
