import { useEffect, useState } from 'react';
import { Play, Trash2, Webhook } from 'lucide-react';
import type { EventHookData, EventHookEvent } from '../../shared/workbench';
import { workbench } from '../runtime/workbench';
import { ConfirmStep } from './ConfirmStep';

const EVENTS: Record<EventHookEvent, string> = { 'needs-you': 'A channel needs you', 'turn-ended': 'A channel ends its turn', failed: 'A channel fails' };

/**
 * Settings → Event hooks (1.33.1): programs of the person's own that Trace runs on a channel's event. Saving one asks in a
 * native dialog with the exact command; arguments are one per line, passed as they are (no shell).
 */
export function EventHooksCard() {
  const [data, setData] = useState<EventHookData>({ hooks: [] }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [event, setEvent] = useState<EventHookEvent>('needs-you'); const [program, setProgram] = useState(''); const [args, setArgs] = useState(''); const [removing, setRemoving] = useState<string | null>(null);
  const refresh = () => workbench<EventHookData>({ action: 'hook-list' }).then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => { void refresh(); }, []);
  const act = async (request: Parameters<typeof workbench>[0], after?: () => void) => { setBusy(true); setError(''); try { await workbench(request); after?.(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <article className="storage-card ui-card settings-card event-hooks" aria-labelledby="event-hooks-title">
    <div className="ui-card-head"><Webhook aria-hidden="true" /><h3 id="event-hooks-title">Event hooks</h3><span className="ui-badge neutral">{data.hooks.length}</span></div>
    <p>Run a program of your own when a channel needs you, ends its turn, or fails: a script that messages your phone, a sound. It runs as you, without a shell, with the channel's number, name, folder and message in <code>TRACE_CHANNEL</code>, <code>TRACE_CHANNEL_NAME</code>, <code>TRACE_FOLDER</code>, <code>TRACE_MESSAGE</code> and <code>TRACE_EVENT</code>, and is stopped after 30 seconds. One hook runs at most once every 10 seconds for a channel.</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    {data.hooks.length > 0 && <ul className="ui-list">{data.hooks.map((hook) => <li className="ui-row" key={hook.id}><span className="ui-row-main"><strong>{EVENTS[hook.event]}</strong><code title={[hook.program, ...hook.args].join(' ')}>{[hook.program, ...hook.args].join(' ')}</code>{hook.lastRun && <small className={hook.lastRun.ok ? 'ui-hint' : 'error-message'}>{hook.lastRun.note} · {new Date(hook.lastRun.at).toLocaleString()}</small>}</span>
      <button type="button" className="quiet-button small" disabled={busy} onClick={() => void act({ action: 'hook-test', id: hook.id })}><Play size={12} aria-hidden="true" />Test</button>
      {removing === hook.id ? <ConfirmStep question="Delete this event hook?" action="Delete hook" busy={busy} onCancel={() => setRemoving(null)} onConfirm={() => { setRemoving(null); void act({ action: 'hook-delete', id: hook.id }); }} /> : <button type="button" className="icon-button" aria-label={`Delete the hook for ${EVENTS[hook.event].toLowerCase()}`} disabled={busy} onClick={() => setRemoving(hook.id)}><Trash2 size={14} aria-hidden="true" /></button>}</li>)}</ul>}
    <form className="hub-form" onSubmit={(e) => { e.preventDefault(); void act({ action: 'hook-save', event, program: program.trim(), args: args.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }, () => { setProgram(''); setArgs(''); }); }}>
      <label>When<select aria-label="Event hook event" value={event} onChange={(e) => setEvent(e.target.value as EventHookEvent)}>{Object.entries(EVENTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Program (full path)<input aria-label="Event hook program" required value={program} onChange={(e) => setProgram(e.target.value)} placeholder="C:\Tools\notify.exe or /usr/local/bin/notify" /></label>
      <label>Arguments, one per line<textarea aria-label="Event hook arguments" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} /></label>
      <div className="ui-actions"><button className="button secondary" disabled={busy || !program.trim()}>Add event hook</button><small className="ui-hint">Trace asks you to confirm the exact command before saving it.</small></div>
    </form>
  </article>;
}
