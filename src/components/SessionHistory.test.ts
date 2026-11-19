import { describe, expect, it } from 'vitest';
import { runBadge } from './SessionHistory';

describe('a recorded run\'s badge', () => {
  it('calls an active run Working, in its engine\'s colour, as a channel is', () => {
    expect(runBadge({ status: 'running', exitCode: null, engine: 'claude' })).toEqual({ word: 'Working', tone: 'claude' });
    expect(runBadge({ status: 'running', exitCode: null, engine: 'codex' })).toEqual({ word: 'Working', tone: 'codex' });
  });
  it('calls a clean run Completed and a failed one by its exit code, in the list and the record alike', () => {
    expect(runBadge({ status: 'completed', exitCode: 0, engine: 'claude' })).toEqual({ word: 'Completed', tone: 'success' });
    expect(runBadge({ status: 'completed', exitCode: 1, engine: 'claude' })).toEqual({ word: 'Exit 1', tone: 'danger' });
    expect(runBadge({ status: 'completed', exitCode: -1, engine: 'codex' })).toEqual({ word: 'Exit -1', tone: 'danger' });
  });
  it('keeps an interrupted run in the limit colour', () => {
    expect(runBadge({ status: 'interrupted', exitCode: null, engine: 'codex' })).toEqual({ word: 'Interrupted', tone: 'limit' });
  });
});
