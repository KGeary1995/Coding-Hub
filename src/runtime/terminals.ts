import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Session } from '../../shared/types';
import type { RunReference, SessionEvent } from '../../shared/ipc';
import { useWorkspaceStore } from '../state/workspace-store';
import { useHubStore } from '../state/hub-store';
import { ENGINE_CURSOR, TERMINAL_FONT, TERMINAL_THEME } from './terminal-theme';
import { forgetActivity, isPersonInput, recordActivity } from '../state/activity-store';
import { exitNotice } from '../../shared/terminal-input';
import { addPastedImage, clearPastedImages, markPastedImagesSent, quotePath } from '../state/pasted-images';
import { clearTerminalTitle, setTerminalTitle } from '../state/channel-names';
import { forgetChatsExcept } from '../state/chat-store';
import { osc52Text, unwrapCopied, type CopiedRow } from './copy-text';

const MAC = /Mac/.test(navigator.userAgent);
const WINDOWS = /Windows/.test(navigator.userAgent);
const pastedLabel = () => `Pasted ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

/**
 * Claude Code and Codex read an image straight from the clipboard when they receive their image key (Ctrl+V on a Mac,
 * Alt+V on Windows), which never reaches the page as a paste. So when Trace sends that key it reads the clipboard too,
 * and shows the image.
 */
async function showClipboardImage(id: string) {
  if (!terminals.get(id)?.run || !window.codingHub) return;
  try { const result = await window.codingHub.clipboardImage(); if (result.ok && result.value) addPastedImage(id, { label: pastedLabel(), thumbnail: result.value.thumbnail, full: result.value.full }); }
  catch { /* The preview is a convenience; the paste itself still reaches the CLI. */ }
}

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}

/**
 * Copying from a channel's terminal, here or on a linked computer. Claude Code and Codex break long text into separate
 * lines to fit the window; copying joins those lines again. Claude Code's full-screen view selects text itself (a drag
 * there goes to the CLI, not the terminal) and copies it with an OSC 52 request, which on a linked computer's channel
 * arrives here with its output. It is honoured only just after the person used the mouse or keyboard in this channel,
 * so a CLI cannot change the clipboard on its own.
 */
export function attachCopy(terminal: Terminal, element: HTMLElement) {
  element.addEventListener('copy', (event) => {
    if (!terminal.hasSelection() || !event.clipboardData) return;
    const rows = selectedRows(terminal); if (!rows?.length) return;
    event.preventDefault(); event.stopPropagation();
    event.clipboardData.setData('text/plain', unwrapCopied(rows, terminal.cols));
  }, true);
  let touched = 0; const touch = () => { touched = Date.now(); };
  element.addEventListener('mouseup', touch, true); element.addEventListener('keydown', touch, true);
  terminal.parser.registerOscHandler(52, (data) => {
    const text = osc52Text(data); if (text !== null && Date.now() - touched < 3000) void window.codingHub?.copyText(text);
    return true;
  });
}

/** The selected text, row by row as it is on screen (rows the terminal itself wrapped are kept together). */
function selectedRows(terminal: Terminal): CopiedRow[] | null {
  const range = terminal.getSelectionPosition(); if (!range) return null;
  const buffer = terminal.buffer.active; const rows: CopiedRow[] = [];
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = buffer.getLine(y); if (!line) continue;
    const full = line.translateToString(false);
    const from = y === range.start.y ? range.start.x : 0; const to = y === range.end.y ? range.end.x : terminal.cols;
    const part = full.slice(from, to);
    if (line.isWrapped && rows.length) rows[rows.length - 1].text += part;
    else rows.push({ text: part, startColumn: from, line: full });
  }
  return rows;
}

/** Dropping files types their paths, as in Terminal.app; dropped images also join the strip. */
function attachDrop(id: string, element: HTMLElement) {
  element.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  element.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files ?? [])]; if (!files.length) return;
    event.preventDefault();
    const paths = files.map((file) => window.codingHub?.pathForFile(file) ?? '').filter(Boolean);
    if (!paths.length || !terminals.get(id)?.run) return;
    void writeTerminal(id, paths.map((file) => quotePath(file, WINDOWS)).join(' ') + ' ');
    for (const file of files) if (file.type.startsWith('image/') && file.size <= 20 * 1024 * 1024) void readImageFile(file).then((url) => addPastedImage(id, { label: file.name, thumbnail: url, full: url })).catch(() => undefined);
    terminals.get(id)?.terminal.focus();
  });
}

interface TerminalEntry { terminal: Terminal; element: HTMLDivElement; fit: FitAddon; run: RunReference | null; inputQueue: Promise<void> }
const terminals = new Map<string, TerminalEntry>();
useHubStore.subscribe((state, previous) => {
  if (state.preferences.terminalFontSize === previous.preferences.terminalFontSize) return;
  for (const entry of terminals.values()) { entry.terminal.options.fontSize = state.preferences.terminalFontSize; try { entry.fit.fit(); } catch { /* Hidden terminal fits on remount. */ } }
});

function reportInputError(id: string, message: string) { useWorkspaceStore.getState().setSessionError(id, message); }

/** Terminal instances outlive React tiles so navigation and isolation keep scrollback. */
export function getTerminal(session: Session, container?: HTMLElement): TerminalEntry {
  const existing = terminals.get(session.id);
  if (existing) return existing;
  const element = document.createElement('div');
  element.className = 'terminal-surface';
  container?.appendChild(element);
  const terminal = new Terminal({
    disableStdin: true, cursorBlink: false, scrollback: 5000,
    fontFamily: TERMINAL_FONT,
    fontSize: useHubStore.getState().preferences.terminalFontSize, lineHeight: 1.45,
    theme: { ...TERMINAL_THEME, cursor: ENGINE_CURSOR[session.config.engine] },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  let webgl: WebglAddon | undefined;
  const disposeWebGL = () => { const addon = webgl; webgl = undefined; try { addon?.dispose(); } catch { /* Keep software rendering when the graphics context fails. */ } };
  if (useHubStore.getState().preferences.terminalWebGL === true) try {
    webgl = new WebglAddon();
    terminal.loadAddon(webgl);
    webgl.onContextLoss(disposeWebGL);
  } catch { disposeWebGL(); }
  const entry: TerminalEntry = { terminal, element, fit, run: null, inputQueue: Promise.resolve() };
  terminals.set(session.id, entry);
  terminal.onData((data) => {
    // Enter on its own is the person sending their message, and with it any images they attached.
    if (data === '\r') markPastedImagesSent(session.id);
    void writeTerminal(session.id, data);
  });
  // The CLI's terminal title says what it is working on (Claude Code's task summary).
  terminal.onTitleChange((title) => setTerminalTitle(session.id, title));
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || event.code !== 'KeyV' || event.shiftKey) return true;
    // On Windows, xterm would turn Ctrl+V into ^V, which pastes nothing in either CLI (Claude Code 2.1.311 ignores it;
    // Codex 0.164 pastes only text). Let the browser paste instead, as Windows Terminal does; the listener below
    // sends Alt+V when the clipboard holds only an image.
    if (WINDOWS && event.ctrlKey && !event.altKey && !event.metaKey) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) void showClipboardImage(session.id);
    return true;
  });
  // A paste with only an image on the clipboard has no text, so nothing would reach the CLI. Send the key Claude Code
  // and Codex treat as "attach the clipboard image" instead: Alt+V on Windows, Ctrl+V on a Mac.
  element.addEventListener('paste', (event) => {
    const data = event.clipboardData; if (!(MAC || WINDOWS) || !data || data.getData('text/plain') || ![...data.items].some((item) => item.type.startsWith('image/'))) return;
    event.preventDefault(); event.stopPropagation();
    if (useWorkspaceStore.getState().sessions.find((item) => item.id === session.id)?.config.engine === 'shell') return;
    void writeTerminal(session.id, WINDOWS ? '\x1bv' : '\x16');
    if (WINDOWS) void showClipboardImage(session.id);
  }, true);
  attachDrop(session.id, element);
  attachCopy(terminal, element);
  terminal.onResize(({ cols, rows }) => sendSize(session.id, entry, cols, rows));
  terminal.writeln(`\x1b[38;2;${{ claude: '241;211;93', codex: '92;208;234', shell: '195;210;204' }[session.config.engine]}m${session.title}\x1b[0m  ·  local interactive terminal`);
  terminal.writeln('');
  terminal.writeln('Choose a project, then start this session.');
  terminal.writeln('Your local CLI manages authentication and approvals.');
  terminal.writeln('');
  terminal.writeln('\x1b[2mNo process started. Usage appears after a reported CLI response.\x1b[0m');
  return entry;
}

function sendSize(id: string, entry: TerminalEntry, cols: number, rows: number) {
  if (entry.run && window.codingHub) void window.codingHub.resizeSession({ ...entry.run, cols: Math.min(500, Math.max(2, cols)), rows: Math.min(300, Math.max(1, rows)) }).then((result) => {
    if (!result.ok && result.error.code !== 'STALE_SESSION') reportInputError(id, result.error.message);
  }).catch(() => reportInputError(id, 'The native terminal connection was lost.'));
}

export function writeTerminal(id: string, data: string): Promise<boolean> {
  const entry = terminals.get(id);
  const run = entry?.run;
  if (!entry || !run || !window.codingHub) return Promise.resolve(false);
  // Serialize complete input events so typing cannot interleave with a large paste.
  let succeeded = true; const sentAt = new Date().toISOString();
  entry.inputQueue = entry.inputQueue.then(async () => {
    try {
      for (let offset = 0; offset < data.length;) {
        if (entry.run?.runId !== run.runId) { succeeded = false; break; }
        let end = Math.min(offset + 16 * 1024, data.length);
        const last = data.charCodeAt(end - 1);
        if (end < data.length && last >= 0xD800 && last <= 0xDBFF) end--;
        const result = await window.codingHub!.writeSession({ ...run, data: data.slice(offset, end) });
        if (!result.ok) { succeeded = false; if (entry.run?.runId === run.runId) reportInputError(id, result.error.message); break; }
        offset = end;
      }
    } catch { succeeded = false; reportInputError(id, 'The native terminal connection was lost.'); }
  });
  return entry.inputQueue.then(() => {
    // Any real keystroke means the person has answered whatever the CLI was waiting for.
    if (succeeded && isPersonInput(data)) useWorkspaceStore.getState().clearAttention(id, sentAt);
    return succeeded;
  });
}

/**
 * Flow control: the host pauses a CLI whose output the window has not drawn yet (see PtyManager), so every piece of
 * output is acknowledged once xterm has parsed it, or at once if it is not shown. Acknowledgements are batched.
 */
const pendingAcks = new Map<string, { sessionId: string; runId: string; bytes: number }>();
let ackTimer: ReturnType<typeof setTimeout> | null = null;
function flushAcks() {
  if (ackTimer) clearTimeout(ackTimer); ackTimer = null;
  for (const ack of pendingAcks.values()) void window.codingHub?.ackSession(ack).catch(() => {});
  pendingAcks.clear();
}
function acknowledge(sessionId: string, runId: string, bytes: number) {
  const key = sessionId + ':' + runId; const ack = pendingAcks.get(key) ?? { sessionId, runId, bytes: 0 };
  ack.bytes += bytes; pendingAcks.set(key, ack);
  if (ack.bytes >= 64 * 1024) flushAcks(); else ackTimer ??= setTimeout(flushAcks, 50);
}

export function routeTerminalEvent(event: SessionEvent) {
  const session = useWorkspaceStore.getState().sessions.find((item) => item.id === event.sessionId);
  if (!session || session.runId !== event.runId) { if (event.type === 'data') acknowledge(event.sessionId, event.runId, event.data.length); return; }
  const entry = getTerminal(session);
  if (event.type === 'started') {
    entry.terminal.reset();
    forgetActivity(event.sessionId);
    clearPastedImages(event.sessionId); clearTerminalTitle(event.sessionId);
    entry.run = { sessionId: event.sessionId, runId: event.runId };
    entry.terminal.options.disableStdin = false;
    entry.terminal.options.cursorBlink = true;
    // Resizes while starting were dropped (no run yet), so the process may have the pre-start size.
    try { entry.fit.fit(); } catch { /* Not attached to the page. */ }
    sendSize(event.sessionId, entry, entry.terminal.cols, entry.terminal.rows);
  } else if (event.type === 'data') {
    recordActivity(event.sessionId, event.data.length);
    entry.terminal.write(event.data, () => acknowledge(event.sessionId, event.runId, event.data.length));
  } else if (event.type === 'exit') {
    entry.run = null;
    entry.terminal.options.disableStdin = true;
    entry.terminal.options.cursorBlink = false;
    entry.terminal.write(exitNotice(event.exitCode, event.signal, event.diagnostic));
  }
}

export function terminalDimensions(id: string) {
  const terminal = terminals.get(id)?.terminal;
  return { cols: Math.min(500, Math.max(2, terminal?.cols ?? 100)), rows: Math.min(300, Math.max(1, terminal?.rows ?? 24)) };
}
export function focusTerminal(id: string) {
  // A chat channel has no terminal: go to its waiting approval (its Allow button), or else its message box.
  const chat = document.querySelector<HTMLElement>(`[data-chat-session="${CSS.escape(id)}"]`);
  if (chat) { const target = chat.querySelector<HTMLElement>('.chat-permission.open button') ?? chat.querySelector<HTMLElement>('textarea'); target?.scrollIntoView({ block: 'nearest' }); target?.focus(); return; }
  terminals.get(id)?.terminal.focus();
}
export function releaseRemovedTerminals(ids: string[]) {
  const retained = new Set(ids);
  for (const [id, entry] of terminals) if (!retained.has(id)) { entry.terminal.dispose(); terminals.delete(id); forgetActivity(id); clearPastedImages(id); }
  forgetChatsExcept(retained);
}
