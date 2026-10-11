import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import GridLayout from 'react-grid-layout';
import { useWorkspaceStore } from '../state/workspace-store';
import { SessionTile } from './SessionTile';

export function SessionGrid() {
  const { sessions, tiles, setTiles, focusedSessionId } = useWorkspaceStore();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => tiles.map(({ sessionId, ...tile }) => ({ i: sessionId, ...tile })), [tiles]);
  const focusedIndex = sessions.findIndex((session) => session.id === focusedSessionId);
  return (
    <div ref={container} className="session-grid-container">
    {focusedIndex >= 0 ? <div className="focused-session"><SessionTile session={sessions[focusedIndex]} index={focusedIndex} /></div> : width > 0 && <GridLayout
      className="session-grid"
      width={width}
      cols={12}
      rowHeight={28}
      margin={[16, 16]}
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
