import { useAccessibility } from './components/AccessibilityControls';
import { CircleHelp, TerminalSquare, PanelLeft } from 'lucide-react';
import { useState } from 'react';
import { Navigation } from './components/Navigation';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { SessionGrid } from './components/SessionGrid';
import { FeaturePanel } from './components/FeaturePanel';
import { useWorkspaceStore } from './state/workspace-store';
import { useNativeHost } from './runtime/use-native-host';
import { CommandMenu } from './components/CommandMenu';
import { SessionHistory } from './components/SessionHistory';
import { RepositoryPanel } from './components/RepositoryPanel';
import { WorkspaceExplorer } from './components/WorkspaceExplorer';

export function App() {
  useAccessibility();
  useNativeHost();
  const [explorer, setExplorer] = useState(false);
  const activeView = useWorkspaceStore((state) => state.activeView);
  const { persistenceReady, persistenceStatus, persistenceError, logError } = useWorkspaceStore();
  return <div className="app-shell"><Navigation /><a className="skip-link" href="#main-content">Skip to workspace content</a><main id="main-content" tabIndex={-1} className="main-shell"><header className="workspace-topbar"><span className="breadcrumb">Personal <span>/</span> <strong className="view-label">{activeView}</strong></span><CommandMenu /><button className="icon-button topbar-help" aria-label="Open help" title="Help & AI guide" onClick={() => useWorkspaceStore.getState().setView('help')}><CircleHelp size={17} /></button><span className="privacy-badge"><i /> Local workspace</span><span className="version">v1.2.1</span></header>{(persistenceError || logError) && <div className="persistence-alert" role="alert">{persistenceError || logError}</div>}{!persistenceReady ? <div className="history-empty">Restoring local workspace…</div> : activeView === 'workspace' ? <><WorkspaceHeader /><button className="button secondary explorer-toggle" aria-expanded={explorer} onClick={() => setExplorer(!explorer)}><PanelLeft size={14} />{explorer ? 'Hide explorer' : 'Show explorer'}</button><div className="workspace-canvas">{explorer && <WorkspaceExplorer onClose={() => setExplorer(false)} />}<SessionGrid /></div><div className="workspace-tip"><CircleHelp size={14} /><span>Click a terminal to interact. Ctrl+C interrupts an operation. Stop ends the CLI process.</span></div></> : activeView === 'history' ? <SessionHistory /> : activeView === 'files' || activeView === 'diff' ? <RepositoryPanel mode={activeView} /> : <FeaturePanel />}<footer className="app-statusbar"><span><TerminalSquare size={13} />{window.codingHub ? 'Native host connected · local PTY sessions' : 'Browser preview · desktop host required'}</span><span className={`storage-status ${persistenceStatus}`} data-testid="persistence-status">{persistenceStatus === 'saved' ? 'Workspace saved locally' : persistenceStatus === 'saving' ? 'Saving workspace…' : persistenceStatus === 'error' ? 'Storage needs attention' : persistenceStatus === 'loading' ? 'Loading workspace…' : 'Browser preview'}</span></footer></main></div>;
}
