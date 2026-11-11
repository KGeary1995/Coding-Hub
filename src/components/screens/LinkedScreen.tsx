import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LockKeyhole, MousePointer2, RotateCcw, X } from 'lucide-react';
import type RFB from '@novnc/novnc';
import type { LinkedComputer, LinkedScreenState } from '../../../shared/remote';
import type { ScreenKind } from '../../../shared/screen';
import { savedCredentials, screen, ScreenChannel, unlockKeys, WAKE_KEYS, type KeyStroke } from '../../runtime/screen-channel';
import { workbench } from '../../runtime/workbench';

const XK_SUPER_L = 0xffeb; const XK_CONTROL_L = 0xffe3; const XK_V = 0x0076;
type Status = 'connecting' | 'reconnecting' | 'signin' | 'connected' | 'ended';
/**
 * A screen that was showing and dropped (a network blip, the other computer's displays changing, its capture restarting)
 * connects again by itself after these waits; then it waits for Reconnect. The limit also keeps two computers that take
 * the screen from each other from doing so forever.
 */
const RETRY_DELAYS = [1000, 3000, 6000];
/** Connected this long, a drop starts the count of retries again. */
const RETRY_RESET_MS = 30000;
/** How often an open screen asks whether that computer is locked, so the note comes and goes with it. */
const LOCK_CHECK_MS = 5000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
  /** A Trace screen service's displays: how many, which is shown (0: all), and which to ask for next (kept through reconnects). */
  const [displays, setDisplays] = useState<number | undefined>(undefined); const [shownDisplay, setShownDisplay] = useState(0); const wantDisplay = useRef(0);
  const [kind, setKind] = useState<ScreenKind | null>(null); const [command, setCommand] = useState(true); const swap = swapFor(kind);
  const [types, setTypes] = useState<string[]>([]); const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [remember, setRemember] = useState(true);
  /** Saved sign-in is skipped on the next try once the computer refused it. */
  const useSaved = useRef(true); const toSave = useRef<{ username: string; password: string } | null>(null);
  const [hasSaved, setHasSaved] = useState(false);
  /** The saved sign-in when it is that Mac's user (not a bare VNC password): the same password unlocks its screen. */
  const savedLogin = useRef<string | null>(null);
  const [locked, setLocked] = useState<boolean | null>(null); const [unlockPassword, setUnlockPassword] = useState(''); const [unlocking, setUnlocking] = useState(false);
  /** The unlock form, opened from the bar when Trace on that Mac cannot say whether it is locked (closed, or older). */
  const [unlockOpen, setUnlockOpen] = useState(false);
  /** Why the computer refused the sign-in, kept for the disconnect that follows; other notes give way to it. */
  const refusal = useRef('');
  /** Automatic reconnects since the screen last stayed up; when it last connected; the wait before the next try. */
  const retries = useRef(0); const connectedAt = useRef<number | null>(null); const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRetry = () => { if (retryTimer.current) clearTimeout(retryTimer.current); retryTimer.current = null; };
  useEffect(() => cancelRetry, []);

  useEffect(() => {
    const target = view.current; if (!target) return; let cancelled = false; let client: RFB | null = null;
    setStatus((current) => current === 'reconnecting' ? current : 'connecting'); setMessage(''); refusal.current = '';
    void (async () => {
      // Loaded only when a screen is opened: the viewer is large and most sessions never use it.
      const { default: Viewer } = await import('@novnc/novnc');
      const saved = await savedCredentials(computer.id).catch(() => null); setHasSaved(Boolean(saved)); savedLogin.current = saved && saved.username !== '-' ? saved.password : null;
      if (cancelled) return;
      const channel = new ScreenChannel(computer.id, wantDisplay.current);
      client = new Viewer(target, channel, saved && useSaved.current ? { credentials: saved, shared: true } : { shared: true }); rfb.current = client;
      // A dot marks the pointer here at once when the other computer draws its own cursor into the picture (Trace's
      // Windows service), which arrives a moment later.
      client.scaleViewport = true; client.viewOnly = !control; client.background = 'transparent'; client.showDotCursor = true;
      client.addEventListener('connect', () => {
        setStatus('connected'); setKind(channel.kind); setDisplays(channel.displays); setShownDisplay(channel.display); wantDisplay.current = channel.display; useSaved.current = true; connectedAt.current = Date.now();
        const credentials = toSave.current; toSave.current = null;
        if (credentials) void screen({ action: 'screen-save-credentials', id: computer.id, ...credentials }).then(() => setHasSaved(true), (error: Error) => setMessage(error.message));
      });
      // A Mac asks for a user name and password; a server set up with only a VNC password asks for that alone.
      client.addEventListener('credentialsrequired', (event) => { setTypes((event as CustomEvent<{ types: string[] }>).detail.types); setUsername((value) => value || saved?.username || ''); setStatus('signin'); });
      client.addEventListener('securityfailure', (event) => {
        useSaved.current = false; toSave.current = null;
        const reason = (event as CustomEvent<{ reason?: string }>).detail.reason;
        refusal.current = `${computer.name} did not accept that user name and password.${reason ? ` (${reason})` : ''}`; setMessage(refusal.current);
      });
      client.addEventListener('disconnect', (event) => {
        if (rfb.current === client) rfb.current = null;
        // Closed here (Reconnect, Close): nothing more to do.
        if (cancelled) return;
        const since = connectedAt.current; connectedAt.current = null; if (since !== null && Date.now() - since >= RETRY_RESET_MS) retries.current = 0;
        // A screen that was showing, or a try to bring one back, goes on by itself; a refused sign-in or a first try that failed does not.
        if ((since !== null || retries.current > 0) && !refusal.current && retries.current < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[retries.current++]; setStatus('reconnecting'); setMessage('');
          cancelRetry(); retryTimer.current = setTimeout(() => { retryTimer.current = null; setAttempt((value) => value + 1); }, delay);
          return;
        }
        setStatus('ended'); setMessage(refusal.current || channel.error || ((event as CustomEvent<{ clean: boolean }>).detail.clean ? 'Screen sharing ended.' : `The connection to ${computer.name}'s screen closed.`));
      });
      // What is copied there lands on this computer's clipboard too.
      client.addEventListener('clipboard', (event) => { const text = (event as CustomEvent<{ text: string }>).detail.text; if (text) void window.codingHub?.copyText(text.slice(0, 1024 * 1024)); });
    })().catch((error: Error) => { if (!cancelled) { setStatus('ended'); setMessage(error.message); } });
    return () => { cancelled = true; client?.disconnect(); if (rfb.current === client) rfb.current = null; };
  }, [computer.id, attempt]);

  useEffect(() => { if (rfb.current) rfb.current.viewOnly = !control; }, [control]);

  // A locked Mac sends its screen black to every viewer but Apple's, and a locked Windows computer takes no keys or clicks
  // from Trace at its lock screen: ask Trace there, and say so here instead.
  const checkLock = () => workbench<LinkedScreenState>({ action: 'linked-screen-state', id: computer.id }).then((state) => { setLocked(state.locked); return state.locked; }, () => null);
  useEffect(() => {
    if (status !== 'connected' || !kind) { setLocked(null); return; }
    void checkLock(); const timer = setInterval(() => void checkLock(), LOCK_CHECK_MS);
    return () => clearInterval(timer);
  }, [status, kind, computer.id]);

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
  const forget = () => void screen({ action: 'screen-forget-credentials', id: computer.id }).then(() => { setHasSaved(false); savedLogin.current = null; }, (error: Error) => setMessage(error.message));
  /** Wakes the Mac, waits for its password field, types the password there and presses Return; then looks again. */
  const unlock = async (password: string) => {
    const client = rfb.current; if (!client || !password || unlocking) return;
    // Keys reach the other computer only while controlling it.
    setControl(true); client.viewOnly = false; setUnlocking(true); setMessage('');
    const send = (keys: KeyStroke[]) => { for (const key of keys) client.sendKey(key.keysym, key.code, key.down); };
    try {
      send(WAKE_KEYS); await wait(1000); if (rfb.current !== client) return;
      send(unlockKeys(password)); setUnlockPassword('');
      // The Mac takes a moment to unlock and to say so.
      for (let tries = 0; tries < 4; tries++) { await wait(1500); const now = await checkLock(); if (now === false) return; if (now === null) { setUnlockOpen(false); return; } }
      setMessage(`${computer.name} is still locked. Check the password and try again; if it is right, unlock it there once and reconnect.`);
    } finally { setUnlocking(false); client.focus(); }
  };
  const retry = () => { cancelRetry(); retries.current = 0; setMessage(''); setStatus('connecting'); setAttempt((value) => value + 1); };
  /** Another display (or all of them): the service captures that one at full size, so it connects again. */
  const showDisplay = (value: number) => { wantDisplay.current = value; setShownDisplay(value); retry(); };
  const named = types.includes('username');
  const lockUnknown = status === 'connected' && kind === 'system' && locked === null;
  const showUnlock = status === 'connected' && kind === 'system' && (locked === true || (lockUnknown && unlockOpen));
  /** Windows lets no other program type at its lock screen, so there is nothing to offer but to say so. */
  const windowsLocked = status === 'connected' && kind === 'trace' && locked === true;

  return <section className="linked-screen" aria-label={`${computer.name} screen`}>
    <header className="linked-screen-bar">
      <strong>Screen</strong>
      <span className={`storage-status ${status === 'connected' ? 'saved' : ''}`} role="status">{status === 'connected' ? (control ? 'Controlling' : 'Viewing') : status === 'signin' ? 'Sign in' : status === 'connecting' ? 'Connecting…' : status === 'reconnecting' ? 'Reconnecting…' : 'Disconnected'}</span>
      <span className="tr-spacer" />
      <button className="tr-detail-button" aria-pressed={control} title={control ? 'Mouse and keyboard reach the other computer' : 'Only watching: nothing is sent'} onClick={() => setControl((value) => !value)}><MousePointer2 size={13} className="tr-detail-icon" /><span className="tr-detail-label">{control ? 'Control' : 'View only'}</span></button>
      {lockUnknown && <button className="tr-detail-button" aria-pressed={unlockOpen} title={`Wake ${computer.name} and type your password at its lock screen`} onClick={() => setUnlockOpen((value) => !value)}><LockKeyhole size={13} className="tr-detail-icon" /><span className="tr-detail-label">Unlock</span></button>}
      {displays !== undefined && displays > 1 && <label className="linked-screen-toggle" title="All displays side by side, or one of them at full size"><select aria-label="Display" value={shownDisplay} onChange={(event) => showDisplay(Number(event.target.value))}><option value={0}>All displays</option>{Array.from({ length: displays }, (_, index) => <option key={index + 1} value={index + 1}>Display {index + 1}</option>)}</select></label>}
      {swap && <label className="linked-screen-toggle" title={swap.title}><input type="checkbox" checked={command} onChange={(event) => setCommand(event.target.checked)} /> {swap.label}</label>}
      {hasSaved && <button className="tr-detail-button" title={`Forget the password saved for ${computer.name}`} onClick={forget}><span className="tr-detail-label">Forget password</span></button>}
      <button className="tr-detail-button" onClick={retry}><RotateCcw size={13} className="tr-detail-icon" /><span className="tr-detail-label">Reconnect</span></button>
      <button className="tr-detail-button icon" title="Close the screen" aria-label="Close the screen" onClick={onClose}><X size={13} /></button>
    </header>
    {message && <p className="session-error" role="alert">{message}</p>}
    {windowsLocked && <div className="linked-screen-signin linked-screen-unlock" role="status"><p><LockKeyhole size={13} aria-hidden="true" /> <strong>{computer.name} is locked.</strong> Windows takes no keys or clicks from other programs at its lock screen, so typing here does nothing until it is unlocked there, at the computer. To keep it from locking while you are away, set Settings → Accounts → Sign-in options → “If you’ve been away” to Never there.</p></div>}
    {showUnlock && <form className="linked-screen-signin linked-screen-unlock" onSubmit={(event) => { event.preventDefault(); void unlock(unlockPassword); }}>
      <p><LockKeyhole size={13} aria-hidden="true" /> {locked ? <><strong>{computer.name} is locked</strong>, so its screen shows black here: macOS shows its lock screen only to Apple’s own viewer.</> : <>If <strong>{computer.name}</strong> is locked, its screen shows black here: macOS shows its lock screen only to Apple’s own viewer.</>} With only Screen Sharing turned on there, macOS 26 also takes no keys from Trace at its lock screen, so unlock it at the Mac. If its Remote Management is on with Control allowed, Trace can try to wake it and type your password.</p>
      <label>Password for {computer.name} <input type="password" autoFocus value={unlockPassword} autoComplete="off" disabled={unlocking} onChange={(event) => setUnlockPassword(event.target.value)} /></label>
      <span className="linked-screen-actions">
        <button className="tr-action start" type="submit" disabled={!unlockPassword || unlocking}>{unlocking ? 'Unlocking…' : 'Wake and unlock'}</button>
        {savedLogin.current && <button className="tr-detail-button" type="button" disabled={unlocking} onClick={() => void unlock(savedLogin.current ?? '')}><span className="tr-detail-label">Use saved password</span></button>}
      </span>
    </form>}
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
