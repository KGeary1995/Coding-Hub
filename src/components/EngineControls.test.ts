import { describe, expect, it } from 'vitest';
import type { ClaudeCLIEngineConfig } from '../../shared/types';
import { withProfile } from './EngineControls';

const A = '11111111-1111-4111-8111-111111111111'; const B = '22222222-2222-4222-8222-222222222222'; const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const config = (extra: Partial<ClaudeCLIEngineConfig> = {}): ClaudeCLIEngineConfig => ({ engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null }, ...extra });

describe('changing a channel’s Claude account', () => {
  it('sets the saved conversation aside, and brings it back when that account is chosen again', () => {
    const kept: Record<string, string> = {};
    const other = withProfile(config({ accountProfileId: A, resumeId: CONVERSATION }), B, kept);
    expect(other).toEqual(config({ accountProfileId: B }));
    expect(withProfile(other, A, kept)).toEqual(config({ accountProfileId: A, resumeId: CONVERSATION }));
  });
  it('works from and back to the default sign-in', () => {
    const kept: Record<string, string> = {};
    const other = withProfile(config({ resumeId: CONVERSATION }), A, kept);
    expect(other.resumeId).toBeUndefined();
    expect(withProfile(other, '', kept)).toEqual(config({ resumeId: CONVERSATION }));
  });
  it('does not bring back a restored conversation that the person then dropped', () => {
    const kept: Record<string, string> = {};
    const restored = withProfile(withProfile(config({ accountProfileId: A, resumeId: CONVERSATION }), B, kept), A, kept);
    expect(restored.resumeId).toBe(CONVERSATION);
    const { resumeId: _dropped, ...fresh } = restored; // Start a fresh conversation next time
    expect(withProfile(withProfile(fresh, B, kept), A, kept).resumeId).toBeUndefined();
  });
});
