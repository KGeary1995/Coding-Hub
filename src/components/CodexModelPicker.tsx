import { useEffect, useState } from 'react';
import type { CodexModelCatalog } from '../../shared/workbench';
import type { CodexCLIEngineConfig } from '../../shared/types';
import { workbench } from '../runtime/workbench';

export function CodexModelPicker({ id, config, directory, onChange }: { id: string; config: CodexCLIEngineConfig; directory: string | null; onChange: (config: CodexCLIEngineConfig) => void }) {
  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let cancelled = false; setBusy(true); setError(''); setCatalog(null);
    void workbench<CodexModelCatalog>({ action: 'codex-models', directory }).then((value) => { if (!cancelled) setCatalog(value); }).catch((failure) => { if (!cancelled) setError(failure.message); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [directory, revision]);
  const selected = catalog?.models.find((item) => item.model === config.model);
  const efforts = selected?.reasoningEfforts.length ? selected.reasoningEfforts : ['none', 'low', 'medium', 'high', 'xhigh'];
  function chooseModel(model: string) {
    const entry = catalog?.models.find((item) => item.model === model);
    const unsupported = Boolean(entry?.reasoningEfforts.length && config.reasoningEffort && !entry.reasoningEfforts.includes(config.reasoningEffort));
    setNotice(unsupported ? 'The previous reasoning override is not listed for this model. Reasoning has been reset to CLI default.' : '');
    onChange({ ...config, model, reasoningEffort: unsupported ? null : config.reasoningEffort });
  }
  return <>
    <label className="model-control">Model
      <input aria-label="codex model" placeholder="CLI default — no override" list={`models-${id}`} value={config.model} onChange={(event) => chooseModel(event.target.value)} spellCheck={false} />
      <datalist id={`models-${id}`}>{catalog?.models.map((item) => <option key={item.model} value={item.model}>{item.displayName}{item.isDefault ? ' · catalog default' : ''}{item.hidden ? ' · additional model' : ''}</option>)}</datalist>
      <small>{busy ? 'Loading models from your local Codex CLI…' : catalog ? `${catalog.models.length} models reported by Codex. Type to search, or enter an exact custom ID.` : 'Enter an exact model ID or leave blank for CLI defaults.'}</small>
      <button type="button" className="quiet-button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>Refresh Codex models</button>
      {error && <small className="error-message" role="alert">{error}</small>}
    </label>
    <label>Reasoning effort
      <select aria-label="Reasoning effort" value={config.reasoningEffort ?? ''} onChange={(event) => { setNotice(''); onChange({ ...config, reasoningEffort: event.target.value || null }); }}>
        <option value="">CLI default</option>{efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        {config.reasoningEffort && !efforts.includes(config.reasoningEffort) && <option value={config.reasoningEffort}>{config.reasoningEffort} · saved override, not listed</option>}
      </select>
      {selected && <small>{selected.description}</small>}
      {notice && <small role="status">{notice}</small>}
      <small>Catalog discovery sends no task. The CLI still verifies account/model access at launch; a catalog default is not necessarily your configured default.</small>
    </label>
  </>;
}
