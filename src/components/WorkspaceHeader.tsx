import { useEffect, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { useWorkspaceStore } from '../state/workspace-store';
import { openProjectFolder } from './shell/Topbar';

/** First-run guide above the channels. Project, layout and status controls live in the top and status bars. */
export function WorkspaceHeader() {
  const { rootDirectory, sessions } = useWorkspaceStore();
  const [setupDismissed, setSetupDismissed] = useState(() => { try { return localStorage.getItem('coding-hub-setup-complete') === 'true'; } catch { return false; } });
  const [error, setError] = useState('');
  const hasProject = Boolean(rootDirectory || sessions.some((session) => session.binding.mode === 'independent' && /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(session.binding.cwd)));
  const dismissSetup = () => { setSetupDismissed(true); try { localStorage.setItem('coding-hub-setup-complete', 'true'); } catch { /* The current window still dismisses the guide. */ } };
  useEffect(() => { if (hasProject && !setupDismissed) dismissSetup(); }, [hasProject, setupDismissed]);
  const browse = () => { setError(''); openProjectFolder().catch(() => setError('The directory picker could not open. Try again.')); };
  return <>
    {!hasProject && !setupDismissed && <div className="workspace-setup"><button className="icon-button setup-dismiss" aria-label="Dismiss workspace setup" title="Dismiss setup guide" onClick={dismissSetup}><X size={15} /></button><div className="setup-introduction"><strong>Set up your workspace</strong><p>Connect your local CLI accounts and choose where your agents will work.</p></div><div className="hub-toolbar"><button className="button primary" onClick={() => useWorkspaceStore.getState().setView('accounts')}>1. Connect accounts<ArrowUpRight size={13} /></button><button className="button secondary" onClick={() => useWorkspaceStore.getState().setView('projects')}>2. Choose or clone a project<ArrowUpRight size={13} /></button><button className="quiet-button" onClick={browse}>Browse local folder</button></div></div>}
    {error && <p role="alert" className="error-message">{error}</p>}
  </>;
}
