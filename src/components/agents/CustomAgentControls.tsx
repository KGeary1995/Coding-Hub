import { useEffect, useState } from 'react';
import type { AgentConfig, CustomChannelConfig, PermissionLevel } from '../../../shared/types';
import { validModel, validResumeId } from '../../../shared/agent-definition';
import { permissionLevel } from '../../../shared/schemas';
import { PERMISSION_LABEL, PERMISSION_LEVELS, permissionHelp } from '../../runtime/permissions';
import { workbench } from '../../runtime/workbench';
import { useAgent } from '../../state/agent-store';
import type { AgentConversation } from '../../../shared/agents';

/**
 * A custom agent channel's settings (docs/custom-agents.md): a permission level only when its definition maps the
 * levels (always for its chat, phase 2; a plain note when a terminal's definition maps none), a model drop-down from the models it lists, and the conversation to continue
 * when it can resume one: picked from what its `resume.listArgs` prints in the channel's folder, or typed.
 */
export function CustomAgentControls({ config, directory = null, onChange }: { config: CustomChannelConfig; directory?: string | null; onChange: (config: AgentConfig) => void }) {
  const agent = useAgent(config.agentId); const definition = agent?.definition ?? null;
  const [models, setModels] = useState<string[]>(definition?.models?.choices ?? []); const [other, setOther] = useState(false); const [typed, setTyped] = useState(config.model);
  // The program's own list (models.listArgs) is asked for once the settings open; its choices show meanwhile.
  useEffect(() => { setModels(definition?.models?.choices ?? []); if (definition?.models?.listArgs && agent?.active) void workbench<string[]>({ action: 'agent-models', id: config.agentId }).then(setModels).catch(() => {}); }, [config.agentId, agent?.active, definition]);
  const [conversation, setConversation] = useState(config.resumeId ?? '');
  // Its list runs a program, so only when asked; null until then. Typing stays for an ID it does not list.
  const [listed, setListed] = useState<AgentConversation[] | null>(null); const [listing, setListing] = useState(false); const [listError, setListError] = useState('');
  const resume = (value: string) => { setConversation(value); if (value === '') { const { resumeId: _old, ...rest } = config; onChange(rest); } else if (validResumeId(value)) onChange({ ...config, resumeId: value }); };
  const listConversations = async () => {
    setListing(true); setListError('');
    try { const found = await workbench<AgentConversation[]>({ action: 'agent-conversations', id: config.agentId, ...(directory ? { directory } : {}) }); setListed(found); if (!found.length) setListError(`${agent?.look.name ?? 'The agent'} listed no conversations here. Type the ID instead.`); }
    catch (error) { setListError((error as Error).message); } finally { setListing(false); }
  };
  if (!agent) return <p className="control-note" role="status">This channel’s agent was removed. Add it again under Agent setup → Agents, or close the channel.</p>;
  const known = config.model === '' || models.includes(config.model);
  // A chat (phase 2) runs over ACP: Trace keeps its level (modes and answers), asks for the model, and loads the conversation itself.
  const chat = config.chat === true;
  return <div className="engine-controls">
    {!agent.active && <p className="control-note" role="status">{agent.look.name} is off on this computer. Open Agent setup → Agents and turn it on before starting.</p>}
    {(definition?.permissions || chat) && <label className="model-control ui-field">Permissions
      <select aria-label={`${agent.look.name} permissions`} value={permissionLevel(config)} onChange={(event) => onChange({ ...config, permissions: event.target.value as PermissionLevel })}>
        {PERMISSION_LEVELS.map((level) => <option key={level} value={level}>{PERMISSION_LABEL[level]}</option>)}
      </select>
      <small className="ui-hint">{chat ? permissionHelp('custom', permissionLevel(config), true, agent.look.name) : `Starts ${agent.look.name} with the arguments its definition gives this level. Applies when the channel starts.`}</small>
    </label>}
    {definition && !definition.permissions && !chat && <p className="control-note">This agent has no permission levels in Trace. It asks, or not, as its own settings say.</p>}
    {definition?.models && <label className="model-control ui-field">Model
      <select aria-label={`${agent.look.name} model`} value={known && !other ? config.model : 'other'} onChange={(event) => { const value = event.target.value; setOther(value === 'other'); if (value !== 'other') onChange({ ...config, model: value }); }}>
        <option value="">{agent.look.name}’s default</option>
        {models.map((model) => <option key={model} value={model}>{model}</option>)}
        <option value="other">Another model…</option>
      </select>
      {(other || !known) && <input aria-label={`${agent.look.name} model name`} placeholder="Model name" maxLength={120} value={typed} spellCheck={false} onChange={(event) => { const value = event.target.value.trim(); setTyped(value); if (value === '' || validModel(value)) onChange({ ...config, model: value }); }} />}
      <small className="ui-hint">{chat ? 'Trace asks the chat for it when it starts. ' : ''}Applies when the channel starts.</small>
    </label>}
    {chat && <label className="model-control ui-field">Conversation to continue
      <input aria-label={`${agent.look.name} conversation`} placeholder="Leave empty for a new conversation" maxLength={200} value={conversation} spellCheck={false} onChange={(event) => { const value = event.target.value.trim(); setConversation(value); if (value === '') { const { resumeId: _old, ...rest } = config; onChange(rest); } else if (validResumeId(value)) onChange({ ...config, resumeId: value }); }} />
      <small className="ui-hint">The session {agent.look.name} runs this chat in, kept by Trace so a restart continues it. Empty starts a new one.</small>
    </label>}
    {!chat && definition?.resume && <div className="model-control ui-field" role="group" aria-label="Conversation to continue">Conversation to continue
      {listed && listed.length > 0 && <select aria-label={`${agent.look.name} conversations`} value={listed.some((item) => item.id === conversation) ? conversation : ''} onChange={(event) => resume(event.target.value)}>
        <option value="">{conversation && !listed.some((item) => item.id === conversation) ? 'Typed below' : 'A new conversation'}</option>
        {listed.map((item) => <option key={item.id} value={item.id}>{item.label ? `${item.id} · ${item.label}` : item.id}</option>)}
      </select>}
      <input aria-label={`${agent.look.name} conversation`} placeholder="Leave empty for a new conversation" maxLength={200} value={conversation} spellCheck={false} onChange={(event) => resume(event.target.value.trim())} />
      {definition.resume.listArgs && agent.active && <button type="button" className="button secondary small" disabled={listing} onClick={() => void listConversations()}>{listing ? 'Listing…' : listed ? 'List again' : 'List its conversations'}</button>}
      {listError && <small className="ui-hint" role="status">{listError}</small>}
      <small className="ui-hint">The ID {agent.look.name} gave the conversation{definition.resume.listArgs ? ', from its list or typed' : ''}. Applies when the channel starts.</small>
    </div>}
    {chat ? <p className="control-note">{agent.look.name} runs as a chat over the Agent Client Protocol: Trace shows its replies and approvals, and gives it this folder’s shared memory and, when turned on in Settings, the channel and task tools. Its tokens are not counted.</p>
    : <p className="control-note">{definition?.mcp && definition.mcp.format !== 'none' ? `${agent.look.name} gets this folder’s shared memory and, when turned on in Settings, the channel and task tools.` : `${agent.look.name} gets no shared memory or channel tools: its definition does not say how it takes MCP servers.`} Trace reads its screen for Needs you and Done{definition?.status?.quietSeconds ? `, and counts ${definition.status.quietSeconds} quiet seconds as a finished turn` : ''}. Its tokens are not counted.</p>}
  </div>;
}
