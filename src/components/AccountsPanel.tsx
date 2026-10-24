import { DiagnosticsPanel } from './DiagnosticsPanel';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TERMINAL_FONT, TERMINAL_THEME } from '../runtime/terminal-theme';
import { CircleUserRound, RefreshCw, ExternalLink, Square, Check, CircleAlert, TerminalSquare } from 'lucide-react';
import type { ClaudeAccountProfile, AccountConnection, AccountLogin, AccountProvider, AccountResponse, AccountRequest } from '../../shared/accounts';
import { useAccountStore, refreshClaudeProfiles } from '../state/account-store';
import { refreshEngines } from '../runtime/use-native-host';
import { useWorkspaceStore } from '../state/workspace-store';

const names: Record<AccountProvider, string> = { claude: 'Claude Code', codex: 'OpenAI Codex', github: 'GitHub' };
const commands: Record<AccountProvider, string> = { claude: 'claude auth login', codex: 'codex login', github: 'gh auth login --hostname github.com --web --git-protocol https' };
const installation: Record<AccountProvider, string> = { claude: 'npm.cmd install -g @anthropic-ai/claude-code', codex: 'npm.cmd install -g @openai/codex', github: 'winget install --id GitHub.cli --exact' };
export function AccountsPanel() {
  const profiles = useAccountStore((s) => s.profiles);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const selectedProfileRef = useRef('');
  const [profileConnection, setProfileConnection] = useState<AccountConnection | null>(null);
  const [profileName, setProfileName] = useState('');
  const [renameName, setRenameName] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [connections, setConnections] = useState<AccountConnection[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [login, setLogin] = useState<AccountLogin | null>(null);
  const container = useRef<HTMLDivElement>(null); const terminal = useRef<Terminal | null>(null); const fit = useRef<FitAddon | null>(null); const active = useRef<AccountLogin | null>(null); const mounted = useRef(true);
  const inputQueue = useRef(Promise.resolve()); const generation = useRef(0);
  async function call(request: AccountRequest): Promise<AccountResponse> {
    if (!window.codingHub) throw new Error('Account setup requires the Electron desktop app.');
    const result = await window.codingHub.accounts(request); if (!result.ok) throw new Error(result.error.message); return result.value;
  }
  async function refresh() {
    const current = ++generation.current;
    try { const result = await call({ action: 'status' }); const profileId = selectedProfileRef.current; const status = profileId ? await call({ action: 'status', profileId }) as AccountConnection[] : null; await refreshClaudeProfiles(); if (mounted.current && current === generation.current) { setConnections(result as AccountConnection[]); setProfileConnection(status?.find((item) => item.provider === 'claude') ?? null); } }
    catch (e) { if (mounted.current && current === generation.current) setError(e instanceof Error ? e.message : 'Account status is unavailable.'); }
  }
  useEffect(() => {
    mounted.current = true;
    const host = window.codingHub; if (!host || !container.current) return;
    const view = new Terminal({ disableStdin: true, cursorBlink: true, scrollback: 1000, fontSize: 13, fontFamily: TERMINAL_FONT, theme: TERMINAL_THEME });
    const addon = new FitAddon(); view.loadAddon(addon); view.open(container.current); terminal.current = view; fit.current = addon;
    view.writeln('Choose Connect on an installed CLI. Its official sign-in prompts appear here.');
    const resize = () => { try { addon.fit(); } catch { /* Initial mount can be hidden. */ } };
    const observer = new ResizeObserver(resize); observer.observe(container.current); resize();
    const input = view.onData((data) => {
      const run = active.current; if (!run) return;
      inputQueue.current = inputQueue.current.then(async () => {
        if (active.current?.runId !== run.runId) return;
        for (let offset = 0; offset < data.length; offset += 16000) {
          const result = await host.accounts({ action: 'write', runId: run.runId, data: data.slice(offset, offset + 16000) });
          if (!result.ok && mounted.current) { setError(result.error.message); break; }
        }
      }).catch(() => { if (mounted.current) setError('Login terminal input could not be delivered.'); });
    });
    const dimensions = view.onResize(({ cols, rows }) => {
      const run = active.current; if (run) void host.accounts({ action: 'resize', runId: run.runId, cols: Math.min(500, Math.max(2, cols)), rows: Math.min(300, Math.max(1, rows)) }).catch(() => {});
    });
    const unsubscribe = host.onAccountEvent((event) => {
      if (!mounted.current) return;
      if (event.type === 'started') { active.current = { runId: event.runId, provider: event.provider, ...(event.profileId ? { profileId: event.profileId } : {}) }; setLogin(active.current); view.reset(); view.options.disableStdin = false; requestAnimationFrame(() => { if (!mounted.current) return; container.current?.scrollIntoView({ block: 'center', behavior: 'auto' }); try { addon.fit(); } catch { /* ResizeObserver fits when visible. */ } view.focus(); }); }
      if (active.current?.runId !== event.runId) return;
      if (event.type === 'data') view.write(event.data);
      if (event.type === 'exit') { active.current = null; setLogin(null); view.options.disableStdin = true; setBusy(false); setNotice(event.exitCode === 0 ? 'Login command finished. Checking the CLI account status…' : `Login command exited with code ${event.exitCode}. Review its instructions below or reconnect.`); void refresh(); void refreshEngines(); }
    });
    void refresh();
    return () => { mounted.current = false; ++generation.current; unsubscribe(); observer.disconnect(); input.dispose(); dimensions.dispose(); void host.accounts({ action: 'stop' }).catch(() => {}); active.current = null; view.dispose(); terminal.current = null; fit.current = null; };
  }, []);
  async function connect(provider: AccountProvider, profileId?: string) {
    if (busy || active.current) return; setBusy(true); setError(''); setNotice(''); terminal.current?.reset();
    try {
      const result = await call({ action: 'login', provider, ...(profileId ? { profileId } : {}), cols: Math.min(500, Math.max(2, terminal.current?.cols ?? 100)), rows: Math.min(300, Math.max(1, terminal.current?.rows ?? 20)) }) as AccountLogin;
      if (!mounted.current) { await window.codingHub?.accounts({ action: 'stop', runId: result.runId }); return; }
      // Started/exit events can arrive before invoke resolves. Only events set live state.
      terminal.current?.focus();
    } catch (e) { if (mounted.current) { setBusy(false); setError(e instanceof Error ? e.message : 'Login could not start.'); } }
  }
  async function saveProfile(rename = false) {
    if (profileSaving || busy || login) return;
    setProfileSaving(true); setError('');
    try {
      const result = await call(rename ? { action: 'profile-rename', profileId: selectedProfileId, name: renameName } : { action: 'profile-create', name: profileName }) as ClaudeAccountProfile;
      if (!mounted.current) return;
      selectedProfileRef.current = result.id; setSelectedProfileId(result.id); setRenameName(result.name); setProfileName('');
      await refresh();
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Could not save profile.'); }
    finally { if (mounted.current) setProfileSaving(false); }
  }
  async function cancel() { try { await call({ action: 'stop' }); } catch (e) { setError(e instanceof Error ? e.message : 'Login could not be cancelled.'); } finally { setBusy(false); } }
  return <section className="feature-panel hub-panel accounts-panel"><div className="feature-panel-heading"><span className="eyebrow">CONNECT YOUR LOCAL TOOLS</span><h1><CircleUserRound size={28} />Accounts & connections</h1><p>Connect your local CLIs, then assign a Claude account profile to each session.</p></div><div className="hub-toolbar"><button className="button secondary" disabled={busy || !window.codingHub} onClick={() => void refresh()}><RefreshCw size={14} />Refresh account status</button><button className="button secondary" onClick={() => useWorkspaceStore.getState().setView('workspace')}>Go to workspace</button></div>{error && <p className="hub-feedback error-message" role="alert">{error}</p>}{notice && <p className="hub-feedback success" role="status">{notice}</p>}<div className="account-cards">{(['claude', 'codex', 'github'] as const).map((provider) => {
    const connection = connections.find((item) => item.provider === provider);
    return <article className="storage-card account-card" key={provider}><header><h2>{names[provider]}</h2>{connection?.state === 'authenticated' ? <Check size={19} /> : <CircleAlert size={19} />}</header><strong className={`account-state ${connection?.state ?? 'unknown'}`}>{!connection ? 'Checking…' : !connection.installed ? 'CLI installation needed' : connection.state === 'authenticated' ? 'Connected through local CLI' : connection.state === 'not-authenticated' ? 'Sign-in needed' : 'Status unverified'}</strong><small className="muted">Login status only · session launch and model access are checked separately.</small><p>{connection?.message ?? 'Inspecting the installed CLI.'}</p>{connection?.version && <small className="muted">{connection.version}</small>}<div className="hub-toolbar"><button className="button primary" disabled={busy || !connection?.canLogin} onClick={() => void connect(provider)}>{connection?.state === 'authenticated' ? 'Reconnect' : 'Connect'} {names[provider]}</button><button className="button secondary" disabled={!window.codingHub} onClick={() => void call({ action: 'install-guide', provider }).catch((e) => setError(e.message))}><ExternalLink size={14} />Installation guide</button></div><details className="account-details"><summary>CLI details & login command</summary>{connection?.executable && <code className="account-path">{connection.executable}</code>}<code className="account-command">{commands[provider]}</code></details>{!connection?.installed && <><p>Install the official CLI in PowerShell, then refresh. Restart Coding Hub if the installer changes PATH.</p><code className="account-command">{installation[provider]}</code></>}</article>;
  })}</div><article className="storage-card claude-profile-manager"><header><div><h2>Claude account profiles</h2><p>Keep multiple Claude logins on this computer. Default uses your existing CLI account; each named profile starts with an empty configuration directory.</p></div></header>
    <form className="profile-create" onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}><label>New Claude profile name<input aria-label="New Claude profile name" required maxLength={60} placeholder="Personal, Work, Client…" value={profileName} onChange={(event) => setProfileName(event.target.value)} disabled={busy || profileSaving} /></label><button className="button secondary" type="submit" disabled={busy || profileSaving || !profileName.trim()}>Add Claude profile</button></form>
    <div className="profile-connect"><label>Claude profile to connect<select aria-label="Claude profile to connect" value={selectedProfileId} disabled={busy || profileSaving} onChange={(event) => { const id = event.target.value; selectedProfileRef.current = id; setSelectedProfileId(id); setRenameName(profiles.find((p) => p.id === id)?.name ?? ''); setProfileConnection(null); void refresh(); }}><option value="">Default · existing CLI login</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>{selectedProfileId && <><strong className={`account-state ${profileConnection?.state ?? 'unknown'}`}>{!profileConnection ? 'Checking profile…' : profileConnection.state === 'authenticated' ? 'Profile connected through local CLI' : profileConnection.state === 'not-authenticated' ? 'Profile sign-in needed' : 'Profile status unverified'}</strong><button className="button primary" disabled={busy || profileSaving || !profileConnection?.canLogin} onClick={() => void connect('claude', selectedProfileId)}>{profileConnection?.state === 'authenticated' ? 'Reconnect Claude profile' : 'Connect Claude profile'}</button></>}</div>
    {selectedProfileId && <form className="profile-create" onSubmit={(event) => { event.preventDefault(); void saveProfile(true); }}><label>Profile display name<input aria-label="Profile display name" required maxLength={60} value={renameName} onChange={(event) => setRenameName(event.target.value)} disabled={busy || profileSaving} /></label><button className="button secondary" type="submit" disabled={busy || profileSaving || !renameName.trim()}>Rename profile</button></form>}
    <p className="control-note">Select an account under Configure → Claude account profile in each Claude session. Two profiles can run side by side. Reconnecting requires stopping sessions using that profile. Named profiles clear inherited Claude authentication overrides and keep their own settings, skills, and user MCP configuration. Project instructions remain shared.</p>
    </article><article className={`storage-card account-login ${busy || login ? 'login-active' : 'login-idle'}`}><header><h2><TerminalSquare size={16} />{login ? `${names[login.provider]}${login.profileId ? ' · ' + (profiles.find((p) => p.id === login.profileId)?.name ?? 'Profile') : ''} login` : 'Official CLI sign-in terminal'}</h2>{(busy || login) && <button className="button secondary" onClick={() => void cancel()}><Square size={12} />Cancel login</button>}</header><p>The CLI may open your browser or display a sign-in URL and code. Follow its prompts here. Login output is temporary and is excluded from saved session logs and Drive memory.</p><div className="account-terminal" ref={container} aria-label="Account login terminal" /></article><DiagnosticsPanel /><p className="control-note">Credentials are stored and managed by Claude Code, Codex, and GitHub CLI on this computer. Existing CLI logins are detected automatically. A configured login does not verify subscription, billing, model access, or repository permissions. Cancelling a login ends its local process; signing out is managed by the official CLI. GitHub connectivity does not automatically push or publish projects.</p></section>;
}
