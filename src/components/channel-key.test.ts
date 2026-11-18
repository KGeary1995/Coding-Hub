import { describe, expect, it } from 'vitest';
import { channelKey } from './channel-key';

const key = (code: string, mods: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => ({ altKey: false, ctrlKey: false, metaKey: false, code, ...mods });

describe('the channel shortcut', () => {
  it('is Alt+1–8 on Windows and Linux, top-row digits only', () => {
    expect(channelKey(key('Digit3', { altKey: true }), false)).toBe(2);
    expect(channelKey(key('Digit9', { altKey: true }), false)).toBeNull();
    expect(channelKey(key('Numpad3', { altKey: true }), false)).toBeNull();
    // AltGr is Ctrl+Alt on Windows: it types characters and is left alone.
    expect(channelKey(key('Digit3', { altKey: true, ctrlKey: true }), false)).toBeNull();
  });
  it('lets Option+digit through on a Mac, where it types # [ ] | {, and uses Cmd+1–8 instead', () => {
    expect(channelKey(key('Digit3', { altKey: true }), true)).toBeNull();
    expect(channelKey(key('Digit5', { altKey: true }), true)).toBeNull();
    expect(channelKey(key('Digit3', { metaKey: true }), true)).toBe(2);
    expect(channelKey(key('Digit3', { metaKey: true, altKey: true }), true)).toBeNull();
  });
});
