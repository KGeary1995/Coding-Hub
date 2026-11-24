import { useLayoutEffect, useRef } from 'react';
import { AppWindow, ExternalLink, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { previewLabel } from '../../shared/app-preview';
import { placePreview, previewAction, usePreviewStore } from '../state/preview-store';

/**
 * The app preview beside the channels (1.39.0). Trace draws the app's page itself, over the room this panel keeps
 * (`.app-preview-page`), so this only says where that room is; while the app loads or has stopped, the page is hidden and
 * the words under it show.
 */
export function AppPreviewPanel() {
  const shown = usePreviewStore((state) => state.shown); const error = usePreviewStore((state) => state.error);
  const room = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = room.current; if (!element || !shown) return;
    // Sent only when it moved: a notice above the channels moves the room without resizing it, so it is also looked at twice a second.
    let last = ''; const measure = () => { const box = element.getBoundingClientRect(); const bounds = { x: Math.max(0, box.left), y: Math.max(0, box.top), width: Math.max(0, box.width), height: Math.max(0, box.height) }; const key = JSON.stringify(bounds); if (key !== last) { last = key; placePreview(bounds); } };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); const timer = setInterval(measure, 500);
    // Leaving the channels (another page of Trace in front) hides the page; the preview stays open for coming back.
    return () => { observer.disconnect(); clearInterval(timer); placePreview(null); };
  }, [shown?.sessionId, shown?.port, Boolean(shown)]);
  // An app that could not be opened says why, until closed.
  if (!shown) return error ? <aside className="app-preview ui-card" aria-label="App preview"><header className="ui-card-head"><AppWindow size={16} /><h2>App preview</h2><div className="ui-card-actions"><button className="icon-button" aria-label="Close the app preview" onClick={() => usePreviewStore.setState({ error: null })}><X size={14} /></button></div></header><p className="app-preview-error error-message" role="alert">{error}</p></aside> : null;
  const label = previewLabel(shown.url);
  return <aside className="app-preview ui-card" aria-label="App preview">
    <header className="ui-card-head"><AppWindow size={16} /><h2 title={shown.url}>{label}</h2>
      <div className="ui-card-actions">
        <button className="icon-button" title="Reload the app" aria-label="Reload the app" onClick={() => void previewAction('preview-reload')}><RefreshCw size={14} /></button>
        <button className="icon-button" title="Open in your browser" aria-label="Open the app in your browser" onClick={() => void previewAction('preview-browser')}><ExternalLink size={14} /></button>
        <button className="icon-button" title="Close the preview" aria-label="Close the app preview" onClick={() => void previewAction('preview-close')}><X size={14} /></button>
      </div></header>
    <div ref={room} className="app-preview-page" data-status={shown.status}>
      {shown.status === 'loading' && <p className="app-preview-note" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />Opening the app at {label}…</p>}
      {shown.status === 'stopped' && <div className="app-preview-note" role="status"><p>The app stopped.</p><p className="control-note">Start it again in its channel, then reload.</p><button className="button secondary" onClick={() => void previewAction('preview-reload')}><RefreshCw size={14} />Reload</button></div>}
    </div>
    {error && <p className="app-preview-error error-message" role="alert">{error}</p>}
  </aside>;
}
