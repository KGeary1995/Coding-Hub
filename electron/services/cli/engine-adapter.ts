import type { CLIEngineConfig, PermissionLevel } from '../../../shared/types';
import type { EngineInfo } from '../../../shared/ipc';
import { permissionLevel } from '../../../shared/schemas';

export class HubError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Fixed flags + argument arrays; normal CLI approval/authentication behavior is inherited. */
export function buildLaunch(config: CLIEngineConfig, engine: EngineInfo): { args: string[]; env: Record<string, string> } {
  if (!engine.available) throw new HubError('ENGINE_UNAVAILABLE', engine.error ?? 'CLI is unavailable.');
  if (engine.engine !== config.engine) throw new HubError('ENGINE_MISMATCH', 'Engine configuration does not match the installed CLI.');
  const args: string[] = [];
  const env: Record<string, string> = {};
  if (config.model) {
    if (!engine.supportsModel) throw new HubError('UNSUPPORTED_MODEL_FLAG', 'This CLI does not advertise --model. Clear the model to use its local default.');
    args.push('--model', config.model);
  }
  if (config.engine === 'codex') {
    if (config.reasoningEffort !== null) {
      if (!engine.supportsConfig) throw new HubError('UNSUPPORTED_REASONING', 'This Codex version does not advertise --config. Use CLI default reasoning or update Codex.');
      args.push('--config', `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`);
    }
    if (engine.supportsNoDaemon) args.push('--no-daemon');
  } else {
    if (config.tokenLimits.maxSessionTokens !== null && !engine.supportsSessionId) throw new HubError('UNSUPPORTED_SESSION_LIMIT', 'This Claude version cannot bind usage to a session ID. Clear the session token limit or update Claude Code.');
    const majorVersion = Number(engine.version?.match(/\d+/)?.[0]);
    if ((config.thinking.budget_tokens !== null || config.tokenLimits.maxOutputTokens !== null) && !(majorVersion >= 1)) {
      throw new HubError('UNVERIFIED_TOKEN_SETTINGS', 'Cannot verify Claude Code token-setting support. Clear token overrides or update Claude Code.');
    }
    if (config.thinking.budget_tokens !== null) {
      const manualThinkingModel = /^claude-(?:3-7-sonnet|sonnet-4(?:-0|-5)?|opus-4(?:-0|-1|-5)?)-(?:\d{8}|latest)$/.test(config.model);
      if (!manualThinkingModel) throw new HubError('UNSUPPORTED_THINKING_BUDGET', 'A thinking budget requires an explicit Claude model with manual extended thinking (3.7 or supported 4/4.1/4.5 IDs). Default aliases and adaptive-thinking models cannot guarantee this budget. Clear the override for CLI defaults.');
      if (config.thinking.budget_tokens < 1024) throw new HubError('INVALID_THINKING_BUDGET', 'Manual extended thinking requires at least 1024 tokens. Clear the override for CLI defaults.');
      if (config.tokenLimits.maxOutputTokens !== null && config.thinking.budget_tokens >= config.tokenLimits.maxOutputTokens) throw new HubError('INVALID_TOKEN_LIMITS', 'The thinking budget must be smaller than maximum output tokens.');
      env.MAX_THINKING_TOKENS = String(config.thinking.budget_tokens);
    }
    if (config.chrome) {
      if (!engine.supportsChrome) throw new HubError('UNSUPPORTED_CHROME', 'This Claude Code version does not advertise --chrome. Turn off Claude in Chrome for this channel, or update Claude Code.');
      args.push('--chrome');
    }
    if (config.tokenLimits.maxOutputTokens !== null) {
      if (config.tokenLimits.maxOutputTokens < 1) throw new HubError('INVALID_OUTPUT_LIMIT', 'Maximum output tokens must be positive.');
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(config.tokenLimits.maxOutputTokens);
    }
  }
  args.push(...permissionArgs(config, engine));
  if (config.resumeId) { if (!engine.supportsResume) throw new HubError('RESUME_UNAVAILABLE', 'This CLI does not advertise conversation resume. Update it before resuming.'); if (config.engine === 'claude') args.push('--resume', config.resumeId); else args.unshift('resume', config.resumeId); }
  return { args, env };
}

/** The level a run actually starts at: the default falls back to the CLI's own settings where the CLI lacks the flags. */
export function launchedLevel(config: CLIEngineConfig, engine: EngineInfo): PermissionLevel {
  return config.permissions === undefined && !engine.supportsPermissions ? 'ask' : permissionLevel(config);
}
/** Claude's modes per level; `ask` keeps the person's own settings. Codex chats take theirs in the app-server protocol. */
export const CLAUDE_MODE = { edits: 'acceptEdits', full: 'bypassPermissions' } as const;
/**
 * The launch flags for a channel's permission level. A Claude chat may also be switched to full access while it runs,
 * which Claude allows only when started with --allow-dangerously-skip-permissions (that flag alone changes nothing).
 */
function permissionArgs(config: CLIEngineConfig, engine: EngineInfo): string[] {
  const level = permissionLevel(config); const chat = config.chat === true;
  if (level === 'ask' && !(chat && config.engine === 'claude')) return [];
  if (!engine.supportsPermissions) {
    // The default on a CLI too old for these flags: its own settings, as before; only a level the person chose is refused.
    if (level === 'ask' || config.permissions === undefined) return [];
    throw new HubError('UNSUPPORTED_PERMISSIONS', 'This CLI version does not advertise permission flags. Set Permissions to Ask, or update the CLI.');
  }
  if (config.engine === 'claude') return [...(chat || level === 'full' ? ['--allow-dangerously-skip-permissions'] : []), ...(level === 'ask' ? [] : ['--permission-mode', CLAUDE_MODE[level]])];
  return level === 'edits' ? ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'] : ['--ask-for-approval', 'never', '--sandbox', 'danger-full-access'];
}
