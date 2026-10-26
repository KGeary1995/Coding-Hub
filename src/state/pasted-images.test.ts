import { beforeEach, describe, expect, it } from 'vitest';
import { addPastedImage, clearPastedImages, markPastedImagesSent, MAX_PASTED_IMAGES, quotePath, removePastedImage, usePastedImages } from './pasted-images';

const image = (label: string) => ({ label, thumbnail: 'data:image/png;base64,AA', full: 'data:image/png;base64,AA' });
const labels = (sessionId: string) => (usePastedImages.getState().images[sessionId] ?? []).map((item) => item.label);

describe('pasted images', () => {
  beforeEach(() => usePastedImages.setState({ images: {}, counts: {} }));
  it('numbers images per channel and run, and marks attached ones sent when the message goes', () => {
    addPastedImage('a', image('one')); addPastedImage('a', image('two')); addPastedImage('b', image('other'));
    expect(usePastedImages.getState().images.a.map((item) => [item.number, item.sentAt])).toEqual([[1, null], [2, null]]);
    expect(usePastedImages.getState().images.b[0].number).toBe(1);
    markPastedImagesSent('a', new Date('2026-10-25T20:30:00Z'));
    addPastedImage('a', image('three'));
    expect(usePastedImages.getState().images.a.map((item) => [item.number, item.sentAt])).toEqual([[1, '2026-10-25T20:30:00.000Z'], [2, '2026-10-25T20:30:00.000Z'], [3, null]]);
    // A restart begins a new run: the strip empties and numbering starts again.
    clearPastedImages('a'); addPastedImage('a', image('again'));
    expect(usePastedImages.getState().images.a.map((item) => item.number)).toEqual([1]);
  });
  it('drops the oldest sent images past the limit, keeping ones still attached', () => {
    addPastedImage('a', image('kept-attached'));
    for (let index = 0; index < MAX_PASTED_IMAGES; index++) { addPastedImage('a', image(`sent-${index}`)); }
    markPastedImagesSent('a');
    addPastedImage('a', image('new'));
    expect(labels('a')).toHaveLength(MAX_PASTED_IMAGES);
    expect(labels('a')).toContain('new'); expect(labels('a')).not.toContain('kept-attached');
    // Attached images are not dropped to make room.
    usePastedImages.setState({ images: {}, counts: {} });
    for (let index = 0; index < MAX_PASTED_IMAGES + 2; index++) addPastedImage('a', image(`attached-${index}`));
    expect(labels('a')).toHaveLength(MAX_PASTED_IMAGES);
  });
  it('removes one image, and forgets a channel when its last image goes', () => {
    addPastedImage('a', image('one')); addPastedImage('a', image('two'));
    const [first, second] = usePastedImages.getState().images.a;
    removePastedImage('a', first.id); expect(usePastedImages.getState().images.a).toEqual([second]);
    removePastedImage('a', second.id); expect('a' in usePastedImages.getState().images).toBe(false);
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
