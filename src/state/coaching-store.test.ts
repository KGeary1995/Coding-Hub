import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveTip } from '../../shared/coaching';
import { receiveTip, useLiveCoaching } from './coaching-store';

const tip = (id: string, at: string, tips: string[], review: LiveTip['review'] = null): LiveTip => ({ id, sessionId: 'one', engine: 'claude', prompt: 'fix the login', tips, at, review });
beforeEach(() => useLiveCoaching.setState({ enabled: true, tips: [], asking: [], errors: {} }));

describe('live coaching', () => {
  it('keeps the newest 50 prompts, replacing a reviewed one in place', () => {
    for (let i = 0; i < 60; i++) receiveTip(tip(String(i), new Date(Date.UTC(2026, 10, 2, 10, i)).toISOString(), ['t']));
    expect(useLiveCoaching.getState().tips).toHaveLength(50); expect(useLiveCoaching.getState().tips[0].id).toBe('59');
    receiveTip({ ...useLiveCoaching.getState().tips[3], review: { advice: 'x', rewrite: 'y' } });
    expect(useLiveCoaching.getState().tips).toHaveLength(50); expect(useLiveCoaching.getState().tips[3].review).not.toBeNull();
  });
});
