import { describe, expect, it } from 'vitest';
import { channelConfigSchema, engineConfigSchema, modelValue, startSessionSchema } from './schemas';
import { GEMINI_MODEL } from './gemini';

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

describe('Gemini CLI channel settings', () => {
  it('take only the fixed model and a permission level, and are a channel, never a chat or task engine', () => {
    expect(channelConfigSchema.safeParse({ engine: 'gemini', model: GEMINI_MODEL }).success).toBe(true);
    expect(channelConfigSchema.safeParse({ engine: 'gemini', model: GEMINI_MODEL, permissions: 'full' }).success).toBe(true);
    for (const config of [{ engine: 'gemini', model: 'gemini-3.8-flash-high' }, { engine: 'gemini', model: '' }, { engine: 'gemini' }, { engine: 'gemini', model: GEMINI_MODEL, chat: true }, { engine: 'gemini', model: GEMINI_MODEL, resumeId: '00000000-0000-4000-8000-000000000000' }, { engine: 'gemini', model: GEMINI_MODEL, permissions: 'root' }])
      expect(channelConfigSchema.safeParse(config).success).toBe(false);
    expect(engineConfigSchema.safeParse({ engine: 'gemini', model: GEMINI_MODEL }).success).toBe(false);
    expect(startSessionSchema.safeParse({ sessionId: 'g1', cwd: '/p', config: { engine: 'gemini', model: GEMINI_MODEL }, cols: 80, rows: 24 }).success).toBe(true);
  });
});
