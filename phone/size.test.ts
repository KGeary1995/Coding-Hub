import { describe, expect, it } from 'vitest';
import { atPhoneSize, replayAsks, takenBack } from './size';

describe('a terminal channel opened on the phone', () => {
  it('shows its text at the chosen size while the phone\'s request is on its way, not only once the computer has answered', () => {
    expect(atPhoneSize(false, true)).toBe(true);
    expect(atPhoneSize(true, false)).toBe(true);
    // Given back (the person used the computer, or the phone was put away): the computer's size, panned sideways.
    expect(atPhoneSize(false, false)).toBe(false);
  });
  it('is taken back only from a size the phone had been given, not when a restarted run starts at the desktop\'s size', () => {
    // The person typed at the computer: the channel went from the phone's size back to the desktop's.
    expect(takenBack(true, true, true, false)).toBe(true);
    // Restarted on the computer: the new run's first size is the desktop's, before the phone's request reached it.
    expect(takenBack(false, true, true, false)).toBe(false);
    // The phone's own size, a phone that no longer holds the channel, or one that has not asked yet.
    expect(takenBack(true, true, true, true)).toBe(false);
    expect(takenBack(true, false, true, false)).toBe(false);
    expect(takenBack(true, true, false, false)).toBe(false);
  });
  it('asks for the phone size on a channel just opened or restarted, never on a replay after a reconnect (1.43.0)', () => {
    expect(replayAsks(true, false)).toBe(true); expect(replayAsks(false, true)).toBe(true);
    expect(replayAsks(false, false)).toBe(false);
  });
});
