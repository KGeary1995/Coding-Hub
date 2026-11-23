import { useShallow } from 'zustand/react/shallow';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { channelNameNow } from '../../state/channel-names';
import { limitLevel, refreshPlanLimits, resetText, usePlanLimits } from '../../state/plan-limits-store';
import { channelsOf, leadOf, useWorkspaceStore } from '../../state/workspace-store';
import { useHubStore, formatNumber, dollars } from '../../state/hub-store';
import { CHANNEL_STATES, channelAlerts, channelState, channelTokensToday, todayTotals, usageFor } from '../../state/channel-state';
import { focusTerminal } from '../../runtime/terminals';
import { useLinkedStore } from '../../state/linked-store';
import type { LinkedComputer } from '../../../shared/remote';
import { PLAN_NAME, type LimitWindow, type PlanLimits } from '../../../shared/plan-limits';
import { dayTotal, refreshDayUsage, useDayUsage } from '../../state/day-usage-store';
import { NeedsYouCell } from './NeedsYou';
import { Check, CircleAlert, Coins, Folder, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useAccountStore } from '../../state/account-store';
import { ENGINE_ICONS } from '../tile/engine-icons';

/** Compact token counts for status cells: 812, 48.2k, 1.3M. */
export const compact = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase();

/**
 * A channel's tile in the workspace's grid, or null where it is not drawn. Tiles stand in channel order, one to a
 * place, and a maximised one alone (SessionGrid); a place holds no tile when its drawing failed.
 */
export function channelTile(id: string): Element | null {
  const { sessions, focusedSessionId } = useWorkspaceStore.getState(); const grid = document.querySelector('.session-grid-container');
  const alone = grid?.querySelector('.focused-session');
  const place = alone ? (focusedSessionId === id ? alone : null) : grid?.querySelectorAll('.session-grid > .react-grid-item:not(.react-grid-placeholder)')[channelsOf(sessions).findIndex((session) => session.id === id)];
  return place?.querySelector('.session-tile') ?? null;
}

/**
 * How far a grid scrolls so a tile shows whole, or from its top edge where it is taller than what the grid shows: 0
 * for one that already does. In the window's pixels, down positive.
 */
export function scrollToTile(tile: { top: number; bottom: number }, view: { top: number; bottom: number }) {
  const down = Math.max(0, tile.bottom - view.bottom);
  return down + Math.min(0, tile.top - down - view.top);
}

/**
 * Shows a channel in the workspace and focuses its terminal, isolating it if another channel is isolated (as Alt+1–8
 * does), and scrolls its grid to the tile: a terminal takes the focus without scrolling to it.
 */
export function jumpToChannel(id: string) {
  const state = useWorkspaceStore.getState();
  // A Round Table's hidden seat is answered in its lead's tile.
  id = leadOf(state.sessions, id)?.id ?? id;
  // Only the isolated tile's terminal is mounted; isolate the requested one instead.
  if (state.focusedSessionId && state.focusedSessionId !== id) state.toggleFocus(id);
  state.setView('workspace'); requestAnimationFrame(() => {
    focusTerminal(id);
    const tile = channelTile(id); const grid = tile?.closest('.session-grid-container');
    if (tile && grid) grid.scrollTop += scrollToTile(tile.getBoundingClientRect(), grid.getBoundingClientRect());
  });
}

const SHORT: Record<string, string> = { Session: '5h', Week: 'wk' };
/** A limit's meter in the bar: the engine's colour with room, then the colours its number turns (shell.css). */
const METER = { ok: '', warning: 'limit', critical: 'danger' } as const;
/**
 * The limits an engine's plan cell shows, from all its accounts' readings: the default login's 5-hour and weekly limits,
 * or with neither its fullest other limit, under its own name. An empty list when that login's reading holds only an
 * error (or only another account has limits): the cell says "no data" and its tooltip says why. Null when no account
 * has a limit or an error: a check that returned nothing has nothing to say, so the cell leaves whole.
 */
export function planReading(all: PlanLimits[]): LimitWindow[] | null {
  if (!all.some((item) => item.windows.length > 0 || item.error)) return null;
  const main = all.find((item) => item.account === 'Default') ?? all[0];
  const known = main.windows.filter((window) => window.label in SHORT);
  if (known.length || !main.windows.length) return known;
  return [main.windows.reduce((fullest, window) => window.usedPercent > fullest.usedPercent ? window : fullest)];
}
/**
 * The named accounts in use whose limits are nearing their cap, each with its fullest limit: the cell counts the default
 * login, so a channel running on another account would otherwise reach its cap with nothing in the bar to say so.
 * `inUse`: the account names this computer's channels run on. The cell's own reading is left out.
 */
export function accountWarnings(all: PlanLimits[], inUse: ReadonlySet<string>): { account: string; window: LimitWindow }[] {
  const main = all.find((item) => item.account === 'Default') ?? all[0];
  return all.filter((item) => item !== main && inUse.has(item.account) && item.windows.length > 0)
    .map((item) => ({ account: item.account, window: item.windows.reduce((fullest, window) => window.usedPercent > fullest.usedPercent ? window : fullest) }))
    .filter(({ window }) => limitLevel(window.usedPercent) !== 'ok');
}
const clock = (time: string) => new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/**
 * Each agent's subscription limits, always in view: the 5-hour session and the week, each a small meter and its used
 * percentage, which turn amber and then red as they fill. Hover for every limit, account and reset; click for Usage.
 */
function PlanLimitCells() {
  const limits = usePlanLimits((state) => state.limits); const stale = usePlanLimits((state) => state.stale);
  // The Claude accounts this computer's channels run on, by the name their readings carry.
  const profiles = useAccountStore((state) => state.profiles); const sessions = useWorkspaceStore((state) => state.sessions);
  const inUse = new Set(sessions.flatMap((session) => { const id = session.config.engine === 'claude' ? session.config.accountProfileId : undefined; const name = id ? profiles.find((profile) => profile.id === id)?.name : undefined; return name ? [name] : []; }));
  useEffect(() => {
    if (!window.codingHub) return;
    void refreshPlanLimits();
    const timer = setInterval(() => void refreshPlanLimits(), 5 * 60000);
    const focus = () => void refreshPlanLimits();
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); };
  }, []);
  return <>{(['claude', 'codex', 'gemini'] as const).map((engine) => {
    const all = limits.filter((item) => item.engine === engine); const shown = planReading(all);
    if (!shown) return null;
    const worst = Math.max(0, ...shown.map((window) => window.usedPercent));
    // The one window that stays when the bar is short (shell.css): the fullest, and of equals the first.
    const kept = shown.findIndex((window) => window.usedPercent === worst);
    const warnings = accountWarnings(all, inUse); const EngineIcon = ENGINE_ICONS[engine];
    // When each reading was taken, and first of all that the last check failed: the numbers then are that old.
    const title = (stale ? 'The last check failed, so these are earlier readings.\n\n' : '') + (all.length > 1 ? 'The bar shows the default login, and any account in use that is near a limit.\n\n' : '') + all.map((item) => `${PLAN_NAME[engine]}${all.length > 1 || item.account !== 'Default' ? ` · ${item.account}` : ''}${item.plan ? ` (${item.plan})` : ''} · checked ${clock(item.checkedAt)}\n${item.error ?? item.windows.map((window) => `  ${window.label}: ${window.usedPercent}% used${resetText(window) ? `, resets ${resetText(window)}` : ''}`).join('\n')}`).join('\n\n');
    return <button key={engine} className={`tr-sb-cell tr-sb-plan ${stale ? 'stale' : ''}`} title={title} onClick={() => useWorkspaceStore.getState().setView('usage')}>
      {/* The engine's own mark, as on its tiles: a shape as well as a colour, so the chip still says whose limits these are when its name has left. */}
      <EngineIcon className={`tr-sb-engine tr-state ${engine}`} size={12} aria-hidden="true" /><span className="tr-sb-plan-name">{PLAN_NAME[engine]}</span>
      {shown.length ? shown.map((window, index) => <span key={window.label} className={`tr-sb-window ${limitLevel(window.usedPercent)} ${index === kept ? 'worst' : ''}`}><small>{SHORT[window.label] ?? window.label}</small><i className={`tr-sb-meter ui-meter ${METER[limitLevel(window.usedPercent)] || engine}`} aria-hidden="true"><i style={{ width: `${Math.min(100, window.usedPercent)}%` }} /></i> {Math.round(window.usedPercent)}%</span>) : <span className="tr-sb-window worst">no data</span>}
      {warnings.map(({ account, window }) => <span key={account} className={`tr-sb-account ${limitLevel(window.usedPercent)}`}>{account} {Math.round(window.usedPercent)}%</span>)}
      {stale && <TriangleAlert className="tr-sb-stale" size={12} aria-label="Last check failed" />}
    </button>;
  })}</>;
}

/** Linked computers' channels that wait for the person or stopped with an error, for the alert cell. */
type LinkedAlert = { sessionId: string; computerId: string; state: 'waiting' | 'failed'; text: string };
const linkedAlerts = (computers: LinkedComputer[]): LinkedAlert[] => computers.filter((computer) => computer.linked && computer.connected).flatMap((computer) => computer.channels.flatMap((channel): LinkedAlert[] =>
  channel.running && channel.attention ? [{ sessionId: channel.sessionId, computerId: computer.id, state: 'waiting' as const, text: `${computer.name} CH${channel.channel} needs approval` }]
    : !channel.running && channel.failed ? [{ sessionId: channel.sessionId, computerId: computer.id, state: 'failed' as const, text: `${computer.name} CH${channel.channel} failed` }] : []));
/** The saved state's sentence: the tooltip of the word the bar shows, and the words themselves for a failure. */
const SAVED = { saved: 'Workspace saved locally', saving: 'Saving workspace…', error: 'Storage needs attention', loading: 'Loading workspace…' } as const;
/**
 * The one global status layer: every channel's state and the project at the left; at the right the saved state, today's
 * usage, plan limits, Needs you and alerts. What can be pressed is a chip (a channel, a plan, Needs you, an alert); what
 * only informs is a mark and its words.
 */
export function StatusBar() {
  const { sessions, rootDirectory, persistenceStatus } = useWorkspaceStore(useShallow((s) => ({ sessions: s.sessions, rootDirectory: s.rootDirectory, persistenceStatus: s.persistenceStatus })));
  const usage = useHubStore((state) => state.usage);
  const logs = useDayUsage((state) => state.usage);
  const today = dayTotal(logs, todayTotals(usage));
  // Against the daily budgets in Settings: amber from the warning share, red once one is used up.
  const preferences = useHubStore((state) => state.preferences); const share = Math.max(preferences.dailyTokens ? today.tokens / preferences.dailyTokens : 0, preferences.dailyCost && today.cost !== null ? today.cost / preferences.dailyCost : 0);
  const budgetLevel = share >= 1 ? 'critical' : share >= (preferences.limitWarning ?? 80) / 100 ? 'warning' : '';
  const budgetNote = share > 0 ? `${Math.round(share * 100)}% of today's budget. ` : '';
  // When the bar is short the Today chip leaves it whole: it wraps to a second line, which its box clips (shell.css). It is
  // then still a button in the page, so it is taken out of the tab order and of what is read out: the focus never lands
  // on something that is not drawn. Measured, since the stylesheet decides when it leaves.
  const todayBox = useRef<HTMLSpanElement>(null); const [todayGone, setTodayGone] = useState(false);
  useEffect(() => {
    const box = todayBox.current; const chip = box?.querySelector('button'); const bar = box?.parentElement; if (!box || !chip || !bar) return;
    const measure = () => setTodayGone(chip.getBoundingClientRect().top - box.getBoundingClientRect().top > box.getBoundingClientRect().height / 2);
    const observer = new ResizeObserver(measure); observer.observe(bar); observer.observe(box); measure();
    return () => observer.disconnect();
  }, []);
  // The CLIs' logs are read every 15 s, and soon after Trace's own channels report usage.
  useEffect(() => { void refreshDayUsage(); const timer = setInterval(() => void refreshDayUsage(), 15000); return () => clearInterval(timer); }, []);
  useEffect(() => { const timer = setTimeout(() => void refreshDayUsage(), 2000); return () => clearTimeout(timer); }, [usage]);
  const computers = useLinkedStore((state) => state.computers);
  // This computer's channels first, then linked computers' channels that wait or failed (clicking opens their tab).
  const alerts: { sessionId: string; computerId?: string; state: 'waiting' | 'failed' | 'limit'; text: string }[] = [...channelAlerts(sessions, usage), ...linkedAlerts(computers)];
  const project = rootDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No project';
  const channels = channelsOf(sessions);
  const jump = jumpToChannel;
  // shell.css counts the room the bar needs from the number of channels. An item with tr-sb-drop leaves whole when the bar
  // is short, instead of being cut off; those sit beside the spacer, in the order they leave, so no gap shows where one was.
  // Its mark and words are one tr-sb-inner, so they leave together.
  const savedWords = persistenceStatus in SAVED ? SAVED[persistenceStatus as keyof typeof SAVED] : 'Browser preview';
  return <footer className="app-statusbar tr-statusbar" style={{ '--sb-channels': channels.length } as CSSProperties}>
    {channels.map((session, index) => {
      const record = usageFor(session, usage); const state = channelState(session, record); const meta = CHANNEL_STATES[state];
      const tokens = channelTokensToday(sessions, session.id, usage);
      return <button key={session.id} className="tr-sb-cell tr-sb-channel" title={`${channelNameNow(session)}: ${meta.word.toLowerCase()}${session.attention ? ` · ${session.attention.message}` : ''}`} onClick={() => jump(session.id)}>
        <i className={`tr-sb-dot ${session.config.engine}`} aria-hidden="true" /><span className="tr-sb-number"><span className="tr-sb-ch">CH</span>{index + 1}</span>
        {/* The word, or only its glyph where the bar has no room for words; working takes the engine's colour. */}
        <span className={`tr-sb-state tr-state ${state === 'working' ? session.config.engine : state}`}><span className="tr-sb-glyph" aria-hidden="true">{meta.glyph}</span><span className="tr-sb-word">{meta.word}</span></span>
        {tokens > 0 && <span className="tr-sb-tokens" title="New tokens in this channel today (input outside the cache, plus output), across restarts, with every agent of a Round Table; cache reads not counted">{compact(tokens)} tok</span>}
      </button>;
    })}
    <span className="tr-sb-cell tr-sb-project tr-sb-drop" title={rootDirectory ?? undefined}><span className="tr-sb-inner"><Folder size={12} aria-hidden="true" /><span className="tr-sb-text">{project}</span></span></span>
    <span className="tr-spacer" />
    {/* The saved state in a word, with its sentence as the tooltip. Only a failure is spelled out. */}
    <span className={`tr-sb-cell storage-status tr-sb-drop ${persistenceStatus}`} data-testid="persistence-status" title={savedWords}>
      <span className="tr-sb-inner">{persistenceStatus === 'saved' ? <><Check size={12} aria-hidden="true" />Saved</> : persistenceStatus === 'saving' || persistenceStatus === 'loading' ? <><LoaderCircle size={12} className="spin" aria-hidden="true" />{persistenceStatus === 'saving' ? 'Saving…' : 'Loading…'}</> : persistenceStatus === 'error' ? <><CircleAlert size={12} aria-hidden="true" /><span className="tr-sb-error-words">{savedWords}</span></> : savedWords}</span>
    </span>
    {/* A chip that opens Usage, as the plan limits beside it do. The item that leaves a short bar whole is still the box
        around it (tr-sb-drop), so the chip is drawn inside it and leaves with it. */}
    <span ref={todayBox} className={`tr-sb-cell tr-sb-today tr-sb-drop ${budgetLevel} ${todayGone ? 'gone' : ''}`}>
      <button type="button" className="tr-sb-cell tr-sb-today-button" tabIndex={todayGone ? -1 : undefined} aria-hidden={todayGone || undefined} onClick={() => useWorkspaceStore.getState().setView('usage')}
        title={`${budgetNote}New tokens today on this computer (input outside the cache, plus output)${today.logs ? `, from Claude Code's, Codex's and Gemini CLI's own records, in Trace or not: Claude ${today.logs.claude.toLocaleString()}, Codex ${today.logs.codex.toLocaleString()}${today.logs.gemini ? `, Gemini ${today.logs.gemini.toLocaleString()}` : ''}` : ', in Trace channels'}. Click for Usage.`}>
        <span className="tr-sb-inner"><Coins size={12} aria-hidden="true" />Today <b>{compact(today.tokens)} tok</b></span>{today.cost === null ? null : <span className="tr-sb-cost">{dollars(today.cost)}</span>}
      </button>
    </span>
    <PlanLimitCells />
    <NeedsYouCell />
    {/* With nothing to report the bar says nothing: a standing "No alerts" was read past. */}
    {alerts.length > 0 && <button className={`tr-sb-cell tr-sb-alert ${alerts.some((alert) => alert.state === 'failed') ? 'failed' : alerts[0].state}`} onClick={() => alerts[0].computerId ? useWorkspaceStore.setState({ computerId: alerts[0].computerId, activeView: 'computer' }) : jump(alerts[0].sessionId)} title="Go to the first channel that needs you">
      <span aria-hidden="true">{CHANNEL_STATES[alerts[0].state].glyph}</span><span className="tr-sb-text">{alerts.map((alert) => alert.text).join(' · ')}</span>
    </button>}
  </footer>;
}

export { formatNumber };
