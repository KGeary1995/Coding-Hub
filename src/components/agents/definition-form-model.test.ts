import { describe, expect, it } from 'vitest';
import { BLANK, checkDraft, draftFrom, draftText, envFromLines, envToLines, field, fromLines, idFrom, setField, toLines, validId } from './definition-form-model';

describe('the agent form', () => {
  it('makes an id from a name, never a built-in one', () => {
    expect(idFrom('Aider')).toBe('aider'); expect(idFrom('Open Code 2!')).toBe('open-code-2'); expect(idFrom('42 Agent')).toBe('agent');
    expect(idFrom('Claude')).toBe('claude-custom'); expect(idFrom('X')).toBe('x-agent'); expect(idFrom('')).toBe('');
    expect(validId('aider')).toBe(true); expect(validId('codex')).toBe(false); expect(validId('Aider')).toBe(false);
  });
  it('keeps one argument per line, spaces inside it included', () => {
    expect(fromLines('--message\nfix the tests\n\n')).toEqual(['--message', 'fix the tests']); expect(toLines(['a', 'b c'])).toBe('a\nb c');
    expect(envFromLines('A=1\nB=x=y\nbad')).toEqual({ A: '1', B: 'x=y' }); expect(envToLines({ A: '1' })).toBe('A=1');
  });
  it('sets fields by path and drops empty optional sections', () => {
    let draft = setField(BLANK, ['models', 'arg'], ['--model', '{model}']); expect(field(draft, ['models', 'arg'])).toEqual(['--model', '{model}']);
    draft = setField(draft, ['models', 'arg'], []); expect(draft.models).toBeUndefined();
    // Permission levels keep an empty list: Ask often takes no arguments.
    draft = setField(draft, ['permissions', 'ask'], []); expect(field(draft, ['permissions', 'ask'])).toEqual([]);
    expect(BLANK.models).toBeUndefined();
  });
  it('says what is wrong with a draft, and reads the JSON tab back', () => {
    expect(checkDraft(BLANK).problems.length).toBeGreaterThan(0);
    const ok = { ...BLANK, id: 'aider', name: 'Aider', program: { command: 'aider' } };
    expect(checkDraft(ok).definition?.id).toBe('aider');
    expect(draftFrom(draftText(ok))).toEqual(ok); expect(draftFrom('[1]')).toBeNull(); expect(draftFrom('{')).toBeNull();
  });
});
