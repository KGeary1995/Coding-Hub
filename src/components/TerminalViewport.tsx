import { useEffect, useRef } from 'react';
import type { Session } from '../../shared/types';
import { getTerminal } from '../runtime/terminals';

export function TerminalViewport({ session }: { session: Session }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const entry = getTerminal(session, container.current);
    container.current.appendChild(entry.element);
    const fit = () => { if (entry.element.isConnected) { try { entry.fit.fit(); } catch { /* Detached/hidden terminals fit when shown again. */ } } };
    const observer = new ResizeObserver(fit);
    observer.observe(container.current);
    fit();
    return () => { observer.disconnect(); entry.element.remove(); };
  // Session identity owns the terminal; configuration/status updates must not recreate it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  return <div ref={container} className="terminal-viewport" role="region" aria-label={`${session.config.engine} interactive terminal`} />;
}
