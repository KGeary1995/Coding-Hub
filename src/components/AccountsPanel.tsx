import { DiagnosticsPanel } from './DiagnosticsPanel';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TERMINAL_FONT, TERMINAL_THEME } from '../runtime/terminal-theme';
import { CircleUserRound, RefreshCw, ExternalLink, Square, TerminalSquare, Github, UsersRound, KeyRound, BookOpen } from 'lucide-react';
import type { ClaudeAccountProfile, AccountConnection, AccountLogin, AccountProvider, AccountResponse, AccountRequest } from '../../shared/accounts';
import { useAccountStore, refreshClaudeProfiles } from '../state/account-store';
import { refreshEngines } from '../runtime/use-native-host';
import { useWorkspaceStore } from '../state/workspace-store';
import { MAC } from './platform';
import { ENGINE_ICONS } from './tile/engine-icons';
import { HowThisWorks } from './HubPanels';

const names: Record<AccountProvider, string> = { claude: 'Claude Code', codex: 'OpenAI Codex', github: 'GitHub' };
/** Each tool's mark, in its engine's colour, as on a channel tile; GitHub is no engine, so it stays neutral. */
const glyphs: Record<AccountProvider, typeof Github> = { claude: ENGINE_ICONS.claude, codex: ENGINE_ICONS.codex, github: Github };
const tones: Record<AccountProvider, string> = { claude: 'claude', codex: 'codex', github: 'neutral' };
/** The state badge's colour: connected is green, anything left to do is amber, not yet known is neutral. */
const stateTone = (connection: AccountConnection | null | undefined) => !connection ? 'neutral' : connection.state === 'authenticated' ? 'success' : !connection.installed || connection.state === 'not-authenticated' ? 'warning' : 'neutral';
const commands: Record<AccountProvider, string> = { claude: 'claude auth login', codex: 'codex login', github: 'gh auth login --hostname github.com --web --git-protocol https' };
/** npm.cmd on Windows, where PowerShell may refuse npm's script shim; Homebrew for the GitHub CLI on a Mac. */
const installation: Record<AccountProvider, string> = MAC ? { claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex', github: 'brew install gh' } : { claude: 'npm.cmd install -g @anthropic-ai/claude-code', codex: 'npm.cmd install -g @openai/codex', github: 'winget install --id GitHub.cli --exact' };
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
  return <section className="feature-panel hub-panel accounts-panel">
    <header className="ui-page-head"><span className="ui-page-icon"><CircleUserRound aria-hidden="true" /></span><div><h1>Accounts & connections</h1><p>Sign in to the CLIs, and choose a Claude account for each channel.</p></div><div className="ui-page-actions"><button className="button secondary" disabled={busy || !window.codingHub} onClick={() => void refresh()}><RefreshCw size={14} />Refresh account status</button><button className="quiet-button" onClick={() => useWorkspaceStore.getState().setView('workspace')}>Go to workspace</button></div></header>
    {error && <p className="hub-feedback error-message" role="alert">{error}</p>}{notice && <p className="hub-feedback success" role="status">{notice}</p>}
    <article className="ui-card accounts-clis"><div className="ui-card-head"><TerminalSquare aria-hidden="true" /><h2>Command-line tools</h2></div><ul className="ui-list account-cards">{(['claude', 'codex', 'github'] as const).map((provider) => {
      const connection = connections.find((item) => item.provider === provider); const Glyph = glyphs[provider];
      const detail = [connection?.message ?? 'Inspecting the installed CLI.', connection?.version].filter(Boolean).join(' · ');
      // Primary only while signing in is what is left to do: a connected tool's Reconnect is not the card's action.
      const toDo = !!connection?.canLogin && connection.state !== 'authenticated';
      return <li className="ui-row account-card" key={provider}><span className={`ui-avatar ${tones[provider]}`} aria-hidden="true"><Glyph /></span><span className="ui-row-main"><strong>{names[provider]}</strong><small title={detail}>{detail}</small></span><strong className={`ui-badge dot account-state ${connection?.state ?? 'unknown'} ${stateTone(connection)}`}>{!connection ? 'Checking…' : !connection.installed ? 'CLI installation needed' : connection.state === 'authenticated' ? 'Connected through local CLI' : connection.state === 'not-authenticated' ? 'Sign-in needed' : 'Status unverified'}</strong><span className="account-actions"><button className={`button ${toDo ? 'primary' : 'secondary'} small`} disabled={busy || !connection?.canLogin} onClick={() => void connect(provider)}>{connection?.state === 'authenticated' ? 'Reconnect' : 'Connect'} {names[provider]}</button><button className="button secondary small" disabled={!window.codingHub} onClick={() => void call({ action: 'install-guide', provider }).catch((e) => setError(e.message))}><ExternalLink size={14} />Installation guide</button></span><details className="account-details"><summary>CLI details & login command</summary>{connection?.executable && <code className="account-path">{connection.executable}</code>}<code className="account-command">{commands[provider]}</code></details>{!connection?.installed && <div className="account-install"><p>Install the official CLI in {MAC ? 'Terminal' : 'PowerShell'}, then refresh. Restart Trace if the installer changes PATH.</p><code className="account-command">{installation[provider]}</code></div>}</li>;
    })}</ul><p className="ui-hint account-hint">Login status only. Starting a channel and model access are checked separately.</p></article>
    <article className="ui-card claude-profile-manager"><div className="ui-card-head"><UsersRound aria-hidden="true" /><h2>Claude account profiles</h2><span className="ui-count neutral">{profiles.length}</span></div><p className="ui-hint">Several Claude logins on this computer; each channel chooses one in its settings.</p>
    <form className="profile-create" onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}><label className="ui-field">New Claude profile name<input aria-label="New Claude profile name" required maxLength={60} placeholder="Personal, Work, Client…" value={profileName} onChange={(event) => setProfileName(event.target.value)} disabled={busy || profileSaving} /></label><button className="button secondary" type="submit" disabled={busy || profileSaving || !profileName.trim()}>Add Claude profile</button></form>
    <div className="profile-connect"><label className="ui-field">Claude profile to connect<select aria-label="Claude profile to connect" value={selectedProfileId} disabled={busy || profileSaving} onChange={(event) => { const id = event.target.value; selectedProfileRef.current = id; setSelectedProfileId(id); setRenameName(profiles.find((p) => p.id === id)?.name ?? ''); setProfileConnection(null); void refresh(); }}><option value="">Default · existing CLI login</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>{selectedProfileId && <span className="profile-connect-state"><strong className={`ui-badge dot account-state ${profileConnection?.state ?? 'unknown'} ${stateTone(profileConnection)}`}>{!profileConnection ? 'Checking profile…' : profileConnection.state === 'authenticated' ? 'Profile connected through local CLI' : profileConnection.state === 'not-authenticated' ? 'Profile sign-in needed' : 'Profile status unverified'}</strong><button className="button secondary" disabled={busy || profileSaving || !profileConnection?.canLogin} onClick={() => void connect('claude', selectedProfileId)}>{profileConnection?.state === 'authenticated' ? 'Reconnect Claude profile' : 'Connect Claude profile'}</button></span>}</div>
    {selectedProfileId && <form className="profile-create" onSubmit={(event) => { event.preventDefault(); void saveProfile(true); }}><label className="ui-field">Profile display name<input aria-label="Profile display name" required maxLength={60} value={renameName} onChange={(event) => setRenameName(event.target.value)} disabled={busy || profileSaving} /></label><button className="button secondary" type="submit" disabled={busy || profileSaving || !renameName.trim()}>Rename profile</button></form>}
    <p className="ui-hint">Reconnecting requires stopping the channels that use that profile.</p>
    <HowThisWorks><p>Default uses your existing CLI account; each named profile starts with an empty configuration directory. Select an account under Settings → Claude account profile in each Claude channel. Two profiles can run side by side.</p><p>Named profiles clear inherited Claude authentication overrides and keep their own settings, skills, and user MCP configuration. Project instructions remain shared.</p><button type="button" className="button secondary small" onClick={() => useWorkspaceStore.setState({ activeView: 'help', helpTopicId: 'claude-profiles' })}><BookOpen size={14} />Read the profiles guide</button></HowThisWorks>
    </article><article className={`ui-card account-login ${busy || login ? 'login-active' : 'login-idle'}`}><div className="ui-card-head"><TerminalSquare aria-hidden="true" /><h2>{login ? `${names[login.provider]}${login.profileId ? ' · ' + (profiles.find((p) => p.id === login.profileId)?.name ?? 'Profile') : ''} login` : 'Sign-in terminal'}</h2>{(busy || login) && <div className="ui-card-actions"><button className="button secondary small" onClick={() => void cancel()}><Square size={12} />Cancel login</button></div>}</div><p className="ui-hint">Connect runs the CLI’s own sign-in here; it may open your browser or show a URL and code.</p><p className="ui-hint">Login output is temporary and is excluded from saved session logs and Drive memory.</p><div className="account-terminal" ref={container} aria-label="Account login terminal" /></article><DiagnosticsPanel /><div className="ui-banner info account-note"><KeyRound aria-hidden="true" /><span>Credentials are stored and managed by Claude Code, Codex, and GitHub CLI on this computer. Existing CLI logins are detected automatically. A configured login does not verify subscription, billing, model access, or repository permissions. Cancelling a login ends its local process; signing out is managed by the official CLI. GitHub connectivity does not automatically push or publish projects.</span></div></section>;
}
