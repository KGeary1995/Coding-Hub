import { useShallow } from 'zustand/react/shallow';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import GridLayout from 'react-grid-layout';
import { channelsOf, useWorkspaceStore } from '../state/workspace-store';
import { mergeTiles, refreshWorktrees, shownChannels, shownTiles, useAllProjects, useShownChannels, useWorktrees } from '../state/projects';
import { SessionTile } from './SessionTile';
import { ErrorBoundary } from './ErrorBoundary';

export function SessionGrid() {
  const { sessions: all, tiles, setTiles, focusedSessionId, layoutMode, rootDirectory } = useWorkspaceStore(useShallow((s) => ({ sessions: s.sessions, tiles: s.tiles, setTiles: s.setTiles, focusedSessionId: s.focusedSessionId, layoutMode: s.layoutMode, rootDirectory: s.rootDirectory })));
  // A Round Table's partner runs in the background: its lead's tile shows the table.
  const channels = useMemo(() => channelsOf(all), [all]);
  // Only the active project's channels (several projects, step 6); the others keep running and their numbers.
  const worktrees = useWorktrees((state) => state.list);
  useEffect(() => { void refreshWorktrees(); }, [channels.length]);
  const allShown = useAllProjects((state) => state.on);
  const settled = useShownChannels((state) => state.settled);
  const sessions = useMemo(() => allShown ? channels : shownChannels(channels, rootDirectory, worktrees), [allShown, channels, rootDirectory, worktrees, settled]);
  const filtered = sessions.length !== channels.length;
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => { setWidth(element.clientWidth); setHeight(element.clientHeight); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // With some hidden, the shown ones keep a layout made while they were shown, else are laid out afresh (their places
  // among the hidden ones would leave gaps); the hidden ones go below them (mergeTiles).
  const layout = useMemo(() => (filtered ? shownTiles(tiles, sessions, layoutMode) : tiles).map(({ sessionId, ...tile }) => ({ i: sessionId, ...tile })), [filtered, sessions, layoutMode, tiles]);
  // A standard tile spans twelve grid rows. Fit the selected arrangement to the
  // canvas; user-resized tiles can extend it and remain reachable by scrolling.
  const bands = layoutMode === 'rows' ? sessions.length : layoutMode === 'grid' ? (sessions.length > 2 ? 2 : 1) : Math.ceil(sessions.length / 4);
  const gridRows = bands * 12;
  const rowHeight = Math.max(14, Math.floor((height - (gridRows - 1) * 8) / gridRows));
  const focused = sessions.find((session) => session.id === focusedSessionId); const focusedIndex = focused ? channels.indexOf(focused) : -1;
  return (
    <div ref={container} className="session-grid-container">
    {sessions.length === 0 && channels.length > 0 ? <div className="project-empty ui-card" role="status"><strong>No channels in this project yet</strong><p className="ui-hint">Add one with <b>+ Channel</b>. The other projects' {channels.length === 1 ? 'channel keeps' : `${channels.length} channels keep`} running: the project menu at the top left opens their project.</p></div>
    : focusedIndex >= 0 ? <div className="focused-session"><ErrorBoundary label={`Channel ${focusedIndex + 1}`}><SessionTile session={focused!} index={focusedIndex} /></ErrorBoundary></div> : width > 0 && <GridLayout
      className="session-grid"
      width={width}
      cols={12}
      rowHeight={rowHeight}
      margin={[8, 8]}
      containerPadding={[0, 0]}
      layout={layout}
      draggableHandle=".tile-drag-handle"
      draggableCancel="button,input,select,.terminal-viewport"
      compactType="vertical"
      resizeHandles={['se']}
      // Not saved while the worktrees are unknown: a worktree's channel would count as another project's and go below.
      onLayoutChange={(next) => { if (filtered && !useWorktrees.getState().loaded) return; const moved = next.map(({ i, x, y, w, h, minW, minH }) => ({ sessionId: i, x, y, w, h, minW: minW ?? 3, minH: minH ?? 10 })); setTiles(filtered ? mergeTiles(tiles, moved) : moved); }}
    >
      {sessions.map((session) => { const index = channels.indexOf(session); return <div key={session.id}><ErrorBoundary label={`Channel ${index + 1}`}><SessionTile session={session} index={index} /></ErrorBoundary></div>; })}
    </GridLayout>}
    </div>
  );
}
