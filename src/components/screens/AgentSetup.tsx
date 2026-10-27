import { useEffect, useState, type ReactNode } from 'react';
import type { AccountConnection } from '../../../shared/accounts';
import { useWorkspaceStore, type NavigationView } from '../../state/workspace-store';
import { useHubStore } from '../../state/hub-store';
import { SETUP_VIEWS } from '../shell/Topbar';

/** One status line per setup area: live where the app already knows it, otherwise what the area holds. */
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
  const status: Partial<Record<NavigationView, { text: string; tone?: 'ok' | 'warn' }>> = {
    // GitHub is optional (project cloning only): it alone not being signed in is no warning.
    accounts: accounts ? { text: `${connected} of ${accounts.length} connected`, tone: accounts.every((item) => item.provider === 'github' || item.state === 'authenticated') ? 'ok' : 'warn' } : { text: 'checking local CLIs…' },
    memory: { text: automaticMemory ? 'automatic for every project' : 'automatic memory off', tone: automaticMemory ? 'ok' : undefined },
    rules: { text: 'CLAUDE.md + AGENTS.md' },
    connectors: { text: 'claude + codex' },
    skills: { text: 'installed and configured' },
    settings: { text: 'backups, updates, storage' },
    workflow: { text: 'search, recovery, templates' },
  };
  return { status, version };
}

/** Agent setup: one place for accounts, memory, rules, MCP servers, skills and settings (docs/design/trace, sheet 07). */
export function AgentSetup({ children }: { children: ReactNode }) {
  const { activeView, setView, storageInfo } = useWorkspaceStore();
  const { status, version } = useSetupStatus();
  const dataPath = storageInfo?.databasePath.replace(/[\\/][^\\/]+$/, '');
  return <div className="tr-setup">
    <nav className="tr-setup-nav" aria-label="Agent setup">
      <h1>Agent setup</h1>
      <ul>{SETUP_VIEWS.map(({ view, label }) => { const line = status[view]; return <li key={view}>
        <button className={activeView === view ? 'active' : ''} aria-current={activeView === view ? 'page' : undefined} onClick={() => setView(view)}>
          <span className="tr-setup-name">{label}</span>
          {line && <span className={`tr-setup-status ${line.tone ?? ''}`}>{line.text}{line.tone === 'ok' ? ' ✓' : line.tone === 'warn' ? ' ▲' : ''}</span>}
        </button>
      </li>; })}</ul>
      <footer>{version && <span>Trace {version} · Electron {navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] ?? '—'}</span>}{dataPath && <span title={dataPath}>{dataPath}</span>}</footer>
    </nav>
    <div className="tr-setup-content">{children}</div>
  </div>;
}
