import { fillArgs, validModel, validResumeId, type AgentDefinition } from '../../../shared/agent-definition';
import type { CustomChannelConfig, PermissionLevel } from '../../../shared/types';
import { permissionLevel } from '../../../shared/schemas';
import { HubError } from '../cli/engine-adapter';

/** An MCP server Trace gives a run (shared memory, the channel tools), as Claude's and Codex's configs name them. */
export interface McpServer { command: string; args: string[]; env: Record<string, string> }

/** The level a custom run starts at: its channel's, when the definition maps the levels; otherwise the program's own settings. */
export const customLevel = (definition: AgentDefinition, config: CustomChannelConfig): PermissionLevel => definition.permissions ? permissionLevel(config) : 'ask';

/**
 * A definition and a channel's settings as the launch (docs/custom-agents.md): the program's own arguments, then the
 * permission level's, the model, the conversation to resume, the extra instructions and Trace's MCP servers. Every value
 * fills one argument (fillArgs); a model or conversation ID is checked first. `mcpFile` is the per-run file a claude-json
 * definition is given; its content comes back in `mcpConfig` for the caller to write.
 */
export function buildCustomLaunch(input: { definition: AgentDefinition; config: CustomChannelConfig; servers: Record<string, McpServer>; instructions: string | null; mcpFile: string }): { args: string[]; env: Record<string, string>; mcpConfig: string | null } {
  const { definition, config } = input; const args = [...definition.program.args ?? []]; const env: Record<string, string> = { ...definition.env };
  if (definition.permissions) args.push(...definition.permissions[customLevel(definition, config)]);
  if (config.model) {
    if (!definition.models) throw new HubError('AGENT_MODEL', `${definition.name} takes no model setting. Clear the model in the channel’s settings.`);
    if (!validModel(config.model)) throw new HubError('AGENT_MODEL', 'That model name can’t be used. Use letters, digits and . : / @ + - _ only.');
    args.push(...fillArgs(definition.models.arg, { model: config.model }));
  }
  if (config.resumeId) {
    if (!definition.resume) throw new HubError('AGENT_RESUME', `${definition.name} has no resume arguments, so it can’t continue a conversation. Clear the conversation in the channel’s settings.`);
    if (!validResumeId(config.resumeId)) throw new HubError('AGENT_RESUME', 'That conversation ID can’t be used.');
    args.push(...fillArgs(definition.resume.args, { id: config.resumeId }));
  }
  if (input.instructions && definition.instructions) {
    if ('args' in definition.instructions) args.push(...fillArgs(definition.instructions.args, { text: input.instructions }));
    else env[definition.instructions.env] = input.instructions;
  }
  let mcpConfig: string | null = null; const names = Object.keys(input.servers);
  if (names.length && definition.mcp?.format === 'claude-json') { mcpConfig = JSON.stringify({ mcpServers: input.servers }); args.push(...fillArgs(definition.mcp.args ?? [], { file: input.mcpFile })); }
  // The arguments Codex's own launch takes (auto-memory.ts, main.ts prepareLaunch): a TOML value in each --config.
  else if (names.length && definition.mcp?.format === 'codex-toml') for (const [name, server] of Object.entries(input.servers)) args.push('--config', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`, '--config', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`, '--config', `mcp_servers.${name}.env={${Object.entries(server.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`);
  return { args, env, mcpConfig };
}
/** Whether a definition can take Trace's shared memory and channel tools at all (its settings say so when not). */
export const takesTools = (definition: AgentDefinition) => Boolean(definition.mcp && definition.mcp.format !== 'none');
