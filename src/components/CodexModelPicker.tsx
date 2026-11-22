import { useEffect, useState } from 'react';
import type { CodexModelCatalog } from '../../shared/workbench';
import type { CodexCLIEngineConfig } from '../../shared/types';
import { workbench } from '../runtime/workbench';
import { MAX_MODEL_LENGTH, modelValue } from '../../shared/schemas';

export function CodexModelPicker({ config, directory, onChange }: { id: string; config: CodexCLIEngineConfig; directory: string | null; onChange: (config: CodexCLIEngineConfig) => void }) {
  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let cancelled = false; setBusy(true); setError(''); setCatalog(null);
    // Each lookup starts a Codex process; wait until the repository path stops changing while typed.
    const timer = setTimeout(() => void workbench<CodexModelCatalog>({ action: 'codex-models', directory }).then((value) => { if (!cancelled) setCatalog(value); }).catch((failure) => { if (!cancelled) setError(failure.message); }).finally(() => { if (!cancelled) setBusy(false); }), 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [directory, revision]);
  const selected = catalog?.models.find((item) => item.model === config.model);
  const [other, setOther] = useState(false); const custom = other || Boolean(config.model && !selected);
  const efforts = selected?.reasoningEfforts.length ? selected.reasoningEfforts : ['none', 'low', 'medium', 'high', 'xhigh'];
  function chooseModel(model: string) {
    const entry = catalog?.models.find((item) => item.model === model);
    const unsupported = Boolean(entry?.reasoningEfforts.length && config.reasoningEffort && !entry.reasoningEfforts.includes(config.reasoningEffort));
    setNotice(unsupported ? 'The previous reasoning override is not listed for this model. Reasoning has been reset to CLI default.' : '');
    onChange({ ...config, model, reasoningEffort: unsupported ? null : config.reasoningEffort });
  }
  return <>
    <label className="model-control ui-field">Model
      {/* Chosen by name from what Codex lists; "Another model" (or a saved one Codex no longer lists) takes an exact ID. Until the list arrives, the ID field alone. */}
      {catalog && <select aria-label="codex model" value={custom ? 'other' : config.model} onChange={(event) => { const value = event.target.value; setOther(value === 'other'); if (value !== 'other') chooseModel(value); }}>
        <option value="">Codex’s default</option>
        {catalog.models.map((item) => <option key={item.model} value={item.model}>{item.displayName}{item.isDefault ? ' · catalog default' : ''}{item.hidden ? ' · additional model' : ''}</option>)}
        <option value="other">Another model…</option>
      </select>}
      {(!catalog || custom) && <input aria-label={catalog ? 'codex model ID' : 'codex model'} placeholder={catalog ? 'Model ID' : 'CLI default — no override'} maxLength={MAX_MODEL_LENGTH} value={config.model} onChange={(event) => { const model = modelValue(event.target.value); if (model !== null) chooseModel(model); }} spellCheck={false} />}
      <small className="ui-hint">{busy ? 'Loading models from your local Codex CLI…' : catalog ? `${catalog.models.length} models reported by Codex.` : 'Enter an exact model ID or leave blank for CLI defaults.'}</small>
      <button type="button" className="quiet-button small" disabled={busy} onClick={() => setRevision((value) => value + 1)}>Refresh Codex models</button>
      {error && <small className="ui-hint error-message" role="alert">{error}</small>}
    </label>
    <label className="ui-field">Reasoning effort
      <select aria-label="Reasoning effort" value={config.reasoningEffort ?? ''} onChange={(event) => { setNotice(''); onChange({ ...config, reasoningEffort: event.target.value || null }); }}>
        <option value="">CLI default</option>{efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        {config.reasoningEffort && !efforts.includes(config.reasoningEffort) && <option value={config.reasoningEffort}>{config.reasoningEffort} · saved override, not listed</option>}
      </select>
      {selected && <small className="ui-hint">{selected.description}</small>}
      {notice && <small className="ui-hint" role="status">{notice}</small>}
      <small className="ui-hint">Catalog discovery sends no task. The CLI still verifies account/model access at launch; a catalog default is not necessarily your configured default.</small>
    </label>
  </>;
}
