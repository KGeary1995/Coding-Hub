import { ArrowLeft, GraduationCap, LayoutGrid, ListChecks, Wrench, type LucideIcon } from 'lucide-react';
import { useWorkspaceStore, type NavigationView } from '../../state/workspace-store';
import { MORE_TOOLS } from '../shell/Topbar';

/** Each tool's mark on its card; the same as the tool's own page heading. */
const TOOL_ICONS: Partial<Record<NavigationView, LucideIcon>> = { coaching: GraduationCap, verification: ListChecks };

/** Tools kept out of the menus because they are rarely used. Each works as before, one click from here. */
export function MoreTools() {
  const setView = useWorkspaceStore((state) => state.setView);
  return <section className="feature-panel hub-panel workbench-page more-tools">
    <header className="ui-page-head"><span className="ui-page-icon"><LayoutGrid aria-hidden="true" /></span><div><h1>More tools</h1><p>Occasional tools, kept out of the menus. What you saved in them is still here.</p></div></header>
    <div className="more-tools-list">{MORE_TOOLS.map(({ view, label, detail }) => { const Icon = TOOL_ICONS[view] ?? Wrench; return <article key={view} className="ui-card">
      <span className="ui-avatar large accent" aria-hidden="true"><Icon /></span>
      <h2>{label}</h2><p>{detail}</p>
      <button className="button secondary" onClick={() => setView(view)}>Open {label}</button>
    </article>; })}</div>
  </section>;
}

/** A way back to More tools from one of its tools. */
export function MoreToolsBack() {
  return <button className="quiet-button more-tools-back" onClick={() => useWorkspaceStore.getState().setView('tools')}><ArrowLeft size={16} aria-hidden="true" />More tools</button>;
}
