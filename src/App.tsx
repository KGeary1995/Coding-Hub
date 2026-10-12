import { APP_VERSION } from './version';
import { useState } from 'react';
import { CircleHelp, TerminalSquare, Folder, ShieldCheck } from 'lucide-react';
import { useAccessibility } from './components/AccessibilityControls';
import { Navigation } from './components/Navigation';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { SessionGrid } from './components/SessionGrid';
import { FeaturePanel } from './components/FeaturePanel';
import { useWorkspaceStore, type NavigationView } from './state/workspace-store';
import { useNativeHost } from './runtime/use-native-host';
import { CommandMenu } from './components/CommandMenu';
import { SessionHistory } from './components/SessionHistory';
import { RepositoryPanel } from './components/RepositoryPanel';
import { WorkspaceExplorer } from './components/WorkspaceExplorer';

const titles: Record<NavigationView, string> = {
  workflow: 'Workflow center', workspace: 'Workspace', design: 'Design workspace', coaching: 'AI coaching', tasks: 'Task coordination', verification: 'Verification profiles', projects: 'Projects', accounts: 'Accounts & connections',
  history: 'Session history', files: 'Files', diff: 'Changes', usage: 'Usage',
  connectors: 'MCP servers', skills: 'Skills & plugins', memory: 'Shared memory',
  rules: 'Shared rules', help: 'Help & AI guide', settings: 'Settings',
};

export function App() {
  useAccessibility();
  useNativeHost();
  const [explorer, setExplorer] = useState(false);
  const { activeView, setView, rootDirectory, sessions, persistenceReady, persistenceStatus, persistenceError, logError } = useWorkspaceStore();
  return (
    <div className="app-shell" data-view={activeView}>
      <Navigation />
      <a className="skip-link" href="#main-content">Skip to workspace content</a>
      <main id="main-content" tabIndex={-1} className="main-shell">
        <header className="workspace-topbar">
          <span className="breadcrumb"><Folder size={14} /><span className="breadcrumb-project" title={rootDirectory ?? undefined}>{rootDirectory ? rootDirectory.split(/[\\/]/).filter(Boolean).at(-1) : 'Local workspace'}</span><span>/</span><strong>{titles[activeView]}</strong></span>
          <CommandMenu />
          <button className="icon-button topbar-help" aria-label="Open help" title="Help & AI guide" onClick={() => setView('help')}><CircleHelp size={17} /></button>
          <span className="privacy-badge" title="Project data is stored locally. CLI requests use the selected provider."><ShieldCheck size={13} />Local storage</span>
          <span className="version">v{APP_VERSION}</span>
        </header>
        {(persistenceError || logError) && <div className="persistence-alert" role="alert">{persistenceError || logError}</div>}
        {!persistenceReady ? <div className="history-empty">Restoring local workspace…</div>
          : activeView === 'workspace' ? (
            <section className="workspace-page">
              <WorkspaceHeader explorer={explorer} onToggleExplorer={() => setExplorer(!explorer)} />
              <div className="workspace-canvas">
                {explorer && <WorkspaceExplorer onClose={() => setExplorer(false)} />}
                <SessionGrid />
              </div>
              <div className="workspace-tip"><CircleHelp size={14} /><span>Click a terminal to interact. Ctrl+C interrupts an operation. Stop ends the CLI process.</span></div>
            </section>
          ) : activeView === 'history' ? <SessionHistory />
            : activeView === 'files' || activeView === 'diff' ? <RepositoryPanel mode={activeView} />
              : <FeaturePanel />}
        <footer className="app-statusbar">
          <span><i className={`host-indicator ${window.codingHub ? 'online' : ''}`} /><TerminalSquare size={13} />{window.codingHub ? 'Desktop host connected' : 'Browser preview · desktop host required'}<span className="statusbar-divider" />{sessions.filter((session) => session.status === 'running').length} running</span>
          <span className={`storage-status ${persistenceStatus}`} data-testid="persistence-status">
            {persistenceStatus === 'saved' ? 'Workspace saved locally' : persistenceStatus === 'saving' ? 'Saving workspace…' : persistenceStatus === 'error' ? 'Storage needs attention' : persistenceStatus === 'loading' ? 'Loading workspace…' : 'Browser preview'}
          </span>
        </footer>
      </main>
    </div>
  );
}
