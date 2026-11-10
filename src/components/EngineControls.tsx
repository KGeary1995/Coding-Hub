import { useEffect, useState } from 'react';
import type { MemoryProject } from '../../shared/hub';
import { hubCall } from '../state/hub-store';
import { refreshClaudeProfiles, useAccountStore } from '../state/account-store';
import type { CLIEngineConfig, PermissionLevel } from '../../shared/types';
import { PERMISSION_LABEL, PERMISSION_LEVELS, permissionHelp, withPermissions } from '../runtime/permissions';
import { CodexModelPicker } from './CodexModelPicker';
import { MAX_MODEL_LENGTH, MAX_TOKEN_SETTING, modelValue, permissionLevel } from '../../shared/schemas';

// Claude Code aliases follow the current models; the listed IDs are current releases.
const claudeModels = ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function tokenValue(value: string): number | null {
  if (value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), MAX_TOKEN_SETTING) : null;
}
/** A limit of 0 would stop the CLI at its first response; treat it as no limit. */
function limitValue(value: string): number | null { return tokenValue(value) || null; }

/**
 * Which shared memory project the channel reads and writes: the folder's automatic one, or another the person picks (a
 * folder that is not the project's own, such as the home folder, would otherwise share notes with everything run there).
 */
function MemoryProjectControl({ config, directory, onChange }: { config: CLIEngineConfig; directory: string | null; onChange: (config: CLIEngineConfig) => void }) {
  const [automatic, setAutomatic] = useState(''); const [projects, setProjects] = useState<MemoryProject[]>([]);
  useEffect(() => { if (directory) void hubCall<string>({ action: 'memory-key', directory }).then(setAutomatic).catch(() => setAutomatic('')); }, [directory]);
  useEffect(() => { void hubCall<MemoryProject[]>({ action: 'memory-projects' }).then(setProjects).catch(() => {}); }, []);
  const chosen = config.memoryKey ?? '';
  return <label className="model-control">Shared memory project
    <select aria-label="Shared memory project" value={chosen} onChange={(event) => { const { memoryKey: _old, ...rest } = config; onChange(event.target.value ? { ...rest, memoryKey: event.target.value } as CLIEngineConfig : rest as CLIEngineConfig); }}>
      <option value="">{automatic ? `Automatic · ${automatic}` : 'Automatic for the channel’s folder'}</option>
      {projects.filter((project) => project.key !== automatic).map((project) => <option key={project.key} value={project.key}>{project.key} · {project.notes} {project.notes === 1 ? 'note' : 'notes'}</option>)}
      {chosen && !projects.some((project) => project.key === chosen) && <option value={chosen}>{chosen} · no notes yet</option>}
    </select>
    <small>{chosen ? `This channel reads and writes the ${chosen} notes, not its folder’s.` : 'Notes are shared by every channel in this project (all clones of its Git remote).'} Applies when the channel starts. A Round Table uses the leading chat’s.</small>
  </label>;
}

export function EngineControls({ id, config, directory = null, onChange }: { id: string; config: CLIEngineConfig; directory?: string | null; onChange: (config: CLIEngineConfig) => void }) {
  const { profiles, error } = useAccountStore();
  useEffect(() => { void refreshClaudeProfiles(); }, []);
  const permissions = permissionLevel(config);
  return (
    <div className="engine-controls">
      <label className="model-control">Permissions
        <select aria-label={`${config.engine} permissions`} value={permissions} onChange={(event) => onChange(withPermissions(config, event.target.value as PermissionLevel))}>
          {PERMISSION_LEVELS.map((level) => <option key={level} value={level}>{PERMISSION_LABEL[level]}</option>)}
        </select>
        <small>{permissionHelp(config.engine, permissions)} {config.chat ? 'A running chat can also change this from its message box.' : 'Applies when the channel starts.'}</small>
      </label>
      <MemoryProjectControl config={config} directory={directory} onChange={onChange} />
      {config.engine === 'claude' && <label className="model-control">Model
        <input aria-label={`${config.engine} model`} placeholder="CLI default" list={`models-${id}`} maxLength={MAX_MODEL_LENGTH} value={config.model} onChange={(event) => { const model = modelValue(event.target.value); if (model !== null) onChange({ ...config, model }); }} spellCheck={false} />
        <datalist id={`models-${id}`}>{claudeModels.map((model) => <option key={model} value={model} />)}</datalist>
      </label>}
      {config.engine === 'claude' ? <>
        <label className="model-control">Claude account profile
          <select aria-label="Claude account profile" value={config.accountProfileId ?? ''} onChange={(event) => {
            // A saved conversation belongs to the old profile's config directory and cannot resume under another.
            const { accountProfileId: _old, resumeId: _resume, ...rest } = config;
            onChange(event.target.value ? { ...rest, accountProfileId: event.target.value } : rest);
          }}><option value="">Default · existing CLI login</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}{config.accountProfileId && !profiles.some((p) => p.id === config.accountProfileId) && <option value={config.accountProfileId}>Saved profile · unavailable</option>}</select>
          <small>Create and connect named accounts in Accounts & connections. Stop this session before changing its account.</small>
          {error && <small role="alert">{error}</small>}
        </label>
        <div className="model-control">
          <label className="update-checkbox"><input type="checkbox" aria-label="Claude in Chrome" checked={config.chrome === true} onChange={(event) => { const { chrome: _old, ...rest } = config; onChange(event.target.checked ? { ...rest, chrome: true } : rest); }} />Claude in Chrome</label>
          <small>Lets Claude use your Chrome, with your sign-ins, through the Claude in Chrome extension (it must be installed and connected). Applies when the channel starts; restart a running channel to use it.</small>
        </div>
        <label>thinking.budget_tokens<input type="number" min="0" max={MAX_TOKEN_SETTING} step="1" placeholder="CLI default" value={config.thinking.budget_tokens ?? ''} onChange={(event) => onChange({ ...config, thinking: { budget_tokens: tokenValue(event.target.value) } })} /></label>
        <label>Max output tokens<input type="number" min="0" max={MAX_TOKEN_SETTING} step="1" placeholder="CLI default" value={config.tokenLimits.maxOutputTokens ?? ''} onChange={(event) => onChange({ ...config, tokenLimits: { ...config.tokenLimits, maxOutputTokens: limitValue(event.target.value) } })} /></label>
        <label>Session token limit<input type="number" min="0" max={MAX_TOKEN_SETTING} step="1" placeholder="Unset" value={config.tokenLimits.maxSessionTokens ?? ''} onChange={(event) => onChange({ ...config, tokenLimits: { ...config.tokenLimits, maxSessionTokens: limitValue(event.target.value) } })} /></label>
      </> : <CodexModelPicker id={id} config={config} directory={directory} onChange={onChange} />}
      <p className="control-note">Blank values inherit local CLI settings. {config.engine === 'claude' ? 'Thinking budgets require an explicit manual-thinking model. Session limits stop the CLI after reported usage reaches the threshold; a response can exceed it. Usage must be available for enforcement.' : 'Reasoning overrides use model_reasoning_effort. The selected model determines which effort levels it accepts.'}</p>
    </div>
  );
}
