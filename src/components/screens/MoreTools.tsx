import { ArrowLeft } from 'lucide-react';
import { useWorkspaceStore } from '../../state/workspace-store';
import { MORE_TOOLS } from '../shell/Topbar';

/** Tools kept out of the menus because they are rarely used. Each works as before, one click from here. */
export function MoreTools() {
  const setView = useWorkspaceStore((state) => state.setView);
  return <section className="feature-panel hub-panel more-tools">
    <h1>More tools</h1>
    <p>Occasional tools, kept out of the menus. Nothing in them changed, and what you saved in them is still here.</p>
    <div className="more-tools-list">{MORE_TOOLS.map(({ view, label, detail }) => <article key={view} className="storage-card">
      <h2>{label}</h2><p>{detail}</p>
      <button className="button secondary" onClick={() => setView(view)}>Open {label}</button>
    </article>)}</div>
  </section>;
}

/** A way back to More tools from one of its tools. */
export function MoreToolsBack() {
  return <button className="quiet-button more-tools-back" onClick={() => useWorkspaceStore.getState().setView('tools')}><ArrowLeft size={13} aria-hidden="true" />More tools</button>;
}
