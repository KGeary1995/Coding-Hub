import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GettingStarted, guideSteps } from './GettingStarted';

describe('the getting started guide', () => {
  it('shows nothing before the saved settings have arrived', () => { expect(renderToStaticMarkup(<GettingStarted />)).toBe(''); });
  it('ticks the steps that have happened and offers to do the next ones', () => {
    const steps = guideSteps({ root: 'C:/code/app', running: false, turned: false, checked: false, phoneSeen: false });
    expect(steps.map((step) => step.done)).toEqual([true, false, false, false, false]);
    expect(steps[0].action).toBeNull(); expect(steps[1].action?.label).toBe('Add Claude Code');
    expect(steps[1].text).toContain('Claude Code, Codex or Gemini');
    expect(guideSteps({ root: 'x', running: true, turned: true, checked: true, phoneSeen: true }).every((step) => step.done)).toBe(true);
  });
});
