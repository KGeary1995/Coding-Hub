import { describe, expect, it } from 'vitest';
import { taskSignal } from './task-signal';

describe('the task completion line', () => {
  it('reads TASK COMPLETE and TASK BLOCKED near the end of a reply, in the forms agents write them', () => {
    expect(taskSignal('Changed a.ts.\n\nTASK COMPLETE')).toEqual({ kind: 'complete' });
    expect(taskSignal('Done.\n**TASK COMPLETE.**\n')).toEqual({ kind: 'complete' });
    expect(taskSignal('`TASK BLOCKED: need the API key name`')).toEqual({ kind: 'blocked', reason: 'need the API key name' });
    expect(taskSignal('TASK BLOCKED:')).toEqual({ kind: 'blocked', reason: 'The agent needs you.' });
  });
  it('does not take a mention earlier in the reply, or a question, as the signal', () => {
    expect(taskSignal('TASK COMPLETE\nline 2\nline 3\nShould I go on?')).toBeNull();
    expect(taskSignal('I will write TASK COMPLETE when done.')).toBeNull();
    expect(taskSignal('')).toBeNull();
  });
});
