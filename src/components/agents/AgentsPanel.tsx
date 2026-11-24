import { useEffect, useState } from 'react';
import { Bot, FilePlus2, Pencil, Power, Sparkles, Trash2, Wand2 } from 'lucide-react';
import type { AgentDraft, AgentEntry, AgentList } from '../../../shared/agents';
import { workbench } from '../../runtime/workbench';
import { refreshAgents, setAgents, useAgentStore } from '../../state/agent-store';
import { ConfirmStep } from '../ConfirmStep';
import { EngineAvatar } from '../tile/EngineAvatar';
import { AgentDefinitionForm } from './AgentDefinitionForm';
import type { Draft } from './definition-form-model';

const BUILT_IN = [{ engine: 'claude', name: 'Claude Code', note: 'Terminal and chat channels, Round Tables, usage and memory.' }, { engine: 'codex', name: 'Codex', note: 'Terminal and chat channels, Round Tables, usage and memory.' }, { engine: 'gemini', name: 'Gemini', note: 'Terminal channels and Round Table seats (agy).' }] as const;
type Editing = { draft?: Draft; editing?: string; problems?: string[] } | null;

/**
 * Agent setup → Agents (docs/custom-agents.md): the built-in agents, the person's own, and adding one. Draft it for me
 * reads the program's help and asks the person's Claude Code to fill in the form; the form saves through a native
 * confirmation that names the exact command.
 */
export function AgentsPanel() {
  const { agents, error: listError } = useAgentStore(); const [form, setForm] = useState<Editing>(null);
  const [program, setProgram] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [noClaude, setNoClaude] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => { void refreshAgents(); }, []);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const draft = () => run(async () => {
    setNoClaude(false);
    try { const result = await workbench<AgentDraft>({ action: 'agent-draft', command: program.trim() }); setForm({ draft: result.definition, problems: result.problems }); }
    catch (e) { if (/Claude Code was not found/.test((e as Error).message)) setNoClaude(true); throw e; }
  });
  const saved = (list: AgentList) => { setAgents(list); setForm(null); setProgram(''); };
  return <section className="feature-panel hub-panel agents-panel">
    <header className="ui-page-head"><span className="ui-page-icon"><Bot aria-hidden="true" /></span><div><h1>Agents</h1><p>The coding agents your channels can run. Add any command-line agent, and Trace starts it in a channel like the built-in ones.</p></div></header>
    {(error || listError) && <p className="error-message" role="alert">{error || listError}</p>}
    {form ? <AgentDefinitionForm key={form.editing ?? 'new'} initial={form.draft} editing={form.editing} problems={form.problems} onSaved={saved} onCancel={() => setForm(null)} /> : <>
      <article className="ui-card agents-add"><div className="ui-card-head"><Wand2 aria-hidden="true" /><h2>Add an agent</h2></div>
        <p>Type the program’s name. Trace reads its help and asks your Claude Code to fill in the details; you check them before saving.</p>
        <form className="hub-form" onSubmit={(event) => { event.preventDefault(); if (program.trim()) void draft(); }}>
          <label>Program<input aria-label="Program to add" value={program} spellCheck={false} onChange={(event) => setProgram(event.target.value)} placeholder="aider, goose, opencode…" /></label>
          <div className="ui-actions"><button className="button primary" disabled={busy || !program.trim()}><Sparkles size={14} aria-hidden="true" />{busy ? 'Drafting… (up to 2 minutes)' : 'Draft it for me'}</button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setForm({ draft: { schema: 1, id: '', name: '', program: { command: program.trim() }, status: { quietSeconds: 4 } } })}><FilePlus2 size={14} aria-hidden="true" />Fill in the form myself</button></div>
        </form>
        {noClaude && <p className="ui-hint" role="status">Drafting needs Claude Code on this computer. Fill in the form yourself instead, or sign in to Claude Code under Accounts & connections.</p>}
      </article>
      <article className="ui-card"><div className="ui-card-head"><Bot aria-hidden="true" /><h2>Your agents</h2><span className="ui-count neutral">{agents.length}</span></div>
        {agents.length === 0 ? <p className="ui-hint">None yet. Added agents appear in + Channel, on this computer and on your phone.</p>
          : <ul className="ui-list">{agents.map((agent) => <AgentRow key={agent.id} agent={agent} busy={busy} removing={removing === agent.id}
            onEdit={() => agent.definition && setForm({ draft: agent.definition as unknown as Draft, editing: agent.id })}
            onActivate={() => void run(async () => setAgents(await workbench<AgentList>({ action: 'agent-activate', id: agent.id })))}
            onRemove={() => setRemoving(agent.id)} onCancelRemove={() => setRemoving(null)}
            onConfirmRemove={() => { setRemoving(null); void run(async () => setAgents(await workbench<AgentList>({ action: 'agent-remove', id: agent.id }))); }} />)}</ul>}
      </article>
      <article className="ui-card"><div className="ui-card-head"><Sparkles aria-hidden="true" /><h2>Built in</h2></div>
        <ul className="ui-list">{BUILT_IN.map((item) => <li className="ui-row" key={item.engine}><EngineAvatar engine={item.engine} size="" /><span className="ui-row-main"><strong>{item.name}</strong><small>{item.note}</small></span></li>)}</ul>
      </article>
    </>}
  </section>;
}

function AgentRow({ agent, busy, removing, onEdit, onActivate, onRemove, onCancelRemove, onConfirmRemove }: { agent: AgentEntry; busy: boolean; removing: boolean; onEdit: () => void; onActivate: () => void; onRemove: () => void; onCancelRemove: () => void; onConfirmRemove: () => void }) {
  const state = agent.problem ? { word: 'Needs a fix', tone: 'warning' } : agent.active ? { word: 'On', tone: 'success' } : { word: 'Off', tone: 'neutral' };
  return <li className="ui-row">
    <EngineAvatar engine="custom" agentId={agent.id} size="" />
    <span className="ui-row-main"><strong>{agent.look.name}</strong><small title={agent.problem ?? agent.program ?? undefined}>{agent.problem ?? (agent.active ? agent.program : 'Changed or copied in: turn it on to confirm the command it runs.')}</small></span>
    <span className={`ui-badge dot ${state.tone}`}>{state.word}</span>
    {!agent.active && agent.definition && <button type="button" className="quiet-button small" disabled={busy} onClick={onActivate}><Power size={12} aria-hidden="true" />Turn on</button>}
    {agent.definition && <button type="button" className="quiet-button small" disabled={busy} onClick={onEdit}><Pencil size={12} aria-hidden="true" />Edit</button>}
    {removing ? <ConfirmStep question={`Remove ${agent.look.name}? Its channels can no longer start.`} action="Remove agent" busy={busy} onCancel={onCancelRemove} onConfirm={onConfirmRemove} />
      : <button type="button" className="icon-button" aria-label={`Remove ${agent.look.name}`} disabled={busy} onClick={onRemove}><Trash2 size={14} aria-hidden="true" /></button>}
  </li>;
}
