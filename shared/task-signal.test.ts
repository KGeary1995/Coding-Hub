import { describe, expect, it } from 'vitest';
import { promptMark, replyToTask, SIGNAL_INSTRUCTION, taskSignal } from './task-signal';

describe('the reply that belongs to one send of a task', () => {
  it('finds a send by its id, so the same title sent again, or another task with that title, never counts', () => {
    const old = { title: 'Fix it', sendId: 't-aaaaaaaa' }; const now = { title: 'Fix it', sendId: 't-bbbbbbbb' };
    expect(promptMark(now)).toBe('Task t-bbbbbbbb: Fix it.'); expect(promptMark({ title: 'Fix it.' })).toBe('Task: Fix it.');
    const before = [{ role: 'user' as const, text: `${promptMark(old)} Do it.` }, { role: 'assistant' as const, text: 'TASK COMPLETE' }];
    // The new send's prompt is not in the transcript yet: no reply for it, though the old one said TASK COMPLETE.
    expect(replyToTask(before, now)).toBeNull();
    expect(replyToTask([...before, { role: 'user', text: `${promptMark(now)} Do it.` }, { role: 'assistant', text: 'Done.\nTASK COMPLETE' }], now)).toBe('Done.\nTASK COMPLETE');
  });
  it('stops where the next task was sent, so a later task’s TASK COMPLETE never counts for an earlier one', () => {
    const first = { title: 'Fix it', sendId: 't-aaaaaaaa' }; const second = { title: 'Write the docs', sendId: 't-bbbbbbbb' };
    const messages = [
      { role: 'user' as const, text: `${promptMark(first)} ${SIGNAL_INSTRUCTION}` }, { role: 'assistant' as const, text: 'Which file?' },
      { role: 'user' as const, text: 'the one in src' }, { role: 'assistant' as const, text: 'Still looking.' },
      { role: 'user' as const, text: `${promptMark(second)} ${SIGNAL_INSTRUCTION}` }, { role: 'assistant' as const, text: 'Docs written.\nTASK COMPLETE' },
    ];
    expect(replyToTask(messages, first)).toBe('Still looking.');
    expect(replyToTask(messages, second)).toBe('Docs written.\nTASK COMPLETE');
  });
});

describe('a later task recorded without its instruction', () => {
  it('still ends the earlier task’s reply, so its TASK COMPLETE never counts for the earlier one', () => {
    const first = { title: 'Fix it', sendId: 't-cccccccc' }; const second = { title: 'Write the docs', sendId: 't-dddddddd' };
    // The transcript kept only the start of the second prompt (its first line), not the instruction at its end.
    const messages = [
      { role: 'user' as const, text: `${promptMark(first)} ${SIGNAL_INSTRUCTION}` }, { role: 'assistant' as const, text: 'Which file?' },
      { role: 'user' as const, text: `${promptMark(second)} In the README.` }, { role: 'assistant' as const, text: 'Docs written.\nTASK COMPLETE' },
    ];
    expect(replyToTask(messages, first)).toBe('Which file?');
    expect(replyToTask(messages, second)).toBe('Docs written.\nTASK COMPLETE');
    // The same task sent again is a new start for it, not another task's prompt.
    const again = { ...first, sendId: 't-eeeeeeee' };
    expect(replyToTask([...messages, { role: 'user', text: `${promptMark(again)} ${SIGNAL_INSTRUCTION}` }, { role: 'assistant', text: 'Fixed.\nTASK COMPLETE' }], again)).toBe('Fixed.\nTASK COMPLETE');
  });
});

describe('the task completion line', () => {
  it('reads TASK COMPLETE and TASK BLOCKED near the end of a reply, in the forms agents write them', () => {
    expect(taskSignal('Changed a.ts.\n\nTASK COMPLETE')).toEqual({ kind: 'complete' });
    expect(taskSignal('Done.\n**TASK COMPLETE.**\n')).toEqual({ kind: 'complete' });
    expect(taskSignal('`TASK BLOCKED: need the API key name`')).toEqual({ kind: 'blocked', reason: 'need the API key name' });
    expect(taskSignal('TASK BLOCKED:')).toEqual({ kind: 'blocked', reason: 'The agent needs you.' });
  });
  it('does not take a mention earlier in the reply, or a question, as the signal', () => {
    expect(taskSignal('TASK COMPLETE\nline 2\nline 3\nShould I go on?')).toBeNull();
    expect(taskSignal('TASK COMPLETE\n\nShould I continue?')).toBeNull(); expect(taskSignal('TASK BLOCKED: key?\nOr should I guess?')).toBeNull();
    expect(taskSignal('I will write TASK COMPLETE when done.')).toBeNull();
    expect(taskSignal('')).toBeNull();
  });
});
