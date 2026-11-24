import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AGENT_ID, agentDefinitionSchema, definitionProblems, DRAFT_FORMAT, MAX_AGENTS, programCommand, validModel, type AgentDefinition } from '../../../shared/agent-definition';
import { agentLook, PERMISSION_NAMES, type AgentLook } from '../../../shared/agent-look';
import type { AgentDraft, AgentEntry, AgentList, AgentRequest, AgentTestResult } from '../../../shared/agents';
import { HubError } from '../cli/engine-adapter';
import { advertisesFlag, findExecutable, freshHostEnvironment, nodeScriptCommand, probeDirectory, PROBE_ENVIRONMENT, type Executable } from '../cli/discovery';
import { readConfig, updateConfig } from '../hub/config';
import { keepBackup } from '../hub/file-backups';
import { load, save } from '../workbench/local-store';

/**
 * Custom agents' store (docs/custom-agents.md): `agents/<id>.json` in Trace's storage, one definition per file, written
 * with updateConfig (backup, atomic replace). Saving or activating one asks in a native dialog that names the exact
 * program and arguments (`confirmSave`); only a definition confirmed on this computer starts. The confirmation is the
 * definition's hash in `agents-confirmed.json`, so a file changed or copied in by any other way waits to be confirmed.
 */
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('agent-list') }).strict(),
  z.object({ action: z.literal('agent-save'), definition: z.unknown(), replaces: z.string().regex(AGENT_ID).optional() }).strict(),
  z.object({ action: z.literal('agent-remove'), id: z.string().regex(AGENT_ID) }).strict(),
  z.object({ action: z.literal('agent-activate'), id: z.string().regex(AGENT_ID) }).strict(),
  z.object({ action: z.literal('agent-test'), definition: z.unknown() }).strict(),
  z.object({ action: z.literal('agent-draft'), command: programCommand }).strict(),
  z.object({ action: z.literal('agent-models'), id: z.string().regex(AGENT_ID) }).strict(),
]);
const confirmedSchema = z.object({ confirmed: z.record(z.string().regex(AGENT_ID), z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
const CONFIRMED = 'agents-confirmed.json';
/** What a probe (version, help, model list) may take: 10 seconds and 64 KB of output. */
export const PROBE_MS = 10_000; export const PROBE_BYTES = 64 * 1024;
/** Claude Code drafting a definition: at most two minutes. */
export const DRAFT_MS = 120_000;
const SCRIPT = /\.(?:c|m)?js$/i;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

export const definitionHash = (definition: AgentDefinition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex');
const pathOf = (env: Record<string, string>) => env[Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'] ?? '';

/** A Node script runs with Node: a console node.exe from PATH on Windows, else Trace itself as Node. */
function nodeExecutable(entry: string, env: Record<string, string>): Executable {
  const command = nodeScriptCommand(entry, env);
  return { file: command.file, prefixArgs: command.args, extraEnv: command.env.ELECTRON_RUN_AS_NODE === '1' && env.ELECTRON_RUN_AS_NODE !== '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {}, displayPath: entry };
}
/**
 * The program an npm or pnpm `.cmd` shim starts, read from the shim's text (never run): its `.js` entry or `.exe`, inside
 * the shim's own folder. Trace runs no batch file, but most Node CLIs on Windows are installed as one of these.
 */
export function shimTarget(shim: string): string | null {
  let text: string; try { if (fs.statSync(shim).size > PROBE_BYTES) return null; text = fs.readFileSync(shim, 'utf8'); } catch { return null; }
  const relative = /%~?dp0%?\\?([^"%*\r\n]+?\.(?:exe|cjs|mjs|js))"/i.exec(text)?.[1]; if (!relative) return null;
  const folder = path.dirname(path.resolve(shim)); const target = path.resolve(folder, relative);
  if (!target.toLowerCase().startsWith(folder.toLowerCase() + path.sep)) return null;
  try { return fs.statSync(target).isFile() ? target : null; } catch { return null; }
}
/**
 * Finds a definition's program without a shell: a full path as given, or the first match on PATH. On Windows that is an
 * .exe or .com, or a Node .js file, or the target of an npm shim; never a .cmd or .bat itself.
 */
export async function findProgram(command: string, env: Record<string, string>, platform: NodeJS.Platform = process.platform): Promise<Executable> {
  const windows = platform === 'win32';
  const isFile = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  const accept = (file: string): Executable | null => {
    if (SCRIPT.test(file)) return nodeExecutable(file, env);
    if (windows) return /\.(?:exe|com)$/i.test(file) ? { file, prefixArgs: [], extraEnv: {}, displayPath: file } : null;
    try { fs.accessSync(file, fs.constants.X_OK); return { file, prefixArgs: [], extraEnv: {}, displayPath: file }; } catch { return null; }
  };
  if (ABSOLUTE.test(command)) {
    const file = path.normalize(command);
    if (!isFile(file)) throw new HubError('AGENT_PROGRAM', `${command} was not found. Check the path, or give the program's name to find it on PATH.`);
    const found = accept(file); if (found) return found;
    throw new HubError('AGENT_PROGRAM', windows ? `${command} is not a program Trace can run. Name an .exe, or a Node .js file.` : `${command} can't be run: it is not marked executable (chmod +x).`);
  }
  const names = windows ? (/\.(?:exe|com|c?js|mjs)$/i.test(command) ? [command] : [`${command}.exe`, `${command}.com`, `${command}.cmd`]) : [command];
  for (const directory of pathOf(env).split(path.delimiter).filter(Boolean)) for (const name of names) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), name); if (!isFile(candidate)) continue;
    if (/\.cmd$/i.test(candidate)) { const target = shimTarget(candidate); const found = target ? accept(target) : null; if (found) return { ...found, displayPath: candidate }; continue; }
    const found = accept(candidate); if (found) return found;
  }
  throw new HubError('AGENT_NOT_FOUND', `${command} was not found on PATH. Install it, check that it runs in a terminal, then try again (or give its full path).`);
}

/** Runs a program without a shell and keeps what it prints, at most `limit` bytes; stopped after `timeout`. */
export function runCaptured(executable: Executable, args: string[], options: { env: Record<string, string>; timeout: number; limit: number; input?: string; cwd?: string }): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = ''; let timedOut = false; let done = false;
    const finish = (exitCode: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ output: output.slice(0, options.limit), exitCode, timedOut }); };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable.file, [...executable.prefixArgs, ...args], { cwd: options.cwd ?? probeDirectory(), env: { ...options.env, ...executable.extraEnv }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ output: `It could not start: ${(error as Error).message}`, exitCode: null, timedOut: false }); return; }
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* Gone. */ } }, options.timeout);
    const take = (chunk: Buffer) => { if (output.length < options.limit) output += chunk.toString('utf8'); else try { child.kill(); } catch { /* Gone. */ } };
    child.stdout?.on('data', take); child.stderr?.on('data', take);
    child.once('error', (error) => { output += `It could not start: ${error.message}`; finish(null); });
    child.once('close', (code) => finish(code));
    child.stdin?.on('error', () => {}); child.stdin?.end(options.input ?? '');
  });
}

/** An argument as the confirmation shows it: quoted when it has spaces, so the person sees where each one ends. */
const shown = (value: string) => value === '' ? '""' : /[\s"]/.test(value) ? JSON.stringify(value) : value;
export const commandLine = (parts: string[]) => parts.map(shown).join(' ');
/** The native confirmation's text: the exact program, every argument it can be given, and its environment. */
export function describeDefinition(definition: AgentDefinition, program: string): string {
  const lines = [`Program: ${program}`, `Always with: ${definition.program.args?.length ? commandLine(definition.program.args) : '(no arguments)'}`];
  if (definition.permissions) for (const level of ['ask', 'edits', 'full'] as const) lines.push(`${PERMISSION_NAMES[level]}: ${definition.permissions[level].length ? commandLine(definition.permissions[level]) : '(no arguments)'}`);
  else lines.push('Permissions: the program’s own settings (no arguments)');
  if (definition.models) lines.push(`Model: ${commandLine(definition.models.arg)}`);
  if (definition.resume) lines.push(`Resume: ${commandLine(definition.resume.args)}`);
  if (definition.mcp && definition.mcp.format !== 'none') lines.push(`Shared memory and channel tools: ${definition.mcp.format === 'claude-json' ? commandLine(definition.mcp.args ?? []) : 'Codex-style --config mcp_servers.* arguments'}`);
  if (definition.instructions) lines.push(`Instructions: ${'args' in definition.instructions ? commandLine(definition.instructions.args) : `in ${definition.instructions.env}`}`);
  for (const [name, value] of Object.entries(definition.env ?? {})) lines.push(`Environment: ${name}=${value}`);
  if (definition.version) lines.push(`Test start: ${commandLine(definition.version.args)}`);
  if (definition.models?.listArgs) lines.push(`Model list: ${commandLine(definition.models.listArgs)}`);
  return lines.join('\n');
}

/** The JSON object in Claude Code's answer: a fenced block, or the outermost braces. */
export function jsonFrom(answer: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(answer)?.[1]; const start = answer.indexOf('{'); const end = answer.lastIndexOf('}');
  for (const text of [fenced, start >= 0 && end > start ? answer.slice(start, end + 1) : undefined]) {
    if (!text) continue; try { const value = JSON.parse(text.trim()); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* Try the next form. */ }
  }
  return null;
}

export interface AgentDialogs {
  /** Saving or activating: the agent's name and the text of describeDefinition. */
  confirmSave(agent: { name: string; detail: string; activate: boolean }): Promise<boolean>;
  /** Running a program the person has not confirmed yet (Test start, the help a draft is made from). */
  confirmRun(run: { title: string; message: string; detail: string }): Promise<boolean>;
}

export class CustomAgents {
  readonly folder: string;
  constructor(private root: string, private dialogs: AgentDialogs, private options: { environment?: () => Promise<Record<string, string>>; claude?: (env: Record<string, string>) => Promise<Executable> } = {}) { this.folder = path.join(root, 'agents'); }
  private environment() { return (this.options.environment ?? freshHostEnvironment)(); }
  private confirmed() { return load(this.root, CONFIRMED, confirmedSchema, { confirmed: {} }).confirmed; }
  private setConfirmed(id: string, hash: string | null) { const confirmed = { ...this.confirmed() }; if (hash) confirmed[id] = hash; else delete confirmed[id]; save(this.root, CONFIRMED, { confirmed }); }
  private file(id: string) { if (!AGENT_ID.test(id)) throw new HubError('AGENT_ID', 'That is not an agent id.'); return path.join(this.folder, `${id}.json`); }

  /** The definition saved under `id`, checked; null when there is no file. */
  private read(id: string): { definition: AgentDefinition | null; problem: string | null } | null {
    const file = this.file(id); if (!fs.existsSync(file)) return null;
    let data: unknown; try { data = readConfig(file).data; } catch (error) { return { definition: null, problem: error instanceof HubError ? error.message : 'The file could not be read.' }; }
    const parsed = agentDefinitionSchema.safeParse(data);
    if (!parsed.success) return { definition: null, problem: `This definition is not valid: ${definitionProblems(parsed.error).join(' ')}` };
    if (parsed.data.id !== id) return { definition: null, problem: `The file is named ${id}.json but its id is ${parsed.data.id}. Rename one so they match.` };
    return { definition: parsed.data, problem: null };
  }
  private ids(): string[] { try { return fs.readdirSync(this.folder).flatMap((name) => { const id = name.endsWith('.json') ? name.slice(0, -5) : ''; return AGENT_ID.test(id) ? [id] : []; }).sort(); } catch { return []; } }

  async list(): Promise<AgentList> {
    const confirmed = this.confirmed(); const env = await this.environment();
    const agents = await Promise.all(this.ids().map(async (id): Promise<AgentEntry> => {
      const read = this.read(id)!; const definition = read.definition;
      let program: string | null = null; let problem = read.problem;
      if (definition) try { program = (await findProgram(definition.program.command, env)).displayPath; } catch (error) { problem = error instanceof HubError ? error.message : 'Its program was not found.'; }
      return { id, look: agentLook(definition ?? { id, name: id }), definition, active: Boolean(definition && confirmed[id] === definitionHash(definition)), program, problem };
    }));
    return { agents };
  }

  /** How each agent turned on here looks, read without looking for programs: for phones' + Channel and channel lists. */
  looks(): AgentLook[] {
    let confirmed: Record<string, string>; try { confirmed = this.confirmed(); } catch { return []; }
    return this.ids().flatMap((id) => { try { const definition = this.read(id)?.definition; return definition && confirmed[id] === definitionHash(definition) ? [agentLook(definition)] : []; } catch { return []; } });
  }
  /** How one agent looks, turned on or not (a channel keeps its agent's name and colour); null when it is gone. */
  look(id: string): AgentLook | null { try { const definition = this.read(id)?.definition; return definition ? agentLook(definition) : null; } catch { return null; } }
  /** The models a saved agent's definition lists (`models.choices`). */
  choices(id: string): string[] { try { return this.read(id)?.definition?.models?.choices ?? []; } catch { return []; } }
  /** A saved agent's status signals, whether or not it is on (a run the background runner kept is read with them). */
  status(id: string): AgentDefinition['status'] | null { try { return this.read(id)?.definition?.status ?? null; } catch { return null; } }
  /** What a channel start needs: the confirmed definition and its program on this computer. */
  async launchable(id: string, env: Record<string, string>): Promise<{ definition: AgentDefinition; executable: Executable }> {
    const read = this.read(id);
    if (!read) throw new HubError('AGENT_MISSING', 'This channel’s agent was removed. Add it again under Agent setup → Agents, or close the channel.');
    if (!read.definition) throw new HubError('AGENT_INVALID', `${read.problem} Fix it under Agent setup → Agents.`);
    if (this.confirmed()[id] !== definitionHash(read.definition)) throw new HubError('AGENT_NOT_CONFIRMED', `${read.definition.name} changed or came from another computer, so it needs your confirmation before it runs. Open Agent setup → Agents and choose Turn on.`);
    return { definition: read.definition, executable: await findProgram(read.definition.program.command, env) };
  }

  private checked(input: unknown): AgentDefinition {
    const parsed = agentDefinitionSchema.safeParse(input);
    if (!parsed.success) throw new HubError('AGENT_INVALID', definitionProblems(parsed.error).join(' '));
    return parsed.data;
  }

  async save(input: unknown, replaces?: string): Promise<AgentList> {
    const definition = this.checked(input); const file = this.file(definition.id);
    if (definition.id !== replaces && fs.existsSync(file)) throw new HubError('AGENT_EXISTS', `An agent with the id ${definition.id} already exists. Choose another id, or edit that one.`);
    if (!replaces && this.ids().length >= MAX_AGENTS) throw new HubError('AGENT_LIMIT', `Up to ${MAX_AGENTS} custom agents are supported.`);
    const program = await findProgram(definition.program.command, await this.environment());
    if (!await this.dialogs.confirmSave({ name: definition.name, detail: describeDefinition(definition, program.displayPath), activate: false })) throw new HubError('AGENT_DECLINED', 'The agent was not saved.');
    const inspected = readConfig(file);
    updateConfig(file, inspected.hash, (data) => { for (const key of Object.keys(data)) delete data[key]; Object.assign(data, definition); });
    this.setConfirmed(definition.id, definitionHash(definition));
    if (replaces && replaces !== definition.id) this.remove(replaces);
    return this.list();
  }

  /** Removes a definition; a private copy is kept with Trace's other configuration backups. */
  remove(id: string) {
    const file = this.file(id);
    try { const text = fs.readFileSync(file, 'utf8'); keepBackup(file, text); fs.rmSync(file, { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HubError('AGENT_REMOVE', 'The agent could not be removed. Check that Trace can write its storage folder.'); }
    this.setConfirmed(id, null);
  }

  /** Confirms a definition that changed or was copied in, after the same dialog as saving. */
  async activate(id: string): Promise<AgentList> {
    const read = this.read(id); if (!read?.definition) throw new HubError('AGENT_INVALID', read?.problem ?? 'That agent is gone.');
    const program = await findProgram(read.definition.program.command, await this.environment());
    if (!await this.dialogs.confirmSave({ name: read.definition.name, detail: describeDefinition(read.definition, program.displayPath), activate: true })) throw new HubError('AGENT_DECLINED', 'The agent was not turned on.');
    this.setConfirmed(id, definitionHash(read.definition)); return this.list();
  }

  /** Test start: the version arguments (or --version), run once. A definition not yet confirmed asks first. */
  async test(input: unknown): Promise<AgentTestResult> {
    const definition = this.checked(input); const env = { ...await this.environment(), ...definition.env };
    const program = await findProgram(definition.program.command, env); const args = definition.version?.args ?? ['--version'];
    const command = commandLine([program.displayPath, ...args]);
    if (this.confirmed()[definition.id] !== definitionHash(definition) && !await this.dialogs.confirmRun({ title: 'Test start', message: `Run ${definition.name} once to see that it starts?`, detail: `${command}\n\nIt runs as you, without a shell, for at most 10 seconds.` })) throw new HubError('AGENT_DECLINED', 'The test did not run.');
    return { command, ...await runCaptured(program, args, { env, timeout: PROBE_MS, limit: PROBE_BYTES }) };
  }

  /** The models the program lists (`models.listArgs`), one per line; only names that can fill {model}. */
  async models(id: string): Promise<string[]> {
    const env = await this.environment(); const { definition, executable } = await this.launchable(id, env);
    const listed = definition.models?.listArgs ? await runCaptured(executable, definition.models.listArgs, { env: { ...env, ...definition.env }, timeout: PROBE_MS, limit: PROBE_BYTES }) : null;
    const names = (listed?.exitCode === 0 ? listed.output.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0] ?? '') : []).filter(validModel);
    return [...new Set([...(definition.models?.choices ?? []), ...names])].slice(0, 100);
  }

  /**
   * Draft it for me: after a confirmation, the program's --help and --version (10 s, 64 KB each), then the person's own
   * Claude Code in print mode (`claude -p`, no tools) fills in a definition from them. The answer is checked, never trusted.
   */
  async draft(command: string): Promise<AgentDraft> {
    const env = await this.environment(); const program = await findProgram(command, env);
    let claude: Executable;
    try { claude = await (this.options.claude ?? ((value) => findExecutable('claude', value)))(env); }
    catch { throw new HubError('CLAUDE_MISSING', 'Claude Code was not found on this computer, so Trace can’t draft the agent. Fill in the form yourself instead.'); }
    if (!await this.dialogs.confirmRun({ title: 'Draft an agent', message: `Run ${command} to read its help?`, detail: `Trace runs ${commandLine([program.displayPath, '--help'])} and ${commandLine([program.displayPath, '--version'])} (10 seconds each, without a shell), then asks your Claude Code (claude -p, with no tools) to draft a definition from what they print. You check the draft before anything is saved.` })) throw new HubError('AGENT_DECLINED', 'Nothing was run.');
    const probe = { env: { ...env, ...PROBE_ENVIRONMENT }, timeout: PROBE_MS, limit: PROBE_BYTES };
    const [help, version] = await Promise.all([runCaptured(program, ['--help'], probe), runCaptured(program, ['--version'], probe)]);
    if (!help.output.trim()) throw new HubError('AGENT_HELP', `${command} --help printed nothing${help.timedOut ? ' in 10 seconds' : ''}, so there is nothing to draft from. Fill in the form yourself.`);
    const own = await runCaptured(claude, ['--help'], probe);
    const flags = [...(advertisesFlag(own.output, '--tools') ? ['--tools', ''] : []), ...(advertisesFlag(own.output, '--no-session-persistence') ? ['--no-session-persistence'] : []), ...(advertisesFlag(own.output, '--strict-mcp-config') ? ['--strict-mcp-config'] : [])];
    const prompt = [`Fill in a Trace agent definition for the command-line program "${command}". Answer with the JSON object only.`, '', DRAFT_FORMAT, '', `Its --version printed:\n${version.output.slice(0, 2000)}`, '', `Its --help printed:\n${help.output.slice(0, 40_000)}`].join('\n');
    const answer = await runCaptured(claude, ['-p', '--output-format', 'text', ...flags], { env: probe.env, timeout: DRAFT_MS, limit: 256 * 1024, input: prompt });
    if (answer.timedOut) throw new HubError('DRAFT_TIMEOUT', 'Claude Code did not answer within 2 minutes. Try again, or fill in the form yourself.');
    const draft = jsonFrom(answer.output);
    if (!draft) throw new HubError('DRAFT_UNREADABLE', `Claude Code did not answer with a definition${answer.exitCode ? ` (it exited with code ${answer.exitCode}; is it signed in?)` : ''}. Try again, or fill in the form yourself.`);
    // The program is the one the person named, whatever the draft says.
    draft.schema = 1; const drafted = draft.program && typeof draft.program === 'object' ? draft.program as Record<string, unknown> : {}; draft.program = { ...drafted, command };
    const parsed = agentDefinitionSchema.safeParse(draft);
    return { definition: draft, problems: parsed.success ? [] : definitionProblems(parsed.error) };
  }

  async execute(input: unknown): Promise<AgentList | AgentTestResult | AgentDraft | string[] | null> {
    const request = requestSchema.parse(input) as AgentRequest;
    if (request.action === 'agent-list') return this.list();
    if (request.action === 'agent-save') return this.save(request.definition, request.replaces);
    if (request.action === 'agent-remove') { this.remove(request.id); return this.list(); }
    if (request.action === 'agent-activate') return this.activate(request.id);
    if (request.action === 'agent-test') return this.test(request.definition);
    if (request.action === 'agent-models') return this.models(request.id);
    return this.draft(request.command);
  }
}
