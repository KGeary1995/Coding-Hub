import { useEffect } from 'react';
import { refreshClaudeProfiles, useAccountStore } from '../state/account-store';
import type { CLIEngineConfig } from '../../shared/types';
import { CodexModelPicker } from './CodexModelPicker';

const claudeModels = ['claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest', 'claude-3-opus-latest'];

function tokenValue(value: string): number | null {
  if (value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

export function EngineControls({ id, config, directory = null, onChange }: { id: string; config: CLIEngineConfig; directory?: string | null; onChange: (config: CLIEngineConfig) => void }) {
  const { profiles, error } = useAccountStore();
  useEffect(() => { void refreshClaudeProfiles(); }, []);
  return (
    <div className="engine-controls">
      {config.engine === 'claude' && <label className="model-control">Model
        <input aria-label={`${config.engine} model`} placeholder="CLI default" list={`models-${id}`} value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })} spellCheck={false} />
        <datalist id={`models-${id}`}>{claudeModels.map((model) => <option key={model} value={model} />)}</datalist>
      </label>}
      {config.engine === 'claude' ? <>
        <label className="model-control">Claude account profile
          <select aria-label="Claude account profile" value={config.accountProfileId ?? ''} onChange={(event) => {
            const { accountProfileId: _old, ...rest } = config;
            onChange(event.target.value ? { ...rest, accountProfileId: event.target.value } : rest);
          }}><option value="">Default · existing CLI login</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}{config.accountProfileId && !profiles.some((p) => p.id === config.accountProfileId) && <option value={config.accountProfileId}>Saved profile · unavailable</option>}</select>
          <small>Create and connect named accounts in Accounts & connections. Stop this session before changing its account.</small>
          {error && <small role="alert">{error}</small>}
        </label>
        <label>thinking.budget_tokens<input type="number" min="0" step="1" placeholder="CLI default" value={config.thinking.budget_tokens ?? ''} onChange={(event) => onChange({ ...config, thinking: { budget_tokens: tokenValue(event.target.value) } })} /></label>
        <label>Max output tokens<input type="number" min="0" step="1" placeholder="CLI default" value={config.tokenLimits.maxOutputTokens ?? ''} onChange={(event) => onChange({ ...config, tokenLimits: { ...config.tokenLimits, maxOutputTokens: tokenValue(event.target.value) } })} /></label>
        <label>Session token limit<input type="number" min="0" step="1" placeholder="Unset" value={config.tokenLimits.maxSessionTokens ?? ''} onChange={(event) => onChange({ ...config, tokenLimits: { ...config.tokenLimits, maxSessionTokens: tokenValue(event.target.value) } })} /></label>
      </> : <CodexModelPicker id={id} config={config} directory={directory} onChange={onChange} />}
      <p className="control-note">Blank values inherit local CLI settings. {config.engine === 'claude' ? 'Thinking budgets require an explicit manual-thinking model. Session limits stop the CLI after reported usage reaches the threshold; a response can exceed it. Usage must be available for enforcement.' : 'Reasoning overrides use model_reasoning_effort. The selected model determines which effort levels it accepts.'}</p>
    </div>
  );
}
