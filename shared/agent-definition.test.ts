import { describe, expect, it } from 'vitest';
import { agentDefinitionSchema, definitionProblems, fillArgs, validModel, validResumeId, type AgentDefinition } from './agent-definition';
import { agentColor, agentInitials, AGENT_PALETTE } from './agent-look';
import { channelConfigSchema, startSessionSchema } from './schemas';
import { isAgentConfig, isBuiltInAgent, isChatRun } from './types';

/** The example from docs/custom-agents.md. */
const aider = (): AgentDefinition => ({
  schema: 1, id: 'aider', name: 'Aider', color: '#7c9cff',
  program: { command: 'aider', args: ['--no-auto-commits'] }, version: { args: ['--version'] },
  models: { choices: ['sonnet', 'gpt-4.1'], listArgs: null, arg: ['--model', '{model}'] },
  permissions: { ask: [], edits: ['--yes-always'], full: ['--yes-always'] }, resume: { args: ['--restore-chat-history', '{id}'] },
  firstRequest: { args: ['--message', '{prompt}'] }, status: { osc: true, waiting: ['\\(Y\\)es/\\(N\\)o', 'Allow .* \\?'], turnEnd: ['^> $'], quietSeconds: 4 },
  mcp: { format: 'claude-json', args: ['--mcp-config', '{file}'] }, instructions: { args: ['--append-system-prompt', '{text}'] }, env: { AIDER_CHECK_UPDATE: 'false' },
});
const refused = (change: (definition: any) => void) => { const definition: any = aider(); change(definition); const result = agentDefinitionSchema.safeParse(definition); return result.success ? null : definitionProblems(result.error).join(' | '); };

describe('agent definitions', () => {
  it('accepts the documented example and a minimal one', () => {
    expect(agentDefinitionSchema.safeParse(aider()).success).toBe(true);
    expect(agentDefinitionSchema.safeParse({ schema: 1, id: 'my-agent', name: 'Mine', program: { command: 'C:\\Tools\\mine.exe' } }).success).toBe(true);
    expect(agentDefinitionSchema.safeParse({ schema: 1, id: 'node-agent', name: 'Node', program: { command: '/opt/agent/cli.js' } }).success).toBe(true);
  });
  it('takes acp (phase 2): its arguments with no placeholder, and mode ids that are not flags; a definition without it stays valid', () => {
    expect(refused((definition) => { definition.acp = { args: ['acp'], modes: { ask: 'plan', edits: 'accept-edits', full: 'auto' } }; })).toBeNull();
    expect(refused((definition) => { definition.acp = { args: [] }; })).toBeNull();
    expect(refused((definition) => { definition.acp = { args: ['--acp', '{model}'] }; })).toMatch(/can’t be used here/);
    expect(refused((definition) => { definition.acp = { args: ['acp'], modes: { ask: '--yolo' } }; })).toMatch(/mode id/);
    expect(refused((definition) => { definition.acp = { args: ['acp'], modes: { ask: 'plan', write: 'x' } }; })).not.toBeNull();
    expect(refused((definition) => { definition.acp = { args: ['acp'], extra: 1 }; })).not.toBeNull();
    expect(refused((definition) => { definition.acp = { args: ['line\nbreak'] }; })).not.toBeNull();
  });
  it('refuses a shell, a batch file, or a command line in the program', () => {
    for (const command of ['cmd', 'cmd.exe', 'powershell', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '/bin/bash', 'sh', 'pwsh', 'env', 'agy.cmd', 'C:\\x\\run.bat', 'tool.ps1', 'aider --yes', 'aider && calc', 'aider;rm', '-x', 'a\nb'])
      expect(refused((definition) => { definition.program.command = command; }), command).not.toBeNull();
  });
  it('refuses unknown placeholders, and a placeholder in a field that does not take it', () => {
    expect(refused((definition) => { definition.program.args = ['{home}']; })).toMatch(/not a placeholder/);
    expect(refused((definition) => { definition.program.args = ['{prompt}']; })).toMatch(/can’t be used here/);
    expect(refused((definition) => { definition.permissions.full = ['--model={model}']; })).toMatch(/can’t be used here/);
    expect(refused((definition) => { definition.models.arg = ['--model']; })).toMatch(/needs \{model\}/);
    expect(refused((definition) => { definition.mcp.args = ['--mcp-config']; })).toMatch(/needs args with \{file\}/);
    // Braces that are not a placeholder (JSON in an argument) are fine.
    expect(refused((definition) => { definition.program.args = ['--settings={"a":1}']; })).toBeNull();
  });
  it('refuses an id that clashes with a built-in agent, unknown fields, and bad ids', () => {
    for (const id of ['claude', 'codex', 'gemini', 'shell', 'custom', 'A', 'x', '1abc', 'has space', 'a'.repeat(32)]) expect(refused((definition) => { definition.id = id; }), id).not.toBeNull();
    expect(refused((definition) => { definition.extra = true; })).not.toBeNull();
    expect(refused((definition) => { definition.status.extra = true; })).not.toBeNull();
  });
  it('limits status patterns: valid, at most 200 characters, and quiet time 0 or 2 to 60 seconds', () => {
    expect(refused((definition) => { definition.status.waiting = ['(unclosed']; })).toMatch(/not a valid regular expression/);
    expect(refused((definition) => { definition.status.turnEnd = ['x'.repeat(201)]; })).not.toBeNull();
    expect(refused((definition) => { definition.status.quietSeconds = 1; })).not.toBeNull();
    expect(refused((definition) => { definition.status.quietSeconds = 61; })).not.toBeNull();
    expect(refused((definition) => { definition.status.quietSeconds = 0; })).toBeNull();
  });
  it('refuses environment variables Trace sets itself', () => {
    for (const name of ['PATH', 'Path', 'CODING_HUB_MEMORY_KEY', 'ELECTRON_RUN_AS_NODE', 'bad-name']) expect(refused((definition) => { definition.env = { [name]: 'x' }; }), name).not.toBeNull();
  });
  it('fills placeholders without ever splitting an argument', () => {
    const prompt = 'fix the "tests" && rm -rf / ; $(calc)\twith spaces';
    expect(fillArgs(['--message', '{prompt}'], { prompt })).toEqual(['--message', prompt]);
    expect(fillArgs(['--model={model}', 'x'], { model: 'gpt-4.1' })).toEqual(['--model=gpt-4.1', 'x']);
    expect(fillArgs(['--config', '{a}'], {})).toEqual(['--config', '{a}']);
    expect(() => fillArgs(['--model', '{model}'], {})).toThrow(/No value/);
  });
  it('checks models and conversation ids before they fill a placeholder', () => {
    expect(validModel('anthropic/claude-sonnet-4.5')).toBe(true); expect(validModel('ollama:llama3@latest')).toBe(true);
    for (const value of ['', '-x', '--yolo', 'two words', 'a'.repeat(121)]) expect(validModel(value), value).toBe(false);
    expect(validResumeId('2026-11-24_chat.1')).toBe(true); expect(validResumeId('--all')).toBe(false);
  });
  it('gives each agent a colour and initials', () => {
    expect(agentColor({ id: 'aider', color: '#123456' })).toBe('#123456');
    expect(AGENT_PALETTE).toContain(agentColor({ id: 'aider' })); expect(agentColor({ id: 'aider' })).toBe(agentColor({ id: 'aider' }));
    expect(agentInitials('Aider')).toBe('AI'); expect(agentInitials('Open Code')).toBe('OC'); expect(agentInitials('goose-cli')).toBe('GC');
  });
});

describe('custom agent channels', () => {
  it('a custom channel names its agent, a model and a level, and is an agent but not a built-in one; a chat only when it says so (phase 2)', () => {
    const config = { engine: 'custom', agentId: 'aider', model: 'sonnet', permissions: 'edits', resumeId: 'chat-1' } as const;
    expect(channelConfigSchema.safeParse(config).success).toBe(true);
    expect(startSessionSchema.safeParse({ sessionId: 'c1', cwd: '/p', config, cols: 80, rows: 24 }).success).toBe(true);
    expect(isAgentConfig(config)).toBe(true); expect(isBuiltInAgent(config)).toBe(false); expect(isChatRun(config)).toBe(false);
    expect(channelConfigSchema.safeParse({ ...config, chat: true }).success).toBe(true); expect(isChatRun({ ...config, chat: true })).toBe(true);
    for (const bad of [{ ...config, agentId: 'claude!' }, { ...config, model: '--yolo' }, { ...config, resumeId: '-x' }, { ...config, chat: 'yes' }, { ...config, program: 'calc' }]) expect(channelConfigSchema.safeParse(bad).success).toBe(false);
  });
});
