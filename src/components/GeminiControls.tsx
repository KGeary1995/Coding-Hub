import type { GeminiChannelConfig, PermissionLevel } from '../../shared/types';
import { GEMINI_MODEL } from '../../shared/gemini';
import { PERMISSION_LABEL, PERMISSION_LEVELS } from '../runtime/permissions';
import { permissionLevel } from '../../shared/schemas';

/**
 * What each level does in Gemini CLI, as seen with agy 1.5.6: with --mode accept-edits it wrote a file without asking and
 * asked before running a command. Ask passes no mode, so agy's own settings decide.
 */
export const GEMINI_PERMISSION_HELP: Record<PermissionLevel, string> = {
  ask: 'Trace passes no mode, so Gemini CLI’s own settings decide what it asks about.',
  edits: 'Gemini CLI edits files without asking (--mode accept-edits); it asks before running commands.',
  full: 'Gemini CLI never asks (--dangerously-skip-permissions): any command, any file. Use it only for work you trust.',
};

/** A Gemini CLI channel's settings: its permission level. The model is fixed (GEMINI_MODEL), so it is shown, not chosen. */
export function GeminiControls({ config, onChange }: { config: GeminiChannelConfig; onChange: (config: GeminiChannelConfig) => void }) {
  const permissions = permissionLevel(config);
  return <div className="engine-controls">
    <label className="model-control">Permissions
      <select aria-label="gemini permissions" value={permissions} onChange={(event) => onChange({ ...config, permissions: event.target.value as PermissionLevel })}>
        {PERMISSION_LEVELS.map((level) => <option key={level} value={level}>{PERMISSION_LABEL[level]}</option>)}
      </select>
      <small>{GEMINI_PERMISSION_HELP[permissions]} Applies when the channel starts.</small>
    </label>
    <p className="control-note">Model: {GEMINI_MODEL}, the highest model on your subscription. Gemini channels always run it.</p>
    <p className="control-note">A Gemini channel is Gemini CLI in a terminal. Usage, resume, shared memory, tasks, image paste and Round Tables are for Claude Code and Codex channels.</p>
  </div>;
}
