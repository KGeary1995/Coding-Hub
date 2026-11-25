import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readConfig, updateConfig } from './config';
import { LOOK_ONLY_TOOLS, MEMORY_TOOLS } from '../../../shared/safe-actions';

/**
 * Shared memory and the channel tools for Gemini (agy). agy takes MCP servers only from its own files, never from its
 * command line (`--settings` refuses `mcpServers`), so Trace keeps a plugin of its own, `trace`, in agy's global
 * customization folder (`~/.gemini/config/plugins/trace`): agy finds it there by itself and runs it unless the person
 * turns it off (`agy plugin disable trace`), and the person's own mcp_config.json is left alone. Its two servers are
 * fixed; what a run needs (notes folder, key, folder, launch context, the channel tools' address) Trace puts in that
 * agy's environment, which agy passes on to the servers it starts. An agy started elsewhere starts them too, and they
 * then offer no tools. All checked with agy 1.5.15 (2026-11-24): a server's working folder is the plugin's, the plugin's
 * rule is in every conversation's instructions, and a server's MCP `instructions` are only a file the model may read.
 */
export const GEMINI_PLUGIN = 'trace';
/** agy names a plugin's server `<plugin>_<server>`: the name the model sees and permission rules (`mcp(server/tool)`) use. */
export const GEMINI_MEMORY_SERVER = `${GEMINI_PLUGIN}_memory`;
export const GEMINI_CHANNELS_SERVER = `${GEMINI_PLUGIN}_channels`;
/**
 * Allowed at Allow edits (agy matches `mcp(server/tool)` exactly, checked with agy 1.5.15): every memory tool, as Codex
 * runs them without asking, and the channel and task tools that only look, as for Codex. Sending, adding or updating asks.
 */
export const GEMINI_TOOL_RULES: readonly string[] = [...MEMORY_TOOLS.map((tool) => `mcp(${GEMINI_MEMORY_SERVER}/${tool})`), ...LOOK_ONLY_TOOLS.map((tool) => `mcp(${GEMINI_CHANNELS_SERVER}/${tool})`)];
/** agy's global customization folder. With CODING_HUB_GEMINI_HOME (tests and smoke runs), a folder inside that one. */
export const geminiConfigRoot = () => process.env.CODING_HUB_GEMINI_HOME ? path.join(process.env.CODING_HUB_GEMINI_HOME, 'config') : path.join(homedir(), '.gemini', 'config');
export interface GeminiPluginPrograms { executable: string; memoryServer: string; channelServer: string }
/**
 * The plugin's rule, which agy puts in every conversation's instructions. It cannot carry a run's notes (one file for every
 * agy on the computer), so it sends the model to memory_context, which Trace's memory server answers for its own run.
 */
export const GEMINI_RULE = ['---', 'trigger: always_on', '---', '# Shared project memory (Trace)', `In a Gemini channel that Trace started, the ${GEMINI_MEMORY_SERVER} MCP tools hold this project's shared memory with Claude Code, Codex and the person. Call memory_context before you start work, and write_handoff before you finish (decisions, changed files, checks run, remaining work, blockers; never credentials or raw terminal logs). Without those tools, ignore this.`, ''].join('\n');

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
/**
 * Writes Trace's agy plugin, or points it at this Trace (a reinstall, the app moved, another copy of Trace wrote it last).
 * Only the two servers' command, arguments and ELECTRON_RUN_AS_NODE are Trace's: anything else in the files is kept.
 * Returns whether a file changed. readConfig/updateConfig throw a HubError the person can act on.
 */
export function installGeminiPlugin(programs: GeminiPluginPrograms, root = geminiConfigRoot()): boolean {
  const folder = path.join(root, 'plugins', GEMINI_PLUGIN); let changed = false;
  const manifest = path.join(folder, 'plugin.json'); const inspected = readConfig(manifest);
  if (inspected.data.name !== GEMINI_PLUGIN) { updateConfig(manifest, inspected.hash, (data) => { data.name = GEMINI_PLUGIN; }); changed = true; }
  const servers: Record<string, { command: string; args: string[] }> = { memory: { command: programs.executable, args: [programs.memoryServer] }, channels: { command: programs.executable, args: [programs.channelServer] } };
  const file = path.join(folder, 'mcp_config.json'); const config = readConfig(file); const present = object(config.data.mcpServers);
  const stale = Object.keys(servers).filter((name) => { const entry = object(present[name]); return entry.command !== servers[name].command || JSON.stringify(entry.args) !== JSON.stringify(servers[name].args) || object(entry.env).ELECTRON_RUN_AS_NODE !== '1'; });
  // The rule is Trace's own file (no settings of the person's in it): replaced whole, through a temporary file.
  const rule = path.join(folder, 'rules', 'AGENTS.md'); let written = ''; try { written = fs.readFileSync(rule, 'utf8'); } catch { /* Not written yet. */ }
  if (written !== GEMINI_RULE) { fs.mkdirSync(path.dirname(rule), { recursive: true }); const temp = `${rule}.coding-hub-${randomUUID()}`; try { fs.writeFileSync(temp, GEMINI_RULE, { flag: 'wx' }); fs.renameSync(temp, rule); } finally { try { fs.unlinkSync(temp); } catch { /* Renamed. */ } } changed = true; }
  if (stale.length) {
    updateConfig(file, config.hash, (data) => { data.mcpServers = object(data.mcpServers); for (const name of stale) { const entry = object(data.mcpServers[name]); data.mcpServers[name] = { ...entry, ...servers[name], env: { ...object(entry.env), ELECTRON_RUN_AS_NODE: '1' } }; } });
    changed = true;
  }
  return changed;
}
/** The person turned Trace's plugin off in agy (`plugins.trace.enabled: false` in agy's config.json); unreadable counts as on. */
export function geminiPluginOff(root = geminiConfigRoot()): boolean {
  try { return object(object(readConfig(path.join(root, 'config.json')).data.plugins)[GEMINI_PLUGIN]).enabled === false; } catch { return false; }
}
