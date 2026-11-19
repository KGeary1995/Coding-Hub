import { useShallow } from 'zustand/react/shallow';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useLinkedStore } from '../../state/linked-store';
import { useHubStore } from '../../state/hub-store';
import { CHANNEL_STATES, channelAlerts } from '../../state/channel-state';
import { startSession } from '../../runtime/use-native-host';
import { jumpToChannel } from './StatusBar';
import { RestartNotice } from './RestartNotice';

/** A tile on the notices' side of the window: where its header rows (and a conversation's bars) end, and a chat's composer. */
export interface TileUnder { top: number; bottom: number; rowsEnd: number; composer?: { top: number; bottom: number }; focused: boolean }
/** Where the notices stand: at the bottom right, or raised to the top right, starting `under` and at most `room` tall (0: no room, they step aside). */
export interface Place { raised: boolean; under: number | null; room: number | null }

/**
 * Where the notices stand, by what is under them: over the bottom-right corner, or at the top right (`raised`) when
 * that corner holds a chat's composer (the message box, its level picker and Send), whoever has the focus, or a tile
 * the keyboard focus is in (a terminal's prompt). A notice so never lies over a message row or the prompt in use. A
 * chat whose composer is scrolled under the status bar counts by its header and bars, which the corner would cover.
 * Raised, they start `under` the first row of tiles' header rows and a conversation's bars there (shell.css), so
 * Restore, Stop both, Approve plan and Close stay in reach, and are at most `room` tall, so a stack ends above the
 * next composer down that side, or above the next chat that starts under it (its header, bars and message row), and
 * scrolls in itself. Where that leaves less than a notice's title and first line (a long message in a short chat),
 * `room` is 0 and they step aside: the status bar still says who needs the person.
 * All in the window's pixels: `height` is the whole stack's, `gap` its 12 px, `barTop` the status bar's top, `top`
 * where the stack stands now and `standsRaised` whether that is the raised place (room is measured from there).
 */
export function noticePlace({ tiles, height, gap, barTop, top, standsRaised }: { tiles: TileUnder[]; height: number; gap: number; barTop: number; top: number; standsRaised: boolean }): Place {
  // Its place at the bottom, wherever it stands now: its own height up from the status bar, and its gap on each side.
  const covers = (box: { top: number; bottom: number }) => height > 0 && box.bottom > barTop - height - 2 * gap && box.top < barTop;
  const raised = tiles.some((tile) => (tile.composer !== undefined && covers(tile.composer.top < barTop ? tile.composer : { top: tile.top, bottom: tile.composer.bottom })) || (tile.focused && covers(tile)));
  if (!raised) return { raised, under: null, room: null };
  // The first row of tiles on that side.
  const first = Math.min(...tiles.map((tile) => tile.top));
  const under = Math.max(0, ...tiles.filter((tile) => tile.top < first + gap).map((tile) => tile.rowsEnd));
  // Once they stand there: what they must end their gap above, the nearest first. The message row of the chat they
  // stand in, or the whole of a chat that starts under them, so its Answer, Stop both and Rounds stay in reach too:
  // half the gap is enough above that one, as the space between two tiles is there as well.
  const next = standsRaised ? tiles.flatMap((tile) => tile.composer ? [tile.top > top ? { top: tile.top + gap / 2, bottom: tile.composer.bottom } : tile.composer] : []).filter((box) => box.bottom > top).sort((a, b) => a.top - b.top)[0] : undefined;
  const room = next && top + height > next.top - gap ? next.top - top : null;
  // 6 gaps are 72 px, a notice's title and first line: with less to show than that, none is shown.
  return { raised, under, room: room !== null && room - gap < 6 * gap ? 0 : room };
}

/** The boxes tiles scroll in: the workspace's grid and a linked computer's. */
const GRIDS = '.session-grid-container, .linked-grid';

/** A share of the window's height, so a place holds at any display scale. */
const share = (value: number | null) => value === null ? null : Math.round(value / window.innerHeight * 10000) / 100;

/**
 * Measures what is under the notices and keeps their place (noticePlace) as that changes. Focus inside a notice
 * changes nothing: its button would otherwise move away under the pointer that is pressing it.
 */
function useClearPlace() {
  const column = useRef<HTMLElement>(null); const [place, setPlace] = useState<Place>({ raised: false, under: null, room: null }); const again = useRef(() => {});
  useEffect(() => {
    let frame = 0; let watched: Element[] = [];
    const measure = () => {
      const box = column.current; const focused = document.activeElement; if (!box || box.contains(focused)) return;
      const own = box.getBoundingClientRect(); const bar = document.querySelector('.app-statusbar')?.getBoundingClientRect();
      // The rectangles are in the window's pixels and the sheet's sizes in the page's, which differ at a display scale.
      const scale = box.offsetWidth ? own.width / box.offsetWidth : 1;
      // The whole stack's height, also while `room` cuts it short.
      const height = box.clientHeight ? own.height * box.scrollHeight / box.clientHeight : 0;
      const all = [...document.querySelectorAll('.session-tile')];
      // A tile that moves or resizes, a composer that grows and bars that wrap all change what the corner covers.
      const watch = [...all, ...all.flatMap((tile) => [...tile.querySelectorAll('.chat-composer, .chat-thread')])];
      for (const element of watched) if (!watch.includes(element)) observer.unobserve(element);
      for (const element of watch) if (!watched.includes(element)) observer.observe(element);
      watched = watch;
      const tiles = all.flatMap((tile): TileUnder[] => {
        const rect = tile.getBoundingClientRect(); if (!rect.height || rect.right <= own.left || rect.left >= own.right) return [];
        // A tile scrolled out of its grid is under nothing, and is not the first row.
        const view = tile.closest(GRIDS)?.getBoundingClientRect(); if (view && (rect.bottom <= view.top || rect.top >= view.bottom)) return [];
        const composer = tile.querySelector('.chat-composer')?.getBoundingClientRect();
        // Its header and detail row and, a conversation, its bars: whichever ends lowest.
        const rowsEnd = Math.max(rect.top, tile.querySelector('.tr-tile-head')?.getBoundingClientRect().bottom ?? 0, tile.querySelector('.tr-tile-detail')?.getBoundingClientRect().bottom ?? 0, tile.querySelector('.chat-thread')?.getBoundingClientRect().top ?? 0);
        return [{ top: rect.top, bottom: rect.bottom, rowsEnd, composer: composer?.height ? composer : undefined, focused: tile.contains(focused) }];
      });
      const next = bar ? noticePlace({ tiles, height, gap: 12 * scale, barTop: bar.top, top: own.top, standsRaised: box.classList.contains('raised') }) : { raised: false, under: null, room: null };
      const under = share(next.under); const room = share(next.room);
      setPlace((current) => current.raised === next.raised && current.under === under && current.room === room ? current : { raised: next.raised, under, room });
    };
    // One measure a frame at most. After the focus has left, it is on the page for a moment before the next element takes it.
    const later = () => { frame ||= requestAnimationFrame(() => { frame = 0; measure(); }); }; again.current = later;
    // A notice that comes or goes changes the height, and so what the corner covers.
    const observer = new ResizeObserver(later); if (column.current) observer.observe(column.current);
    // Layouts, a maximised channel, the view and a linked computer's channels move tiles without resizing any.
    const stores = [useWorkspaceStore.subscribe(later), useLinkedStore.subscribe(later)];
    // A grid scrolls where its tiles do not fit (rows, a small window), which brings a message row under the notices
    // with nothing resized. Only the grids: a terminal's own scrolling fires far more often and moves no tile.
    const scrolled = (event: Event) => { if (event.target instanceof Element && event.target.matches(GRIDS)) later(); };
    document.addEventListener('focusin', measure); document.addEventListener('focusout', later); window.addEventListener('resize', measure); document.addEventListener('scroll', scrolled, { capture: true, passive: true });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); for (const stop of stores) stop(); document.removeEventListener('focusin', measure); document.removeEventListener('focusout', later); window.removeEventListener('resize', measure); document.removeEventListener('scroll', scrolled, { capture: true }); };
  }, []);
  // Raised, they have moved: how far down they may reach is measured from where they now stand.
  useEffect(() => { if (place.raised) again.current(); }, [place.raised, place.under]);
  return { column, place };
}

/**
 * Bottom-right notices for channels that need the person (waiting) or have failed. They stay until the channel moves
 * on (answered, retried, closed) or the person dismisses them; a channel that needs them again gets a new notice.
 */
export function Toasts() {
  const { sessions, setView } = useWorkspaceStore(useShallow((s) => ({ sessions: s.sessions, setView: s.setView })));
  const usage = useHubStore((state) => state.usage);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const alerts = channelAlerts(sessions, usage).filter((alert) => alert.state !== 'limit');
  const active = alerts.map((alert) => {
    const session = sessions.find((item) => item.id === alert.sessionId)!;
    return { alert, session, key: `${alert.sessionId}:${alert.state}:${alert.state === 'waiting' ? session.attention?.at : session.runId}` };
  });
  const activeKeys = active.map(({ key }) => key).join('\n');
  // A dismissal lasts only while its notice is current: once the channel moves on (answered, retried, closed), it is
  // forgotten, so the next request or failure shows again even when a launch failed before it had a run ID.
  useEffect(() => { setDismissed((current) => { const kept = current.filter((key) => activeKeys.split('\n').includes(key)); return kept.length === current.length ? current : kept; }); }, [activeKeys]);
  const keyed = active.filter(({ key }) => !dismissed.includes(key));
  const { column, place } = useClearPlace();
  // The restart notice shares the column, so notices never sit on top of each other (an empty column takes no space).
  return <section ref={column} className={`tr-toasts ${place.raised ? 'raised' : ''} ${place.room === null ? '' : place.room === 0 ? 'short away' : 'short'}`} style={place.under === null ? undefined : { '--tr-toasts-under': `${place.under}%`, ...(place.room === null ? {} : { '--tr-toasts-room': `${place.room}%` }) } as CSSProperties} aria-label="Channel notifications" aria-live="polite"><RestartNotice /><LoadNotice />
    {keyed.map(({ alert, session, key }) => {
      const meta = CHANNEL_STATES[alert.state]; const channel = `CH${alert.channel}`;
      // One line with an ellipsis, so the whole text is also its tooltip.
      const message = alert.state === 'waiting' ? session.attention?.message : session.error?.split('\n')[0] ?? `${session.title} stopped with an error.`;
      return <article key={key} className={`tr-toast ${alert.state}`}>
        <header><span aria-hidden="true">{meta.glyph}</span><strong>{alert.text}</strong>
          <button className="tr-toast-close icon-button small" aria-label={`Dismiss ${channel} notification`} onClick={() => setDismissed([...dismissed, key])}><X /></button></header>
        <p title={message}>{message}</p>
        {/* Actions sit at the right, the main one last. */}
        <footer>
          {alert.state === 'waiting'
            ? <button className="tr-toast-action button small waiting" aria-label={`Answer ${channel} in its terminal`} onClick={() => jumpToChannel(session.id)}>Answer<kbd aria-hidden="true">Alt {alert.channel}</kbd></button>
            : <><button className="tr-toast-action quiet-button small" aria-label={`Open log for ${channel}`} onClick={() => { useWorkspaceStore.setState({ workflowTab: 'recovery', recoverySessionId: session.id }); setView('workflow'); }}>Open log</button>
              <button className="tr-toast-action button small primary" aria-label={`Retry ${channel}`} onClick={() => { setView('workspace'); void startSession(session.id); }}>Retry</button></>}
        </footer>
      </article>;
    })}
  </section>;
}

/** What loading the saved workspace changed (Gemini channels removed, as Trace no longer runs Gemini), until dismissed. */
function LoadNotice() {
  const notice = useWorkspaceStore((state) => state.loadNotice);
  if (!notice) return null;
  return <article className="tr-toast" aria-label="Workspace loaded">
    <header><strong>Workspace loaded</strong><button className="tr-toast-close icon-button small" aria-label="Dismiss the workspace notice" onClick={() => useWorkspaceStore.setState({ loadNotice: null })}><X /></button></header>
    <p>{notice}</p>
  </article>;
}
