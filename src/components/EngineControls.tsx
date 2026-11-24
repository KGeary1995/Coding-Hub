import { useEffect, useRef, useState } from 'react';
import type { MemoryProject } from '../../shared/hub';
import { hubCall, useHubStore } from '../state/hub-store';
import { refreshClaudeProfiles, useAccountStore } from '../state/account-store';
import type { ChatEngineConfig, ClaudeCLIEngineConfig, CLIEngineConfig, PermissionLevel } from '../../shared/types';
import { PERMISSION_LABEL, PERMISSION_LEVELS, permissionHelp, withPermissions } from '../runtime/permissions';
import { CodexModelPicker } from './CodexModelPicker';
import { GeminiModelPicker } from './GeminiModelPicker';
import { MAX_MODEL_LENGTH, MAX_TOKEN_SETTING, modelValue, permissionLevel } from '../../shared/schemas';
import { modelLabel } from '../../shared/model-name';

/** Claude Code's model, chosen by name; "Another model" takes an exact ID or alias for one not listed. */
function ClaudeModelControl({ config, onChange }: { config: ClaudeCLIEngineConfig; onChange: (config: CLIEngineConfig) => void }) {
  const models = useHubStore((state) => state.catalog.claudeModels); const listed = config.model === '' || models.includes(config.model); const [other, setOther] = useState(false);
  return <label className="model-control ui-field">Model
    <select aria-label="claude model" value={listed && !other ? config.model : 'other'} onChange={(event) => { const value = event.target.value; setOther(value === 'other'); if (value !== 'other') onChange({ ...config, model: value }); }}>
      <option value="">Claude Code’s default</option>
      {models.map((model) => <option key={model} value={model}>{modelLabel(model)}</option>)}
      <option value="other">Another model…</option>
    </select>
    {(other || !listed) && <input aria-label="claude model ID" placeholder="Model ID or alias" maxLength={MAX_MODEL_LENGTH} value={config.model} onChange={(event) => { const model = modelValue(event.target.value); if (model !== null) onChange({ ...config, model }); }} spellCheck={false} />}
    <small className="ui-hint">Applies when the channel starts.</small>
  </label>;
}

function tokenValue(value: string): number | null {
  if (value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), MAX_TOKEN_SETTING) : null;
}
/** A limit of 0 would stop the CLI at its first response; treat it as no limit. */
function limitValue(value: string): number | null { return tokenValue(value) || null; }
/**
 * The config with another Claude account ('' for the default sign-in). A saved conversation belongs to the account's
 * config folder and cannot resume under another, so it is set aside in `kept` (by account) instead of being lost:
 * choosing that account again while Settings is open brings it back. A restored one leaves `kept` (the config holds it
 * again), so one the person then drops is not brought back by a later change.
 */
export function withProfile(config: ClaudeCLIEngineConfig, profileId: string, kept: Record<string, string>): ClaudeCLIEngineConfig {
  const { accountProfileId: from, resumeId, ...rest } = config;
  if (resumeId) kept[from ?? ''] = resumeId;
  const back = kept[profileId]; delete kept[profileId];
  return { ...rest, ...(profileId ? { accountProfileId: profileId } : {}), ...(back ? { resumeId: back } : {}) };
}

/**
 * Which shared memory project the channel reads and writes: the folder's automatic one, or another the person picks (a
 * folder that is not the project's own, such as the home folder, would otherwise share notes with everything run there).
 */
function MemoryProjectControl({ config, directory, onChange }: { config: ChatEngineConfig; directory: string | null; onChange: (config: CLIEngineConfig) => void }) {
  const [automatic, setAutomatic] = useState(''); const [projects, setProjects] = useState<MemoryProject[]>([]);
  useEffect(() => { if (directory) void hubCall<string>({ action: 'memory-key', directory }).then(setAutomatic).catch(() => setAutomatic('')); }, [directory]);
  useEffect(() => { void hubCall<MemoryProject[]>({ action: 'memory-projects' }).then(setProjects).catch(() => {}); }, []);
  const chosen = config.memoryKey ?? '';
  return <label className="model-control ui-field">Shared memory project
    <select aria-label="Shared memory project" value={chosen} onChange={(event) => { const { memoryKey: _old, ...rest } = config; onChange(event.target.value ? { ...rest, memoryKey: event.target.value } as ChatEngineConfig : rest as ChatEngineConfig); }}>
      <option value="">{automatic ? `Automatic · ${automatic}` : 'Automatic for the channel’s folder'}</option>
      {projects.filter((project) => project.key !== automatic).map((project) => <option key={project.key} value={project.key}>{project.key} · {project.notes} {project.notes === 1 ? 'note' : 'notes'}</option>)}
      {chosen && !projects.some((project) => project.key === chosen) && <option value={chosen}>{chosen} · no notes yet</option>}
    </select>
    <small className="ui-hint">{chosen ? `This channel reads and writes the ${chosen} notes, not its folder’s.` : 'Notes are shared by every channel in this project (all clones of its Git remote).'} Applies when the channel starts. A Round Table uses the leading chat’s.</small>
  </label>;
}

export function EngineControls({ id, config, directory = null, onChange }: { id: string; config: CLIEngineConfig; directory?: string | null; onChange: (config: CLIEngineConfig) => void }) {
  const { profiles, error } = useAccountStore();
  useEffect(() => { void refreshClaudeProfiles(); }, []);
  const permissions = permissionLevel(config);
  /** Conversations set aside by an account change, by account, while Settings is open. */
  const kept = useRef<Record<string, string>>({});
  const setAside = config.engine === 'claude' && !config.resumeId ? Object.entries(kept.current).find(([profile]) => profile !== (config.accountProfileId ?? '')) : undefined;
  return (
    <div className="engine-controls">
      <label className="model-control ui-field">Permissions
        <select aria-label={`${config.engine} permissions`} value={permissions} onChange={(event) => onChange(withPermissions(config, event.target.value as PermissionLevel))}>
          {PERMISSION_LEVELS.map((level) => <option key={level} value={level}>{PERMISSION_LABEL[level]}</option>)}
        </select>
        <small className="ui-hint">{permissionHelp(config.engine, permissions)} {config.engine !== 'gemini' && config.chat ? 'A running chat can also change this from its message box.' : 'Applies when the channel starts.'}</small>
      </label>
      {config.engine === 'gemini' ? <GeminiModelPicker id={id} config={config} onChange={onChange} /> : <MemoryProjectControl config={config} directory={directory} onChange={onChange} />}
      {config.engine === 'claude' && <ClaudeModelControl config={config} onChange={onChange} />}
      {config.engine === 'claude' ? <>
        <label className="model-control ui-field">Claude account profile
          <select aria-label="Claude account profile" value={config.accountProfileId ?? ''} onChange={(event) => onChange(withProfile(config, event.target.value, kept.current))}><option value="">Default · existing CLI login</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}{config.accountProfileId && !profiles.some((p) => p.id === config.accountProfileId) && <option value={config.accountProfileId}>Saved profile · unavailable</option>}</select>
          <small className="ui-hint">Create and connect named accounts in Accounts & connections. Stop this channel before changing its account.</small>
          {setAside && <small className="ui-hint" role="status">The saved conversation belongs to {setAside[0] ? profiles.find((p) => p.id === setAside[0])?.name ?? 'another profile' : 'the default sign-in'}, so the next start begins a new conversation. Choose that account again to continue it.</small>}
          {error && <small className="ui-hint error-message" role="alert">{error}</small>}
        </label>
        <div className="model-control ui-field">
          <label className="update-checkbox"><input type="checkbox" aria-label="Claude in Chrome" checked={config.chrome === true} onChange={(event) => { const { chrome: _old, ...rest } = config; onChange(event.target.checked ? { ...rest, chrome: true } : rest); }} />Claude in Chrome</label>
          <small className="ui-hint">Lets Claude use your Chrome, with your sign-ins, through the Claude in Chrome extension (it must be installed and connected). Applies when the channel starts; restart a running channel to use it.</small>
        </div>
        <label className="ui-field">thinking.budget_tokens<input type="number" min="0" max={MAX_TOKEN_SETTING} step="1" placeholder="CLI default" value={config.thinking.budget_tokens ?? ''} onChange={(event) => onChange({ ...config, thinking: { budget_tokens: tokenValue(event.target.value) } })} /></label>
        <label className="ui-field">Max output tokens<input type="number" min="0" max={MAX_TOKEN_SETTING} step="1" placeholder="CLI default" value={config.tokenLimits.maxOutputTokens ?? ''} onChange={(event) => onChange({ ...config, tokenLimits: { ...config.tokenLimits, maxOutputTokens: limitValue(event.target.value) } })} /></label>
        <label className="ui-field">Session token limit<input type="number" min="0" max={MAX_TOKEN_SETTING} step="1" placeholder="Unset" value={config.tokenLimits.maxSessionTokens ?? ''} onChange={(event) => onChange({ ...config, tokenLimits: { ...config.tokenLimits, maxSessionTokens: limitValue(event.target.value) } })} /></label>
      </> : config.engine === 'codex' ? <CodexModelPicker id={id} config={config} directory={directory} onChange={onChange} /> : null}
      <p className="control-note">{config.engine === 'gemini' ? 'Gemini channels have no shared memory or tasks. Their tokens count in today’s total, on the Usage screen and, from the conversation each channel writes to, on its tile, and Gemini can sit at a Round Table as a seat that reviews or plans.' : <>Blank values inherit local CLI settings. {config.engine === 'claude' ? 'Thinking budgets require an explicit manual-thinking model. Session limits stop the CLI after reported usage reaches the threshold; a response can exceed it. Usage must be available for enforcement.' : 'Reasoning overrides use model_reasoning_effort. The selected model determines which effort levels it accepts.'}</>}</p>
    </div>
  );
}
