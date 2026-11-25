import type { ChatEvent } from '../../../shared/chat';
import type { PermissionLevel } from '../../../shared/types';
import { AcpStream, type AcpOptions } from './acp-stream';
import { GEMINI_SAFE_COMMANDS } from '../../../shared/safe-actions';
import { GEMINI_TOOL_RULES } from '../hub/gemini-plugin';
export { CONFIRM_MS } from './acp-stream';

/**
 * agy's session mode for each permission level (from 1.39; Ask is plan, read-only, from 1.40.1 by the owner's decision of
 * 2026-11-24, because Default could edit without asking). agy 1.5.16 offers default, accept-edits,
 * auto and plan in `session/new` and `session/load` (seen 2026-11-24). Default asks before commands and, by agy's own
 * permission settings, may write files without asking (it did, seen with 1.5.16): Trace cannot set those settings over
 * ACP. Accept edits writes without asking and asks before commands. Auto also runs commands it takes for safe; at Full
 * access Trace answers whatever it still asks (allow), as Claude's and Codex's full access never ask.
 */
export const GEMINI_MODE: Record<PermissionLevel, string> = { ask: 'plan', edits: 'accept-edits', full: 'auto' };

/**
 * What a Gemini chat at Allow edits runs without asking, as a Gemini terminal's --settings allow it there (`agy acp` takes
 * no settings). agy 1.5.16 asks with `run_command` ({ CommandLine }) and `call_mcp_tool` ({ ServerName, ToolName }), seen
 * 2026-11-25. A command must equal a safe one exactly, as agy matches its rules, so `git status && rm -rf x` asks.
 */
export function geminiAllows(call: Record<string, unknown>, safeCommands: boolean): boolean {
  const input = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput as Record<string, unknown> : {};
  if (call.name === 'run_command') return safeCommands && typeof input.CommandLine === 'string' && GEMINI_SAFE_COMMANDS.includes(input.CommandLine.trim());
  if (call.name === 'call_mcp_tool') return typeof input.ServerName === 'string' && typeof input.ToolName === 'string' && GEMINI_TOOL_RULES.includes(`mcp(${input.ServerName}/${input.ToolName})`);
  return false;
}

/**
 * A Gemini chat run: a Round Table's seat (in 1.20, removed in 1.21, back in 1.28), and from 1.39 a chat channel that
 * leads a table or edits at one. Gemini CLI's Agent Client Protocol server (`agy acp`), driven as AcpStream drives every
 * ACP agent (from custom agents' phase 2 the same class serves them), with agy's ways: plan mode while read-only (Ask's
 * mode), and a model or mode counts only once agy reports it. Its memory tools come from Trace's agy plugin, not ACP.
 */
export class GeminiStream extends AcpStream {
  constructor(write: (line: string) => void, emit: (event: ChatEvent) => void, options: AcpOptions) { super(write, emit, options, { name: 'Gemini', prefix: 'gemini', modes: GEMINI_MODE, agy: true, allows: geminiAllows }); }
}
