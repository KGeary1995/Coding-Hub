import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CircleUserRound, RefreshCw, ExternalLink, Square, Check, CircleAlert, TerminalSquare } from 'lucide-react';
import type { AccountConnection, AccountLogin, AccountProvider, AccountResponse, AccountRequest } from '../../shared/accounts';
import { refreshEngines } from '../runtime/use-native-host';
import { useWorkspaceStore } from '../state/workspace-store';

const names: Record<AccountProvider, string> = { claude: 'Claude Code', codex: 'OpenAI Codex', github: 'GitHub' };
const commands: Record<AccountProvider, string> = { claude: 'claude auth login', codex: 'codex login', github: 'gh auth login --hostname github.com --web --git-protocol https' };
const installation: Record<AccountProvider, string> = { claude: 'npm.cmd install -g @anthropic-ai/claude-code', codex: 'npm.cmd install -g @openai/codex', github: 'winget install --id GitHub.cli --exact' };
export function AccountsPanel() {
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
    try { const result = await call({ action: 'status' }); if (mounted.current && current === generation.current) setConnections(result as AccountConnection[]); }
    catch (e) { if (mounted.current && current === generation.current) setError(e instanceof Error ? e.message : 'Account status is unavailable.'); }
  }
  useEffect(() => {
    mounted.current = true;
    const host = window.codingHub; if (!host || !container.current) return;
    const view = new Terminal({ disableStdin: true, cursorBlink: true, scrollback: 1000, fontSize: 13, fontFamily: 'Consolas, monospace', theme: { background: '#121517', foreground: '#d2ddd4', green: '#b4e88b' } });
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
      if (event.type === 'started') { active.current = { runId: event.runId, provider: event.provider }; setLogin(active.current); view.reset(); view.options.disableStdin = false; view.focus(); }
      if (active.current?.runId !== event.runId) return;
      if (event.type === 'data') view.write(event.data);
      if (event.type === 'exit') { active.current = null; setLogin(null); view.options.disableStdin = true; setBusy(false); setNotice(event.exitCode === 0 ? 'Login command finished. Checking the CLI account status…' : `Login command exited with code ${event.exitCode}. Review its instructions below or reconnect.`); void refresh(); void refreshEngines(); }
    });
    void refresh();
    return () => { mounted.current = false; ++generation.current; unsubscribe(); observer.disconnect(); input.dispose(); dimensions.dispose(); void host.accounts({ action: 'stop' }).catch(() => {}); active.current = null; view.dispose(); terminal.current = null; fit.current = null; };
  }, []);
  async function connect(provider: AccountProvider) {
    if (busy || active.current) return; setBusy(true); setError(''); setNotice(''); terminal.current?.reset();
    try {
      const result = await call({ action: 'login', provider, cols: Math.min(500, Math.max(2, terminal.current?.cols ?? 100)), rows: Math.min(300, Math.max(1, terminal.current?.rows ?? 20)) }) as AccountLogin;
      if (!mounted.current) { await window.codingHub?.accounts({ action: 'stop', runId: result.runId }); return; }
      // Started/exit events can arrive before invoke resolves. Only events set live state.
      terminal.current?.focus();
    } catch (e) { if (mounted.current) { setBusy(false); setError(e instanceof Error ? e.message : 'Login could not start.'); } }
  }
  async function cancel() { try { await call({ action: 'stop' }); } catch (e) { setError(e instanceof Error ? e.message : 'Login could not be cancelled.'); } finally { setBusy(false); } }
  return <section className="feature-panel hub-panel accounts-panel"><div className="feature-panel-heading"><span className="eyebrow">CONNECT YOUR LOCAL TOOLS</span><h1><CircleUserRound size={28} />Accounts & connections</h1><p>Sign in before starting a coding session. No project or shared-rule setup is required here.</p></div><div className="hub-toolbar"><button className="button secondary" disabled={busy || !window.codingHub} onClick={() => void refresh()}><RefreshCw size={14} />Refresh account status</button><button className="button secondary" onClick={() => useWorkspaceStore.getState().setView('workspace')}>Go to workspace</button></div>{error && <p className="hub-feedback error-message" role="alert">{error}</p>}{notice && <p className="hub-feedback success" role="status">{notice}</p>}<div className="account-cards">{(['claude', 'codex', 'github'] as const).map((provider) => {
    const connection = connections.find((item) => item.provider === provider);
    return <article className="storage-card account-card" key={provider}><header><h2>{names[provider]}</h2>{connection?.state === 'authenticated' ? <Check size={19} /> : <CircleAlert size={19} />}</header><strong className={`account-state ${connection?.state ?? 'unknown'}`}>{!connection ? 'Checking…' : !connection.installed ? 'CLI installation needed' : connection.state === 'authenticated' ? 'Connected through local CLI' : connection.state === 'not-authenticated' ? 'Sign-in needed' : 'Status unverified'}</strong><p>{connection?.message ?? 'Inspecting the installed CLI.'}</p>{connection?.version && <small className="muted">{connection.version}</small>}<div className="hub-toolbar"><button className="button primary" disabled={busy || !connection?.canLogin} onClick={() => void connect(provider)}>{connection?.state === 'authenticated' ? 'Reconnect' : 'Connect'} {names[provider]}</button><button className="button secondary" disabled={!window.codingHub} onClick={() => void call({ action: 'install-guide', provider }).catch((e) => setError(e.message))}><ExternalLink size={14} />Installation guide</button></div><details className="account-details"><summary>CLI details & login command</summary>{connection?.executable && <code className="account-path">{connection.executable}</code>}<code className="account-command">{commands[provider]}</code></details>{!connection?.installed && <><p>Install the official CLI in PowerShell, then refresh. Restart Coding Hub if the installer changes PATH.</p><code className="account-command">{installation[provider]}</code></>}</article>;
  })}</div><article className={`storage-card account-login ${busy || login ? 'login-active' : 'login-idle'}`}><header><h2><TerminalSquare size={16} />{login ? `${names[login.provider]} login` : 'Official CLI sign-in terminal'}</h2>{(busy || login) && <button className="button secondary" onClick={() => void cancel()}><Square size={12} />Cancel login</button>}</header><p>The CLI may open your browser or display a sign-in URL and code. Follow its prompts here. Login output is temporary and is excluded from saved session logs and Drive memory.</p><div className="account-terminal" ref={container} aria-label="Account login terminal" /></article><p className="control-note">Credentials are stored and managed by Claude Code, Codex, and GitHub CLI on this computer. Existing CLI logins are detected automatically. A configured login does not verify subscription, billing, model access, or repository permissions. Cancelling a login ends its local process; signing out is managed by the official CLI. GitHub connectivity does not automatically push or publish projects.</p></section>;
}
