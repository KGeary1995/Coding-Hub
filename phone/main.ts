import '@fontsource/ibm-plex-sans-condensed/400.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@xterm/xterm/css/xterm.css';
import '../src/tokens.css';
import './phone.css';
import { Terminal } from '@xterm/xterm';
import { ENGINE_CURSOR, TERMINAL_FONT, TERMINAL_THEME } from '../src/runtime/terminal-theme';
import { PAIRING_PREFIX, type RemoteChannel } from '../shared/remote';
import { withoutTerminalReplies } from '../shared/terminal-input';
import { follow, INPUT_LIMIT, pair, send, token, unpair, Unpaired, type StreamEvent } from './api';

/** Keys a CLI prompt usually needs, which a phone keyboard does not offer. */
const KEYS: { label: string; name?: string; data: string }[] = [
  { label: 'Enter', data: '\r' }, { label: 'Esc', data: '\x1b' }, { label: '↑', name: 'Up', data: '\x1b[A' }, { label: '↓', name: 'Down', data: '\x1b[B' },
  { label: '1', data: '1' }, { label: '2', data: '2' }, { label: '3', data: '3' }, { label: 'y', data: 'y' }, { label: 'n', data: 'n' },
  { label: 'Tab', data: '\t' }, { label: '←', name: 'Left', data: '\x1b[D' }, { label: '→', name: 'Right', data: '\x1b[C' }, { label: 'Ctrl C', data: '\x03' },
];
const ENGINE = { claude: 'Claude Code', codex: 'Codex' } as const;

type Child = Node | string | false | null | undefined;
/** A DOM element with properties (`className`, `onclick`, …), `data-` and `aria-` attributes, and children. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { dataset?: Record<string, string>; aria?: Record<string, string>; [property: string]: unknown } = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const { dataset, aria, ...rest } = props; const element = Object.assign(document.createElement(tag), rest);
  for (const [key, value] of Object.entries(dataset ?? {})) element.dataset[key] = value;
  for (const [key, value] of Object.entries(aria ?? {})) element.setAttribute(key === 'role' ? 'role' : `aria-${key}`, value);
  element.append(...children.filter((child): child is Node | string => Boolean(child)));
  return element;
}

const app = document.getElementById('app')!;
let channels: RemoteChannel[] = []; let current: string | null = null; let run: string | null = null;
let stop: (() => void) | null = null; let terminal: Terminal | null = null; let connected = false;
/** Unsent messages, by channel. */
const drafts = new Map<string, string>();

const state = (channel: RemoteChannel) => channel.attention ? 'waiting' : channel.running ? 'running' : 'idle';
const word = { waiting: 'needs you', running: 'running', idle: 'idle' } as const;

function header(back?: () => void, title?: Node, ...tools: Node[]) {
  return h('header', { className: 'bar' },
    back ? h('button', { className: 'icon', onclick: back, aria: { label: 'Back to channels' } }, '‹') : h('span', { className: 'mark' }, h('i'), h('i'), h('i'), ' trace'),
    title ?? h('span'), ...tools,
    h('span', { className: `link ${connected ? 'on' : ''}`, aria: { live: 'polite' } }, connected ? 'live' : 'reconnecting…'));
}

function showPair(error = '') {
  stop?.(); stop = null; disposeTerminal(); current = null;
  const code = location.hash.startsWith(PAIRING_PREFIX) ? decodeURIComponent(location.hash.slice(PAIRING_PREFIX.length)) : '';
  const agent = navigator.userAgent; const name = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android phone' : 'Phone';
  const codeInput = h('input', { id: 'code', value: code, autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: false, required: true });
  const nameInput = h('input', { id: 'name', value: name, maxLength: 60 });
  const message = h('p', { className: 'error', aria: { role: 'alert' } }, error);
  const form = h('form', { className: 'pair' },
    h('span', { className: 'mark big' }, h('i'), h('i'), h('i'), ' trace'),
    h('h1', {}, 'Pair this phone'),
    h('p', { className: 'dim' }, 'Enter the code shown in Trace on your computer, under Settings → Phone access. Scanning its QR code fills it in.'),
    h('label', {}, 'Pairing code', codeInput), h('label', {}, 'Name for this phone', nameInput),
    h('button', { className: 'primary', type: 'submit' }, 'Pair'), message);
  form.onsubmit = async (event) => {
    event.preventDefault(); message.textContent = '';
    try { await pair(codeInput.value.trim(), nameInput.value.trim()); history.replaceState(null, '', '/'); showList(); }
    catch (e) { message.textContent = (e as Error).message; }
  };
  app.replaceChildren(form);
}

function listen(sessionId: string | null) {
  stop?.();
  stop = follow(sessionId, onEvent, (value) => { connected = value; for (const link of document.querySelectorAll('.link')) { link.className = `link ${value ? 'on' : ''}`; link.textContent = value ? 'live' : 'reconnecting…'; } }, () => showPair('This phone was removed on the computer. Pair it again to continue.'));
}

function showList() {
  disposeTerminal(); current = null; run = null;
  const list = h('ul', { id: 'channel-list', className: 'channels' });
  const remove = h('button', { className: 'quiet', onclick: async () => { if (!confirm('Remove this phone? You will need a new pairing code to use it again.')) return; await unpair().catch(() => {}); showPair(); } }, 'Remove this phone');
  app.replaceChildren(header(), h('main', { className: 'list' }, h('h1', {}, 'Channels'), list, h('p', { id: 'empty', className: 'dim', hidden: true }, 'No channels yet. Open a project in Trace on your computer.')), h('footer', {}, remove));
  renderList(); listen(null);
}

function renderList() {
  const list = document.getElementById('channel-list'); if (!list) return;
  list.replaceChildren(...channels.map((channel) => h('li', {},
    h('button', { className: `channel ${state(channel)}`, onclick: () => showChannel(channel.sessionId) },
      h('span', { className: 'chip', dataset: { engine: channel.engine } }, `CH${channel.channel}`),
      h('span', { className: 'name' }, channel.title, channel.title !== ENGINE[channel.engine] && h('small', {}, ENGINE[channel.engine])),
      h('span', { className: 'tag' }, word[state(channel)]),
      channel.attention && h('span', { className: 'ask' }, channel.attention)))));
  const empty = document.getElementById('empty'); if (empty) empty.hidden = channels.length > 0;
}

function disposeTerminal() { terminal?.dispose(); terminal = null; }

/**
 * Draws the CLI's screen at its own width: by default the text shrinks to fit the phone, down to a floor. The person
 * can make it larger (the screen then scrolls sideways); that choice is remembered on the phone.
 */
const SIZE_KEY = 'trace-remote-text-size';
let larger = Number(localStorage.getItem(SIZE_KEY)) || 0;
function fitFont(cols: number) {
  const width = document.getElementById('output')?.clientWidth ?? 360;
  return Math.max(7, Math.min(16, Math.floor((width - 4) / (cols * 0.6)) + larger));
}
function resizeText(step: number) {
  larger = Math.max(0, Math.min(8, larger + step)); localStorage.setItem(SIZE_KEY, String(larger));
  const channel = channels.find((item) => item.sessionId === current); if (terminal && channel) terminal.options.fontSize = fitFont(channel.cols ?? 80);
}

function showChannel(sessionId: string) {
  current = sessionId; run = null; disposeTerminal();
  const channel = channels.find((item) => item.sessionId === sessionId);
  const title = h('span', { className: 'title', id: 'channel-title' });
  const waiting = h('p', { id: 'waiting', className: 'ask-banner', hidden: true, aria: { role: 'status' } });
  const output = h('div', { id: 'output', className: 'terminal', aria: { label: 'Channel output' } });
  const problem = h('p', { id: 'send-error', className: 'error', aria: { role: 'alert' } });
  const text = h('input', { id: 'text', autocomplete: 'off', placeholder: 'Type to the CLI', enterKeyHint: 'send', aria: { label: 'Message' } });
  const form = h('form', { className: 'compose' }, text, h('button', { className: 'primary', type: 'submit' }, 'Send'));
  // The draft stays in the field until it has been delivered, and is cleared only if nothing new was typed meanwhile.
  // Drafts are kept per channel, so going back to the list and returning finds the message still there.
  text.value = drafts.get(sessionId) ?? ''; text.addEventListener('input', () => { if (text.value) drafts.set(sessionId, text.value); else drafts.delete(sessionId); });
  form.onsubmit = async (event) => {
    event.preventDefault(); const value = text.value; if (!value) return;
    if (!await type(value + '\r')) return;
    // The channel may have been left and reopened while sending: clear only what still holds this message.
    const field = document.getElementById('text') as HTMLInputElement | null;
    if (field && current === sessionId && field.value === value) field.value = '';
    if (drafts.get(sessionId) === value) drafts.delete(sessionId);
  };
  const keys = h('div', { className: 'keys', aria: { label: 'Keys' } }, ...KEYS.map((key) => h('button', { type: 'button', onclick: () => void type(key.data), ...(key.name ? { aria: { label: key.name } } : {}) }, key.label)));
  const size = [h('button', { className: 'icon small', type: 'button', onclick: () => resizeText(-1), aria: { label: 'Smaller text' } }, 'A−'), h('button', { className: 'icon small', type: 'button', onclick: () => resizeText(1), aria: { label: 'Larger text' } }, 'A+')];
  app.replaceChildren(header(showList, title, ...size), h('main', { className: 'channel-view' }, waiting, output, problem, keys, form));
  terminal = new Terminal({ cols: channel?.cols ?? 80, rows: channel?.rows ?? 24, fontFamily: TERMINAL_FONT, fontSize: fitFont(channel?.cols ?? 80), lineHeight: 1.2, scrollback: 3000, cursorBlink: false,
    theme: { ...TERMINAL_THEME, cursor: channel ? ENGINE_CURSOR[channel.engine] : TERMINAL_THEME.cursor } });
  terminal.open(output);
  // Typing straight into the terminal (tap it to bring up the keyboard) goes to the CLI as it is typed. The terminal's
  // own replies to the CLI's queries (cursor position and the like, also raised by replayed output) are left out: the
  // desktop's terminal already answers them, and they are not the person answering a prompt.
  terminal.onData((data) => { const typed = withoutTerminalReplies(data); if (typed) void type(typed); });
  renderChannel(); listen(sessionId);
}

function renderChannel() {
  const channel = channels.find((item) => item.sessionId === current); if (!channel) return;
  const title = document.getElementById('channel-title');
  title?.replaceChildren(h('span', { className: 'chip', dataset: { engine: channel.engine } }, `CH${channel.channel}`), ` ${channel.title} `, h('small', { className: `state-${state(channel)}` }, word[state(channel)]));
  const waiting = document.getElementById('waiting');
  if (waiting) { waiting.hidden = !channel.attention; waiting.textContent = channel.attention ? `Waiting for you: ${channel.attention}` : ''; }
  // A restarted channel is a new process: its screen starts afresh, as on the desktop.
  if (channel.runId && channel.runId !== run) { run = channel.runId; inOrder((screen) => screen.reset()); }
  if (channel.cols && channel.rows) resizeTo(channel.cols, channel.rows);
}

/**
 * Applies a change to the terminal once everything written before it has been drawn (xterm draws writes later), and
 * before anything written after: a resize or reset keeps its place among the output, as the CLI produced it.
 */
function inOrder(change: (screen: Terminal) => void) {
  const screen = terminal; screen?.write('', () => { if (terminal === screen) change(screen); });
}
function resizeTo(cols: number, rows: number) {
  inOrder((screen) => { if (screen.cols !== cols || screen.rows !== rows) { screen.options.fontSize = fitFont(cols); screen.resize(cols, rows); } });
}

/** Sends input to the channel being shown; true once the computer has taken it. */
async function type(data: string) {
  const channel = channels.find((item) => item.sessionId === current); const problem = document.getElementById('send-error');
  if (problem) problem.textContent = '';
  if (!channel?.runId || channel.runId !== run) { if (problem) problem.textContent = 'This channel is not running. Start it in Trace on your computer.'; return false; }
  if (data.length > INPUT_LIMIT) { if (problem) problem.textContent = `Messages sent from the phone can be at most ${(INPUT_LIMIT - 1).toLocaleString('en-US')} characters.`; return false; }
  try { await send(channel.sessionId, run, data); return true; }
  catch (e) { if (e instanceof Unpaired) showPair(e.message); else if (problem) problem.textContent = (e as Error).message; return false; }
}

function onEvent(event: StreamEvent) {
  if (event.type === 'channels') { channels = event.data; renderList(); renderChannel(); return; }
  if (event.data.sessionId !== current || !terminal) return;
  if (event.type === 'resize') {
    const channel = channels.find((item) => item.sessionId === event.data.sessionId); if (channel?.runId === event.data.runId) Object.assign(channel, { cols: event.data.cols, rows: event.data.rows });
    if (event.data.runId === run) resizeTo(event.data.cols, event.data.rows);
    return;
  }
  if (event.type === 'replay') {
    run = event.data.runId; inOrder((screen) => screen.reset()); resizeTo(event.data.cols, event.data.rows);
    terminal.write(event.data.data); return;
  }
  if (event.data.runId === run) terminal.write(event.data.data);
}

window.addEventListener('resize', () => { const channel = channels.find((item) => item.sessionId === current); if (terminal && channel?.cols) terminal.options.fontSize = fitFont(channel.cols); });
if (!token.get() || location.hash.startsWith(PAIRING_PREFIX)) showPair(); else showList();
