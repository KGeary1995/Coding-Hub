import { APP_VERSION } from '../version';
import { useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, ListTodo, CheckCheck, GraduationCap, PanelsTopLeft, FolderOpen, CircleUserRound, Braces, Cable, Files, GitCompareArrows, LayoutDashboard, Settings2, Sparkles, ChartNoAxesCombined, History, BookOpen, ShieldCheck, CircleHelp } from 'lucide-react';
import { useWorkspaceStore, type NavigationView } from '../state/workspace-store';

const navigation = [
  { id: 'workspace', label: 'Workspace', icon: LayoutDashboard },
  { id: 'design', label: 'Design workspace', icon: PanelsTopLeft },
  { id: 'projects', label: 'Projects', icon: FolderOpen },
  { id: 'accounts', label: 'Accounts & connections', icon: CircleUserRound },
  { id: 'history', label: 'Session history', icon: History },
  { id: 'files', label: 'Files', icon: Files },
  { id: 'diff', label: 'Changes', icon: GitCompareArrows },
  { id: 'tasks', label: 'Task coordination', icon: ListTodo },
  { id: 'verification', label: 'Verification profiles', icon: CheckCheck },
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
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('coding-hub-navigation-collapsed') === 'true'; } catch { return false; } });
  function toggle() { const next = !collapsed; setCollapsed(next); try { localStorage.setItem('coding-hub-navigation-collapsed', String(next)); } catch { /* The layout still changes in this window. */ } }
  const running = sessions.filter((session) => session.status === 'running').length;
  return (
    <aside className={`navigation ${collapsed ? 'navigation-collapsed' : ''}`} aria-label="Workspace navigation">
      <div className="brand-row">
      <a className="brand" href="#workspace" onClick={() => setView('workspace')} aria-label="AI Coding Hub home">
        <span className="brand-mark"><Braces size={22} strokeWidth={2.4} /></span>
        <span className="brand-name">Coding Hub<small>AI DEVELOPMENT ENVIRONMENT</small></span>
      </a>
      <button className="icon-button navigation-toggle" aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} title={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!collapsed} onClick={toggle}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      </div>
      <div className="sidebar-workspace" title={`${sessions.length} sessions · ${running} running`}><span className="workspace-avatar">W</span><div><strong>Local workspace</strong><small><i className={running ? 'online' : ''} />{running ? `${running} active ${running === 1 ? 'session' : 'sessions'}` : 'No active processes'}</small></div></div>
      <nav aria-label="Main navigation">
        {[
          { label: 'WORKBENCH', ids: ['workspace', 'design', 'projects', 'accounts'] },
          { label: 'REVIEW & INSIGHTS', ids: ['files', 'diff', 'history', 'usage', 'coaching', 'tasks', 'verification'] },
          { label: 'AGENT CONFIGURATION', ids: ['connectors', 'skills', 'memory', 'rules'] },
          { label: 'RESOURCES', ids: ['help'] },
        ].map((group) => <div className="nav-group" key={group.label}>
          <div className="nav-section-label">{group.label}</div>
          {group.ids.map((id) => {
            const item = navigation.find((entry) => entry.id === id)!;
            const Icon = item.icon;
            return <button key={id} aria-label={item.label} title={collapsed ? item.label : undefined} className={`nav-item ${activeView === id ? 'active' : ''}`} onClick={() => setView(item.id)} aria-current={activeView === id ? 'page' : undefined}>
              <Icon size={16} /><span>{item.label}</span>{id === 'workspace' && <span className="nav-count">{sessions.length}</span>}
            </button>;
          })}
        </div>)}
      </nav>
      <button aria-label="Settings" title={collapsed ? 'Settings' : undefined} className={`nav-item settings-item ${activeView === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><Settings2 size={16} /><span>Settings</span></button>
      <div className="sidebar-footer"><span className="avatar">CH</span><span>AI Coding Hub<small>Desktop workspace · v{APP_VERSION}</small></span></div>
    </aside>
  );
}
