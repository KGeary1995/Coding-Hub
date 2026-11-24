import type { NavigationView } from './workspace-store';
import { useHubStore } from './hub-store';

/**
 * Simple mode (1.38.0, on unless Settings → Show advanced tools): the views and settings a new user does not need are
 * left out of the menus, the command menu and Settings. Nothing is removed: they come back with the switch.
 */
export const ADVANCED_VIEWS: readonly NavigationView[] = ['coaching', 'verification', 'memory', 'rules', 'connectors'];
export const useAdvanced = () => useHubStore((state) => state.preferences.advancedTools === true);
export const shownViews = <T extends { view: NavigationView }>(views: T[], advanced: boolean) => advanced ? views : views.filter((item) => !ADVANCED_VIEWS.includes(item.view));
