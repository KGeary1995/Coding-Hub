import { GraduationCap, PanelsTopLeft, FolderOpen, CircleUserRound, Braces, Cable, Files, GitCompareArrows, LayoutDashboard, Settings2, Sparkles, ChartNoAxesCombined, History, BookOpen, ShieldCheck, CircleHelp } from 'lucide-react';
import { useWorkspaceStore, type NavigationView } from '../state/workspace-store';

const navigation = [
  { id: 'workspace', label: 'Workspace', icon: LayoutDashboard },
  { id: 'design', label: 'Design workspace', icon: PanelsTopLeft },
  { id: 'projects', label: 'Projects', icon: FolderOpen },
  { id: 'accounts', label: 'Accounts & connections', icon: CircleUserRound },
  { id: 'history', label: 'Session history', icon: History },
  { id: 'files', label: 'Files', icon: Files },
  { id: 'diff', label: 'Changes', icon: GitCompareArrows },
  { id: 'coaching', label: 'AI coaching', icon: GraduationCap },
  { id: 'usage', label: 'Usage', icon: ChartNoAxesCombined },
  { id: 'connectors', label: 'MCP servers', icon: Cable },
  { id: 'skills', label: 'Skills & plugins', icon: Sparkles },
  { id: 'memory', label: 'Shared memory', icon: BookOpen },
  { id: 'rules', label: 'Shared rules', icon: ShieldCheck },
  { id: 'help', label: 'Help & AI guide', icon: CircleHelp },
] satisfies { id: NavigationView; label: string; icon: typeof Files }[];

export function Navigation() {
  const { activeView, setView, sessions } = useWorkspaceStore();
  return (
    <aside className="navigation">
      <a className="brand" href="#workspace" onClick={() => setView('workspace')} aria-label="AI Coding Hub home">
        <span className="brand-mark"><Braces size={22} strokeWidth={2.4} /></span>
        <span>Coding Hub<small>LOCAL AI WORKSPACE</small></span>
      </a>
      <nav aria-label="Main navigation">
        {[
          { label: 'WORKBENCH', ids: ['workspace', 'design', 'projects', 'accounts'] },
          { label: 'REVIEW & INSIGHTS', ids: ['files', 'diff', 'history', 'usage', 'coaching'] },
          { label: 'AGENT CONFIGURATION', ids: ['connectors', 'skills', 'memory', 'rules'] },
          { label: 'RESOURCES', ids: ['help'] },
        ].map((group) => <div className="nav-group" key={group.label}>
          <div className="nav-section-label">{group.label}</div>
          {group.ids.map((id) => {
            const item = navigation.find((entry) => entry.id === id)!;
            const Icon = item.icon;
            return <button key={id} aria-label={item.label} className={`nav-item ${activeView === id ? 'active' : ''}`} onClick={() => setView(item.id)} aria-current={activeView === id ? 'page' : undefined}>
              <Icon size={16} /><span>{item.label}</span>{id === 'workspace' && <span className="nav-count">{sessions.length}</span>}
            </button>;
          })}
        </div>)}
      </nav>
      <button className={`nav-item settings-item ${activeView === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><Settings2 size={18} />Settings</button>
      <div className="sidebar-footer"><span className="avatar">CH</span><span>Personal workspace<small>Local desktop · v1.5.0</small></span></div>
    </aside>
  );
}
