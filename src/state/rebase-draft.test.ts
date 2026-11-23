import { describe, expect, it } from 'vitest';
import { rebaseDraft } from './rebase-draft';

describe('rebaseDraft', () => {
  const saved = { driveDirectory: 'G:\\Old', terminalFontSize: 14, dailyCost: null as number | null };
  it('takes the new values when nothing was edited', () => {
    const next = { ...saved, driveDirectory: 'G:\\New' };
    expect(rebaseDraft(saved, saved, next)).toBe(next);
  });
  it('takes a field changed elsewhere and keeps the fields being edited', () => {
    const draft = { ...saved, terminalFontSize: 16 };
    expect(rebaseDraft(draft, saved, { ...saved, driveDirectory: 'G:\\New' })).toEqual({ driveDirectory: 'G:\\New', terminalFontSize: 16, dailyCost: null });
  });
  it('keeps an edit to the same field that changed elsewhere', () => {
    const draft = { ...saved, driveDirectory: 'D:\\Mine' };
    expect(rebaseDraft(draft, saved, { ...saved, driveDirectory: 'G:\\New' }).driveDirectory).toBe('D:\\Mine');
  });
  it('adds and removes fields the saved copy gained or lost', () => {
    const before: Record<string, unknown> = { a: 1, gone: true }; const draft = { ...before, a: 2 };
    expect(rebaseDraft(draft, before, { a: 1, added: 'x' })).toEqual({ a: 2, added: 'x' });
  });
});
