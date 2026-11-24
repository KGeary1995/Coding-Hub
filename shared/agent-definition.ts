import { z } from 'zod';
import type { AgentDefinition as ShapeForPhone } from './agents';

/**
 * Custom agents (docs/custom-agents.md, 1.40.0): a CLI the person adds as a small JSON definition, read at run time,
 * instead of a Trace release per CLI. This file is the one place that says what a definition may hold. The host builds
 * every launch from a validated definition; the window only ever sends one to be checked and confirmed.
 */
export const AGENT_ID = /^[a-z][a-z0-9-]{1,30}$/;
/** Names a definition can't take: the built-in channel types (and the custom type itself). */
export const RESERVED_IDS = ['claude', 'codex', 'gemini', 'shell', 'custom'] as const;
/** A model name: from `choices`, the program's own list, or typed. It never starts with `-`, so it can't be read as a flag. */
export const AGENT_MODEL = /^[A-Za-z0-9][\w.:/@+-]{0,119}$/;
/** A conversation ID to resume, typed by the person or printed by the program; never a flag either. */
export const AGENT_RESUME_ID = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;
/** As long as a prepared request may be (shared/schemas.ts preparedRequest). */
export const MAX_AGENT_PROMPT = 4000;
export const MAX_AGENTS = 20;
/** An ACP session mode id (`session/set_mode`), as the agent lists it: never a flag, no spaces. */
export const AGENT_MODE = /^[A-Za-z0-9][\w.:/-]{0,79}$/;
export const PLACEHOLDERS = ['model', 'prompt', 'id', 'file', 'text'] as const;
export type Placeholder = typeof PLACEHOLDERS[number];
const PLACEHOLDER = /\{([a-z]+)\}/g;

/** Programs that are shells or start other programs from text: a definition names the agent itself, never one of these. */
const SHELLS = new Set(['cmd', 'command', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'nu', 'xonsh', 'wsl', 'env', 'sudo', 'doas', 'start', 'open', 'osascript', 'cscript', 'wscript', 'mshta', 'rundll32', 'conhost', 'explorer']);
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const baseName = (command: string) => command.split(/[\\/]/).at(-1) ?? command;

/** One argument: at most 500 characters, no NUL or line break, and only the placeholders its field may use. */
const argument = (allowed: readonly Placeholder[]) => z.string().max(500).refine((value) => !/[\0\r\n]/.test(value), 'An argument can’t hold a line break.').superRefine((value, context) => {
  for (const match of value.matchAll(PLACEHOLDER)) {
    const name = match[1] as Placeholder;
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) context.addIssue({ code: 'custom', message: `{${name}} is not a placeholder Trace knows. Use ${PLACEHOLDERS.map((item) => `{${item}}`).join(', ')}.` });
    else if (!allowed.includes(name)) context.addIssue({ code: 'custom', message: `{${name}} can’t be used here.${allowed.length ? ` This field takes ${allowed.map((item) => `{${item}}`).join(' and ')}.` : ''}` });
  }
});
const args = (allowed: readonly Placeholder[] = []) => z.array(argument(allowed)).max(30);
/** A pattern over the screen's lines: compiled once, at most 200 characters. */
const pattern = z.string().min(1).max(200).refine((value) => { try { new RegExp(value); return true; } catch { return false; } }, 'This pattern is not a valid regular expression.');
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Use letters, digits and _ for a variable name.')
  .refine((name) => name.toUpperCase() !== 'PATH' && !name.toUpperCase().startsWith('CODING_HUB_') && name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE', 'Trace sets this variable itself.');

const modeId = z.string().regex(AGENT_MODE, 'Use a mode id the agent lists, such as plan.');

export const programCommand =z.string().min(1).max(1024)
  .refine((value) => !/[\0\r\n]/.test(value), 'The program can’t hold a line break.')
  .refine((value) => ABSOLUTE.test(value) || /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(value), 'Give the program’s name, such as aider, or its full path. Its arguments go in program.args.')
  .refine((value) => !/\.(cmd|bat|ps1|vbs|lnk)$/i.test(value), 'Trace runs no batch or script files (.cmd, .bat, .ps1). Name the program itself: an .exe, or a Node .js file.')
  .refine((value) => !SHELLS.has(baseName(value).replace(/\.exe$/i, '').toLowerCase()), 'A shell can run anything. Name the agent’s own program instead.');

export const agentDefinitionSchema = z.object({
  schema: z.literal(1),
  id: z.string().regex(AGENT_ID, 'The id is 2 to 31 lowercase letters, digits or -, starting with a letter.').refine((id) => !(RESERVED_IDS as readonly string[]).includes(id), 'That id belongs to a built-in agent. Choose another.'),
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour such as #7c9cff.').optional(),
  program: z.object({ command: programCommand, args: args().optional() }).strict(),
  version: z.object({ args: args() }).strict().optional(),
  models: z.object({ choices: z.array(z.string().regex(AGENT_MODEL)).max(50).optional(), listArgs: args().nullable().optional(), arg: args(['model']) }).strict().optional(),
  permissions: z.object({ ask: args(), edits: args(), full: args() }).strict().optional(),
  resume: z.object({ args: args(['id']), listArgs: args().nullable().optional() }).strict().optional(),
  firstRequest: z.object({ args: args(['prompt']) }).strict().optional(),
  status: z.object({
    osc: z.boolean().optional(),
    waiting: z.array(pattern).max(10).optional(),
    turnEnd: z.array(pattern).max(10).optional(),
    quietSeconds: z.number().int().refine((value) => value === 0 || (value >= 2 && value <= 60), 'Quiet time is 0 (off) or 2 to 60 seconds.').optional(),
  }).strict().optional(),
  mcp: z.object({ format: z.enum(['claude-json', 'codex-toml', 'none']), args: args(['file']).optional() }).strict().optional(),
  instructions: z.union([z.object({ args: args(['text']) }).strict(), z.object({ env: envName }).strict()]).optional(),
  env: z.record(envName, z.string().max(2000).refine((value) => !value.includes('\0'))).refine((value) => Object.keys(value).length <= 20, 'At most 20 variables.').optional(),
  /**
   * Phase 2: the arguments that start the program as an Agent Client Protocol server (JSON-RPC over stdin and stdout),
   * for its chat channel and Round Table seats, and the session mode each permission level asks for, where it has modes.
   */
  acp: z.object({ args: args(), modes: z.object({ ask: modeId.optional(), edits: modeId.optional(), full: modeId.optional() }).strict().optional() }).strict().optional(),
}).strict().superRefine((definition, context) => {
  // A claude-json file reaches the program only through {file}; codex-toml takes Codex's own --config arguments.
  if (definition.mcp?.format === 'claude-json' && !definition.mcp.args?.some((value) => value.includes('{file}'))) context.addIssue({ code: 'custom', path: ['mcp', 'args'], message: 'claude-json needs args with {file}, such as ["--mcp-config", "{file}"].' });
  if (definition.models && !definition.models.arg.some((value) => value.includes('{model}'))) context.addIssue({ code: 'custom', path: ['models', 'arg'], message: 'models.arg needs {model}, such as ["--model", "{model}"].' });
  if (definition.resume && !definition.resume.args.some((value) => value.includes('{id}'))) context.addIssue({ code: 'custom', path: ['resume', 'args'], message: 'resume.args needs {id}.' });
  if (definition.instructions && 'args' in definition.instructions && !definition.instructions.args.some((value) => value.includes('{text}'))) context.addIssue({ code: 'custom', path: ['instructions', 'args'], message: 'instructions.args needs {text}.' });
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
/** The schema and the shape written out for the phone (shared/agents.ts) say the same thing. */
type Agrees<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const agrees: Agrees<AgentDefinition, ShapeForPhone> = true; void agrees;

/** A zod refusal as one plain sentence per problem, naming the field. */
export function definitionProblems(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((issue) => `${issue.path.length ? issue.path.join('.') + ': ' : ''}${issue.message}`);
}

/**
 * Fills placeholders in a definition's arguments. Each argument stays one argument whatever its value holds (spaces,
 * quotes): nothing is split, and no shell ever reads it. A placeholder without a value is refused, never left as text.
 */
export function fillArgs(template: readonly string[], values: Partial<Record<Placeholder, string>>): string[] {
  return template.map((value) => value.replace(PLACEHOLDER, (whole, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) return whole;
    const filled = values[name as Placeholder];
    if (filled === undefined) throw new Error(`No value for {${name}}.`);
    return filled;
  }));
}

/** A model or conversation ID the person or the program gave, checked before it fills a placeholder. */
export const validModel = (value: string) => AGENT_MODEL.test(value);
export const validResumeId = (value: string) => AGENT_RESUME_ID.test(value);
/** A first request that can go to the program as one argument (`firstRequest.args`): text, at most as long as a prepared request. */
export const promptFits = (value: string) => value.trim().length > 0 && value.length <= MAX_AGENT_PROMPT && !value.includes('\0');

/**
 * The format section of docs/custom-agents.md, given to Claude Code with a program's --help when the person asks Trace
 * to draft a definition. Kept short: the schema above still checks whatever comes back.
 */
export const DRAFT_FORMAT = `A Trace agent definition is JSON (schema 1). Unknown fields are refused. Example:
{"schema":1,"id":"aider","name":"Aider","color":"#7c9cff",
 "program":{"command":"aider","args":["--no-auto-commits"]},
 "version":{"args":["--version"]},
 "models":{"choices":["sonnet","gpt-4.1"],"listArgs":null,"arg":["--model","{model}"]},
 "permissions":{"ask":[],"edits":["--yes-always"],"full":["--yes-always"]},
 "resume":{"args":["--restore-chat-history"]},
 "firstRequest":{"args":["--message","{prompt}"]},
 "status":{"osc":true,"waiting":["\\\\(Y\\\\)es/\\\\(N\\\\)o"],"turnEnd":["^> $"],"quietSeconds":4},
 "mcp":{"format":"claude-json","args":["--mcp-config","{file}"]},
 "instructions":{"args":["--append-system-prompt","{text}"]},
 "env":{"AIDER_CHECK_UPDATE":"false"},
 "acp":{"args":["acp"],"modes":{"ask":"plan","edits":"accept-edits","full":"auto"}}}
Rules:
- id: ^[a-z][a-z0-9-]{1,30}$, not claude, codex, gemini, shell or custom. name: 1-40 characters. color: #rrggbb, optional.
- program.command: the program's name on PATH (or a full path), never a shell, .cmd or .bat. Arguments are arrays of strings.
- Placeholders, replaced inside one argument: {model} in models.arg, {id} in resume.args, {prompt} in firstRequest.args, {file} in mcp.args, {text} in instructions.args. No others.
- Every field but schema, id, name and program is optional: leave out what the help text does not show.
- models.choices: model names the help lists. models.listArgs: arguments that print one model per line, or null.
- permissions: arguments for ask (asks before edits and commands), edits (edits files without asking), full (never asks). Leave permissions out unless the help shows such flags.
- resume.args: arguments to continue a conversation, with {id} for its ID.
- status: how Trace tells the agent waits or finished a turn. osc: true when it sends terminal notifications (OSC 9/777/99). waiting: regexes for its approval questions. turnEnd: regexes for its idle prompt line. quietSeconds: 2-60 seconds of no output that mean the turn ended (4 is a good default), 0 for off.
- mcp.format: claude-json (a {"mcpServers":{...}} file passed with {file}), codex-toml (Codex-style --config mcp_servers.* arguments), or none.
- instructions: {"args":[...,"{text}"]} or {"env":"VARIABLE"} for extra system instructions, if the program takes them.
- env: environment variables the program needs (no secrets).
- acp: only when the help shows an Agent Client Protocol (ACP) server mode, such as an acp subcommand or an --acp or --experimental-acp flag: {"args":[...]} with the arguments that start it. modes: the session mode ids for ask (read-only, or asks before changes), edits and full, only those the help names; leave modes out otherwise. No placeholders in acp.`;
