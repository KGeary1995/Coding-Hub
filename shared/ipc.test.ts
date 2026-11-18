import { expect, it } from 'vitest';
import { CLIPBOARD_PREVIEW_LIMIT, clipboardPreviewType } from './ipc';

it('shows a copied PNG or JPEG as it is, so the main process does not encode a screenshot again', () => {
  expect(clipboardPreviewType('image/png', 3_000_000)).toBe('image/png');
  expect(clipboardPreviewType('IMAGE/JPEG; charset=binary', 10)).toBe('image/jpeg');
  expect(clipboardPreviewType('image/png', CLIPBOARD_PREVIEW_LIMIT)).toBe('image/png');
  // Too big for one reply, empty, or a type a linked computer cannot read: scaled down and encoded as before.
  expect(clipboardPreviewType('image/png', CLIPBOARD_PREVIEW_LIMIT + 1)).toBeNull();
  expect(clipboardPreviewType('image/png', 0)).toBeNull();
  for (const type of ['image/svg+xml', 'image/gif', 'image/webp', 'image/bmp', 'text/html']) expect(clipboardPreviewType(type, 100)).toBeNull();
});
