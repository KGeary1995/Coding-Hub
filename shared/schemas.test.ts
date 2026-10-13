import { describe, expect, it } from 'vitest';
import { engineConfigSchema, modelValue } from './schemas';

describe('engine model settings', () => {
  it('accepts Claude Code context-suffixed aliases and still refuses flag-like values', () => {
    const config = (model: string) => engineConfigSchema.safeParse({ engine: 'claude', model, thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }).success;
    expect(config('sonnet[1m]')).toBe(true); expect(config('claude-sonnet-4-5[1m]')).toBe(true);
    expect(config('--dangerously-skip-permissions')).toBe(false); expect(config('model & calc')).toBe(false);
  });
  it('only lets the UI store model text the saved workspace accepts', () => {
    expect(modelValue(' gpt-5 ')).toBe('gpt-5'); expect(modelValue('')).toBe('');
    expect(modelValue('two words')).toBeNull(); expect(modelValue('-flag')).toBeNull(); expect(modelValue('x'.repeat(161))).toBeNull();
  });
});
