import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import GridLayout from 'react-grid-layout';
import { useWorkspaceStore } from '../state/workspace-store';
import { SessionTile } from './SessionTile';

export function SessionGrid() {
  const { sessions, tiles, setTiles, focusedSessionId, layoutMode } = useWorkspaceStore();
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
  const layout = useMemo(() => tiles.map(({ sessionId, ...tile }) => ({ i: sessionId, ...tile })), [tiles]);
  // A standard tile spans twelve grid rows. Fit the selected arrangement to the
  // canvas; user-resized tiles can extend it and remain reachable by scrolling.
  const bands = layoutMode === 'rows' ? sessions.length : layoutMode === 'grid' && sessions.length > 2 ? 2 : 1;
  const gridRows = bands * 12;
  const rowHeight = Math.max(14, Math.floor((height - (gridRows - 1) * 12) / gridRows));
  const focusedIndex = sessions.findIndex((session) => session.id === focusedSessionId);
  return (
    <div ref={container} className="session-grid-container">
    {focusedIndex >= 0 ? <div className="focused-session"><SessionTile session={sessions[focusedIndex]} index={focusedIndex} /></div> : width > 0 && <GridLayout
      className="session-grid"
      width={width}
      cols={12}
      rowHeight={rowHeight}
      margin={[12, 12]}
      containerPadding={[0, 0]}
      layout={layout}
      draggableHandle=".tile-drag-handle"
      draggableCancel="button,input,select,.terminal-viewport"
      compactType="vertical"
      resizeHandles={['se']}
      onLayoutChange={(next) => setTiles(next.map(({ i, x, y, w, h, minW, minH }) => ({ sessionId: i, x, y, w, h, minW: minW ?? 3, minH: minH ?? 10 })))}
    >
      {sessions.map((session, index) => <div key={session.id}><SessionTile session={session} index={index} /></div>)}
    </GridLayout>}
    </div>
  );
}
