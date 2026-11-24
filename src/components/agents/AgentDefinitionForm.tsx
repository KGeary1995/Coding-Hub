import { useState, type ReactNode } from 'react';
import { Braces, ListChecks, Play, Save } from 'lucide-react';
import type { AgentList, AgentTestResult } from '../../../shared/agents';
import { workbench } from '../../runtime/workbench';
import { PERMISSION_LABEL, PERMISSION_LEVELS } from '../../runtime/permissions';
import { BLANK, checkDraft, draftFrom, draftText, envFromLines, envToLines, field, fromLines, idFrom, setField, toLines, type Draft } from './definition-form-model';

/** A textarea of one argument (or pattern) per line, bound to a list in the draft. */
function Lines({ label, hint, draft, path, onChange, rows = 2, placeholder }: { label: string; hint?: string; draft: Draft; path: string[]; onChange: (draft: Draft) => void; rows?: number; placeholder?: string }) {
  return <label className="ui-field">{label}<textarea aria-label={label} rows={rows} spellCheck={false} placeholder={placeholder} value={toLines(field(draft, path))} onChange={(event) => onChange(setField(draft, path, fromLines(event.target.value)))} />{hint && <small className="ui-hint">{hint}</small>}</label>;
}
function Section({ title, children }: { title: string; children: ReactNode }) { return <fieldset className="agent-form-section"><legend>{title}</legend>{children}</fieldset>; }

/**
 * The definition form (docs/custom-agents.md, "Write or paste one"), with a JSON tab for the whole definition. Nothing
 * runs from here without the host's native confirmation: Test start and Save each ask, naming the exact command.
 */
export function AgentDefinitionForm({ initial, editing, problems: given = [], note, onSaved, onCancel }: { initial?: Draft; editing?: string; problems?: string[]; /** Where a shared definition came from. */ note?: string; onSaved: (list: AgentList) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial ?? BLANK); const [tab, setTab] = useState<'form' | 'json'>('form');
  const [text, setText] = useState(''); const [textProblem, setTextProblem] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [tested, setTested] = useState<AgentTestResult | null>(null);
  const [touched, setTouched] = useState(given.length > 0);
  const checked = checkDraft(draft); const problems = touched ? checked.problems : [];
  const change = (next: Draft) => { setDraft(next); setTested(null); };
  // A new agent's id follows its name until the person sets the id.
  const [idSet, setIdSet] = useState(Boolean(editing) || Boolean(initial?.id));
  const setName = (name: string) => change({ ...setField(draft, ['name'], name), ...(idSet ? {} : { id: idFrom(name) }) });
  const toJson = () => { setText(draftText(draft)); setTextProblem(''); setTab('json'); };
  const fromJson = () => { const read = draftFrom(text); if (!read) { setTextProblem('This is not a JSON object. Fix it, or keep editing the JSON.'); return; } change(read); setIdSet(true); setTab('form'); };
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const current = (): Draft | null => { if (tab === 'json') { const read = draftFrom(text); if (!read) { setTextProblem('This is not a JSON object.'); return null; } setDraft(read); return read; } return draft; };
  const test = () => { const value = current(); setTouched(true); if (!value || checkDraft(value).problems.length) return; void run(async () => setTested(await workbench<AgentTestResult>({ action: 'agent-test', definition: value }))); };
  const save = () => { const value = current(); setTouched(true); if (!value || checkDraft(value).problems.length) return; void run(async () => onSaved(await workbench<AgentList>({ action: 'agent-save', definition: value, ...(editing ? { replaces: editing } : {}) }))); };
  const level = field(draft, ['permissions']) !== undefined; const instructions = field(draft, ['instructions']) as { args?: string[]; env?: string } | undefined;
  const mcp = (field(draft, ['mcp', 'format']) as string | undefined) ?? 'none';
  const acp = field(draft, ['acp']) as { args?: string[]; modes?: Partial<Record<'ask' | 'edits' | 'full', string>> } | undefined;
  return <article className="ui-card agent-form" aria-label={editing ? 'Edit agent' : 'New agent'}>
    <div className="ui-card-head"><ListChecks aria-hidden="true" /><h2>{editing ? `Edit ${String(draft.name || editing)}` : 'New agent'}</h2>
      <div className="ui-card-actions"><span className="tr-seg" role="group" aria-label="Definition view"><button type="button" aria-pressed={tab === 'form'} className={tab === 'form' ? 'active' : ''} onClick={() => tab === 'json' ? fromJson() : undefined}>Form</button><button type="button" aria-pressed={tab === 'json'} className={tab === 'json' ? 'active' : ''} onClick={() => tab === 'form' ? toJson() : undefined}><Braces size={12} aria-hidden="true" />JSON</button></span></div></div>
    {note && <p className="ui-hint" role="status">{note}</p>}
    {tab === 'json' ? <label className="ui-field">Definition (JSON)<textarea aria-label="Agent definition JSON" className="agent-json" rows={18} spellCheck={false} value={text} onChange={(event) => { setText(event.target.value); setTextProblem(''); }} />{textProblem && <small className="error-message" role="alert">{textProblem}</small>}<small className="ui-hint">The format is in docs/custom-agents.md. Switch back to Form to check it.</small></label> : <>
      <Section title="The agent">
        <label className="ui-field">Name<input aria-label="Agent name" maxLength={40} value={String(draft.name ?? '')} onChange={(event) => setName(event.target.value)} placeholder="Aider" /></label>
        <label className="ui-field">Id<input aria-label="Agent id" maxLength={31} spellCheck={false} value={String(draft.id ?? '')} onChange={(event) => { setIdSet(true); change(setField(draft, ['id'], event.target.value.trim())); }} /><small className="ui-hint">Lowercase letters, digits and -. Channels name their agent by it.</small></label>
        <label className="ui-field">Colour<input aria-label="Agent colour" type="color" value={String(draft.color ?? '#7c9cff')} onChange={(event) => change(setField(draft, ['color'], event.target.value))} /></label>
        <label className="ui-field">Program<input aria-label="Agent program" spellCheck={false} value={String(field(draft, ['program', 'command']) ?? '')} onChange={(event) => change(setField(draft, ['program', 'command'], event.target.value.trim()))} placeholder="aider, or its full path" /><small className="ui-hint">Its name on PATH, or its full path. Trace runs it without a shell; .cmd and .bat files are not run.</small></label>
        <Lines label="Always start it with (one argument per line)" draft={draft} path={['program', 'args']} onChange={change} />
        <Lines label="Test start arguments" hint="What Test start runs; --version when empty." draft={draft} path={['version', 'args']} onChange={change} rows={1} placeholder="--version" />
      </Section>
      <Section title="Model">
        <Lines label="Model argument" hint="With {model} where the name goes, such as --model then {model}. Empty: the channel has no model setting." draft={draft} path={['models', 'arg']} onChange={change} placeholder={'--model\n{model}'} />
        <Lines label="Models to choose from (one per line)" draft={draft} path={['models', 'choices']} onChange={change} />
        <Lines label="Arguments that list its models" hint="Optional: the program prints one model per line." draft={draft} path={['models', 'listArgs']} onChange={change} rows={1} />
      </Section>
      <Section title="Permissions">
        <label className="update-checkbox"><input type="checkbox" aria-label="It has permission levels" checked={level} onChange={(event) => change(setField(draft, ['permissions'], event.target.checked ? { ask: [], edits: [], full: [] } : undefined))} />It has flags for how much it may do without asking</label>
        {level && PERMISSION_LEVELS.map((item) => <Lines key={item} label={`${PERMISSION_LABEL[item]}: arguments`} draft={draft} path={['permissions', item]} onChange={change} rows={1} />)}
        {!level && <small className="ui-hint">Without these, the channel has no permission setting and the program asks as it is set up to.</small>}
      </Section>
      <Section title="Needs you and Done">
        <label className="update-checkbox"><input type="checkbox" aria-label="It sends terminal notifications" checked={field(draft, ['status', 'osc']) === true} onChange={(event) => change(setField(draft, ['status', 'osc'], event.target.checked || undefined))} />It sends terminal notifications (OSC 9, 777 or 99)</label>
        <Lines label="Lines that mean it waits for you (patterns)" hint="Regular expressions, one per line, tried on the bottom of its screen. The matching line becomes the notice." draft={draft} path={['status', 'waiting']} onChange={change} placeholder={'\\(Y\\)es/\\(N\\)o'} />
        <Lines label="Its ready prompt (patterns)" hint="A match on the line the cursor is on, after it answered, means its turn ended." draft={draft} path={['status', 'turnEnd']} onChange={change} placeholder="^> $" />
        <label className="ui-field">Quiet seconds that mean it finished<input aria-label="Quiet seconds" type="number" min={0} max={60} value={Number(field(draft, ['status', 'quietSeconds']) ?? 0)} onChange={(event) => change(setField(draft, ['status', 'quietSeconds'], Number(event.target.value) || undefined))} /><small className="ui-hint">2 to 60, or 0 for off.</small></label>
      </Section>
      <Section title="Shared memory and channel tools">
        <label className="ui-field">How it takes MCP servers<select aria-label="MCP format" value={mcp} onChange={(event) => change(setField(draft, ['mcp'], event.target.value === 'none' ? undefined : { format: event.target.value, ...(event.target.value === 'claude-json' ? { args: (field(draft, ['mcp', 'args']) as string[] | undefined) ?? ['--mcp-config', '{file}'] } : {}) }))}>
          <option value="none">It doesn’t (no shared memory)</option><option value="claude-json">A JSON file, as Claude Code’s --mcp-config</option><option value="codex-toml">Settings arguments, as Codex’s --config</option></select></label>
        {mcp === 'claude-json' && <Lines label="File argument" hint="With {file} where the file's path goes." draft={draft} path={['mcp', 'args']} onChange={change} />}
        <label className="ui-field">Extra instructions<select aria-label="Instructions" value={instructions ? ('env' in instructions ? 'env' : 'args') : 'none'} onChange={(event) => change(setField(draft, ['instructions'], event.target.value === 'args' ? { args: ['--append-system-prompt', '{text}'] } : event.target.value === 'env' ? { env: 'AGENT_SYSTEM_PROMPT' } : undefined))}>
          <option value="none">None</option><option value="args">Arguments with {'{text}'}</option><option value="env">An environment variable</option></select><small className="ui-hint">Carries the project’s recent notes, as Claude Code gets them.</small></label>
        {instructions && 'args' in instructions && <Lines label="Instructions arguments" draft={draft} path={['instructions', 'args']} onChange={change} />}
        {instructions && 'env' in instructions && <label className="ui-field">Variable name<input aria-label="Instructions variable" spellCheck={false} value={instructions.env ?? ''} onChange={(event) => change(setField(draft, ['instructions'], { env: event.target.value.trim() }))} /></label>}
      </Section>
      <Section title="Chat and Round Tables">
        <label className="update-checkbox"><input type="checkbox" aria-label="It speaks the Agent Client Protocol" checked={acp !== undefined} onChange={(event) => change(setField(draft, ['acp'], event.target.checked ? { args: ['acp'] } : undefined))} />It has an Agent Client Protocol (ACP) server, so it can be a chat and sit at a Round Table</label>
        {acp && <Lines label="Start it as an ACP server with (one argument per line)" hint="Such as acp, or --experimental-acp. Empty when the program is the server itself." draft={draft} path={['acp', 'args']} onChange={change} rows={1} />}
        {acp && PERMISSION_LEVELS.map((item) => <label key={item} className="ui-field">{`${PERMISSION_LABEL[item]}: its mode`}<input aria-label={`${PERMISSION_LABEL[item]} mode`} spellCheck={false} placeholder={item === 'ask' ? 'plan' : item === 'edits' ? 'accept-edits' : 'auto'} value={acp.modes?.[item] ?? ''} onChange={(event) => { const value = event.target.value.trim(); const modes = { ...acp.modes }; if (value) modes[item] = value; else delete modes[item]; change(setField(draft, ['acp', 'modes'], modes)); }} /></label>)}
        {acp && <small className="ui-hint">Optional: the session mode ids it lists for each level. Ask’s is also a reviewer’s at a Round Table, so give it a read-only one when it has one. A level with none stays in the mode it starts in.</small>}
      </Section>
      <Section title="More">
        <Lines label="Continue a conversation: arguments" hint="With {id} for the conversation, such as --resume then {id}." draft={draft} path={['resume', 'args']} onChange={change} />
        <label className="ui-field">Environment (NAME=value, one per line)<textarea aria-label="Agent environment" rows={2} spellCheck={false} value={envToLines(draft.env)} onChange={(event) => change(setField(draft, ['env'], envFromLines(event.target.value)))} /><small className="ui-hint">No secrets: the definition is a plain file.</small></label>
      </Section>
    </>}
    {problems.length > 0 && <div className="session-error" role="alert"><ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {tested && <div className="agent-test"><small className="ui-hint">{tested.command} · {tested.timedOut ? 'stopped after 10 seconds' : `exit code ${tested.exitCode ?? 'none'}`}</small><pre>{tested.output.trim() || '(it printed nothing)'}</pre></div>}
    <div className="ui-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={test}><Play size={14} aria-hidden="true" />Test start</button>
      <button type="button" className="button primary" disabled={busy} onClick={save}><Save size={14} aria-hidden="true" />{editing ? 'Save changes' : 'Save agent'}</button>
      <button type="button" className="button ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      <small className="ui-hint">Trace shows you the exact command to confirm before anything runs or is saved.</small>
    </div>
  </article>;
}
