import { beforeEach, describe, expect, it } from 'vitest';
import { addPastedImage, clearPastedImages, MAX_PASTED_IMAGES, quotePath, removePastedImage, usePastedImages } from './pasted-images';

const image = (label: string) => ({ label, thumbnail: 'data:image/png;base64,AA', full: 'data:image/png;base64,AA' });

describe('pasted images', () => {
  beforeEach(() => usePastedImages.setState({ images: {} }));
  it('keeps each channel’s images apart and drops the oldest past the limit', () => {
    for (let index = 0; index < MAX_PASTED_IMAGES + 2; index++) addPastedImage('a', image(`a${index}`));
    addPastedImage('b', image('b0'));
    const { images } = usePastedImages.getState();
    expect(images.a.map((item) => item.label)).toEqual(Array.from({ length: MAX_PASTED_IMAGES }, (_, index) => `a${index + 2}`));
    expect(images.b.map((item) => item.label)).toEqual(['b0']);
  });
  it('removes one image, and forgets a channel when its last image goes or it restarts', () => {
    addPastedImage('a', image('one')); addPastedImage('a', image('two')); addPastedImage('b', image('three'));
    const [first, second] = usePastedImages.getState().images.a;
    removePastedImage('a', first.id);
    expect(usePastedImages.getState().images.a).toEqual([second]);
    removePastedImage('a', second.id);
    expect('a' in usePastedImages.getState().images).toBe(false);
    clearPastedImages('b');
    expect(usePastedImages.getState().images).toEqual({});
  });
});

describe('quotePath', () => {
  it('leaves plain paths alone', () => {
    expect(quotePath('/Users/me/Desktop/shot.png', false)).toBe('/Users/me/Desktop/shot.png');
    expect(quotePath('C:\\Users\\me\\shot.png', true)).toBe('C:\\Users\\me\\shot.png');
  });
  it('quotes paths with spaces or shell characters', () => {
    expect(quotePath('/Users/me/Desktop/Screenshot 2026-10-25 at 4.31.png', false)).toBe("'/Users/me/Desktop/Screenshot 2026-10-25 at 4.31.png'");
    expect(quotePath("/tmp/it's.png", false)).toBe("'/tmp/it'\\''s.png'");
    expect(quotePath('C:\\Users\\me\\My Pictures\\shot.png', true)).toBe('"C:\\Users\\me\\My Pictures\\shot.png"');
  });
});
