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
  terminal.onData((data) => { void writeTerminal(session.id, data); });
  terminal.onResize(({ cols, rows }) => sendSize(session.id, entry, cols, rows));
  terminal.writeln(`\x1b[38;2;${session.config.engine === 'claude' ? '241;211;93' : '92;208;234'}m${session.title}\x1b[0m  ·  local interactive terminal`);
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

export function routeTerminalEvent(event: SessionEvent) {
  const session = useWorkspaceStore.getState().sessions.find((item) => item.id === event.sessionId);
  if (!session || session.runId !== event.runId) return;
  const entry = getTerminal(session);
  if (event.type === 'started') {
    entry.terminal.reset();
    forgetActivity(event.sessionId);
    entry.run = { sessionId: event.sessionId, runId: event.runId };
    entry.terminal.options.disableStdin = false;
    entry.terminal.options.cursorBlink = true;
    // Resizes while starting were dropped (no run yet), so the process may have the pre-start size.
    try { entry.fit.fit(); } catch { /* Not attached to the page. */ }
    sendSize(event.sessionId, entry, entry.terminal.cols, entry.terminal.rows);
  } else if (event.type === 'data') {
    recordActivity(event.sessionId, event.data.length);
    entry.terminal.write(event.data);
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
export function focusTerminal(id: string) { terminals.get(id)?.terminal.focus(); }
export function releaseRemovedTerminals(ids: string[]) {
  const retained = new Set(ids);
  for (const [id, entry] of terminals) if (!retained.has(id)) { entry.terminal.dispose(); terminals.delete(id); forgetActivity(id); }
}
