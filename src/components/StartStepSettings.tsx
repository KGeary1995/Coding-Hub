import { useState } from 'react';
import type { Session } from '../../shared/types';
import { isAgentConfig, isChatRun } from '../../shared/types';
import { DEFAULT_WAIT_SECONDS, MAX_COMMAND, MAX_STEP, MAX_WAIT_SECONDS, MAX_WAIT_TEXT, type StartStep } from '../../shared/start-order';
import { useWorkspaceStore } from '../state/workspace-store';

/** A channel's step in Start in order (shared/start-order.ts), with its next launch settings. */
export function StartStepSettings({ session }: { session: Session }) {
  const step = session.startup; const agent = isAgentConfig(session.config); const chat = isChatRun(session.config);
  // Typed seconds kept as text, so the field can be cleared to type another number.
  const [secondsText, setSecondsText] = useState(String(step?.waitSeconds ?? DEFAULT_WAIT_SECONDS));
  const save = (next: StartStep | undefined) => useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((item) => { if (item.id !== session.id) return item; const { startup: _old, ...rest } = item; return next ? { ...rest, startup: next } : rest; }) }));
  /** Empty text fields are left out, so a cleared field does not keep an empty command or request. */
  const change = (patch: Partial<StartStep>) => { const next = { ...step!, ...patch } as StartStep; for (const key of ['command', 'prompt', 'waitFor'] as const) if (!next[key]?.trim()) delete next[key]; save(next); };
  return <details className="session-preferences"><summary>Start in order{step ? `: step ${step.order}` : ''}</summary>
    <label className="binding-control ui-field">Step<select aria-label="Start in order step" value={step?.order ?? 0} onChange={(event) => { const order = Number(event.target.value); save(order ? { ...(step ?? {}), order } : undefined); }}>
      <option value={0}>Not in the order</option>{Array.from({ length: MAX_STEP }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
    {step && !agent && <label className="binding-control ui-field">Command to type once it starts<input aria-label="Command to type once it starts" value={step.command ?? ''} maxLength={MAX_COMMAND} placeholder="For example npm run dev" onChange={(event) => change({ command: event.target.value })} /></label>}
    {step && agent && <label className="binding-control ui-field">First request<textarea aria-label="First request" rows={2} value={step.prompt ?? ''} maxLength={4000} placeholder="Offered on the channel once it starts; you send it with one press" onChange={(event) => change({ prompt: event.target.value })} /></label>}
    {step && !chat && <label className="binding-control ui-field">Next step waits until this channel shows<input aria-label="Text to wait for" value={step.waitFor ?? ''} maxLength={MAX_WAIT_TEXT} placeholder="For example ready (leave empty not to wait)" onChange={(event) => change({ waitFor: event.target.value })} /></label>}
    {step?.waitFor && <label className="binding-control ui-field">Wait at most (seconds)<input type="number" aria-label="Seconds to wait" min={5} max={MAX_WAIT_SECONDS} value={secondsText} onChange={(event) => { setSecondsText(event.target.value); const value = Math.round(Number(event.target.value)); if (value >= 5 && value <= MAX_WAIT_SECONDS) change({ waitSeconds: value }); }} /></label>}
    <p className="control-note">Start in order, on the top bar, starts the channels that have a step, lowest first. Nothing starts on its own, including from a template.</p>
  </details>;
}
