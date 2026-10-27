import { useEffect } from 'react';
import { useWorkspaceStore, type NavigationView } from '../state/workspace-store';

/** `G` then a letter opens a view. Alt+1…8 (focus a channel) is handled in AccessibilityControls. */
export const VIEW_KEYS: Record<string, NavigationView> = {
  w: 'workspace', c: 'diff', p: 'projects', u: 'usage', h: 'history', f: 'files', t: 'tasks', v: 'verification', d: 'design', o: 'coaching', l: 'tools',
  a: 'accounts', m: 'memory', r: 'rules', s: 'settings',
};

export function useViewShortcuts() {
  useEffect(() => {
    let armedAt = 0;
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      // Never steal keys typed into fields or a terminal.
      // An open native <dialog> (the image viewer) has no role attribute and may leave focus on the page itself.
      if ((event.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], .xterm, [role="menu"], [role="dialog"], dialog') || document.querySelector('dialog[open]')) { armedAt = 0; return; }
      const key = event.key.toLowerCase();
      if (armedAt && Date.now() - armedAt < 1500 && VIEW_KEYS[key]) { event.preventDefault(); armedAt = 0; useWorkspaceStore.getState().setView(VIEW_KEYS[key]); return; }
      armedAt = key === 'g' && !event.shiftKey ? Date.now() : 0;
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
