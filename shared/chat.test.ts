import { describe, expect, it } from 'vitest';
import { isTracePrompt } from './chat';

describe('isTracePrompt', () => {
  it('recognises the prompts Trace sends a Round Table builder', () => {
    for (const text of ['[Step: plan] The task', '[Step: review, round 1 of 3] x', '[Trace Round Table · hierarchy] steps', '[Trace Round Table] hi', '[The person answers] yes']) expect(isTracePrompt(text)).toBe(true);
  });
  it('keeps the person\'s own messages that start with a bracket', () => {
    for (const text of ['[WIP] fix the parser', '[Step] by step', '[The person] said', 'plain']) expect(isTracePrompt(text)).toBe(false);
  });
});
