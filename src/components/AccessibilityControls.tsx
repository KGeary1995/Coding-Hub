import { useEffect, useState } from 'react';
import { CircleAlert, Keyboard } from 'lucide-react';
import { jumpToChannel } from './shell/StatusBar';
import { channelsOf, useWorkspaceStore } from '../state/workspace-store';
import { CHANNEL_KEYS, channelKey } from './channel-key';
interface DisplaySettings { scale: number; density: 'comfortable' | 'compact'; contrast: boolean }
const defaults: DisplaySettings = { scale: 100, density: 'comfortable', contrast: false };
function load(): DisplaySettings { try { const value = JSON.parse(localStorage.getItem('coding-hub-display') ?? 'null'); return value && [80, 90, 100, 110, 125].includes(value.scale) && ['comfortable', 'compact'].includes(value.density) && typeof value.contrast === 'boolean' ? value : defaults; } catch { return defaults; } }
function apply(value: DisplaySettings) { document.documentElement.style.zoom = String(value.scale / 100); document.documentElement.style.setProperty('--display-scale', String(value.scale / 100)); document.documentElement.dataset.density = value.density; document.documentElement.dataset.contrast = value.contrast ? 'high' : 'normal'; }
export function useAccessibility() {
  useEffect(() => {
    apply(load());
    const handler = (event: KeyboardEvent) => {
      const channel = channelKey(event);
      if (channel !== null) {
        const state = useWorkspaceStore.getState(); const session = channelsOf(state.sessions)[channel];
        if (session) {
          // As Answer on a notice does (its key hint is this shortcut): the workspace, the channel isolated if another is, its grid scrolled to the tile.
          event.preventDefault(); event.stopPropagation(); jumpToChannel(session.id);
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); useWorkspaceStore.getState().setView('search'); }
      if (event.key === 'F1') { event.preventDefault(); event.stopPropagation(); useWorkspaceStore.getState().setView('help'); }
    };
    window.addEventListener('keydown', handler, true); return () => window.removeEventListener('keydown', handler, true);
  }, []);
}
export function AccessibilityControls() {
  const [value, setValue] = useState(load); const [error, setError] = useState('');
  function update(next: DisplaySettings) { setValue(next); apply(next); try { localStorage.setItem('coding-hub-display', JSON.stringify(next)); setError(''); } catch { setError('Display settings apply now but could not be saved.'); } }
  return <article className="storage-card ui-card settings-card"><div className="ui-card-head"><Keyboard aria-hidden="true" /><h3>Display and keyboard</h3><button type="button" className="ui-help" aria-label="Help: display on a small window" title="On small windows, lower the scale or use compact density." /></div>
    <div className="settings-fields"><label className="ui-field">Interface scale<select aria-label="Interface scale" value={value.scale} onChange={(e) => update({ ...value, scale: Number(e.target.value) })}>{[80, 90, 100, 110, 125].map((scale) => <option key={scale} value={scale}>{scale}%</option>)}</select></label><label className="ui-field">Information density<select aria-label="Information density" value={value.density} onChange={(e) => update({ ...value, density: e.target.value as DisplaySettings['density'] })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label className="ui-check"><input type="checkbox" checked={value.contrast} onChange={(e) => update({ ...value, contrast: e.target.checked })} />Higher contrast</label></div>
    <p className="ui-hint">These apply at once and stay in this Electron profile. Terminal font size is below.</p>{error && <p role="alert" className="ui-banner danger"><CircleAlert aria-hidden="true" /><span>{error}</span></p>}
    <dl className="settings-facts settings-keys" aria-label="Keyboard shortcuts"><dt><kbd>{CHANNEL_KEYS}</kbd></dt><dd>Focuses a channel</dd><dt><kbd>F1</kbd></dt><dd>Opens help</dd><dt><kbd>Ctrl/Cmd+Shift+F</kbd></dt><dd>Searches local context</dd><dt><kbd>Ctrl/Cmd+Shift+P</kbd></dt><dd>Opens commands</dd><dt><kbd>Tab</kbd></dt><dd>Follows keyboard focus; inside a terminal it passes to the CLI</dd></dl></article>;
}
