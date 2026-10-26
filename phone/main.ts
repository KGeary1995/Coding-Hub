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
import { alertsOn, alertsSupported, collectKeys, disableAlerts, enableAlerts, follow, homeName, INPUT_LIMIT, pair, send, token, unpair, Unpaired, type StreamEvent, type Target } from './api';

/** Keys a CLI prompt usually needs, which a phone keyboard does not offer. */
const KEYS: { label: string; name?: string; data: string }[] = [
  { label: 'Enter', data: '\r' }, { label: 'Esc', data: '\x1b' }, { label: '↑', name: 'Up', data: '\x1b[A' }, { label: '↓', name: 'Down', data: '\x1b[B' },
  { label: '1', data: '1' }, { label: '2', data: '2' }, { label: '3', data: '3' }, { label: 'y', data: 'y' }, { label: 'n', data: 'n' },
  { label: 'Tab', data: '\t' }, { label: '←', name: 'Left', data: '\x1b[D' }, { label: '→', name: 'Right', data: '\x1b[C' }, { label: 'Ctrl C', data: '\x03' },
];
const ENGINE = { claude: 'Claude Code', codex: 'Codex', shell: 'Terminal' } as const;

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
/** The other computer the phone is talking to directly while this app's own computer is off, if any. */
let via: string | null = null;
/** Unsent messages, by channel. */
const drafts = new Map<string, string>();
/** A channel an alert asked to open that the phone has not heard of yet: opened when the next channel list has it. */
let opening: string | null = null;

const state = (channel: RemoteChannel) => channel.attention ? 'waiting' : channel.running ? 'running' : 'idle';
const word = { waiting: 'needs you', running: 'running', idle: 'idle' } as const;

function header(back?: () => void, title?: Node, ...tools: Node[]) {
  return h('header', { className: 'bar' },
    back ? h('button', { className: 'icon', onclick: back, aria: { label: 'Back to channels' } }, '‹') : h('span', { className: 'mark' }, h('i'), h('i'), h('i'), ' trace'),
    title ?? h('span'), ...tools,
    h('span', { className: `link ${connected ? 'on' : ''}`, aria: { live: 'polite' } }, linkText()));
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

const linkText = () => !connected ? 'reconnecting…' : via ? `live · ${via}` : 'live';
function listen(sessionId: string | null) {
  stop?.();
  stop = follow(sessionId, onEvent, (value: boolean, target: Target) => {
    connected = value; if (value) via = target.id ? target.name : null;
    for (const link of document.querySelectorAll('.link')) { link.className = `link ${value ? 'on' : ''}`; link.textContent = linkText(); }
    const notice = document.getElementById('direct'); if (notice) { notice.hidden = !via; notice.textContent = via ? `${homeName() ?? 'This app’s computer'} can’t be reached, so this phone is connected straight to ${via}. It switches back by itself.` : ''; }
    // On its own computer, the phone picks up keys to the others, so it can still reach them when this one is off.
    if (value && !target.id) void collectKeys().catch(() => {});
  }, () => showPair('This phone was removed on the computer. Pair it again to continue.'));
}

function showList() {
  disposeTerminal(); current = null; run = null;
  const list = h('ul', { id: 'channel-list', className: 'channels' });
  const remove = h('button', { className: 'quiet', onclick: async () => { if (!confirm('Remove this phone from all your computers? You will need a new pairing code to use it again.')) return; await unpair().catch(() => {}); showPair(); } }, 'Remove this phone');
  app.replaceChildren(header(), h('main', { className: 'list' }, h('h1', {}, 'Channels'), h('p', { id: 'direct', className: 'ask-banner', hidden: !via, aria: { role: 'status' } }), h('nav', { id: 'computer-switcher', className: 'switcher', hidden: true, aria: { label: 'Computer' } }), list, h('p', { id: 'empty', className: 'dim', hidden: true }, 'No channels yet. Open a project in Trace on your computer.'), alertsPanel()), h('footer', {}, remove));
  renderList(); listen(null);
}

/** Alerts: a switch that subscribes this phone to the computer's Web Push alerts, or why it cannot. */
function alertsPanel() {
  const panel = h('section', { className: 'alerts', aria: { labelledby: 'alerts-title' } });
  const render = (on: boolean | null, note = '') => {
    const ios = /iPhone|iPad/.test(navigator.userAgent) && !(navigator as Navigator & { standalone?: boolean }).standalone;
    const button = h('button', { id: 'alerts-switch', type: 'button', className: on ? '' : 'primary', disabled: on === null || !alertsSupported(), aria: { pressed: String(Boolean(on)) },
      onclick: async () => { render(null, ''); try { if (on) await disableAlerts(); else await enableAlerts(); render(await alertsOn()); } catch (e) { render(on, (e as Error).message); } } }, on ? 'Turn off alerts' : 'Turn on alerts');
    panel.replaceChildren(h('h2', { id: 'alerts-title' }, 'Alerts'),
      h('p', { className: 'dim' }, on ? 'This phone is told when a channel needs you or stops with an error.' : 'Get a notification when a channel needs you or stops with an error, even with Trace closed.'),
      !alertsSupported() ? h('p', { className: 'dim' }, ios ? 'On iPhone and iPad, add Trace to your Home Screen first (Share → Add to Home Screen), then open it from there.' : 'This browser cannot receive alerts.') : button,
      h('p', { className: 'error', aria: { role: 'alert' } }, note));
  };
  render(null); if (alertsSupported()) void alertsOn().then((on) => render(on)).catch(() => render(false)); else render(false);
  return panel;
}

/** Which computer's channels the list shows (`''` for every computer); remembered on the phone. */
const COMPUTER_KEY = 'trace-remote-computer';
let shownComputer = localStorage.getItem(COMPUTER_KEY) ?? '';
function computerSwitcher() {
  const computers = [...new Map(channels.flatMap((channel) => channel.computer ? [[channel.computer.id, channel.computer.name] as const] : [])).entries()];
  const switcher = document.getElementById('computer-switcher'); if (!switcher) return;
  switcher.hidden = computers.length < 2;
  // A computer that is off (or unlinked) is not offered; the list falls back to every computer.
  if (shownComputer && !computers.some(([id]) => id === shownComputer)) shownComputer = '';
  const choose = (id: string) => { shownComputer = id; localStorage.setItem(COMPUTER_KEY, id); renderList(); };
  switcher.replaceChildren(...[['', 'All'] as const, ...computers].map(([id, name]) => h('button', { className: id === shownComputer ? 'active' : '', aria: { pressed: String(id === shownComputer) }, onclick: () => choose(id) }, name,
    h('span', { className: 'count' }, String(channels.filter((channel) => (!id || channel.computer?.id === id) && channel.attention).length || '')))));
}

function renderList() {
  const list = document.getElementById('channel-list'); if (!list) return;
  computerSwitcher();
  const shown = channels.filter((channel) => !shownComputer || channel.computer?.id === shownComputer);
  const several = new Set(channels.map((channel) => channel.computer?.id)).size > 1;
  list.replaceChildren(...shown.map((channel) => h('li', {},
    h('button', { className: `channel ${state(channel)}`, onclick: () => showChannel(channel.sessionId) },
      h('span', { className: 'chip', dataset: { engine: channel.engine } }, `CH${channel.channel}`),
      h('span', { className: 'name' }, channel.title, (channel.title !== ENGINE[channel.engine] || several) && h('small', {}, [channel.title !== ENGINE[channel.engine] ? ENGINE[channel.engine] : null, several && !shownComputer ? channel.computer?.name : null].filter(Boolean).join(' · '))),
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
  if (event.type === 'channels') {
    channels = event.data; renderList(); renderChannel();
    // The list that arrives after an alert was tapped (on connecting, or just after) decides whether its channel opens.
    if (opening) { const id = opening; opening = null; if (channels.some((item) => item.sessionId === id)) showChannel(id); }
    return;
  }
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
// Alerts arrive through the service worker; tapping one opens its channel.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (event) => { const id = (event.data as { open?: string }).open; if (id && token.get()) openChannel(id); });
}
/** Opens the channel an alert was for: now if the phone knows it, otherwise once the next channel list includes it. */
function openChannel(id: string) {
  if (channels.some((item) => item.sessionId === id)) { opening = null; showChannel(id); return; }
  // Reconnecting brings a fresh channel list straight away, even if this page was asleep with a dead connection.
  opening = id; showList();
}
const linked = location.hash.startsWith('#channel=') ? decodeURIComponent(location.hash.slice(9)) : null;
if (!token.get() || location.hash.startsWith(PAIRING_PREFIX)) showPair();
else { if (linked) history.replaceState(null, '', '/'); showList(); if (linked) openChannel(linked); }
