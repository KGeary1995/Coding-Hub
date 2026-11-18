import { expect, it } from 'vitest';
import { modelLabel } from './model-name';

it('names models the way people say them', () => {
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
  expect(modelLabel('claude-haiku-5-5-20260101')).toBe('Haiku 5.5');
  expect(modelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M)');
  expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
  expect(modelLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
  expect(modelLabel('gpt-6.1')).toBe('GPT-6.1');
  expect(modelLabel('opus')).toBe('Opus');
  expect(modelLabel('opus[1m]')).toBe('Opus (1M)'); expect(modelLabel('Sonnet[1M]')).toBe('Sonnet (1M)'); expect(modelLabel('GPT-6.1-SOL')).toBe('GPT-6.1 Sol');
  expect(modelLabel('some-custom-model')).toBe('some-custom-model');
});
