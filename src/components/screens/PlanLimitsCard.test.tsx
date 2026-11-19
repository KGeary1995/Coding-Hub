import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanLimits } from '../../../shared/plan-limits';
import { PlanLimitsCard } from './PlanLimitsCard';

/** A server render reads a zustand store's initial state, so the card is given its readings through a stand-in. */
const store = vi.hoisted(() => ({ limits: [] as unknown[], loading: false }));
vi.mock('../../state/plan-limits-store', async (original) => ({ ...await original<typeof import('../../state/plan-limits-store')>(), usePlanLimits: () => store }));

const reading = (fields: Partial<PlanLimits>): PlanLimits => ({ engine: 'codex', account: 'Default', windows: [], plan: null, checkedAt: '2026-11-18T12:00:00.000Z', error: null, ...fields });
const shown = (limits: PlanLimits[]) => { store.limits = limits; return renderToStaticMarkup(<PlanLimitsCard />); };

describe('a reading without limits on Usage', () => {
  it('shows a failed check as a failure', () => {
    const html = shown([reading({ error: 'Codex could not be started.', failed: true })]);
    expect(html).toMatch(/<p class="ui-banner danger"><svg[^>]*lucide-circle-alert[^>]*>.*<span>Codex could not be started\.<\/span><\/p>/);
  });
  it('shows a fact about the account as information, and so does an older reading that does not say which it is', () => {
    for (const item of [reading({ error: 'This Codex account has no usage limits to show.', failed: false }), reading({ error: 'This Codex account has no usage limits to show.' })]) {
      const html = shown([item]);
      expect(html).toMatch(/<p class="ui-banner info"><svg[^>]*lucide-info[^>]*>.*<span>This Codex account has no usage limits to show\.<\/span><\/p>/);
      expect(html).not.toContain('ui-banner danger');
    }
  });
});
