import { describe, expect, it } from 'vitest';
import { ADVANCED_VIEWS, shownViews } from './simple-mode';
import { INSIGHT_VIEWS, SETUP_VIEWS } from '../components/shell/Topbar';

describe('simple mode', () => {
  it('leaves the advanced views out of the menus until advanced tools are shown', () => {
    expect(shownViews(INSIGHT_VIEWS, false).map((item) => item.label)).toEqual(['Usage', 'Session history', 'Files', 'Search']);
    expect(shownViews(SETUP_VIEWS, false).map((item) => item.label)).toEqual(['Accounts & connections', 'Skills & plugins', 'Settings']);
    expect(shownViews(INSIGHT_VIEWS, true)).toHaveLength(INSIGHT_VIEWS.length);
    expect(ADVANCED_VIEWS).not.toContain('settings');
  });
});
