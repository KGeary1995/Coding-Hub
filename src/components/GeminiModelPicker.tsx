import { useEffect, useState } from 'react';
import type { GeminiModelCatalog } from '../../shared/workbench';
import type { GeminiCLIEngineConfig } from '../../shared/types';
import { workbench } from '../runtime/workbench';
import { MAX_MODEL_LENGTH, modelValue } from '../../shared/schemas';

/** Gemini CLI's model: one of the models agy lists for the signed-in account (each names its effort), or agy's default. */
export function GeminiModelPicker({ id, config, onChange }: { id: string; config: GeminiCLIEngineConfig; onChange: (config: GeminiCLIEngineConfig) => void }) {
  const [catalog, setCatalog] = useState<GeminiModelCatalog | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false; setBusy(true); setError('');
    void workbench<GeminiModelCatalog>({ action: 'gemini-models' }).then((value) => { if (!cancelled) setCatalog(value); }).catch((failure) => { if (!cancelled) setError(failure.message); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [revision]);
  const listed = catalog?.models.some((item) => item.model === config.model);
  return <label className="model-control ui-field">Model
    {catalog ? <select aria-label="gemini model" value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })}>
      <option value="">Gemini CLI’s default</option>
      {catalog.models.map((item) => <option key={item.model} value={item.model}>{item.displayName}</option>)}
      {config.model && !listed && <option value={config.model}>{config.model} · saved, not listed now</option>}
    </select> : <input aria-label="gemini model" placeholder="Gemini CLI’s default" list={`models-${id}`} maxLength={MAX_MODEL_LENGTH} value={config.model} onChange={(event) => { const model = modelValue(event.target.value); if (model !== null) onChange({ ...config, model }); }} spellCheck={false} />}
    <small className="ui-hint">{busy ? 'Loading models from Gemini CLI…' : catalog ? `${catalog.models.length} models your account can use, as Gemini CLI lists them. The name includes the effort (Low to XHigh).` : 'Enter an exact model ID, or leave blank for Gemini CLI’s default.'} Applies when the channel starts.</small>
    <button type="button" className="quiet-button small" disabled={busy} onClick={() => setRevision((value) => value + 1)}>Refresh Gemini models</button>
    {error && <small className="ui-hint error-message" role="alert">{error}</small>}
  </label>;
}
