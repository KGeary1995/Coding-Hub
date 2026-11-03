import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveTip } from '../../shared/coaching';
import { channelTip, dismissTip, receiveTip, useLiveCoaching } from './coaching-store';

const tip = (id: string, at: string, tips: string[], review: LiveTip['review'] = null): LiveTip => ({ id, sessionId: 'one', engine: 'claude', prompt: 'fix the login', tips, at, review });
const shown = () => channelTip(useLiveCoaching.getState(), 'one')?.id ?? null;
beforeEach(() => useLiveCoaching.setState({ enabled: true, tips: [], dismissed: [], asking: [], errors: {} }));

describe('live coaching under a channel', () => {
  it('shows the channel\'s newest prompt, and nothing once it is dismissed', () => {
    receiveTip(tip('a', '2026-11-02T10:00:00Z', ['Old tip'])); receiveTip(tip('b', '2026-11-02T10:01:00Z', ['New tip']));
    expect(shown()).toBe('b'); dismissTip('b'); expect(shown()).toBeNull();
    expect(channelTip(useLiveCoaching.getState(), 'other')).toBeNull();
  });
  it('shows nothing for a prompt with no tips until Claude is asked about it', () => {
    receiveTip(tip('a', '2026-11-02T10:00:00Z', [])); expect(shown()).toBeNull();
    useLiveCoaching.setState({ asking: ['a'] }); expect(shown()).toBe('a');
    receiveTip(tip('a', '2026-11-02T10:00:00Z', [], { advice: 'Good as it is.', rewrite: 'fix the login' })); useLiveCoaching.setState({ asking: [] }); expect(shown()).toBe('a');
  });
  it('keeps the newest 50 prompts, replacing a reviewed one in place', () => {
    for (let i = 0; i < 60; i++) receiveTip(tip(String(i), new Date(Date.UTC(2026, 10, 2, 10, i)).toISOString(), ['t']));
    expect(useLiveCoaching.getState().tips).toHaveLength(50); expect(useLiveCoaching.getState().tips[0].id).toBe('59');
    receiveTip({ ...useLiveCoaching.getState().tips[3], review: { advice: 'x', rewrite: 'y' } });
    expect(useLiveCoaching.getState().tips).toHaveLength(50); expect(useLiveCoaching.getState().tips[3].review).not.toBeNull();
  });
});
