import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MousePointer2, RotateCcw, X } from 'lucide-react';
import type RFB from '@novnc/novnc';
import type { LinkedComputer } from '../../../shared/remote';
import type { ScreenKind } from '../../../shared/screen';
import { savedCredentials, screen, ScreenChannel } from '../../runtime/screen-channel';

const XK_SUPER_L = 0xffeb; const XK_CONTROL_L = 0xffe3; const XK_V = 0x0076;
type Status = 'connecting' | 'signin' | 'connected' | 'ended';
const mac = navigator.userAgent.includes('Mac');
/**
 * The modifier each side copies and pastes with differs, so one local key stands in for the other's: on Windows (whose
 * Windows key cannot be sent) viewing a Mac, Ctrl sends ⌘; on a Mac viewing Windows, ⌘ sends Ctrl (noVNC would send Alt).
 */
function swapFor(kind: ScreenKind | null) {
  if (kind === 'system' && !mac) return { codes: ['ControlLeft', 'ControlRight'], keysym: XK_SUPER_L, code: 'MetaLeft', label: 'Ctrl as ⌘', title: 'Ctrl is sent as ⌘ (Command), so Ctrl+C and Ctrl+V copy and paste on the Mac', paste: (event: KeyboardEvent) => event.ctrlKey && !event.metaKey };
  if (kind === 'trace' && mac) return { codes: ['MetaLeft', 'MetaRight'], keysym: XK_CONTROL_L, code: 'ControlLeft', label: '⌘ as Ctrl', title: '⌘ is sent as Ctrl, so ⌘C and ⌘V copy and paste on Windows', paste: (event: KeyboardEvent) => event.metaKey && !event.ctrlKey };
  return null;
}

/**
 * The other computer's screen, through its own screen-sharing server (macOS Screen Sharing), so it works even while
 * Trace is closed there. The person signs in as that computer's user; the password can be saved, encrypted, here.
 */
export function LinkedScreen({ computer, onClose }: { computer: LinkedComputer; onClose: () => void }) {
  const view = useRef<HTMLDivElement>(null); const pasteTarget = useRef<HTMLTextAreaElement>(null); const rfb = useRef<RFB | null>(null);
  const [attempt, setAttempt] = useState(0); const [status, setStatus] = useState<Status>('connecting'); const [message, setMessage] = useState('');
  const [control, setControl] = useState(true);
  const [kind, setKind] = useState<ScreenKind | null>(null); const [command, setCommand] = useState(true); const swap = swapFor(kind);
  const [types, setTypes] = useState<string[]>([]); const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [remember, setRemember] = useState(true);
  /** Saved sign-in is skipped on the next try once the computer refused it. */
  const useSaved = useRef(true); const toSave = useRef<{ username: string; password: string } | null>(null);
  const [hasSaved, setHasSaved] = useState(false);

  useEffect(() => {
    const target = view.current; if (!target) return; let cancelled = false; let client: RFB | null = null;
    setStatus('connecting'); setMessage('');
    void (async () => {
      // Loaded only when a screen is opened: the viewer is large and most sessions never use it.
      const { default: Viewer } = await import('@novnc/novnc');
      const saved = await savedCredentials(computer.id).catch(() => null); setHasSaved(Boolean(saved));
      if (cancelled) return;
      const channel = new ScreenChannel(computer.id);
      client = new Viewer(target, channel, saved && useSaved.current ? { credentials: saved, shared: true } : { shared: true }); rfb.current = client;
      client.scaleViewport = true; client.viewOnly = !control; client.background = 'transparent';
      client.addEventListener('connect', () => {
        setStatus('connected'); setKind(channel.kind); useSaved.current = true;
        const credentials = toSave.current; toSave.current = null;
        if (credentials) void screen({ action: 'screen-save-credentials', id: computer.id, ...credentials }).then(() => setHasSaved(true), (error: Error) => setMessage(error.message));
      });
      // A Mac asks for a user name and password; a server set up with only a VNC password asks for that alone.
      client.addEventListener('credentialsrequired', (event) => { setTypes((event as CustomEvent<{ types: string[] }>).detail.types); setUsername((value) => value || saved?.username || ''); setStatus('signin'); });
      client.addEventListener('securityfailure', (event) => {
        useSaved.current = false; toSave.current = null;
        const reason = (event as CustomEvent<{ reason?: string }>).detail.reason;
        setMessage(`${computer.name} did not accept that user name and password.${reason ? ` (${reason})` : ''}`);
      });
      client.addEventListener('disconnect', (event) => {
        if (rfb.current === client) rfb.current = null;
        setStatus('ended'); setMessage((current) => current || channel.error || ((event as CustomEvent<{ clean: boolean }>).detail.clean ? 'Screen sharing ended.' : `The connection to ${computer.name}'s screen closed.`));
      });
      // What is copied there lands on this computer's clipboard too.
      client.addEventListener('clipboard', (event) => { const text = (event as CustomEvent<{ text: string }>).detail.text; if (text) void window.codingHub?.copyText(text.slice(0, 1024 * 1024)); });
    })().catch((error: Error) => { if (!cancelled) { setStatus('ended'); setMessage(error.message); } });
    return () => { cancelled = true; client?.disconnect(); if (rfb.current === client) rfb.current = null; };
  }, [computer.id, attempt]);

  useEffect(() => { if (rfb.current) rfb.current.viewOnly = !control; }, [control]);

  // The swapped key is sent as the other side's (down and up, so it never sticks), and its V first puts this computer's
  // text on the other's clipboard: the browser pastes into a hidden field, which hands the text over before V is sent.
  useEffect(() => {
    const target = view.current; if (!target || !command || !swap) return; let held = false;
    const key = (event: KeyboardEvent) => {
      const client = rfb.current; if (!client || !control) return;
      if (swap.codes.includes(event.code)) {
        event.preventDefault(); event.stopPropagation(); const down = event.type === 'keydown';
        if (!(down && held)) { held = down; client.sendKey(swap.keysym, swap.code, down); }
        return;
      }
      if (event.type === 'keydown' && swap.paste(event) && !event.altKey && !event.shiftKey && event.code === 'KeyV') { event.stopPropagation(); pasteTarget.current?.focus(); }
    };
    const release = () => { if (held) { held = false; rfb.current?.sendKey(swap.keysym, swap.code, false); } };
    target.addEventListener('keydown', key, true); target.addEventListener('keyup', key, true); window.addEventListener('blur', release);
    return () => { release(); target.removeEventListener('keydown', key, true); target.removeEventListener('keyup', key, true); window.removeEventListener('blur', release); };
  }, [command, control, kind]);

  const pasted = (text: string) => {
    const client = rfb.current; if (!client) return;
    if (text) client.clipboardPasteFrom(text);
    client.sendKey(XK_V, 'KeyV', true); client.sendKey(XK_V, 'KeyV', false); client.focus();
  };
  const signIn = (event: FormEvent) => {
    event.preventDefault(); const client = rfb.current; if (!client || !password) return;
    const named = types.includes('username');
    toSave.current = remember ? { username: named ? username : '-', password } : null;
    setMessage(''); setStatus('connecting'); client.sendCredentials(named ? { username, password } : { password }); setPassword('');
  };
  const forget = () => void screen({ action: 'screen-forget-credentials', id: computer.id }).then(() => setHasSaved(false), (error: Error) => setMessage(error.message));
  const retry = () => { setMessage(''); setAttempt((value) => value + 1); };
  const named = types.includes('username');

  return <section className="linked-screen" aria-label={`${computer.name} screen`}>
    <header className="linked-screen-bar">
      <strong>Screen</strong>
      <span className={`storage-status ${status === 'connected' ? 'saved' : ''}`} role="status">{status === 'connected' ? (control ? 'Controlling' : 'Viewing') : status === 'signin' ? 'Sign in' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
      <span className="tr-spacer" />
      <button className="tr-detail-button" aria-pressed={control} title={control ? 'Mouse and keyboard reach the other computer' : 'Only watching: nothing is sent'} onClick={() => setControl((value) => !value)}><MousePointer2 size={13} className="tr-detail-icon" /><span className="tr-detail-label">{control ? 'Control' : 'View only'}</span></button>
      {swap && <label className="linked-screen-toggle" title={swap.title}><input type="checkbox" checked={command} onChange={(event) => setCommand(event.target.checked)} /> {swap.label}</label>}
      {hasSaved && <button className="tr-detail-button" title={`Forget the password saved for ${computer.name}`} onClick={forget}><span className="tr-detail-label">Forget password</span></button>}
      <button className="tr-detail-button" onClick={retry}><RotateCcw size={13} className="tr-detail-icon" /><span className="tr-detail-label">Reconnect</span></button>
      <button className="tr-detail-button icon" title="Close the screen" aria-label="Close the screen" onClick={onClose}><X size={13} /></button>
    </header>
    {message && <p className="session-error" role="alert">{message}</p>}
    {status === 'signin' && <form className="linked-screen-signin" onSubmit={signIn}>
      <p>{named ? `Sign in as a user on ${computer.name}: the name and password you use to log in there.` : `Enter the screen-sharing password set on ${computer.name}.`}</p>
      {named && <label>User name <input autoFocus value={username} autoComplete="off" spellCheck={false} onChange={(event) => setUsername(event.target.value)} /></label>}
      <label>Password <input type="password" autoFocus={!named} value={password} autoComplete="off" onChange={(event) => setPassword(event.target.value)} /></label>
      <label className="linked-screen-toggle"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Save on this computer (encrypted)</label>
      <button className="tr-action start" type="submit" disabled={!password || (named && !username)}>Sign in</button>
    </form>}
    {/* The paste field sits inside the view, so releasing Ctrl while it has focus still releases ⌘ there. */}
    <div ref={view} className="linked-screen-view" hidden={status === 'signin'}>
      <textarea ref={pasteTarget} className="linked-screen-paste" aria-hidden="true" tabIndex={-1} onPaste={(event) => { event.preventDefault(); pasted(event.clipboardData.getData('text/plain')); }} />
    </div>
  </section>;
}
