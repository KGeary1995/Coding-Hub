import { useState } from 'react';
import { useAccessibility } from './components/AccessibilityControls';
import { EmptyWorkspace, useProjectSetup } from './components/workspace/EmptyWorkspace';
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
import { Toasts } from './components/shell/Toasts';

/** Channels, or the empty screen until a project is chosen. Mounted per visit, so setup state is re-read each time. */
function WorkspaceView({ explorer, onCloseExplorer }: { explorer: boolean; onCloseExplorer: () => void }) {
  const { needsProject, skip } = useProjectSetup();
  if (needsProject) return <EmptyWorkspace onSkip={skip} />;
  return <section className="workspace-page">
    <div className="workspace-canvas">
      {explorer && <WorkspaceExplorer onClose={onCloseExplorer} />}
      <SessionGrid />
    </div>
  </section>;
}

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
          : activeView === 'workspace' ? <WorkspaceView explorer={explorer} onCloseExplorer={() => setExplorer(false)} />
          : activeView === 'history' ? <SessionHistory />
            : activeView === 'files' || activeView === 'diff' ? <RepositoryPanel mode={activeView} />
              : <FeaturePanel />}
      </main>
      <StatusBar />
      <Toasts />
    </div>
  );
}
