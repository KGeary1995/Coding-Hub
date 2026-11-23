import { describe, expect, it } from 'vitest';
import { pasteKeys } from './LinkedScreen';

const ctrl = { ctrlKey: true, metaKey: false }; const cmd = { ctrlKey: false, metaKey: true };

describe('pasting this computer\'s text on another computer\'s screen', () => {
  it('hands the text over first between two Windows PCs and between two Macs too, not only across', () => {
    // Windows viewing Windows (Trace's screen service), Mac viewing a Mac (Screen Sharing): no swap, the local paste key.
    expect(pasteKeys('trace', true, false)?.(ctrl)).toBe(true); expect(pasteKeys('trace', true, false)?.(cmd)).toBe(false);
    expect(pasteKeys('system', true, true)?.(cmd)).toBe(true); expect(pasteKeys('system', true, true)?.(ctrl)).toBe(false);
  });
  it('across, pastes with the swapped key while the swap is on, and not at all with it off', () => {
    expect(pasteKeys('system', true, false)?.(ctrl)).toBe(true); expect(pasteKeys('system', false, false)).toBeNull();
    expect(pasteKeys('trace', true, true)?.(cmd)).toBe(true); expect(pasteKeys('trace', false, true)).toBeNull();
  });
  it('waits until it knows what it is connected to', () => {
    expect(pasteKeys(null, true, false)).toBeNull();
  });
});
