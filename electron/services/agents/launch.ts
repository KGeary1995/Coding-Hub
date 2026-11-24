import { fillArgs, promptFits, validModel, validResumeId, type AgentDefinition } from '../../../shared/agent-definition';
import type { CustomChannelConfig, PermissionLevel } from '../../../shared/types';
import { permissionLevel } from '../../../shared/schemas';
import { HubError } from '../cli/engine-adapter';
import type { AcpAgent } from '../chat/acp-stream';

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
export function buildCustomLaunch(input: { definition: AgentDefinition; config: CustomChannelConfig; servers: Record<string, McpServer>; instructions: string | null; mcpFile: string; prompt?: string }): { args: string[]; env: Record<string, string>; mcpConfig: string | null; prompted: boolean } {
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
  const prompted = Boolean(input.prompt && firstRequestFits(definition, input.prompt));
  if (prompted) args.push(...fillArgs(definition.firstRequest!.args, { prompt: input.prompt! }));
  // MCP last: a claude-json flag such as Claude's --mcp-config can take a list, which would swallow what followed it.
  let mcpConfig: string | null = null; const names = Object.keys(input.servers);
  if (names.length && definition.mcp?.format === 'claude-json') { mcpConfig = JSON.stringify({ mcpServers: input.servers }); args.push(...fillArgs(definition.mcp.args ?? [], { file: input.mcpFile })); }
  // The arguments Codex's own launch takes (auto-memory.ts, main.ts prepareLaunch): a TOML value in each --config.
  else if (names.length && definition.mcp?.format === 'codex-toml') for (const [name, server] of Object.entries(input.servers)) args.push('--config', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`, '--config', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`, '--config', `mcp_servers.${name}.env={${Object.entries(server.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`);
  return { args, env, mcpConfig, prompted };
}
/**
 * Whether a first request goes to the program as an argument: the definition gives `firstRequest.args` and the prompt
 * fits (promptFits). A prompt that would be an argument of its own and starts with `-` could be read as a flag, so it is
 * typed instead. Otherwise it is typed once the agent is ready (sendWhenReady), as before.
 */
export function firstRequestFits(definition: AgentDefinition, prompt: string): boolean {
  if (!definition.firstRequest || !promptFits(prompt)) return false;
  return !(definition.firstRequest.args.includes('{prompt}') && prompt.trimStart().startsWith('-'));
}
/** Whether a definition can take Trace's shared memory and channel tools at all (its settings say so when not). */
export const takesTools = (definition: AgentDefinition) => Boolean(definition.mcp && definition.mcp.format !== 'none');

/**
 * A definition's chat run (phase 2): the program started with `acp.args` as an Agent Client Protocol server, and how
 * AcpStream drives it. Its terminal's arguments (permissions, model, resume, MCP) are not given: over ACP the level is a
 * session mode and Trace's answers to its requests, the model `session/set_model`, a resumed conversation `session/load`,
 * and Trace's MCP servers go in `session/new`. Extra instructions reach it only through an environment variable.
 */
export function buildAcpLaunch(input: { definition: AgentDefinition; config: CustomChannelConfig; servers: Record<string, McpServer>; instructions: string | null }): { args: string[]; env: Record<string, string>; agent: AcpAgent } {
  const { definition, config } = input;
  if (!definition.acp) throw new HubError('AGENT_NO_CHAT', `${definition.name} has no acp arguments in its definition, so it can’t run as a chat. Add acp under Agent setup → Agents, or add it as a terminal channel.`);
  if (config.model && !validModel(config.model)) throw new HubError('AGENT_MODEL', 'That model name can’t be used. Use letters, digits and . : / @ + - _ only.');
  if (config.resumeId && !validResumeId(config.resumeId)) throw new HubError('AGENT_RESUME', 'That conversation ID can’t be used.');
  const env: Record<string, string> = { ...definition.env };
  if (input.instructions && definition.instructions && 'env' in definition.instructions) env[definition.instructions.env] = input.instructions;
  const mcpServers = Object.entries(input.servers).map(([name, server]) => ({ name, command: server.command, args: server.args, env: Object.entries(server.env).map(([key, value]) => ({ name: key, value })) }));
  return { args: [...definition.acp.args], env, agent: { name: definition.name, prefix: 'acp', modes: { ...definition.acp.modes }, allowEdits: true, mcpServers } };
}
