import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@xterm/xterm/css/xterm.css';
import '../src/tokens.css';
import './phone.css';
import { mountChat, receiveChat, receiveReplay } from './chat';
import { ENGINE_ICON, iconSvg, mountScreen } from './screens';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { measureLikeTheCLIs } from '../shared/terminal-width';
import { ENGINE_CURSOR, TERMINAL_FONT, TERMINAL_THEME } from '../src/runtime/terminal-theme';
import { unlockKeys, type KeyStroke } from '../src/runtime/screen-channel';
import type RFB from '@novnc/novnc';
import type { ChannelEngine } from '../shared/types';
import { PAIRING_PREFIX, type ChannelControl, type ChannelTranscript, type RemoteChannel, type RemoteChannelChange, type RemoteMe, type RemoteTask } from '../shared/remote';
import { modelLabel } from '../shared/model-name';
import { addChannel, changeChannel, channelSettings, chat, control, whoAmI, activeTarget, alertsOn, alertsSupported, api, collectKeys, releaseChannel, sizeChannel, disableAlerts, enableAlerts, follow, homeName, INPUT_LIMIT, pair, revive, send, token, unpair, Unpaired, type StreamEvent, type Target } from './api';
import { atPhoneSize, FIT_KEY, fitsOnOpen, takenBack } from './size';

/** Keys a CLI prompt usually needs, which a phone keyboard does not offer. */
/** In three rows, all in view without scrolling and each key at least 44 px wide: the named keys, the arrows, the usual answers. */
const KEYS: { label: string; name?: string; data: string }[][] = [
  // Shift+Tab switches Claude Code's mode (plan, auto-accept); a phone keyboard has neither it nor a reliable Backspace here.
  [{ label: 'Enter', data: '\r' }, { label: 'Esc', data: '\x1b' }, { label: 'Tab', data: '\t' }, { label: '⇧Tab', name: 'Shift Tab', data: '\x1b[Z' },
    { label: 'Ctrl C', data: '\x03' }, { label: '⌫', name: 'Backspace', data: '\x7f' }],
  [{ label: '↑', name: 'Up', data: '\x1b[A' }, { label: '↓', name: 'Down', data: '\x1b[B' }, { label: '←', name: 'Left', data: '\x1b[D' }, { label: '→', name: 'Right', data: '\x1b[C' }],
  [{ label: '1', data: '1' }, { label: '2', data: '2' }, { label: '3', data: '3' }, { label: 'y', data: 'y' }, { label: 'n', data: 'n' }],
];
const ENGINE = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', shell: 'Terminal' } as const;

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
/**
 * The height of what can be seen: smaller than the window while a phone's keyboard is open. iOS keeps 100dvh at the
 * full height then, so the chat's message box went under the keyboard; the chat is sized from this (1.31.6).
 */
{ const view = window.visualViewport; if (view) { const set = () => document.documentElement.style.setProperty('--seen-height', `${Math.round(view.height)}px`); view.addEventListener('resize', set); set(); } }
let channels: RemoteChannel[] = []; let current: string | null = null; let run: string | null = null;
let stop: (() => void) | null = null; let terminal: Terminal | null = null; let fit: FitAddon | null = null; let connected = false;
/** The other computer the phone is talking to directly while this app's own computer is off, if any. */
let via: string | null = null;
/** Unsent messages, by channel. */
const drafts = new Map<string, string>();
/** A channel an alert asked to open that the phone has not heard of yet: opened when the next channel list has it. */
let opening: string | null = null;
/** Who this phone is to the computer: whether it may start and stop agents (null until asked). */
let me: RemoteMe | null = null;
/** Removes the chat view shown for a chat channel, when there is one. */
let unmountChat: (() => void) | null = null;
const closeChat = () => { unmountChat?.(); unmountChat = null; };
/** Removes the React screen shown under a tab (Usage, Tasks, History, More), when there is one. */
let unmountScreen: (() => void) | null = null;
const closeScreen = () => { unmountScreen?.(); unmountScreen = null; };

/** The phone's sections, along the bottom as on the redesign: each a stroke icon and a word. */
type Tab = 'channels' | 'usage' | 'tasks' | 'history' | 'more';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'channels', label: 'Channels', icon: '<rect x="3" y="4" width="18" height="16"/><path d="M7 9l3 3-3 3M12 15h5"/>' },
  { id: 'usage', label: 'Usage', icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
  { id: 'tasks', label: 'Tasks', icon: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>' },
  { id: 'history', label: 'History', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  { id: 'more', label: 'More', icon: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>' },
];
function tabBar(active: Tab) {
  return h('nav', { className: 'tabbar', aria: { label: 'Sections' } }, ...TABS.map((tab) => {
    const button = h('button', { type: 'button', className: tab.id === active ? 'active' : '', aria: { current: tab.id === active ? 'page' : 'false' }, onclick: () => { if (tab.id === 'channels') showList(); else showTab(tab.id); } });
    // Fixed markup: the icon is ours, not data.
    button.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${tab.icon}</svg>`;
    button.append(h('span', {}, tab.label));
    return button;
  }));
}
/** Usage, Tasks, History or More: a screen of this computer's state (phone/screens.tsx) above the tabs. */
function showTab(tab: Exclude<Tab, 'channels'>) {
  leaveScreen(); leaveChannel(); disposeTerminal(); closeChat(); closeScreen(); current = null; run = null; shownChat = null;
  const label = TABS.find((item) => item.id === tab)!.label;
  const screen = h('div', { className: 'screen-host' });
  // With more than one computer, which one these are from: the one the phone is connected to, whichever the channel
  // list is showing (before 1.31.6 nothing said so, and picking another computer for the list did not change them).
  const from = activeTarget().name ?? homeName(); const many = new Set(channels.flatMap((channel) => channel.computer ? [channel.computer.id] : [])).size > 1;
  const main = h('main', { className: 'list' }, h('h1', {}, tab === 'more' ? 'Memory' : label), many && from ? h('p', { className: 'dim tab-computer' }, `From ${from}, the computer this phone is connected to`) : '', directNotice(), screen);
  if (tab === 'more') main.append(h('section', { className: 'phone-card' }, h('h2', {}, 'This computer'), h('button', { type: 'button', onclick: () => void showScreen() }, 'Screen')));
  app.replaceChildren(header(), main, tabBar(tab));
  unmountScreen = mountScreen(screen, tab === 'more' ? 'memory' : tab, me?.canRun ?? false);
  listen(null);
}
/** The chat shown, as it was when it was drawn: it is drawn again when that chat starts, stops or restarts. */
let shownChat: string | null = null;

const state = (channel: RemoteChannel) => channel.attention ? 'waiting' : channel.running ? 'running' : channel.failed ? 'failed' : 'idle';
/** The state in the words the computer's tiles use (src/state/channel-state.ts); the phone knows four of the seven. */
const word = { waiting: 'Needs you', running: 'Working', failed: 'Failed', idle: 'Idle' } as const;
/** The state as a badge in its colour: working in the engine's, as on the computer's tiles. */
const badge = (channel: RemoteChannel, className = '') => { const now = state(channel); return h('span', { className: `badge ${{ waiting: 'waiting', running: channel.engine, failed: 'danger', idle: 'neutral' }[now]} ${className}` }, word[now]); };
/** An engine's avatar, as on the computer's tiles. The SVG is fixed markup, not data. */
function avatar(engine: RemoteChannel['engine']) { const element = h('span', { className: `avatar ${engine}`, aria: { hidden: 'true' } }); element.innerHTML = iconSvg(ENGINE_ICON[engine]); return element; }

/** Trace's mark: the keycap (as on the desktop's top bar) and the name. The SVG is fixed markup, not data. */
function mark(big = false) {
  const element = h('span', { className: `mark ${big ? 'big' : ''}` });
  // The app icon's keycap (scripts/make-icon.cjs, its 32 px drawing), the same as the desktop top bar's.
  element.innerHTML = '<svg width="20" height="20" viewBox="34 33 188 188" aria-hidden="true"><path transform="translate(0 16)" fill-rule="evenodd" class="mark-lip" d="M101 35H155c19.570 0 29.354 0 37.073 3.197a42 42 0 0 1 22.730 22.730c3.197 7.718 3.197 17.503 3.197 37.073V140.000c0 19.570 0 29.354 -3.197 37.073a42 42 0 0 1 -22.730 22.730c-7.718 3.197 -17.503 3.197 -37.073 3.197H101c-19.570 0 -29.354 0 -37.073 -3.197a42 42 0 0 1 -22.730 -22.730c-3.197 -7.718 -3.197 -17.503 -3.197 -37.073V98.000c0 -19.570 0 -29.354 3.197 -37.073a42 42 0 0 1 22.730 -22.730c7.718 -3.197 17.503 -3.197 37.073 -3.197ZM76 50H180A8 8 0 0 1 188 58V78A8 8 0 0 1 180 86H154A6 6 0 0 0 148 92V150A8 8 0 0 1 140 158H116A8 8 0 0 1 108 150V92A6 6 0 0 0 102 86H76A8 8 0 0 1 68 78V58A8 8 0 0 1 76 50Z"/><path class="mark-face" fill-rule="evenodd" d="M101 35H155c19.570 0 29.354 0 37.073 3.197a42 42 0 0 1 22.730 22.730c3.197 7.718 3.197 17.503 3.197 37.073V140.000c0 19.570 0 29.354 -3.197 37.073a42 42 0 0 1 -22.730 22.730c-7.718 3.197 -17.503 3.197 -37.073 3.197H101c-19.570 0 -29.354 0 -37.073 -3.197a42 42 0 0 1 -22.730 -22.730c-3.197 -7.718 -3.197 -17.503 -3.197 -37.073V98.000c0 -19.570 0 -29.354 3.197 -37.073a42 42 0 0 1 22.730 -22.730c7.718 -3.197 17.503 -3.197 37.073 -3.197ZM76 66H180A8 8 0 0 1 188 74V94A8 8 0 0 1 180 102H154A6 6 0 0 0 148 108V166A8 8 0 0 1 140 174H116A8 8 0 0 1 108 166V108A6 6 0 0 0 102 102H76A8 8 0 0 1 68 94V74A8 8 0 0 1 76 66Z"/></svg><span>Trace</span>';
  return element;
}
function header(back?: () => void, title?: Node, ...tools: Node[]) {
  return h('header', { className: 'bar' },
    back ? h('button', { className: 'icon', onclick: back, aria: { label: 'Back to channels' } }, '‹') : mark(),
    title ?? h('span'), ...tools,
    h('span', { className: `link ${connected ? 'on' : ''}`, aria: { live: 'polite' } }, linkText()));
}

/** The version this app was built with (vite.phone.config.ts); '' in a build that does not say. */
declare const __TRACE_VERSION__: string | undefined;
const OWN_VERSION = typeof __TRACE_VERSION__ === 'string' ? __TRACE_VERSION__ : '';
const RELOADED_KEY = 'trace-remote-reloaded';
/**
 * The computer that served this app runs another version of Trace than the app was built with: after an update there,
 * the phone still runs the app it had saved, until reloaded (every release said "reload the phone app"). It reloads
 * itself once nothing is open (a channel, the screen, a sheet, an unsent message), and once per version, so a phone
 * that cannot get the new app is not reloaded over and over.
 */
let newer: string | null = null;
function computerVersion(version: string) {
  if (!OWN_VERSION || activeTarget().id || version === OWN_VERSION || sessionStorage.getItem(RELOADED_KEY) === version) return;
  newer = version; reloadWhenIdle();
}
function reloadWhenIdle() {
  if (!newer || current || viewer || drafts.size || document.querySelector('.copy-sheet')) return false;
  sessionStorage.setItem(RELOADED_KEY, newer); newer = null; location.reload(); return true;
}
/** A link's encoded part; a mistyped or cut-off link gives '' rather than a blank page. */
function decoded(value: string) { try { return decodeURIComponent(value); } catch { return ''; } }

function showPair(error = '') {
  leaveScreen(); stop?.(); stop = null; disposeTerminal(); current = null;
  const code = location.hash.startsWith(PAIRING_PREFIX) ? decoded(location.hash.slice(PAIRING_PREFIX.length)) : '';
  const agent = navigator.userAgent; const name = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android phone' : 'Phone';
  const codeInput = h('input', { id: 'code', value: code, autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: false, required: true });
  const nameInput = h('input', { id: 'name', value: name, maxLength: 60 });
  const message = h('p', { className: 'error', aria: { role: 'alert' } }, error);
  const form = h('form', { className: 'pair' },
    mark(true),
    h('div', { className: 'pair-card' },
      h('h1', {}, 'Pair this phone'),
      h('p', { className: 'dim' }, 'Enter the code from Settings → Phone access in Trace on your computer.'),
      h('label', {}, 'Pairing code', codeInput), h('label', {}, 'Name for this phone', nameInput),
      h('button', { className: 'primary', type: 'submit' }, 'Pair'), message));
  form.onsubmit = async (event) => {
    event.preventDefault(); message.textContent = '';
    try { await pair(codeInput.value.trim(), nameInput.value.trim()); history.replaceState(null, '', '/'); showList(); }
    catch (e) { message.textContent = (e as Error).message; }
  };
  app.replaceChildren(form);
}

const linkText = () => !connected ? 'Reconnecting…' : via ? `Live · ${via}` : 'Live';
function listen(sessionId: string | null) {
  stop?.();
  stop = follow(sessionId, onEvent, (value: boolean, target: Target, problem?: string) => {
    connected = value; if (value) via = target.id ? target.name : null;
    for (const link of document.querySelectorAll('.link')) { link.className = `link ${value ? 'on' : ''}`; link.textContent = linkText(); }
    // While nothing is connected, the list says which computer this app is asking for and why it does not answer.
    const text = !value && problem ? problem : via ? `${homeName() ?? 'This app’s computer'} can’t be reached, so this phone is connected straight to ${via}. It switches back by itself.` : '';
    const notice = document.getElementById('direct'); if (notice) { notice.hidden = !text; notice.querySelector('.banner-text')!.textContent = text; }
    showEmpty();
    // On its own computer, the phone picks up keys to the others, so it can still reach them when this one is off.
    if (value && !target.id) void collectKeys().catch(() => {});
    // Opened while the computer could not be reached, the phone did not know what it may do (start, stop, + Channel)
    // until the list was opened again: it asks once a connection is made (1.31.4).
    if (value && !me) void whoAmI().then((found) => { me = found; if (!current) renderList(); else renderChannel(); }).catch(() => {});
  }, () => showPair('This phone was removed on the computer. Pair it again to continue.'));
}

/**
 * The channel screen's buttons in a box of their own, drawn again when the channel starts or stops or what this phone
 * may do becomes known (before 1.31.4 they stayed as first drawn: Start on a channel already running). The box takes
 * no room of its own (phone.css), so the header's layout is the buttons'.
 */
const controlsKey = (channel: RemoteChannel) => `${channel.running}|${me?.canRun ?? ''}|${me?.computer ?? ''}`;
function controlsBox(channel: RemoteChannel) { return h('span', { className: 'channel-controls', id: 'channel-controls', dataset: { key: controlsKey(channel) } }, ...channelControls(channel)); }
/** Start, Stop and Restart for a channel on this computer, when this phone may start and stop agents. */
function channelControls(channel: RemoteChannel): Node[] {
  // Only this computer's own channels: the server does not start or stop another computer's.
  if (!me?.canRun || (channel.computer && channel.computer.id !== me.computer)) return [];
  const press = (value: ChannelControl) => async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    try { await control(channel.sessionId, value); } catch (e) { alertText((e as Error).message); } finally { button.disabled = false; }
  };
  // Restart and Stop are icons with their names, leaving the channel's name room beside them in the header. Fixed markup, not data.
  const iconButton = (className: string, value: ChannelControl, label: string, paths: string) => { const button = h('button', { className: `small icon-only ${className}`, type: 'button', title: label, onclick: press(value), aria: { label: `${label} CH${channel.channel}` } }); button.innerHTML = iconSvg(paths); return button; };
  // Fixed markup: lucide's Settings2.
  const settings = h('button', { className: 'small icon-only', type: 'button', title: 'Channel settings', onclick: () => void showSettings(channel), aria: { label: `Settings for CH${channel.channel}` } }); settings.innerHTML = iconSvg('<path d="M14 17H5"/><path d="M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>');
  return [settings, ...startStop()];
  function startStop() { return channel.running
    ? [iconButton('', 'restart', 'Restart', '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'), iconButton('stop', 'stop', 'Stop', '<rect width="14" height="14" x="5" y="5" rx="2"/>')]
    : [h('button', { className: 'primary small', type: 'button', onclick: press('start'), aria: { label: `Start CH${channel.channel}` } }, 'Start')]; }
}

const PERMISSIONS = [['ask', 'Ask'], ['edits', 'Allow edits'], ['full', 'Full access']] as const;
/** What a permission level lets the agent do, in a line (the computer's settings say more). */
const PERMISSION_NOTE = { ask: 'The agent asks before edits and commands.', edits: 'The agent edits files in the project without asking.', full: 'The agent never asks: any command, any file. Use it only for work you trust.' } as const;
/**
 * A channel's settings, as on its tile on the computer: its name and, for an agent, what it may do without asking, its
 * model (chosen by name from what its CLI lists) and Codex's reasoning effort. Saved on the computer, which applies
 * them as its own settings would: permissions reach a running chat at once, a model waits for the channel to be stopped.
 */
async function showSettings(channel: RemoteChannel) {
  const status = h('span', { className: 'dim', aria: { live: 'polite' } }, 'Reading…'); const body = h('form', { className: 'settings-form' });
  const close = () => sheet.remove();
  const sheet = h('div', { className: 'copy-sheet settings-sheet', aria: { role: 'dialog', modal: 'true', label: 'Channel settings' } },
    h('div', { className: 'copy-bar' }, h('strong', {}, `CH${channel.channel} settings`), status, h('button', { className: 'icon small', type: 'button', onclick: close }, 'Done')), body);
  document.body.append(sheet);
  try {
    const now = await channelSettings(channel.sessionId); status.textContent = '';
    const name = h('input', { value: now.title, maxLength: 100, autocomplete: 'off', aria: { label: 'Channel name' } });
    const fields: Node[] = [h('label', { className: 'field' }, 'Name', name)];
    const agent = now.engine !== 'shell';
    const note = h('small', { className: 'dim' }, now.permissions ? PERMISSION_NOTE[now.permissions] : '');
    const permissions = h('select', { aria: { label: 'Permissions' }, onchange: () => { note.textContent = PERMISSION_NOTE[permissions.value as keyof typeof PERMISSION_NOTE]; } }, ...PERMISSIONS.map(([value, label]) => h('option', { value, selected: value === now.permissions }, label)));
    const cli = ENGINE[now.engine]; const listed = now.models.some((item) => item.id === now.model);
    const model = h('select', { aria: { label: 'Model' }, disabled: now.running, onchange: () => fillEfforts() },
      h('option', { value: '', selected: !now.model }, `${cli}’s default`), ...now.models.map((item) => h('option', { value: item.id, selected: item.id === now.model }, item.name)),
      now.model && !listed ? h('option', { value: now.model, selected: true }, `${modelLabel(now.model)} · saved`) : null);
    const effort = h('select', { aria: { label: 'Reasoning effort' }, disabled: now.running });
    /** The levels the chosen Codex model lists (the usual five when it lists none); one saved that it does not list is kept. */
    const fillEfforts = () => {
      const levels = now.models.find((item) => item.id === model.value)?.efforts ?? ['none', 'low', 'medium', 'high', 'xhigh']; const chosen = effort.options.length ? effort.value : now.effort ?? '';
      effort.replaceChildren(h('option', { value: '' }, `${cli}’s default`), ...levels.map((level) => h('option', { value: level }, level)), ...(chosen && !levels.includes(chosen) ? [h('option', { value: chosen }, `${chosen} · saved`)] : [])); effort.value = chosen;
    };
    if (agent) {
      fields.push(h('label', { className: 'field' }, 'Permissions', permissions, note));
      // No list (the CLI did not answer in time, or is signed out): the model stays as it is, and the computer can change it.
      fields.push(now.models.length ? h('label', { className: 'field' }, 'Model', model) : h('p', { className: 'dim' }, `${cli} did not list its models, so the model stays ${now.model ? modelLabel(now.model) : 'its default'}. Try again in a moment, or change it on the computer.`));
      if (now.engine === 'codex') { fillEfforts(); fields.push(h('label', { className: 'field' }, 'Reasoning effort', effort)); }
      if (now.running) fields.push(h('p', { className: 'dim' }, `The model${now.engine === 'codex' ? ' and reasoning effort change' : ' changes'} only while the channel is stopped.${now.chat ? ' Permissions change at once.' : ' Permissions apply when it next starts.'}`));
    }
    const problem = h('p', { className: 'error', aria: { role: 'alert' } }); const save = h('button', { className: 'primary', type: 'submit' }, 'Save');
    body.replaceChildren(...fields, problem, save);
    body.onsubmit = async (event) => {
      event.preventDefault(); problem.textContent = '';
      // Only what was changed is sent, so a setting changed on the computer meanwhile is not put back.
      const change: RemoteChannelChange = { sessionId: now.sessionId };
      if (name.value.trim() && name.value.trim() !== now.title) change.title = name.value.trim();
      if (agent && permissions.value !== now.permissions) change.permissions = permissions.value as RemoteChannelChange['permissions'];
      if (agent && now.models.length && !now.running && model.value !== (now.model ?? '')) change.model = model.value;
      if (now.engine === 'codex' && !now.running && (effort.value || null) !== (now.effort ?? null)) change.effort = effort.value || null;
      if (Object.keys(change).length === 1) { close(); return; }
      save.disabled = true; status.textContent = 'Saving…';
      try { await changeChannel(change); status.textContent = 'Saved.'; setTimeout(close, 600); }
      catch (error) { status.textContent = ''; problem.textContent = (error as Error).message; save.disabled = false; }
    };
  } catch (error) { status.textContent = ''; body.replaceChildren(h('p', { className: 'error', aria: { role: 'alert' } }, (error as Error).message)); }
}
/** Waits until `find` returns something from the channel list as the computer updates it; null after `ms`. */
async function channelWhere<T>(find: () => T | undefined | null, ms: number): Promise<T | null> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 300))) { const found = find(); if (found) return found; }
  return null;
}
/**
 * Round Table from the phone: the other agent as a chat channel in the same folder on this computer, started, then
 * seated at this chat's table (this chat's agent drives first, two rounds), as the desktop's people button does.
 */
async function openTableHere(channel: RemoteChannel): Promise<string | null> {
  if ((channel.engine !== 'claude' && channel.engine !== 'codex') || !channel.runId) return 'This chat is not running.';
  const other = channel.engine === 'claude' ? 'codex' : 'claude'; const before = new Set(channels.map((item) => item.sessionId));
  try {
    await addChannel(other, true, channel.sessionId);
    const added = await channelWhere(() => channels.find((item) => !before.has(item.sessionId) && item.engine === other && item.chat), 15000);
    if (!added) return 'The other agent’s channel did not appear. Check the computer.';
    await control(added.sessionId, 'start');
    const partner = await channelWhere(() => { const item = channels.find((candidate) => candidate.sessionId === added.sessionId); return item?.running && item.runId ? item : null; }, 60000);
    if (!partner?.runId) return `${other === 'codex' ? 'Codex' : 'Claude Code'} did not start. Check its channel.`;
    await chat({ action: 'table-open', sessionId: channel.sessionId, runId: channel.runId, partner: { sessionId: partner.sessionId, runId: partner.runId }, driver: channel.engine, rounds: 2 });
    return null;
  } catch (e) { return (e as Error).message; }
}
/** A short message in the page's live region (the phone has no toast); inside a channel, in that channel's own error line. */
function alertText(text: string) {
  const line = document.getElementById('phone-alert') ?? document.getElementById('send-error') ?? document.getElementById('control-error'); if (!line) return;
  line.textContent = text; line.hidden = false; setTimeout(() => { if (line.textContent === text) { line.textContent = ''; if (line.id === 'control-error') line.hidden = true; } }, 6000);
}

/** + Channel on the phone: the same kinds as the computer's, in its order (terminals; chats come with a Round Table), added there. Shown when this phone may start agents. */
function addMenu() {
  const kinds: { label: string; engine: ChannelEngine; chat: boolean }[] = [
    { label: 'Terminal', engine: 'shell', chat: false }, { label: 'Claude Code', engine: 'claude', chat: false }, { label: 'Codex', engine: 'codex', chat: false }, { label: 'Gemini CLI', engine: 'gemini', chat: false }];
  const menu = h('div', { className: 'add-menu', hidden: true, aria: { role: 'menu', label: 'New channel' } },
    ...kinds.map((kind) => h('button', { type: 'button', aria: { role: 'menuitem' }, onclick: async () => { menu.hidden = true; try { await addChannel(kind.engine, kind.chat); alertText(`${kind.label} added. Start it from its channel.`); } catch (e) { alertText((e as Error).message); } } }, kind.label)));
  const button = h('button', { id: 'add-channel', className: 'fab', type: 'button', aria: { label: 'New channel', haspopup: 'menu' }, onclick: () => { menu.hidden = !menu.hidden; } }, '+');
  return h('div', { id: 'add-wrap', className: 'add-wrap', hidden: !me?.canRun }, menu, button);
}

/** No channels: the list keeps its place, with an empty state in it. The SVG is fixed markup, not data. */
function emptyList() {
  const element = h('div', { id: 'empty', className: 'empty', hidden: true }); element.innerHTML = iconSvg(ENGINE_ICON.shell);
  element.append(h('strong', {}, 'No channels'), h('p', {}, 'Open a project in Trace on your computer.')); return element;
}
/** Why this app's computer does not answer, or that the phone went to another one, as api.ts and listen() word it. The SVG is fixed markup. */
function directNotice() {
  const element = h('p', { id: 'direct', className: 'banner warning', hidden: !via, aria: { role: 'status' } });
  element.innerHTML = iconSvg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
  element.append(h('span', { className: 'banner-text' })); return element;
}
/**
 * Android's Back and the iPhone's swipe from the edge leave a channel or the screen for the list, as the app's own Back
 * does, instead of closing the app (1.31.6). Opening one adds a step to the browser's history; the app's own Back
 * takes it off again, so a Back on the list still closes the app.
 */
let inner = false;
function enterInner() { if (!inner) { inner = true; history.pushState({ trace: 'inner' }, ''); } }
window.addEventListener('popstate', () => { if (inner) { inner = false; showList(); } });
function showList() {
  if (inner) { inner = false; if (history.state?.trace === 'inner') history.back(); }
  leaveScreen(); leaveChannel(); disposeTerminal(); closeChat(); closeScreen(); current = null; run = null; shownChat = null;
  if (reloadWhenIdle()) return;
  void whoAmI().then((value) => { me = value; renderList(); }).catch(() => {});
  const list = h('ul', { id: 'channel-list', className: 'channels' });
  const remove = h('button', { className: 'quiet', onclick: async () => { if (!confirm('Remove this phone from all your computers? You will need a new pairing code to use it again.')) return; await unpair().catch(() => {}); showPair(); } }, 'Remove this phone');
  app.replaceChildren(header(undefined, undefined, h('button', { className: 'quiet', type: 'button', onclick: () => void showScreen(), title: 'See and control this computer\'s screen' }, 'Screen')), h('main', { className: 'list' }, h('h1', {}, 'Channels'), h('section', { id: 'needs-you', className: 'needs-you', aria: { label: 'Needs you' } }), directNotice(), h('nav', { id: 'computer-switcher', className: 'switcher', hidden: true, aria: { label: 'Computer' } }), list, emptyList(), alertsPanel()), h('footer', {}, remove));
  app.append(addMenu(), h('p', { id: 'phone-alert', className: 'phone-alert', aria: { live: 'polite' } }), tabBar('channels'));
  renderList(); listen(null);
}

/** Keys a phone keyboard lacks, as X keysyms. */
/** Two rows of four, so each key is at least 44 px wide on a phone. */
const SCREEN_KEYS: [string, number, string][][] = [[['Esc', 0xff1b, 'Escape'], ['Tab', 0xff09, 'Tab'], ['⌫', 0xff08, 'Backspace'], ['⏎', 0xff0d, 'Enter']], [['←', 0xff51, 'ArrowLeft'], ['↑', 0xff52, 'ArrowUp'], ['↓', 0xff54, 'ArrowDown'], ['→', 0xff53, 'ArrowRight']]];
let viewer: RFB | null = null;
/**
 * The phone's Screen choices (1.31.7), kept through reconnects: which display of a Windows computer (0: all side by side;
 * before, always all, squeezed into a strip), the picture fitted to the phone or at its own size (then a drag moves
 * around it and a tap still clicks: noVNC's own panning, so a tap lands where it shows), and whether touches control it.
 */
let screenDisplay = 0; let screenActual = false; let screenViewOnly = false;
/** Ends the screen session when the phone leaves the Screen view by any path (Back, a tab, a notification), so it does not run unseen. */
function leaveScreen() { viewer?.disconnect(); viewer = null; }
/**
 * The computer's own screen, carried over this remote: a Mac's through its screen-sharing server (macOS Screen Sharing),
 * which asks for its user name and password (they go to it, not to Trace); a Windows computer's through Trace's screen
 * service, when Share this screen is on there, which the phone's pairing lets in. Tap to click, drag to move, and type
 * with the phone's keyboard. A locked Mac shows black here and takes no keys: macOS shows its lock screen only to Apple's
 * viewer. (These paths are not /api/screen, which a Windows computer that shares its screen passes to that service.)
 */
async function showScreen() {
  enterInner(); closeChat(); closeScreen();
  leaveChannel(); disposeTerminal(); current = null; run = null; leaveScreen();
  const status = h('p', { className: 'dim', aria: { live: 'polite' } }, 'Connecting…');
  const user = h('input', { autocomplete: 'username', autocapitalize: 'none', placeholder: 'Mac user name', aria: { label: 'User name' } });
  const password = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', aria: { label: 'Password' } });
  const signin = h('form', { className: 'compose screen-signin', hidden: true }, user, password, h('button', { className: 'primary', type: 'submit' }, 'Sign in'));
  const view = h('div', { className: 'screen-view', aria: { label: 'Computer screen' } });
  const display = h('select', { className: 'screen-display', hidden: true, aria: { label: 'Display' }, onchange: () => { screenDisplay = Number(display.value); void showScreen(); } });
  const zoom = h('button', { type: 'button', aria: { pressed: String(screenActual) }, onclick: () => { screenActual = !screenActual; zoom.setAttribute('aria-pressed', String(screenActual)); fit(); } }, 'Actual size');
  const only = h('button', { type: 'button', aria: { pressed: String(screenViewOnly) }, onclick: () => { screenViewOnly = !screenViewOnly; only.setAttribute('aria-pressed', String(screenViewOnly)); if (viewer) viewer.viewOnly = screenViewOnly; } }, 'View only');
  const fit = () => { if (!viewer) return; viewer.scaleViewport = !screenActual; viewer.clipViewport = screenActual; viewer.dragViewport = screenActual; };
  const tools = h('div', { className: 'screen-tools' }, display, zoom, only);
  const typing = h('input', { className: 'screen-typing', autocomplete: 'off', autocapitalize: 'none', placeholder: 'Type here to send keys', aria: { label: 'Keys to send' } });
  const send = (keys: KeyStroke[]) => { for (const key of keys) viewer?.sendKey(key.keysym, key.code, key.down); };
  // What the phone's keyboard inserts goes over as key presses; the field itself stays empty.
  typing.addEventListener('input', () => { if (typing.value) { send(unlockKeys(typing.value).filter((key) => key.keysym !== 0xff0d)); typing.value = ''; } });
  typing.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === 'Backspace') { event.preventDefault(); send([{ keysym: event.key === 'Enter' ? 0xff0d : 0xff08, code: event.key, down: true }, { keysym: event.key === 'Enter' ? 0xff0d : 0xff08, code: event.key, down: false }]); } });
  const keys = h('div', { className: 'keys screen-keys', aria: { role: 'group', label: 'Keys' } }, ...SCREEN_KEYS.map((row) => h('div', {}, ...row.map(([label, keysym, code]) => h('button', { type: 'button', onclick: () => send([{ keysym, code, down: true }, { keysym, code, down: false }]), aria: { label: code } }, label)))));
  const back = () => { leaveScreen(); showList(); };
  app.replaceChildren(header(back, h('span', { className: 'title' }, `Screen${activeTarget().name ? ` · ${activeTarget().name}` : ''}`)), h('main', { className: 'screen' }, status, signin, tools, view, typing, keys));
  try {
    const { ticket } = await (await api('/api/phone-screen-ticket', { method: 'POST' })).json() as { ticket: string };
    const { default: Viewer } = await import('@novnc/novnc');
    const origin = activeTarget().base || location.origin;
    const client = new Viewer(view, `${origin.replace(/^http/, 'ws')}/api/phone-screen?ticket=${encodeURIComponent(ticket)}${screenDisplay ? `&display=${screenDisplay}` : ''}`, { shared: true }); viewer = client;
    fit(); client.viewOnly = screenViewOnly; client.showDotCursor = true; client.background = 'transparent';
    let shown = false;
    client.addEventListener('connect', () => {
      shown = true; status.textContent = ''; signin.hidden = true;
      // A Windows computer's displays, when it has more than one (a Mac's screen sharing, or an older Trace, answers 1).
      void api('/api/phone-screen-displays').then((response) => response.json()).then((value: { displays?: number; display?: number }) => {
        const count = Number(value.displays) || 1; if (count < 2 || viewer !== client) return; screenDisplay = Number(value.display) || 0;
        display.replaceChildren(...Array.from({ length: count + 1 }, (_, i) => h('option', { value: String(i), selected: i === screenDisplay }, i ? `Display ${i}` : 'All displays'))); display.hidden = false;
      }).catch(() => { /* No picker. */ });
    });
    client.addEventListener('credentialsrequired', () => { status.textContent = 'Sign in with this computer\'s user name and password.'; signin.hidden = false; user.focus(); });
    signin.onsubmit = (event) => { event.preventDefault(); client.sendCredentials({ username: user.value, password: password.value }); password.value = ''; status.textContent = 'Signing in…'; };
    client.addEventListener('securityfailure', () => { status.textContent = 'That user name and password were not accepted.'; });
    client.addEventListener('disconnect', () => {
      if (viewer !== client) return; viewer = null; signin.hidden = true;
      const again = h('button', { className: 'quiet', type: 'button', onclick: () => void showScreen() }, 'Reconnect');
      status.replaceChildren('The screen connection closed. ', again);
      // Never connected: the computer says why (its screen service refused, or could not capture the screen). An older Trace has no answer.
      if (!shown) void api('/api/phone-screen-problem').then((response) => response.json()).then((value: { error?: string | null }) => { if (value.error && status.contains(again)) status.replaceChildren(`${value.error} `, again); }).catch(() => {});
    });
  } catch (error) { status.textContent = (error as Error).message; }
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
      !alertsSupported() ? h('p', { className: 'dim' }, ios ? 'On iPhone and iPad, alerts need Trace on the Home Screen (Share → Add to Home Screen).' : 'This browser cannot receive alerts.') : button,
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

/** Whose Claude account a channel runs on (personal, work…), in that account's colour, as on the computer's tiles. */
const tone = (channel: RemoteChannel): Record<string, string> => channel.account ? { account: String(channel.account.tone % 4) } : {};
const account = (channel: RemoteChannel) => channel.account ? h('span', { className: 'account', dataset: tone(channel) }, channel.account.name) : '';
/** The tasks of the computer shown, read at most every 30 s for Needs you. */
let phoneTasks: RemoteTask[] = []; let tasksRead = 0;
function readTasks() {
  if (Date.now() - tasksRead < 30000) return; tasksRead = Date.now();
  void api('/api/tasks').then((response) => response.json()).then((value: RemoteTask[]) => { phoneTasks = Array.isArray(value) ? value : []; renderNeeds(); }).catch(() => { /* Shown without tasks. */ });
}
/** Needs you, as on the computer: approvals with the exact request first, then tasks that stopped, went quiet or are ready for review. */
function renderNeeds() {
  const box = document.getElementById('needs-you'); if (!box) return;
  const asking = channels.filter((channel) => channel.attention && (!shownComputer || channel.computer?.id === shownComputer));
  const flagged = phoneTasks.filter((task) => task.status === 'review' || (task.status === 'working' && task.outcome && task.outcome !== 'finished'));
  const why = (task: RemoteTask) => task.status === 'review' ? 'ready for review' : task.outcome === 'failed' ? 'channel failed' : task.outcome === 'stopped' ? 'channel stopped' : task.outcome === 'blocked' ? 'waiting for you' : task.outcome === 'unconfirmed' ? 'not confirmed done' : 'gone quiet';
  box.hidden = !asking.length && !flagged.length;
  box.replaceChildren(h('h2', {}, 'Needs you ', h('span', { className: 'count waiting' }, String(asking.length + flagged.length))), h('ul', {},
    ...asking.map((channel) => h('li', {}, h('button', { type: 'button', className: 'need waiting', onclick: () => showChannel(channel.sessionId) }, h('strong', {}, `CH${channel.channel} needs approval`), h('span', {}, channel.attention ?? '')))),
    ...flagged.map((task) => h('li', {}, h('button', { type: 'button', className: `need ${task.outcome ?? 'review'}`, onclick: () => showTab('tasks') }, h('strong', {}, task.title), h('span', {}, `${task.channel ? `CH${task.channel} · ` : ''}${why(task)}`))))));
}
/** What a channel is, under its name: the engine (unless that is its name), a chat or a Round Table (two agents in one channel), and whose computer. */
const meta = (channel: RemoteChannel, several: boolean) => [channel.title !== ENGINE[channel.engine] ? ENGINE[channel.engine] : null, channel.table ? 'Round Table' : channel.chat ? 'Chat' : null, several && !shownComputer ? channel.computer?.name : null].filter(Boolean).join(' · ');
/** "No channels" only while the computer answers: while it does not, the notice above the list says why nothing is listed. */
function showEmpty() { const empty = document.getElementById('empty'); if (empty) empty.hidden = channels.length > 0 || !connected; }
function renderList() {
  const list = document.getElementById('channel-list'); if (!list) return;
  renderNeeds(); readTasks();
  computerSwitcher();
  const shown = channels.filter((channel) => !shownComputer || channel.computer?.id === shownComputer);
  const several = new Set(channels.map((channel) => channel.computer?.id)).size > 1;
  list.replaceChildren(...shown.map((channel) => h('li', {},
    h('button', { className: `channel ${state(channel)}`, dataset: tone(channel), onclick: () => showChannel(channel.sessionId) },
      avatar(channel.engine),
      h('span', { className: 'main' }, h('span', { className: 'line' }, h('span', { className: 'chip', dataset: { engine: channel.engine } }, `CH${channel.channel}`), h('strong', {}, channel.title)), (meta(channel, several) || channel.account) && h('span', { className: 'line' }, meta(channel, several) && h('small', {}, meta(channel, several)), account(channel))),
      badge(channel, 'tag'),
      channel.topic && h('span', { className: 'topic' }, channel.topic),
      channel.attention ? h('span', { className: 'ask' }, channel.attention) : !channel.running && channel.failed && h('span', { className: 'ask failed' }, channel.failed)))));
  showEmpty();
  const add = document.getElementById('add-wrap'); if (add) add.hidden = !me?.canRun;
}

function disposeTerminal() { terminal?.dispose(); terminal = null; fit = null; }

/**
 * The phone shows a channel at its own size, like tmux: it works out how many columns and rows fit its screen at the
 * chosen text size and asks the computer to redraw the CLI at that size. The computer puts the desktop's size back
 * when the phone leaves the channel or disconnects, or the person types at the desktop. A− / A+ change the text size
 * (remembered on the phone), which changes how much fits.
 *
 * Opening a terminal channel takes it at the phone's size at once, even while the computer is in use, as "Fit to
 * phone" does (phone/size.ts): every request carries `force`. The phone holds that size only while it is in use: it
 * is given back when the phone is locked or the app is in the background, or when the computer is used after the phone
 * has gone untouched for ten seconds, and once the desktop has taken it back the
 * phone asks again only when the person uses the phone (opens the channel, touches it, types or changes the text
 * size), not when it merely reconnects, wakes or its screen changes. "Desktop size" is remembered on the phone: the
 * next channel opens at the desktop's size, and the phone asks for nothing until "Fit to phone".
 */
const SIZE_KEY = 'trace-remote-font';
let textSize = Math.max(9, Math.min(20, Number(localStorage.getItem(SIZE_KEY)) || 13));
let chosenSize = localStorage.getItem(FIT_KEY);
let sizeTimer: ReturnType<typeof setTimeout> | null = null; let sentSize = '';
/** Whether the phone wants the channel at its size, and the size it last asked for. */
let holding = false; let asked: { cols: number; rows: number } | null = null; let askedBefore: { cols: number; rows: number } | null = null;
/**
 * Whether the computer has drawn the channel at the phone's size. At the desktop's size the phone shows that layout
 * with its text shrunk to fit the screen's width. `shownAtPhone`: what the button shows, and so what pressing it does.
 */
let granted = false; let askAgain = false; let shownAtPhone = false;
/** The person is using the phone: the channel is drawn at the phone's size again, unless they chose "Desktop size". */
function useChannel() {
  if (!fitsOnOpen(chosenSize)) return;
  // Already at the phone's size: tell the computer the phone is still in use (at most every few seconds), since a
  // computer in use takes the channel back from a phone that has gone quiet (PHONE_QUIET_MS there).
  if (holding && sentSize) { if (granted && Date.now() - touched > 4000) { touched = Date.now(); askAgain = true; requestSize(0); } return; }
  holding = true; sentSize = ''; requestSize();
}
/** When a touch last told the computer the phone is in use. */
let touched = 0;
/** `wait` gathers a burst of screen changes into one request; a channel's fresh screen asks at once. */
function requestSize(wait = 200) {
  if (!holding || document.visibilityState !== 'visible') return;
  if (sizeTimer) clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => {
    sizeTimer = null; const dims = fit?.proposeDimensions();
    // The desktop may have taken the channel back, or the phone been locked, while this waited.
    if (!holding || document.visibilityState !== 'visible') return;
    if (!current || !run || !terminal || !dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    // What fits at the chosen text size, even while the text is shrunk to show the desktop's layout.
    const scale = (terminal.options.fontSize ?? textSize) / textSize;
    const cols = Math.max(20, Math.min(300, Math.floor(dims.cols * scale))); const rows = Math.max(6, Math.min(200, Math.floor(dims.rows * scale))); const again = askAgain; askAgain = false;
    const key = `${current}:${run}:${cols}x${rows}`;
    if (key === sentSize && !again) return; sentSize = key; askedBefore = asked; asked = { cols, rows };
    const channel = current; const asking = run;
    // Always with force: the phone asks only while the person holds it, and an unforced request waits for the computer to go unused.
    void sizeChannel(channel, asking, cols, rows, true).then((held) => { if (current === channel && run === asking) { granted = held; fitText(); } }).catch(() => { sentSize = ''; });
  }, wait);
}
/** Gives the channel being left back to the desktop's size. */
function leaveChannel() { if (current) void releaseChannel(current).catch(() => {}); sentSize = ''; holding = false; asked = null; askedBefore = null; granted = false; }
function resizeText(step: number) {
  textSize = Math.max(9, Math.min(20, textSize + step)); localStorage.setItem(SIZE_KEY, String(textSize));
  if (terminal) { terminal.options.fontSize = textSize; if (fitsOnOpen(chosenSize)) holding = true; fitText(); requestSize(); }
}
/** At the phone's size, the chosen text size; at the desktop's size, small enough that its width fits the screen. */
function fitText() {
  if (!terminal || !fit) return;
  shownAtPhone = atPhoneSize(granted, holding);
  document.getElementById('fit-phone')?.replaceChildren(shownAtPhone ? 'Desktop size' : 'Fit to phone');
  // Back at the chosen text size, ask again: the size asked for while the text was shrunk can be a row or column short.
  if (shownAtPhone) { if (terminal.options.fontSize !== textSize) { terminal.options.fontSize = textSize; requestSize(); } return; }
  const dims = fit.proposeDimensions(); if (!dims || !Number.isFinite(dims.cols) || dims.cols <= 0) return;
  const fits = (terminal.options.fontSize ?? textSize) * dims.cols / terminal.cols;
  // Below 6 px the text cannot be read; the screen then pans sideways instead.
  const size = Math.max(6, Math.min(textSize, Math.floor(fits * 2) / 2));
  if (terminal.options.fontSize !== size) terminal.options.fontSize = size;
}
/** "Fit to phone" takes the channel at the phone's size now; "Desktop size" gives it back. The choice is kept on the phone for the next channel. */
function toggleFit() {
  if (!current) return;
  if (shownAtPhone) { chosenSize = 'desktop'; localStorage.setItem(FIT_KEY, chosenSize); void releaseChannel(current).catch(() => {}); granted = false; holding = false; sentSize = ''; fitText(); return; }
  chosenSize = null; localStorage.removeItem(FIT_KEY); holding = true; askAgain = true; sentSize = ''; fitText(); requestSize();
}

function showChannel(sessionId: string) {
  enterInner(); leaveScreen();
  if (current !== sessionId) leaveChannel();
  current = sessionId; run = null; holding = fitsOnOpen(chosenSize); granted = false; disposeTerminal();
  const channel = channels.find((item) => item.sessionId === sessionId);
  // Set again below if this one is a chat, so a terminal shown after a chat is not taken for that chat.
  closeChat(); shownChat = null;
  // A chat channel: the conversation itself, as on the computer (phone/chat.tsx), with its approvals and Round Table.
  if (channel?.chat && (channel.engine === 'claude' || channel.engine === 'codex')) {
    holding = false; shownChat = `${channel.sessionId}:${channel.runId}:${channel.running}`;
    const container = h('main', { className: 'chat-host' });
    // Where Start, Stop and Restart say why they failed: a chat has no send-error line of its own here.
    app.replaceChildren(header(showList, h('span', { className: 'title', id: 'channel-title' }), controlsBox(channel)), h('p', { id: 'control-error', className: 'error control-error', hidden: true, aria: { role: 'alert' } }), container);
    unmountChat = mountChat(container, { sessionId, runId: channel.runId, engine: channel.engine, running: channel.running, send: chat,
      ...(me?.canRun && (!channel.computer || channel.computer.id === me.computer) ? { openTable: () => openTableHere(channel) } : {}),
      follow: (id) => follow(id, (event) => { if (event.type === 'chat') receiveChat(event.data); else if (event.type === 'chat-replay') receiveReplay(event.data); }, () => {}, () => {}) });
    renderChannel(); listen(sessionId);
    return;
  }
  const title = h('span', { className: 'title', id: 'channel-title' });
  const waiting = h('p', { id: 'waiting', className: 'banner waiting', hidden: true, aria: { role: 'status' } });
  const coach = h('div', { id: 'coach', className: 'coach', hidden: true, aria: { role: 'status', label: 'Prompt coaching' } });
  const output = h('div', { id: 'output', className: 'terminal', aria: { label: 'Channel output' } });
  const problem = h('p', { id: 'send-error', className: 'error', aria: { role: 'alert' } });
  const sendingLine = h('p', { id: 'sending', className: 'dim sending', hidden: true, aria: { role: 'status' } }, 'Sending…');
  const text = h('input', { id: 'text', autocomplete: 'off', placeholder: 'Type here, then Send', enterKeyHint: 'send', aria: { label: 'Message' } });
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
  const keys = h('div', { className: 'keys', aria: { role: 'group', label: 'Keys' } }, ...KEYS.map((row) => h('div', {}, ...row.map((key) => h('button', { type: 'button', onclick: () => void type(key.data), ...(key.name ? { aria: { label: key.name } } : {}) }, key.label)))));
  // The channel's tools sit with the keys, under the thumb, leaving the header room for the channel's name.
  const tools = h('div', { className: 'tools', aria: { role: 'toolbar', label: 'Channel' } }, h('button', { type: 'button', onclick: () => showCopy(), aria: { label: 'Copy text from the channel' } }, 'Copy'),
    channel && (channel.engine === 'claude' || channel.engine === 'codex') ? h('button', { type: 'button', onclick: () => void showConversation(sessionId), title: 'The whole conversation, including what was said before restarts' }, 'Conversation') : null,
    h('button', { id: 'fit-phone', type: 'button', onclick: toggleFit, title: 'Fit to phone draws the channel at this screen\'s size until you type in it on the computer. Desktop size shows the computer\'s size, and this phone opens the next channel that way too.' }, 'Fit to phone'),
    h('button', { type: 'button', onclick: () => resizeText(-1), aria: { label: 'Smaller text' } }, 'A−'), h('button', { type: 'button', onclick: () => resizeText(1), aria: { label: 'Larger text' } }, 'A+'));
  // Touching anything in the channel (the screen, the keys, the message box) is using it.
  const selected = h('div', { className: 'select-bar', hidden: true, aria: { role: 'toolbar', label: 'Selected text' } });
  app.replaceChildren(header(showList, title, ...(channel ? [controlsBox(channel)] : [])), h('main', { className: 'channel-view', onpointerdown: useChannel }, waiting, coach, output, selected, problem, sendingLine, tools, keys, form));
  terminal = new Terminal({ cols: channel?.cols ?? 80, rows: channel?.rows ?? 24, fontFamily: TERMINAL_FONT, fontSize: textSize, lineHeight: 1.2, scrollback: 3000, cursorBlink: false, allowProposedApi: true,
    theme: { ...TERMINAL_THEME, cursor: channel ? ENGINE_CURSOR[channel.engine] : TERMINAL_THEME.cursor } });
  measureLikeTheCLIs(terminal); fit = new FitAddon(); terminal.loadAddon(fit);
  terminal.open(output);
  // The terminal only shows the channel. Typed straight into it, a phone keyboard's autocorrect and predictions rewrite
  // words as they are typed and every rewrite reaches the CLI, garbling the text; so tapping the terminal opens the
  // message box instead, where the keyboard works as in any text field. Its replies to the CLI's queries are not sent
  // either: the desktop's terminal answers them.
  terminal.options.disableStdin = true; terminal.textarea?.setAttribute('inputmode', 'none'); terminal.textarea?.setAttribute('tabindex', '-1');
  output.addEventListener('click', (event) => { if (terminal && !tapScreen(output, terminal, event)) text.focus(); });
  selectByHold(output, terminal, selected); scrollBySwipe(output, terminal);
  fitText(); renderChannel(); listen(sessionId);
}

/**
 * Swiping scrolls the channel. xterm 6 scrolls only for the mouse wheel (it has no touch scrolling), so the phone does
 * it: a CLI drawn in the normal screen scrolls the terminal's own scrollback, and a full-screen CLI that takes mouse
 * reports (Claude Code's full-screen view, whose alternate screen has no scrollback) is sent wheel reports instead, one
 * per line swiped (SGR encoding, which Claude Code asks for). A horizontal swipe is left to the browser, which pans a
 * desktop-sized channel that is wider than the screen.
 */
function scrollBySwipe(element: HTMLElement, screen: Terminal) {
  let last: { x: number; y: number } | null = null; let swiped = 0; let vertical: boolean | null = null;
  element.addEventListener('touchstart', (event) => { last = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; swiped = 0; vertical = null; }, { capture: true, passive: true });
  element.addEventListener('touchmove', (event) => {
    if (last === null || event.touches.length !== 1) return;
    const { clientX: x, clientY: y } = event.touches[0];
    vertical ??= Math.abs(y - last.y) >= Math.abs(x - last.x) ? true : Math.abs(x - last.x) > 4 ? false : null;
    if (vertical !== true) { if (vertical === false) last = null; return; }
    event.preventDefault(); event.stopPropagation();
    swiped += last.y - y; last = { x, y };
    const line = element.clientHeight / screen.rows; const lines = Math.trunc(swiped / line); if (!lines || terminal !== screen) return;
    swiped -= lines * line;
    // Moving the finger up shows newer lines (wheel down, 65); moving it down shows older ones (wheel up, 64).
    if (fullScreen(screen)) void type(`\x1b[<${lines > 0 ? 65 : 64};${Math.ceil(screen.cols / 2)};${Math.ceil(screen.rows / 2)}M`.repeat(Math.abs(lines)));
    else screen.scrollLines(lines);
  }, { capture: true, passive: false });
  element.addEventListener('touchend', () => { last = null; }, { capture: true, passive: true });
}

/** A full-screen CLI that takes mouse reports (Claude Code's full-screen view). */
const fullScreen = (screen: Terminal) => screen.buffer.active.type === 'alternate' && screen.modes.mouseTrackingMode !== 'none';

/**
 * A tap on a full-screen CLI is a click there (press and release, SGR encoding), so its own buttons work, such as the
 * one in Claude Code's full-screen view that jumps back to the newest output; the message box below is tapped to type.
 * Returns false for a CLI drawn in the normal screen, where a tap opens the message box.
 */
function tapScreen(element: HTMLElement, screen: Terminal, event: MouseEvent) {
  if (!fullScreen(screen)) return false;
  const { col, row } = cellAt(element, screen, event.clientX, event.clientY);
  void type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`); return true;
}
/** The on-screen cell (from 0) under a point, from the drawn grid's bounds, which include any panning of a wide channel. */
function cellAt(element: HTMLElement, screen: Terminal, x: number, y: number) {
  const grid = (element.querySelector('.xterm-screen') ?? element).getBoundingClientRect();
  return { col: Math.min(screen.cols - 1, Math.max(0, Math.floor((x - grid.left) / (grid.width / screen.cols)))), row: Math.min(screen.rows - 1, Math.max(0, Math.floor((y - grid.top) / (grid.height / screen.rows)))) };
}

/**
 * Press and hold the channel to select text, and drag to select more; a bar then offers to copy it. xterm selects only
 * with a mouse, so the phone drives xterm's own selection, which works in a full-screen CLI too (where a mouse drag
 * would go to the CLI). The text is taken when the finger lifts, so a redraw that clears the selection loses nothing.
 * Registered before the swipe, so a drag that selects does not also scroll.
 */
function selectByHold(element: HTMLElement, screen: Terminal, bar: HTMLElement) {
  let timer: ReturnType<typeof setTimeout> | undefined; let start: { x: number; y: number } | null = null;
  let anchor: { col: number; row: number } | null = null; let swallowClick = false;
  const cell = (x: number, y: number) => { const at = cellAt(element, screen, x, y); return { col: at.col, row: at.row + screen.buffer.active.viewportY }; };
  const extend = (x: number, y: number) => {
    if (!anchor) return; const end = cell(x, y);
    const [from, to] = end.row < anchor.row || (end.row === anchor.row && end.col < anchor.col) ? [end, anchor] : [anchor, end];
    screen.select(from.col, from.row, (to.row - from.row) * screen.cols + to.col - from.col + 1);
  };
  const close = () => { screen.clearSelection(); bar.hidden = true; bar.replaceChildren(); };
  const offer = (text: string) => {
    const status = h('span', { className: 'dim', aria: { live: 'polite' } }, `${text.length.toLocaleString()} characters`);
    bar.replaceChildren(status, h('button', { className: 'primary', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(text); status.textContent = 'Copied.'; setTimeout(close, 800); }
      catch { close(); showCopy(); }
    } }, 'Copy'), h('button', { type: 'button', onclick: close }, 'Cancel'));
    bar.hidden = false;
  };
  element.addEventListener('touchstart', (event) => {
    clearTimeout(timer); anchor = null; start = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; if (!start) return;
    const at = start; timer = setTimeout(() => { if (terminal !== screen) return; anchor = cell(at.x, at.y); extend(at.x, at.y); navigator.vibrate?.(10); }, 450);
  }, { capture: true, passive: true });
  element.addEventListener('touchmove', (event) => {
    const touch = event.touches[0]; if (!touch) return;
    if (anchor) { event.preventDefault(); event.stopImmediatePropagation(); extend(touch.clientX, touch.clientY); return; }
    if (start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 8) { clearTimeout(timer); start = null; }
  }, { capture: true, passive: false });
  const end = (event: TouchEvent) => {
    clearTimeout(timer); start = null; if (!anchor) return;
    // Moves can be dropped or merged; where the finger lifts is where the selection ends.
    const lifted = event.type === 'touchend' ? event.changedTouches[0] : undefined; if (lifted) extend(lifted.clientX, lifted.clientY);
    anchor = null;
    // A browser that sends no click after a hold must not swallow the next real tap.
    swallowClick = true; setTimeout(() => { swallowClick = false; }, 400);
    const text = screen.getSelection(); if (text.trim()) offer(text); else close();
  };
  element.addEventListener('touchend', end, { capture: true, passive: true }); element.addEventListener('touchcancel', end, { capture: true, passive: true });
  // The tap that ends a hold, or one that dismisses a selection, neither opens the message box nor clicks in the CLI.
  element.addEventListener('click', (event) => {
    if (!swallowClick && bar.hidden) return;
    if (!swallowClick) close(); swallowClick = false; event.stopPropagation(); event.preventDefault();
  }, { capture: true });
  element.addEventListener('contextmenu', (event) => event.preventDefault());
}

/**
 * The channel's text in a sheet the phone can select from: xterm has no touch selection, and tapping the terminal
 * opens the message box. Shows the whole scrollback (a full-screen CLI's alternate screen has only what is shown).
 */
function showCopy() {
  if (!terminal) return;
  const buffer = terminal.buffer.active; const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const text = lines.join('\n');
  const body = h('pre', { className: 'copy-text', tabIndex: 0 }, text || '(Nothing to copy yet.)');
  const status = h('span', { className: 'dim', aria: { live: 'polite' } });
  const close = () => sheet.remove();
  const copyAll = h('button', { className: 'primary', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(text); status.textContent = 'Copied.'; }
    catch { const range = document.createRange(); range.selectNodeContents(body); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); status.textContent = 'Selected: use Copy from the menu.'; }
  } }, 'Copy all');
  const sheet = h('div', { className: 'copy-sheet', aria: { role: 'dialog', modal: 'true', label: 'Copy text' } },
    h('div', { className: 'copy-bar' }, h('strong', {}, 'Copy text'), status, copyAll, h('button', { className: 'icon small', type: 'button', onclick: close }, 'Done')),
    h('p', { className: 'dim' }, 'Press and hold to select part of it, or copy it all.'), body);
  document.body.append(sheet); body.scrollTop = body.scrollHeight;
}

/**
 * A Claude Code or Codex channel's whole conversation, from its CLI's transcript on the computer: the screen shows only
 * the current run, so this is where what was said before a restart can be read again.
 */
async function showConversation(sessionId: string) {
  const status = h('span', { className: 'dim', aria: { live: 'polite' } }, 'Reading…');
  const body = h('div', { className: 'copy-text conversation', tabIndex: 0 });
  const sheet = h('div', { className: 'copy-sheet', aria: { role: 'dialog', modal: 'true', label: 'Conversation' } },
    h('div', { className: 'copy-bar' }, h('strong', {}, 'Conversation'), status, h('button', { className: 'icon small', type: 'button', onclick: () => sheet.remove() }, 'Done')), body);
  document.body.append(sheet);
  try {
    const { transcript } = await (await api(`/api/transcript?sessionId=${encodeURIComponent(sessionId)}`)).json() as { transcript: ChannelTranscript };
    if (!transcript?.messages.length) { status.textContent = ''; body.append(h('p', { className: 'dim' }, 'No saved conversation yet. It appears once the agent has answered in this channel.')); return; }
    status.textContent = transcript.messages.length === 200 ? 'Latest 200 messages' : '';
    for (const message of transcript.messages) {
      if (message.role === 'user') { body.append(h('p', { className: 'said you' }, h('b', {}, 'You  '), message.text || (message.images ? `(${message.images === 1 ? 'an image' : `${message.images} images`})` : ''))); continue; }
      for (const block of message.blocks) {
        if (block.type === 'text') body.append(h('p', { className: 'said agent' }, block.text));
        else if (block.type === 'tool') body.append(h('p', { className: 'said tool dim' }, `▸ ${block.name}`));
      }
    }
    body.scrollTop = body.scrollHeight;
  } catch (error) { status.textContent = ''; body.append(h('p', { className: 'error', aria: { role: 'alert' } }, (error as Error).message)); }
}

/** Live coaching on the prompt last sent in the channel, as on the desktop, with Ask AI for a channel on the computer this phone talks to. */
let coachAsking: string | null = null; let coachDismissed: string | null = null; let coachError = '';
function renderCoach(channel: RemoteChannel) {
  const box = document.getElementById('coach'); if (!box) return;
  const tip = channel.coaching; if (!tip || coachDismissed === tip.id) { box.hidden = true; return; }
  box.hidden = false;
  // This computer's own channels carry its name too (remote-server stamps them), so "own" is the same computer, not no
  // computer: with no computer name the button never showed (before 1.31.4).
  const ask = !tip.review && (!channel.computer || channel.computer.id === me?.computer) && h('button', { className: 'quiet', disabled: coachAsking === tip.id, onclick: async () => {
    coachAsking = tip.id; coachError = ''; renderCoach(channel);
    try { const response = await api('/api/coaching-review', { method: 'POST', body: JSON.stringify({ id: tip.id }) }); if (!response.ok) coachError = ((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'The prompt could not be reviewed.'; }
    catch (error) { coachError = (error as Error).message; }
    finally { coachAsking = null; const now = channels.find((item) => item.sessionId === channel.sessionId); if (now) renderCoach(now); }
  } }, coachAsking === tip.id ? 'Asking…' : 'Ask AI');
  box.replaceChildren(
    ...(tip.review ? [h('p', {}, tip.review.advice), h('details', {}, h('summary', {}, 'Suggested rewrite'), h('pre', {}, tip.review.rewrite))] : tip.tips.map((text) => h('p', {}, text))),
    ...(coachError ? [h('p', { className: 'error' }, coachError)] : []),
    h('div', { className: 'coach-actions' }, ...(ask ? [ask] : []), h('button', { className: 'quiet', onclick: () => { coachDismissed = tip.id; box.hidden = true; } }, 'Dismiss')));
}

function renderChannel() {
  const channel = channels.find((item) => item.sessionId === current); if (!channel) return;
  const title = document.getElementById('channel-title');
  // Two lines, so the name keeps its room beside the channel's buttons: CH2 and the name, then the state and the account.
  title?.replaceChildren(h('span', { className: 'title-line' }, h('span', { className: 'chip', dataset: { engine: channel.engine } }, `CH${channel.channel}`), h('span', { className: 'title-name' }, channel.title)), h('span', { className: 'title-line' }, badge(channel, `state-${state(channel)}`), account(channel)));
  const controls = document.getElementById('channel-controls'); if (controls && controls.dataset.key !== controlsKey(channel)) controls.replaceWith(controlsBox(channel));
  const waiting = document.getElementById('waiting');
  if (waiting) { waiting.hidden = !channel.attention; waiting.textContent = channel.attention ? `Waiting for you: ${channel.attention}` : ''; }
  renderCoach(channel);
  // A chat has no screen to size or reset: its view follows the conversation itself.
  if (channel.chat) return;
  // A restarted channel is a new process: its screen starts afresh, as on the desktop, at the desktop's size until the phone's is granted.
  if (channel.runId && channel.runId !== run) { run = channel.runId; granted = false; inOrder((screen) => screen.reset()); requestSize(); }
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
  inOrder((screen) => { if (screen.cols !== cols || screen.rows !== rows) screen.resize(cols, rows); fitText(); });
}

/** Sends input to the channel being shown; true once the computer has taken it. */
async function type(data: string) {
  const channel = channels.find((item) => item.sessionId === current); const problem = document.getElementById('send-error');
  if (problem) problem.textContent = '';
  if (!channel?.runId || channel.runId !== run) { if (problem) problem.textContent = 'This channel is not running. Start it in Trace on your computer.'; return false; }
  if (data.length > INPUT_LIMIT) { if (problem) problem.textContent = `Messages sent from the phone can be at most ${(INPUT_LIMIT - 1).toLocaleString('en-US')} characters.`; return false; }
  // A slow network: say the key is on its way, so a tap that shows nothing yet is not taken for one that was lost.
  // A status, not the alert line; it stays while any key is still on its way.
  sending++; const slow = setTimeout(() => { const line = document.getElementById('sending'); if (line && sending) line.hidden = false; }, 1000);
  try { await send(channel.sessionId, run, data); return true; }
  // Only this app's own computer unpairing the phone means pairing again; another computer's key being removed does not.
  catch (e) { if (e instanceof Unpaired && e.home) showPair(e.message); else if (problem) problem.textContent = e instanceof Unpaired ? 'That computer no longer accepts this phone. Remove and add it again under Settings → Phone access there.' : (e as Error).message; return false; }
  finally { clearTimeout(slow); const line = document.getElementById('sending'); if (!--sending && line) line.hidden = true; }
}
/** Keys typed on the phone that the computer has not taken yet. */
let sending = 0;

function onEvent(event: StreamEvent) {
  if (event.type === 'chat') { receiveChat(event.data); return; }
  if (event.type === 'chat-replay') { receiveReplay(event.data); return; }
  if (event.type === 'me') { me = event.data; renderList(); if (current) showChannel(current); return; }
  if (event.type === 'version') { computerVersion(event.data); return; }
  if (event.type === 'channels') {
    channels = event.data; renderList(); renderChannel();
    // A chat shown here that started, stopped or restarted is drawn again for its new run.
    const shown = channels.find((item) => item.sessionId === current);
    // Drawn again when the chat starts, stops or restarts, and when the channel turns out to be a chat (or not) after it
    // was opened as the other kind: opened from an alert before the list arrived, it was drawn as a terminal and stayed one.
    const wanted = shown?.chat && shown.engine !== 'shell' ? `${shown.sessionId}:${shown.runId}:${shown.running}` : null;
    if (shown && wanted !== shownChat) showChannel(shown.sessionId);
    // The list that arrives after an alert was tapped (on connecting, or just after) decides whether its channel opens.
    if (opening) { const id = opening; opening = null; if (channels.some((item) => item.sessionId === id)) showChannel(id); }
    return;
  }
  if (event.data.sessionId !== current || !terminal) return;
  if (event.type === 'resize') {
    const channel = channels.find((item) => item.sessionId === event.data.sessionId); if (channel?.runId === event.data.runId) Object.assign(channel, { cols: event.data.cols, rows: event.data.rows });
    // The computer applied the phone's size, or took it back (the person typed there).
    // The size the phone asked for before its latest can still arrive after it: that is the phone's too, not the desktop's.
    const mine = (size: typeof asked) => Boolean(size && event.data.cols === size.cols && event.data.rows === size.rows);
    const had = granted; if (event.data.runId === run) granted = mine(asked) || mine(askedBefore);
    if (event.data.runId === run) resizeTo(event.data.cols, event.data.rows);
    // The desktop took the channel back (the person typed there): the phone leaves it at that size until it is used.
    if (event.data.runId === run && takenBack(had, holding, Boolean(asked && sentSize), mine(asked) || mine(askedBefore))) { holding = false; sentSize = ''; }
    return;
  }
  if (event.type === 'replay') {
    run = event.data.runId; inOrder((screen) => screen.reset()); resizeTo(event.data.cols, event.data.rows);
    // A fresh screen (also after reconnecting, when the computer gave the channel back) asks for the phone's size again.
    terminal.write(event.data.data); sentSize = ''; requestSize(0); return;
  }
  if (event.data.runId === run) terminal.write(event.data.data);
}

// Rotating the phone, or the keyboard opening or closing, changes how much fits.
window.addEventListener('resize', () => requestSize()); window.visualViewport?.addEventListener('resize', () => requestSize());
// A locked phone, or one showing another app, gives the channel back; coming back to it takes it again, if it held it.
document.addEventListener('visibilitychange', () => {
  if (!current) return;
  if (document.visibilityState === 'visible') { sentSize = ''; requestSize(); }
  else { void releaseChannel(current).catch(() => {}); sentSize = ''; }
});
/** Back at the front, or back online: a stream that died while the phone slept is replaced (after a moment for what was held up to arrive). */
const wake = () => { if (document.visibilityState === 'visible') setTimeout(() => revive(), 2000); };
document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake); window.addEventListener('pageshow', (event) => { if (event.persisted) wake(); });
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
const linked = location.hash.startsWith('#channel=') ? decoded(location.hash.slice(9)) || null : null;
if (!token.get() || location.hash.startsWith(PAIRING_PREFIX)) showPair();
else { if (linked) history.replaceState(null, '', '/'); showList(); if (linked) openChannel(linked); }
