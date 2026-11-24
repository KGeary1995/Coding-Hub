import { useState } from 'react';
import { CircleCheck, CircleX, LoaderCircle, X } from 'lucide-react';
import { dismissAutoCheck, useAutoCheckStore } from '../state/auto-check-store';

/** The channel's last automatic check (1.38.0): running, passed, or failed with what it printed. */
export function AutoCheckLine({ sessionId }: { sessionId: string }) {
  const status = useAutoCheckStore((state) => state.bySession[sessionId]); const [open, setOpen] = useState(false);
  if (!status) return null;
  const Icon = status.state === 'running' ? LoaderCircle : status.state === 'passed' ? CircleCheck : CircleX;
  return <div className={`auto-check ${status.state}`} role="status" title={status.folder}>
    <Icon size={14} aria-hidden="true" className={status.state === 'running' ? 'spin' : undefined} />
    <span>{status.summary}</span>
    {status.output && <button type="button" className="quiet-button small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide output' : 'Show output'}</button>}
    {status.state !== 'running' && <button type="button" className="quiet-button small icon-button" aria-label="Dismiss check result" onClick={() => dismissAutoCheck(sessionId)}><X size={12} /></button>}
    {open && status.output && <pre className="auto-check-output">{status.output}</pre>}
  </div>;
}
