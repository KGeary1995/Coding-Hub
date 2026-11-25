import { Terminal } from '@xterm/xterm';
import type { LinkedComputer, LinkedComputerEvent } from '../../shared/remote';
import type { ChannelEngine } from '../../shared/types';
import { useLinkedStore } from '../state/linked-store';
import { useHubStore } from '../state/hub-store';
import { ENGINE_CURSOR, TERMINAL_FONT, TERMINAL_THEME, terminalFontSize } from './terminal-theme';
import { workbench } from './workbench';
import { withoutTerminalReplies } from '../../shared/terminal-input';
import { measureLikeTheCLIs } from '../../shared/terminal-width';
import { attachCopy } from './terminals';
import { inputPieces } from './input-pieces';
import { forgetLinkedChatsExcept } from '../state/chat-store';

/**
 * Terminals showing channels that run on a linked computer. Each is drawn at that CLI's own size: the other computer
 * owns it, and this window only asks for its tile's size (`linked-fit`). What the person types goes back to that computer.
 */
interface Entry { terminal: Terminal; element: HTMLDivElement; runId: string | null; queue: Promise<unknown>; failures: number }
const terminals = new Map<string, Entry>();
const MAC = navigator.userAgent.includes('Mac'); const WINDOWS = navigator.userAgent.includes('Windows');
/** The most a linked computer takes in one 'linked-input' request (main.ts and remote-server.ts check it). */
export const LINKED_INPUT_LIMIT = 4096;

/**
 * Typing and pastes go out one request at a time and in order, so "y" then Enter cannot arrive reversed, and a long paste
 * goes in pieces the host accepts. When one fails, what was already waiting behind it is not sent (arriving late, it would
 * answer whatever the CLI shows by then), and the reason shows above that computer's channels.
 */
export function sendLinkedInput(entry: Pick<Entry, 'runId' | 'queue' | 'failures'>, computerId: string, sessionId: string, data: string) {
  const runId = entry.runId; if (!runId || !data) return;
  const after = entry.failures;
  entry.queue = entry.queue.then(async () => {
    for (const piece of inputPieces(data, LINKED_INPUT_LIMIT)) {
      if (after !== entry.failures || entry.runId !== runId) return;
      await workbench({ action: 'linked-input', id: computerId, sessionId, runId, data: piece });
    }
  }).catch((error: Error) => { entry.failures++; useLinkedStore.setState({ addError: `Not everything typed reached the channel, so what followed it was not sent. Check the channel before typing again. ${error.message}` }); });
}

function base64(bytes: Uint8Array) { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); }

/** Sends an image to a channel on a linked computer; what went wrong shows above that computer's channels. */
function sendImage(entry: Entry, computerId: string, sessionId: string, engine: ChannelEngine, image: string) {
  const runId = entry.runId; if (!runId) return;
  if (engine === 'shell' || engine === 'gemini') { useLinkedStore.setState({ addError: 'Images paste into Claude Code and Codex channels, not terminals or Gemini.' }); return; }
  useLinkedStore.setState({ addError: '' });
  entry.queue = entry.queue.then(() => workbench({ action: 'linked-paste-image', id: computerId, sessionId, runId, image })).catch((error: Error) => useLinkedStore.setState({ addError: error.message }));
}

/** Ctrl+V on a Mac: this computer's clipboard image if there is one, else the key itself. */
async function pasteClipboardImage(entry: Entry, computerId: string, sessionId: string, engine: ChannelEngine) {
  const result = await window.codingHub?.clipboardImage().catch(() => null);
  const full = result?.ok ? result.value?.full : undefined;
  if (full) { sendImage(entry, computerId, sessionId, engine, full.slice(full.indexOf(',') + 1)); return; }
  sendLinkedInput(entry, computerId, sessionId, '\x16');
}
const key = (computerId: string, sessionId: string) => `${computerId}:${sessionId}`;

export function linkedTerminal(computerId: string, sessionId: string, engine: ChannelEngine, size: { cols: number | null; rows: number | null }): Entry {
  const id = key(computerId, sessionId); const existing = terminals.get(id); if (existing) return existing;
  const element = document.createElement('div'); element.className = 'terminal-surface linked-surface';
  const terminal = new Terminal({ cols: size.cols ?? 100, rows: size.rows ?? 30, scrollback: 5000, fontFamily: TERMINAL_FONT, fontSize: terminalFontSize(useHubStore.getState().preferences.terminalFontSize), lineHeight: 1.3, allowProposedApi: true, theme: { ...TERMINAL_THEME, cursor: ENGINE_CURSOR[engine] } });
  measureLikeTheCLIs(terminal); terminal.open(element);
  const entry: Entry = { terminal, element, runId: null, queue: Promise.resolve(), failures: 0 };
  terminal.onData((data) => {
    // The computer running the CLI answers its queries (cursor position, device attributes, colours) and focus
    // reports itself; this view's own answers would reach the CLI twice, as stray input like ^[[12;1R.
    sendLinkedInput(entry, computerId, sessionId, withoutTerminalReplies(data).replace(/\x1b\[[IO]/g, ''));
  });
  // On Windows, xterm would turn Ctrl+V into ^V, which pastes nothing, and Ctrl+C into ^C, which would interrupt the CLI
  // there instead of copying what is selected here. Let the browser paste or copy instead.
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true;
    // On a Mac, Ctrl+V is Claude Code's image key, which would read the other computer's clipboard: an image here goes
    // across instead, and without one the key goes as it is.
    if (MAC && event.code === 'KeyV') { void pasteClipboardImage(entry, computerId, sessionId, engine); return false; }
    if (!WINDOWS) return true;
    return !(event.code === 'KeyV' || (event.code === 'KeyC' && terminal.hasSelection()));
  });
  // An image pasted here is on this computer's clipboard, which the CLI there cannot read: it is sent to that computer,
  // which puts it on its own clipboard and presses the CLI's image key, as a paste there would.
  element.addEventListener('paste', (event) => {
    const data = event.clipboardData; const file = [...(data?.items ?? [])].find((item) => item.type === 'image/png' || item.type === 'image/jpeg')?.getAsFile();
    if (!data || data.getData('text/plain') || !file) return;
    event.preventDefault(); event.stopPropagation();
    void file.arrayBuffer().then((bytes) => sendImage(entry, computerId, sessionId, engine, base64(new Uint8Array(bytes))));
  }, true);
  attachCopy(terminal, element, () => engine !== 'shell');
  terminals.set(id, entry);
  return entry;
}

/** Live output, screens and sizes from linked computers, and their channel lists. */
export function routeLinkedEvent(event: LinkedComputerEvent) {
  if (event.type === 'computers') {
    useLinkedStore.setState({ computers: event.computers });
    // Channels that went away (or whose computer was unlinked) drop their terminals.
    const live = new Set(event.computers.flatMap((computer) => computer.channels.map((channel) => key(computer.id, channel.sessionId))));
    for (const [id, entry] of terminals) if (!live.has(id)) { entry.terminal.dispose(); entry.element.remove(); terminals.delete(id); }
    // Chat threads go only with their computer: a Round Table's hidden seats are not in its channel list.
    forgetLinkedChatsExcept(event.computers.map((computer) => computer.id));
    return;
  }
  const entry = terminals.get(key(event.id, event.sessionId)); if (!entry) return;
  if (event.type === 'replay') { entry.runId = event.runId; entry.terminal.reset(); entry.terminal.resize(event.cols, event.rows); entry.terminal.write(event.data); return; }
  if (event.type === 'resize') { if (entry.runId === event.runId) entry.terminal.resize(event.cols, event.rows); return; }
  // A run that started while the tab was open begins with a clean screen.
  if (entry.runId !== event.runId) { entry.runId = event.runId; entry.terminal.reset(); }
  entry.terminal.write(event.data);
}

export async function refreshLinked() {
  try { useLinkedStore.setState({ computers: await workbench<LinkedComputer[]>({ action: 'linked-status' }) }); } catch { /* Shown as no other computers. */ }
}
