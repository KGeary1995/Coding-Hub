import { useState } from 'react';
import { useAccessibility } from './components/AccessibilityControls';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { SessionGrid } from './components/SessionGrid';
import { FeaturePanel } from './components/FeaturePanel';
import { useWorkspaceStore } from './state/workspace-store';
import { useNativeHost } from './runtime/use-native-host';
import { useViewShortcuts } from './runtime/view-shortcuts';
import { SessionHistory } from './components/SessionHistory';
import { RepositoryPanel } from './components/RepositoryPanel';
import { WorkspaceExplorer } from './components/WorkspaceExplorer';
import { Topbar } from './components/shell/Topbar';
import { StatusBar } from './components/shell/StatusBar';

export function App() {
  useAccessibility();
  useNativeHost();
  useViewShortcuts();
  const [explorer, setExplorer] = useState(false);
  const { activeView, persistenceReady, persistenceError, logError } = useWorkspaceStore();
  return (
    <div className="app-shell" data-view={activeView}>
      <a className="skip-link" href="#main-content">Skip to workspace content</a>
      <Topbar explorer={explorer} onToggleExplorer={() => setExplorer(!explorer)} />
      <main id="main-content" tabIndex={-1} className="main-shell">
        {(persistenceError || logError) && <div className="persistence-alert" role="alert">{persistenceError || logError}</div>}
        {!persistenceReady ? <div className="history-empty">Restoring local workspace…</div>
          : activeView === 'workspace' ? (
            <section className="workspace-page">
              <WorkspaceHeader />
              <div className="workspace-canvas">
                {explorer && <WorkspaceExplorer onClose={() => setExplorer(false)} />}
                <SessionGrid />
              </div>
            </section>
          ) : activeView === 'history' ? <SessionHistory />
            : activeView === 'files' || activeView === 'diff' ? <RepositoryPanel mode={activeView} />
              : <FeaturePanel />}
      </main>
      <StatusBar />
    </div>
  );
}
