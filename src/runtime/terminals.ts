import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Session } from '../../shared/types';
import type { RunReference, SessionEvent } from '../../shared/ipc';
import { useWorkspaceStore } from '../state/workspace-store';
import { useHubStore } from '../state/hub-store';

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
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: useHubStore.getState().preferences.terminalFontSize, lineHeight: 1.45,
    theme: { background: '#0c1017', foreground: '#c9d3e1', black: '#141b27', brightBlack: '#69778e', red: '#f18c93', green: '#8ed9b4', yellow: '#e6bf8a', blue: '#7baaff', magenta: '#b7a0ed', cyan: '#8acddd', white: '#dce4ef', selectionBackground: '#283e61', cursor: '#a8c8ff' },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  let webgl: WebglAddon | undefined;
  try {
    webgl = new WebglAddon();
    terminal.loadAddon(webgl);
    webgl.onContextLoss(() => { webgl?.dispose(); webgl = undefined; });
  } catch { webgl?.dispose(); }
  const entry: TerminalEntry = { terminal, element, fit, run: null, inputQueue: Promise.resolve() };
  terminals.set(session.id, entry);
  terminal.onData((data) => { void writeTerminal(session.id, data); });
  terminal.onResize(({ cols, rows }) => {
    if (entry.run && window.codingHub) void window.codingHub.resizeSession({ ...entry.run, cols: Math.min(500, Math.max(2, cols)), rows: Math.min(300, Math.max(1, rows)) }).then((result) => {
      if (!result.ok && result.error.code !== 'STALE_SESSION') reportInputError(session.id, result.error.message);
    }).catch(() => reportInputError(session.id, 'The native terminal connection was lost.'));
  });
  terminal.writeln(`\x1b[${session.config.engine === 'claude' ? '33' : '32'}m${session.title}\x1b[0m  ·  local interactive terminal`);
  terminal.writeln('');
  terminal.writeln('Choose a project, then start this session.');
  terminal.writeln('Your local CLI manages authentication and approvals.');
  terminal.writeln('');
  terminal.writeln('\x1b[2mNo process started. Usage appears after a reported CLI response.\x1b[0m');
  return entry;
}

export function writeTerminal(id: string, data: string): Promise<void> {
  const entry = terminals.get(id);
  const run = entry?.run;
  if (!entry || !run || !window.codingHub) return Promise.resolve();
  // Serialize complete input events so typing cannot interleave with a large paste.
  entry.inputQueue = entry.inputQueue.then(async () => {
    try {
      for (let offset = 0; offset < data.length;) {
        if (entry.run?.runId !== run.runId) break;
        let end = Math.min(offset + 16 * 1024, data.length);
        const last = data.charCodeAt(end - 1);
        if (end < data.length && last >= 0xD800 && last <= 0xDBFF) end--;
        const result = await window.codingHub!.writeSession({ ...run, data: data.slice(offset, end) });
        if (!result.ok) { if (entry.run?.runId === run.runId) reportInputError(id, result.error.message); break; }
        offset = end;
      }
    } catch { reportInputError(id, 'The native terminal connection was lost.'); }
  });
  return entry.inputQueue;
}

export function routeTerminalEvent(event: SessionEvent) {
  const session = useWorkspaceStore.getState().sessions.find((item) => item.id === event.sessionId);
  if (!session || session.runId !== event.runId) return;
  const entry = getTerminal(session);
  if (event.type === 'started') {
    entry.terminal.reset();
    entry.run = { sessionId: event.sessionId, runId: event.runId };
    entry.terminal.options.disableStdin = false;
    entry.terminal.options.cursorBlink = true;
  } else if (event.type === 'data') {
    entry.terminal.write(event.data);
  } else if (event.type === 'exit') {
    entry.run = null;
    entry.terminal.options.disableStdin = true;
    entry.terminal.options.cursorBlink = false;
    // Failure details may have been drawn in Codex's alternate screen. Repeat
    // the bounded diagnostic after leaving it so the last error stays visible.
    entry.terminal.write(`\x1b[?1049l\x1b[?25h\x1b[0m\r\n\x1b[2m[Process exited · code ${event.exitCode}${event.signal ? ` · signal ${event.signal}` : ''}]\x1b[0m\r\n${event.diagnostic ? event.diagnostic.replace(/\r?\n/g, '\r\n') + '\r\n' : ''}`);
  }
}

export function terminalDimensions(id: string) {
  const terminal = terminals.get(id)?.terminal;
  return { cols: Math.min(500, Math.max(2, terminal?.cols ?? 100)), rows: Math.min(300, Math.max(1, terminal?.rows ?? 24)) };
}
export function focusTerminal(id: string) { terminals.get(id)?.terminal.focus(); }
export function releaseRemovedTerminals(ids: string[]) {
  const retained = new Set(ids);
  for (const [id, entry] of terminals) if (!retained.has(id)) { entry.terminal.dispose(); terminals.delete(id); }
}
