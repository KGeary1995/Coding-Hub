import { useEffect, useState } from 'react';
import type { AgentConfig, CustomChannelConfig, PermissionLevel } from '../../../shared/types';
import { validModel, validResumeId } from '../../../shared/agent-definition';
import { permissionLevel } from '../../../shared/schemas';
import { PERMISSION_LABEL, PERMISSION_LEVELS } from '../../runtime/permissions';
import { workbench } from '../../runtime/workbench';
import { useAgent } from '../../state/agent-store';

/**
 * A custom agent channel's settings (docs/custom-agents.md): a permission level only when its definition maps the
 * levels, a model drop-down from the models it lists, and the conversation to continue when it can resume one.
 */
export function CustomAgentControls({ config, onChange }: { config: CustomChannelConfig; onChange: (config: AgentConfig) => void }) {
  const agent = useAgent(config.agentId); const definition = agent?.definition ?? null;
  const [models, setModels] = useState<string[]>(definition?.models?.choices ?? []); const [other, setOther] = useState(false); const [typed, setTyped] = useState(config.model);
  // The program's own list (models.listArgs) is asked for once the settings open; its choices show meanwhile.
  useEffect(() => { setModels(definition?.models?.choices ?? []); if (definition?.models?.listArgs && agent?.active) void workbench<string[]>({ action: 'agent-models', id: config.agentId }).then(setModels).catch(() => {}); }, [config.agentId, agent?.active, definition]);
  const [conversation, setConversation] = useState(config.resumeId ?? '');
  if (!agent) return <p className="control-note" role="status">This channel’s agent was removed. Add it again under Agent setup → Agents, or close the channel.</p>;
  const listed = config.model === '' || models.includes(config.model);
  return <div className="engine-controls">
    {!agent.active && <p className="control-note" role="status">{agent.look.name} is off on this computer. Open Agent setup → Agents and turn it on before starting.</p>}
    {definition?.permissions && <label className="model-control ui-field">Permissions
      <select aria-label={`${agent.look.name} permissions`} value={permissionLevel(config)} onChange={(event) => onChange({ ...config, permissions: event.target.value as PermissionLevel })}>
        {PERMISSION_LEVELS.map((level) => <option key={level} value={level}>{PERMISSION_LABEL[level]}</option>)}
      </select>
      <small className="ui-hint">Starts {agent.look.name} with the arguments its definition gives this level. Applies when the channel starts.</small>
    </label>}
    {definition?.models && <label className="model-control ui-field">Model
      <select aria-label={`${agent.look.name} model`} value={listed && !other ? config.model : 'other'} onChange={(event) => { const value = event.target.value; setOther(value === 'other'); if (value !== 'other') onChange({ ...config, model: value }); }}>
        <option value="">{agent.look.name}’s default</option>
        {models.map((model) => <option key={model} value={model}>{model}</option>)}
        <option value="other">Another model…</option>
      </select>
      {(other || !listed) && <input aria-label={`${agent.look.name} model name`} placeholder="Model name" maxLength={120} value={typed} spellCheck={false} onChange={(event) => { const value = event.target.value.trim(); setTyped(value); if (value === '' || validModel(value)) onChange({ ...config, model: value }); }} />}
      <small className="ui-hint">Applies when the channel starts.</small>
    </label>}
    {definition?.resume && <label className="model-control ui-field">Conversation to continue
      <input aria-label={`${agent.look.name} conversation`} placeholder="Leave empty for a new conversation" maxLength={200} value={conversation} spellCheck={false} onChange={(event) => { const value = event.target.value.trim(); setConversation(value); if (value === '') { const { resumeId: _old, ...rest } = config; onChange(rest); } else if (validResumeId(value)) onChange({ ...config, resumeId: value }); }} />
      <small className="ui-hint">The ID {agent.look.name} gave the conversation. Applies when the channel starts.</small>
    </label>}
    <p className="control-note">{definition?.mcp && definition.mcp.format !== 'none' ? `${agent.look.name} gets this folder’s shared memory and, when turned on in Settings, the channel and task tools.` : `${agent.look.name} gets no shared memory or channel tools: its definition does not say how it takes MCP servers.`} Trace reads its screen for Needs you and Done{definition?.status?.quietSeconds ? `, and counts ${definition.status.quietSeconds} quiet seconds as a finished turn` : ''}. Its tokens are not counted.</p>
  </div>;
}
