import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conversationsFrom, CustomAgents, describeDefinition, findProgram, jsonFrom, shimTarget, type AgentDialogs } from './agents';
import { setBackupRoot } from '../hub/file-backups';
import type { AgentDefinition } from '../../../shared/agent-definition';
import type { AgentConversation, AgentDraft, AgentList, AgentTestResult } from '../../../shared/agents';

const roots: string[] = [];
const fixture = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agents-')); roots.push(dir); return dir; };
afterEach(() => { setBackupRoot(null); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
/** A Node program that prints `text` for --version and --help. */
function program(dir: string, name: string, help = '--model <name>  Use this model\n--yes  Never ask') {
  const file = path.join(dir, name); fs.writeFileSync(file, `if (process.argv.includes('--help')) console.log(${JSON.stringify(help)}); else console.log('fake-agent 1.2.3 ' + process.argv.slice(2).join(' '));\n`); return file;
}
const definition = (command: string): AgentDefinition => ({ schema: 1, id: 'fake', name: 'Fake agent', program: { command, args: ['--plain'] }, permissions: { ask: [], edits: ['--edits'], full: ['--yes'] }, models: { choices: ['small'], arg: ['--model', '{model}'] }, status: { quietSeconds: 4 }, env: { FAKE_MODE: 'test' } });
/** A store in a temp home whose dialogs answer `answer` and record what they were asked. */
function store(answer = { save: true, run: true }, options: ConstructorParameters<typeof CustomAgents>[2] = {}) {
  const root = fixture(); setBackupRoot(root); const asked: string[] = [];
  const dialogs: AgentDialogs = { confirmSave: async (agent) => { asked.push(agent.detail); return answer.save; }, confirmRun: async (run) => { asked.push(run.detail); return answer.run; } };
  return { root, asked, agents: new CustomAgents(root, dialogs, { environment: async () => ({ ...process.env as Record<string, string> }), ...options }) };
}

describe('custom agent store', () => {
  it('saves a definition only after the person confirms the exact program and arguments', async () => {
    const { root, asked, agents } = store({ save: false, run: true }); const file = program(root, 'fake.js');
    await expect(agents.execute({ action: 'agent-save', definition: definition(file) })).rejects.toMatchObject({ code: 'AGENT_DECLINED' });
    expect(fs.existsSync(path.join(root, 'agents', 'fake.json'))).toBe(false);
    expect(asked[0]).toContain(`Program: ${file}`); expect(asked[0]).toContain('Full access: --yes'); expect(asked[0]).toContain('Environment: FAKE_MODE=test');
  });
  it('lists a saved agent as on, and one changed by hand as off until it is confirmed again', async () => {
    const { root, agents } = store(); const file = program(root, 'fake.js');
    const listed = await agents.execute({ action: 'agent-save', definition: definition(file) }) as AgentList;
    expect(listed.agents).toMatchObject([{ id: 'fake', active: true, program: file, problem: null, look: { name: 'Fake agent', initials: 'FA' } }]);
    await expect(agents.launchable('fake', process.env as Record<string, string>)).resolves.toMatchObject({ definition: { id: 'fake' } });
    const saved = path.join(root, 'agents', 'fake.json'); const edited = { ...definition(file), program: { command: file, args: ['--other'] } }; fs.writeFileSync(saved, JSON.stringify(edited));
    expect((await agents.list()).agents[0].active).toBe(false);
    await expect(agents.launchable('fake', process.env as Record<string, string>)).rejects.toMatchObject({ code: 'AGENT_NOT_CONFIRMED' });
    expect((await agents.execute({ action: 'agent-activate', id: 'fake' }) as AgentList).agents[0].active).toBe(true);
  });
  it('keeps a backup of an edited and a removed definition, and refuses a second agent with the same id', async () => {
    const { root, agents } = store(); const file = program(root, 'fake.js');
    await agents.save(definition(file));
    await expect(agents.save(definition(file))).rejects.toMatchObject({ code: 'AGENT_EXISTS' });
    await agents.save({ ...definition(file), name: 'Renamed' }, 'fake');
    await agents.save({ ...definition(file), id: 'moved' }, 'fake');
    expect((await agents.list()).agents.map((agent) => agent.id)).toEqual(['moved']);
    await agents.execute({ action: 'agent-remove', id: 'moved' });
    expect((await agents.list()).agents).toEqual([]);
    const backups = fs.readdirSync(path.join(root, 'config-backups')); expect(backups.length).toBeGreaterThanOrEqual(2);
    await expect(agents.launchable('moved', process.env as Record<string, string>)).rejects.toMatchObject({ code: 'AGENT_MISSING' });
  });
  it('reports a definition file that is not valid, or whose id does not match its name, without failing the list', async () => {
    const { root, agents } = store(); fs.mkdirSync(path.join(root, 'agents'));
    fs.writeFileSync(path.join(root, 'agents', 'broken.json'), JSON.stringify({ schema: 1, id: 'broken', name: 'B', program: { command: 'cmd' } }));
    fs.writeFileSync(path.join(root, 'agents', 'named.json'), JSON.stringify({ schema: 1, id: 'other', name: 'N', program: { command: 'node' } }));
    const { agents: listed } = await agents.list();
    expect(listed.map((agent) => [agent.id, agent.active, Boolean(agent.problem)])).toEqual([['broken', false, true], ['named', false, true]]);
    expect(listed[1].problem).toMatch(/Rename one/);
  });
  it('Test start runs the version arguments once, after asking for a definition not yet saved', async () => {
    const { root, asked, agents } = store(); const file = program(root, 'fake.js');
    const result = await agents.execute({ action: 'agent-test', definition: { ...definition(file), version: { args: ['--version', 'two words'] } } }) as AgentTestResult;
    expect(result.exitCode).toBe(0); expect(result.output).toContain('fake-agent 1.2.3 --version two words'); expect(result.command).toContain('"two words"');
    expect(asked).toHaveLength(1);
  });
  it('drafts a definition from the program’s help through Claude Code in print mode, and checks it', async () => {
    const root = fixture(); const prompts = path.join(root, 'prompt.txt');
    const claude = path.join(root, 'claude.js'); fs.writeFileSync(claude, `if (process.argv.includes('--help')) { console.log('--tools <tools...>\\n--no-session-persistence'); process.exit(0); }
let input = ''; process.stdin.on('data', (chunk) => input += chunk); process.stdin.on('end', () => { require('fs').writeFileSync(${JSON.stringify(prompts)}, process.argv.slice(2).join(' ') + '\\n' + input);
console.log('Here it is:\\n\`\`\`json\\n' + JSON.stringify({ schema: 1, id: 'fake', name: 'Fake', program: { command: 'something-else', args: [] }, models: { arg: ['--model', '{model}'] }, status: { quietSeconds: 4 } }) + '\\n\`\`\`'); });`);
    const { agents } = store({ save: true, run: true }, { claude: async (env) => findProgram(claude, env) }); const file = program(root, 'fake.js', 'USAGE: fake --model <name>');
    const draft = await agents.execute({ action: 'agent-draft', command: file }) as AgentDraft;
    expect(draft.problems).toEqual([]); expect((draft.definition.program as { command: string }).command).toBe(file);
    const sent = fs.readFileSync(prompts, 'utf8'); expect(sent).toContain('-p --output-format text --tools  --no-session-persistence'); expect(sent).toContain('USAGE: fake --model <name>'); expect(sent).toContain('Placeholders'); expect(sent).toContain('acp: only when the help shows an Agent Client Protocol');
  });
  it('says so when Claude Code is missing, before running anything', async () => {
    const { root, asked, agents } = store({ save: true, run: true }, { claude: async () => { throw new Error('none'); } }); const file = program(root, 'fake.js');
    await expect(agents.draft(file)).rejects.toMatchObject({ code: 'CLAUDE_MISSING' }); expect(asked).toEqual([]);
  });
});

describe('finding a program without a shell', () => {
  it('finds a program on PATH, refuses a batch file, and follows an npm shim to its Node entry', async () => {
    const dir = fixture(); const windows = process.platform === 'win32';
    const native = path.join(dir, windows ? 'tool.exe' : 'tool'); fs.writeFileSync(native, ''); if (!windows) fs.chmodSync(native, 0o755);
    await expect(findProgram('tool', { PATH: dir })).resolves.toMatchObject({ file: native, prefixArgs: [] });
    await expect(findProgram('missing', { PATH: dir })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    if (!windows) return;
    fs.writeFileSync(path.join(dir, 'batch.bat'), '@echo off'); await expect(findProgram('batch', { PATH: dir })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    const entry = path.join(dir, 'node_modules', 'pkg', 'bin', 'cli.js'); fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '');
    fs.writeFileSync(path.join(dir, 'pkg.cmd'), '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\cli.js" %*\r\n');
    expect(shimTarget(path.join(dir, 'pkg.cmd'))).toBe(entry);
    const found = await findProgram('pkg', { PATH: dir }); expect(found.prefixArgs.at(-1)).toBe(entry); expect(found.displayPath).toBe(path.join(dir, 'pkg.cmd'));
    // A shim pointing outside its own folder is not followed.
    fs.writeFileSync(path.join(dir, 'out.cmd'), '"%dp0%\\..\\elsewhere\\cli.js" %*'); expect(shimTarget(path.join(dir, 'out.cmd'))).toBeNull();
  });
});

describe('drafts and confirmations', () => {
  it('reads the JSON in an answer, fenced or not', () => {
    expect(jsonFrom('Sure:\n```json\n{"a":1}\n```\nDone')).toEqual({ a: 1 }); expect(jsonFrom('text {"b":[1]} more')).toEqual({ b: [1] }); expect(jsonFrom('no json')).toBeNull(); expect(jsonFrom('[1,2]')).toBeNull();
  });
  it('names every argument the agent can be given, quoted where it has spaces', () => {
    const text = describeDefinition({ ...definition('aider'), instructions: { env: 'AIDER_SYSTEM' }, mcp: { format: 'claude-json', args: ['--mcp-config', '{file}'] }, program: { command: 'aider', args: ['--message prefix'] } }, 'C:\\bin\\aider.exe');
    expect(text.split('\n')).toEqual(['Program: C:\\bin\\aider.exe', 'Always with: "--message prefix"', 'Ask: (no arguments)', 'Allow edits: --edits', 'Full access: --yes', 'Model: --model {model}', 'Shared memory and channel tools: --mcp-config {file}', 'Instructions: in AIDER_SYSTEM', 'Environment: FAKE_MODE=test']);
    // An ACP chat's arguments and modes are named too (phase 2).
    expect(describeDefinition({ ...definition('aider'), acp: { args: ['acp', '--stdio'], modes: { ask: 'plan', full: 'auto' } } }, 'aider')).toContain('Chat (ACP): acp --stdio; modes Ask plan, Allow edits (its own), Full access auto');
  });
});

describe('conversations to continue (resume.listArgs)', () => {
  it('reads one ID per line, or a line starting with one, and leaves out headers, flags and repeats', () => {
    const printed = '\x1b[1mID       UPDATED   TITLE\x1b[0m\nses_01abc  2 hours ago  Fix the login form\n\n  7f3e9c2a: Add dark mode\n--help\nses_01abc again\n- a bullet\nbad id with $ sign\n';
    expect(conversationsFrom(printed)).toEqual([{ id: 'ses_01abc', label: '2 hours ago Fix the login form' }, { id: '7f3e9c2a', label: 'Add dark mode' }, { id: 'bad', label: 'id with $ sign' }]);
    expect(conversationsFrom('')).toEqual([]);
    expect(conversationsFrom(Array.from({ length: 80 }, (_, i) => `c${i}`).join('\n'))).toHaveLength(50);
  });
  it('runs the list only for a confirmed agent, in the channel’s folder, and says so when it fails', async () => {
    const { root, agents } = store(); const file = path.join(root, 'lister.js');
    fs.writeFileSync(file, `if (process.argv.includes('--fail')) process.exit(3); console.log('one  ' + process.cwd()); console.log('two');\n`);
    const withList = { ...definition(file), resume: { args: ['--resume', '{id}'], listArgs: ['sessions'] } };
    await agents.execute({ action: 'agent-save', definition: withList });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agents-cwd-')); roots.push(folder);
    const listed = await agents.execute({ action: 'agent-conversations', id: 'fake', directory: folder }) as AgentConversation[];
    expect(listed.map((item) => item.id)).toEqual(['one', 'two']); expect(fs.realpathSync(listed[0].label)).toBe(fs.realpathSync(folder));
    fs.writeFileSync(path.join(root, 'agents', 'fake.json'), JSON.stringify({ ...withList, resume: { ...withList.resume, listArgs: ['--fail'] } }));
    await expect(agents.execute({ action: 'agent-conversations', id: 'fake' })).rejects.toMatchObject({ code: 'AGENT_NOT_CONFIRMED' });
    await agents.execute({ action: 'agent-activate', id: 'fake' });
    await expect(agents.execute({ action: 'agent-conversations', id: 'fake' })).rejects.toMatchObject({ code: 'AGENT_LIST', message: expect.stringContaining('exited with code 3') });
  });
  it('keeps the models the program listed for phones, which never run it', async () => {
    const { root, agents } = store(); const file = path.join(root, 'models.js');
    fs.writeFileSync(file, `console.log('big-1  the large one'); console.log('-not-a-model');\n`);
    await agents.execute({ action: 'agent-save', definition: { ...definition(file), models: { choices: ['small'], listArgs: ['models'], arg: ['--model', '{model}'] } } });
    expect(agents.choices('fake')).toEqual(['small']);
    expect(await agents.execute({ action: 'agent-models', id: 'fake' })).toEqual(['small', 'big-1']);
    expect(agents.choices('fake')).toEqual(['small', 'big-1']); expect(agents.settings('fake')).toEqual({ models: true, permissions: true });
  });
});
