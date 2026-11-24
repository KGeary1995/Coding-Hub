import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { DUTY_LABEL, isBuiltInPreset, MAX_PRESET_NAME, MAX_SEAT_INSTRUCTIONS, MAX_SEAT_NAME, MAX_SEATS, SEAT_DUTIES, type TableKind } from '../../../shared/table-seats';
import { MAX_CHANNELS, MAX_MODEL_LENGTH } from '../../../shared/schemas';
import { isAgentConfig, isChatRun, seatEngineOf } from '../../../shared/types';
import type { CodexModelCatalog, GeminiModelCatalog } from '../../../shared/workbench';
import { openTable, seatRoom, changeSeats, startTable, tableSeats } from '../../runtime/round-table';
import { workbench } from '../../runtime/workbench';
import { deletePreset, savePreset, useTablePresets } from '../../state/table-presets';
import { useWorkspaceStore } from '../../state/workspace-store';
import { modelLabel } from '../../../shared/model-name';
import { useHubStore } from '../../state/hub-store';
import { ConfirmStep } from '../ConfirmStep';
import { modelProblem } from './seat-model';
import { addSeat, draftFromPreset, draftFromTable, draftProblem, patchSeat, pickPreset, placeholders, removePreset, removeSeat, roomNote, roundsRange, runSetup, saveAsPreset, setDriver, setDuty, updatePreset, withKind, type Draft, type SetupDeps, type SetupMode } from './table-setup-model';

const DEPS: SetupDeps = { startTable, openTable, changeSeats };
const AGENTS = [{ engine: 'claude' as const, label: 'Claude Code' }, { engine: 'codex' as const, label: 'Codex' }, { engine: 'gemini' as const, label: 'Gemini' }];
const agentOf = (value: string) => value === 'codex' ? 'codex' as const : value === 'gemini' ? 'gemini' as const : 'claude' as const;
const KIND_LABEL: Record<TableKind, string> = { discussion: 'Discussion: agents answer each other', hierarchy: 'Hierarchy: plan, build, review' };

/** The models Codex lists, for the model fields' suggestions; none when it cannot be asked (any text can still be typed). */
interface NamedModel { id: string; name: string }
/**
 * A seat's model, chosen by name from its agent's models (the list follows the seat's agent); "Another model…", or a
 * saved model the agent does not list, takes an exact ID. A typed field with suggestions offered nothing once it held
 * a model, and kept the other agent's model when the agent was changed (2026-11-22).
 */
function SeatModel({ label, describedBy, invalid, model, models, disabled, onChange }: { label: string; describedBy: string; invalid: boolean; model: string; models: NamedModel[]; disabled: boolean; onChange: (model: string) => void }) {
  const [other, setOther] = useState(false); const custom = other || Boolean(model && !models.some((item) => item.id === model));
  return <>
    <select aria-label={`${label} model`} aria-invalid={invalid && !custom ? true : undefined} aria-describedby={describedBy} value={custom ? 'other' : model} disabled={disabled} onChange={(event) => { const value = event.target.value; setOther(value === 'other'); if (value !== 'other') onChange(value); }}>
      <option value="">CLI default</option>
      {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      <option value="other">Another model…</option>
    </select>
    {custom && <input aria-label={`${label} model ID`} aria-invalid={invalid ? true : undefined} aria-describedby={describedBy} placeholder="Model ID" maxLength={MAX_MODEL_LENGTH} value={model} disabled={disabled} spellCheck={false} onChange={(event) => onChange(event.target.value)} />}
  </>;
}
/** Gemini CLI's models for the signed-in account, by name (each names its effort); none while it has not listed them. */
function useGeminiModels(wanted: boolean) {
  const [models, setModels] = useState<NamedModel[]>([]);
  useEffect(() => {
    if (!wanted || !window.codingHub) return; let live = true;
    void workbench<GeminiModelCatalog>({ action: 'gemini-models' }).then((catalog) => { if (live) setModels(catalog.models.map((item) => ({ id: item.model, name: item.displayName || item.model }))); }).catch(() => {});
    return () => { live = false; };
  }, [wanted]);
  return models;
}
function useCodexModels(wanted: boolean, directory: string | null) {
  const [models, setModels] = useState<NamedModel[]>([]);
  useEffect(() => {
    if (!wanted || !window.codingHub) return; let live = true;
    void workbench<CodexModelCatalog>({ action: 'codex-models', directory }).then((catalog) => { if (live) setModels(catalog.models.filter((item) => !item.hidden).map((item) => ({ id: item.model, name: item.displayName || modelLabel(item.model) }))); }).catch(() => {});
    return () => { live = false; };
  }, [wanted, directory]);
  return models;
}

/**
 * The Round Table setup panel: pick a preset and change a copy of it, then Start (a new table, or one on a chat); or change the
 * seats of a table that is open or saved, then Apply. Each seat has its agent, model, name and instructions, and its duties
 * (a hierarchy) or whether it edits files (a discussion). `onFailure`: a new table closes the panel at Start and a failure goes
 * there (the caller shows it on the new channel's tile); without it the panel stays open and shows the message.
 */
export function TableSetup({ mode, onClose, onFailure }: { mode: SetupMode; onClose: () => void; onFailure?: (error: string) => void }) {
  const id = useId(); const presets = useTablePresets();
  const sessions = useWorkspaceStore((state) => state.sessions); const rootDirectory = useWorkspaceStore((state) => state.rootDirectory);
  const lead = mode.type === 'new' ? null : sessions.find((session) => session.id === mode.leadId) ?? null;
  /** A table started on a chat: that chat leads, with its own agent and model. */
  const fixed = useMemo(() => mode.type === 'chat' && lead && isChatRun(lead.config) && isAgentConfig(lead.config) ? { engine: seatEngineOf(lead.config), model: lead.config.model } : undefined, [mode.type, lead?.id]);
  const [draft, setDraft] = useState<Draft>(() => {
    if (mode.type === 'edit') return draftFromTable(tableSeats(mode.leadId), lead?.roundTable?.kind === 'hierarchy' ? 'hierarchy' : 'discussion', lead?.roundTable?.rounds ?? 2);
    return draftFromPreset(pickPreset(presets, mode.type === 'new' ? mode.table ?? 'discussion' : 'discussion'), fixed);
  });
  const [error, setError] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [deleting, setDeleting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const directory = lead?.runningCwd ?? rootDirectory;
  const claudeIds = useHubStore((state) => state.catalog.claudeModels); const claudeSeatModels = useMemo<NamedModel[]>(() => claudeIds.map((id) => ({ id, name: modelLabel(id) })), [claudeIds]);
  const codexModels = useCodexModels(draft.seats.some((seat) => seat.engine === 'codex'), directory); const geminiModels = useGeminiModels(draft.seats.some((seat) => seat.engine === 'gemini'));
  useEffect(() => {
    // Modal: focus moves in (the first field), Escape closes, and focus goes back to what opened it.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null; dialog.current?.showModal();
    return () => { dialog.current?.close(); if (before?.isConnected) before.focus(); };
  }, []);

  const editing = mode.type === 'edit'; const hierarchy = draft.kind === 'hierarchy';
  const room = seatRoom(mode.type === 'new' ? undefined : mode.leadId); const space = roomNote(draft, room, MAX_SEATS); const names = placeholders(draft);
  // More seats than the eight agents and terminals leave room for: the host would refuse it, so it is said here.
  const problem = draftProblem(draft) ?? (draft.seats.length > room ? `This table has ${draft.seats.length} seats, but only ${room} fit now: Trace runs at most ${MAX_CHANNELS} agents and terminals at once, and every seat is one. Take a seat away or close a channel.` : null); const [low, high] = roundsRange(draft.kind);
  const own = presets.some((preset) => preset.id === draft.presetId && !isBuiltInPreset(preset.id));
  const change = (next: Draft) => { setDraft(next); setError(''); setNote(''); };
  /**
   * Table and Kind replace every seat with another table's: once the seats have been changed, they ask first (1.31.2;
   * before, a name, model or instructions typed in were lost without a word). `chosen` is the draft as last picked.
   */
  const [chosen, setChosen] = useState(draft); const [replacing, setReplacing] = useState<Draft | null>(null);
  const choose = (next: Draft) => { if (next === draft) return; if (JSON.stringify(draft) !== JSON.stringify(chosen)) { setReplacing(next); return; } change(next); setChosen(next); };

  const submit = async () => {
    setError(''); setNote('');
    if (problem) { setError(problem); return; }
    if (mode.type === 'new' && onFailure) { void runSetup(mode, draft, DEPS).then((failure) => { if (failure) onFailure(failure); }); onClose(); return; }
    setBusy(true); const failure = await runSetup(mode, draft, DEPS); setBusy(false);
    if (failure) setError(failure); else onClose();
  };
  /** Saves, updates or deletes one of the person's own tables; the message of a refusal stays in the panel. */
  const keep = async (work: () => Promise<string | null>, done: string, after?: () => void) => { setError(''); setNote(''); setBusy(true); const failure = await work(); setBusy(false); if (failure) setError(failure); else { setNote(done); after?.(); } };
  const kindOf = (value: string) => value as TableKind;

  return <dialog ref={dialog} className="table-setup" aria-labelledby={`${id}-title`} onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} onKeyDown={(event) => { /* Enter in a field must not start up to eight agents: Start is its button. */ if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') event.preventDefault(); }}>
      <header><h2 id={`${id}-title`}>{mode.type === 'new' ? 'New Round Table' : mode.type === 'chat' ? 'Round Table on this chat' : 'Seats at this Round Table'}</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={14} /></button></header>
      <div className="table-setup-body">
        {!editing && <div className="table-setup-row">
          <label className="ui-field">Table<select aria-label="Table" value={draft.presetId} onChange={(event) => { const preset = presets.find((item) => item.id === event.target.value); if (preset) choose(draftFromPreset(preset, fixed)); }}>
            <optgroup label="Trace's own">{presets.filter((preset) => isBuiltInPreset(preset.id)).map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {preset.kind}</option>)}</optgroup>
            {presets.some((preset) => !isBuiltInPreset(preset.id)) && <optgroup label="Yours">{presets.filter((preset) => !isBuiltInPreset(preset.id)).map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {preset.kind}</option>)}</optgroup>}
          </select></label>
          <label className="ui-field">Kind<select aria-label="Kind of table" value={draft.kind} onChange={(event) => choose(withKind(draft, presets, kindOf(event.target.value), fixed))}>
            {(['discussion', 'hierarchy'] as const).map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}</select></label>
        </div>}
        {replacing && <ConfirmStep question="Replace the seats you changed?" action="Replace them" onCancel={() => setReplacing(null)} onConfirm={() => { change(replacing); setChosen(replacing); setReplacing(null); }} />}
        {editing && <p className="ui-hint">{hierarchy ? 'A hierarchy Round Table' : 'A discussion Round Table'}. Seats can only be changed while the Round Table is not working; Trace says so if it is. Changing a seat's model restarts that agent, and its conversation is resumed.</p>}
        {mode.type === 'chat' && <p className="ui-hint">This chat leads the table with its own agent and model{hierarchy ? ', as the builder' : ''}.</p>}

        <ol className="table-setup-seats" aria-label="Seats">
          {draft.seats.map((seat, index) => { const base = `${id}-${seat.key}`; const label = `Seat ${index + 1}`; const why = modelProblem(seat.model); const list = seat.engine === 'codex' ? codexModels : seat.engine === 'gemini' ? geminiModels : claudeSeatModels;
            return <li key={seat.key}><fieldset>
              <legend>{label}{seat.lead ? ' · leads the table' : ''}{seat.status && seat.status !== 'running' ? ` · ${seat.status}` : ''}</legend>
              <div className="table-setup-row">
                <label className="ui-field">Agent<select aria-label={`${label} agent`} value={seat.engine} disabled={seat.keepsAgent} onChange={(event) => change(patchSeat(draft, index, { engine: agentOf(event.target.value), model: '' }))}>{AGENTS.map((agent) => <option key={agent.engine} value={agent.engine}>{agent.label}</option>)}</select></label>
                <label className="ui-field">Model<SeatModel key={seat.engine} label={label} describedBy={`${base}-model`} invalid={Boolean(why)} model={seat.model} models={list} disabled={Boolean(seat.keepsModel)} onChange={(model) => change(patchSeat(draft, index, { model }))} /></label>
                <label className="ui-field">Name<input aria-label={`${label} name`} placeholder={names[index]} maxLength={MAX_SEAT_NAME} value={seat.name} onChange={(event) => change(patchSeat(draft, index, { name: event.target.value }))} /></label>
              </div>
              <small id={`${base}-model`} className={`ui-hint ${why ? 'error-message' : ''}`} role={why ? 'alert' : undefined}>{why || (seat.keepsModel ? 'This chat keeps its model; change it in the channel\'s settings.' : editing && seat.session ? 'Changing the model restarts this agent; its conversation is resumed.' : 'Blank is the CLI\'s default model.')}</small>
              <label className="ui-field">Instructions<textarea aria-label={`${label} instructions`} rows={3} maxLength={MAX_SEAT_INSTRUCTIONS} placeholder="Optional: what this seat should focus on or keep in mind" value={seat.instructions} onChange={(event) => change(patchSeat(draft, index, { instructions: event.target.value }))} />
                <small className="ui-hint tnum">{seat.instructions.length.toLocaleString('en-US')} of {MAX_SEAT_INSTRUCTIONS.toLocaleString('en-US')} characters</small></label>
              {hierarchy
                ? <div role="group" aria-label={`${label} duties`} className="table-setup-duties">{SEAT_DUTIES.map((duty) => <label key={duty} className="ui-check"><input type="checkbox" checked={seat.duties.includes(duty)} disabled={duty === 'build' || seat.lead} onChange={(event) => change(setDuty(draft, index, duty, event.target.checked))} />{DUTY_LABEL[duty]}</label>)}</div>
                : <label className="ui-check"><input type="radio" name={`${id}-driver`} checked={draft.driver === index} onChange={() => change(setDriver(draft, index))} />Edits files <span className="ui-hint">(the others review and stay read-only)</span></label>}
              {hierarchy && seat.lead && <small className="ui-hint">The builder leads the table and only builds; the other seats stay read-only.</small>}
              {!seat.lead && <button type="button" className="quiet-button small" aria-label={`Remove ${label}`} onClick={() => change(removeSeat(draft, index))}><Trash2 size={13} />Remove seat</button>}
            </fieldset></li>; })}
        </ol>
        <div className="table-setup-row table-setup-add">
          <button type="button" className="button secondary small" disabled={space.left === 0} onClick={() => change(addSeat(draft, room))}><Plus size={13} />Add seat</button>
          <span className="ui-hint" aria-live="polite">{draft.seats.length} {draft.seats.length === 1 ? 'seat' : 'seats'}. {space.text}</span>
        </div>
        <label className="ui-field table-setup-rounds">{hierarchy ? 'Review rounds' : 'Rounds'}
          <select aria-label={hierarchy ? 'Review rounds' : 'Rounds'} value={draft.rounds} onChange={(event) => change({ ...draft, rounds: Number(event.target.value) })}>{Array.from({ length: high - low + 1 }, (_, at) => low + at).map((count) => <option key={count} value={count}>{count}</option>)}</select>
          <small className="ui-hint">{hierarchy ? 'How many times the reviewers review and the builder fixes, before the final review (if there is one).' : 'How many times each agent replies to the others.'}</small></label>

        <div className="table-setup-presets">
          <label className="ui-field">Name for a saved table<input aria-label="Name for a saved table" maxLength={MAX_PRESET_NAME} value={draft.name} placeholder="For example: Two reviewers" onChange={(event) => change({ ...draft, name: event.target.value })} /></label>
          <div className="ui-actions">
            <button type="button" className="button secondary small" disabled={busy} onClick={() => { const next = crypto.randomUUID(); void keep(() => saveAsPreset(draft, next, { savePreset, deletePreset }), 'Saved as one of your tables.', () => setDraft((current) => { const saved = { ...current, presetId: next }; setChosen(saved); return saved; })); }}>Save as preset</button>
            {own && <button type="button" className="button secondary small" disabled={busy} onClick={() => void keep(() => updatePreset(draft, { savePreset, deletePreset }), 'Your table is updated.')}>Update preset</button>}
            {own && !deleting && <button type="button" className="button secondary small" disabled={busy} onClick={() => setDeleting(true)}>Delete preset</button>}
            {own && deleting && <ConfirmStep question="Delete this table?" action="Delete preset" busy={busy} onCancel={() => setDeleting(false)} onConfirm={() => { setDeleting(false); void keep(() => removePreset(draft.presetId, { savePreset, deletePreset }), 'Deleted. Tables already open keep their seats.', () => setDraft((current) => ({ ...current, presetId: pickPreset(presets, current.kind, null).id }))); }} />}
          </div>
        </div>
      </div>
      <footer>
        <div className="table-setup-messages">
          {(error || problem) && <p className="error-message" role="alert">{error || problem}</p>}
          {note && !error && <p className="ui-hint" role="status">{note}</p>}
        </div>
        <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy || problem !== null}>{editing ? 'Apply' : 'Start Round Table'}</button>
      </footer>
    </form>
  </dialog>;
}
