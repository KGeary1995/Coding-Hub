import { create } from 'zustand';

/** An image the person pasted or dropped into a channel, shown under its terminal. The CLI attaches its own copy. */
export interface PastedImage { id: string; label: string; thumbnail: string; full: string }

/** Thumbnails kept per channel; the oldest drop off first. */
export const MAX_PASTED_IMAGES = 12;

export const usePastedImages = create<{ images: Record<string, PastedImage[]> }>(() => ({ images: {} }));

let counter = 0;
export function addPastedImage(sessionId: string, image: Omit<PastedImage, 'id'>) {
  const { images } = usePastedImages.getState();
  const next = [...(images[sessionId] ?? []), { ...image, id: `pasted-${++counter}` }].slice(-MAX_PASTED_IMAGES);
  usePastedImages.setState({ images: { ...images, [sessionId]: next } });
}

export function removePastedImage(sessionId: string, id: string) {
  const { images } = usePastedImages.getState(); const current = images[sessionId];
  if (!current) return;
  const next = { ...images, [sessionId]: current.filter((image) => image.id !== id) };
  if (!next[sessionId].length) delete next[sessionId];
  usePastedImages.setState({ images: next });
}

export function clearPastedImages(sessionId: string) {
  const { images } = usePastedImages.getState();
  if (!(sessionId in images)) return;
  const next = { ...images }; delete next[sessionId];
  usePastedImages.setState({ images: next });
}

/** A dropped file's path as typed at a shell prompt, quoted when it holds spaces or shell characters. */
export function quotePath(file: string, windows: boolean): string {
  if (/^[\w@%+=:,./\\-]+$/.test(file)) return file;
  return windows ? `"${file.replace(/"/g, '')}"` : `'${file.replace(/'/g, `'\\''`)}'`;
}
