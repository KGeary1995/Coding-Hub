import { useEffect, useState, type ReactNode } from 'react';
import type { AccountConnection } from '../../../shared/accounts';
import { useWorkspaceStore, type NavigationView } from '../../state/workspace-store';
import { useHubStore } from '../../state/hub-store';
import { SETUP_VIEWS } from '../shell/Topbar';

/** A status badge for the areas whose state the app already knows; the others show only their name (docs/design/midnight, section 6). */
function useSetupStatus() {
  const [accounts, setAccounts] = useState<AccountConnection[] | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const automaticMemory = useHubStore((state) => state.preferences.automaticMemory !== false);
  const onAccounts = useWorkspaceStore((state) => state.activeView === 'accounts');
  // Status checks run the CLIs, so read them on opening and again on leaving Accounts, where sign-ins change.
  useEffect(() => {
    let live = true;
    void window.codingHub?.accounts({ action: 'status' }).then((result) => { if (live && result.ok) setAccounts(result.value as AccountConnection[]); }).catch(() => {});
    return () => { live = false; };
  }, [onAccounts]);
  useEffect(() => { void window.codingHub?.updates({ action: 'status' }).then((result) => { if (result.ok) setVersion(result.value.version); }).catch(() => {}); }, []);
  const connected = accounts?.filter((item) => item.state === 'authenticated').length ?? 0;
  const status: Partial<Record<NavigationView, { text: string; tone: 'success' | 'warning' | 'neutral' }>> = {
    // GitHub is optional (project cloning only): it alone not being signed in is no warning.
    accounts: accounts ? { text: `${connected} of ${accounts.length} connected`, tone: accounts.every((item) => item.provider === 'github' || item.state === 'authenticated') ? 'success' : 'warning' } : { text: 'Checking', tone: 'neutral' },
    memory: automaticMemory ? { text: 'On for every project', tone: 'success' } : { text: 'Off', tone: 'neutral' },
  };
  return { status, version };
}

/** Agent setup: one place for accounts, memory, rules, MCP servers, skills and settings (docs/design/midnight, section 6). */
export function AgentSetup({ children }: { children: ReactNode }) {
  const { activeView, setView, storageInfo } = useWorkspaceStore();
  const { status, version } = useSetupStatus();
  const dataPath = storageInfo?.databasePath.replace(/[\\/][^\\/]+$/, '');
  return <div className="tr-setup">
    <nav className="tr-setup-nav" aria-label="Agent setup">
      <h2>Agent setup</h2>
      <ul className="ui-list">{SETUP_VIEWS.map(({ view, label, icon: Icon }) => { const line = status[view]; return <li key={view}>
        <button className={`ui-row ${activeView === view ? 'active' : ''}`} aria-current={activeView === view ? 'page' : undefined} onClick={() => setView(view)}>
          <Icon className="tr-setup-icon" size={16} aria-hidden="true" />
          <span className="ui-row-main"><strong className="tr-setup-name">{label}</strong>{line && <span className={`ui-badge dot tr-setup-status ${line.tone}`}>{line.text}</span>}</span>
        </button>
      </li>; })}</ul>
      <footer>{version && <span>Trace {version} · Electron {navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] ?? '—'}</span>}{dataPath && <code title={dataPath}>{dataPath}</code>}</footer>
    </nav>
    <div className="tr-setup-content">{children}</div>
  </div>;
}
