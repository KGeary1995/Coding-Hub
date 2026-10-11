import { useEffect, useState } from 'react';
import { focusTerminal } from '../runtime/terminals';
import { useWorkspaceStore } from '../state/workspace-store';
interface DisplaySettings { scale: number; density: 'comfortable' | 'compact'; contrast: boolean }
const defaults: DisplaySettings = { scale: 100, density: 'comfortable', contrast: false };
function load(): DisplaySettings { try { const value = JSON.parse(localStorage.getItem('coding-hub-display') ?? 'null'); return value && [80, 90, 100, 110, 125].includes(value.scale) && ['comfortable', 'compact'].includes(value.density) && typeof value.contrast === 'boolean' ? value : defaults; } catch { return defaults; } }
function apply(value: DisplaySettings) { document.documentElement.style.zoom = String(value.scale / 100); document.documentElement.style.setProperty('--display-scale', String(value.scale / 100)); document.documentElement.dataset.density = value.density; document.documentElement.dataset.contrast = value.contrast ? 'high' : 'normal'; }
export function useAccessibility() {
  useEffect(() => {
    apply(load());
    const handler = (event: KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-4]$/.test(event.key)) {
        const state = useWorkspaceStore.getState(); const session = state.sessions[Number(event.key) - 1];
        if (session) { event.preventDefault(); event.stopPropagation(); state.setView('workspace'); requestAnimationFrame(() => focusTerminal(session.id)); }
      }
      if (event.key === 'F1') { event.preventDefault(); event.stopPropagation(); useWorkspaceStore.getState().setView('help'); }
    };
    window.addEventListener('keydown', handler, true); return () => window.removeEventListener('keydown', handler, true);
  }, []);
}
export function AccessibilityControls() {
  const [value, setValue] = useState(load); const [error, setError] = useState('');
  function update(next: DisplaySettings) { setValue(next); apply(next); try { localStorage.setItem('coding-hub-display', JSON.stringify(next)); setError(''); } catch { setError('Display settings apply now but could not be saved.'); } }
  return <article className="storage-card"><h2>Display and keyboard</h2><div className="hub-toolbar"><label>Interface scale<select aria-label="Interface scale" value={value.scale} onChange={(e) => update({ ...value, scale: Number(e.target.value) })}>{[80, 90, 100, 110, 125].map((scale) => <option key={scale} value={scale}>{scale}%</option>)}</select></label><label>Information density<select aria-label="Information density" value={value.density} onChange={(e) => update({ ...value, density: e.target.value as DisplaySettings['density'] })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label className="update-checkbox"><input type="checkbox" checked={value.contrast} onChange={(e) => update({ ...value, contrast: e.target.checked })} />Higher contrast</label></div><p><kbd>Alt+1–4</kbd> focuses a session. <kbd>F1</kbd> opens help. <kbd>Ctrl/Cmd+Shift+P</kbd> opens commands. <kbd>Tab</kbd> follows keyboard focus; inside a terminal it passes to the CLI.</p><p className="control-note">Display settings stay in this Electron profile. Terminal font size is configured separately below. On small windows, lower scale or use compact density.</p>{error && <p role="alert" className="error-message">{error}</p>}</article>;
}
