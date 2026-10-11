import { FolderOpen, CircleUserRound, Blocks, Braces, Cable, Files, GitCompareArrows, LayoutDashboard, Settings2, Sparkles, ChartNoAxesCombined, History, BookOpen, ShieldCheck, CircleHelp } from 'lucide-react';
import { useWorkspaceStore, type NavigationView } from '../state/workspace-store';

const navigation = [
  { id: 'workspace', label: 'Workspace', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', icon: FolderOpen },
  { id: 'accounts', label: 'Accounts & connections', icon: CircleUserRound },
  { id: 'history', label: 'Session history', icon: History },
  { id: 'files', label: 'Files', icon: Files },
  { id: 'diff', label: 'Changes', icon: GitCompareArrows },
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
      <div className="nav-section-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        {navigation.map(({ id, label, icon: Icon }) => (
          <button key={id} aria-label={label} className={`nav-item ${activeView === id ? 'active' : ''}`} onClick={() => setView(id)} aria-current={activeView === id ? 'page' : undefined}>
            <Icon size={18} /><span>{label}</span>{id === 'workspace' && <span className="nav-count">{sessions.length}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-note"><Blocks size={21} /><strong>Your tools. One workspace.</strong><p>Claude Code and Codex, side by side on your machine.</p><span className="local-label"><i /> Local by design</span></div>
      <button className={`nav-item settings-item ${activeView === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><Settings2 size={18} />Settings</button>
      <div className="sidebar-footer"><span className="avatar">CH</span><span>Personal workspace<small>Local desktop · v1.2.1</small></span></div>
    </aside>
  );
}
