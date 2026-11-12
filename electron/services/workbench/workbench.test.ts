import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Backups, resolveStorageRoot } from './backups';
import { ClaudeProfiles } from '../cli/claude-profiles';
import { NativeSessions } from './native-sessions';
import { Tasks, scopesOverlap, matchesScope, taskPrompt } from './tasks';
import { execFileSync } from 'node:child_process';
import { Verification } from './verification';
import { repositoryState } from './repository-state';
import { movedTask } from '../../../src/state/task-move';
import { SIGNAL_INSTRUCTION } from '../../../shared/task-signal';
import { Experiments } from './experiments';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-enterprise-')); roots.push(root); return root; }
describe('backup and restore integrity', () => {
  it('snapshots SQLite with WAL data, excludes credentials, and activates a separate restored copy', async () => {
    const root = fixture(); const profile = path.join(root, 'profile'); const active = path.join(root, 'data'); fs.mkdirSync(active);
    const db = new DatabaseSync(path.join(active, 'storage.db')); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT); INSERT INTO records VALUES(\'preserved\');');
    fs.mkdirSync(path.join(active, 'claude-profiles'), { recursive: true }); fs.writeFileSync(path.join(active, 'claude-profiles/profiles.json'), '[]'); fs.mkdirSync(path.join(active, 'claude-profiles/private')); fs.writeFileSync(path.join(active, 'claude-profiles/private/.credentials.json'), 'NEVER EXPORT');
    const service = new Backups(active, active, profile, '1.6.0', { ready: async () => {}, exportFile: async () => null, importFile: async () => null, confirmRestore: async () => true });
    try { const created = await service.execute({ action: 'backup-create', includeLogs: false }) as any; expect(created.record.files).toBe(2);
      const restored = await service.execute({ action: 'backup-restore', id: created.record.id }) as any; expect(restored.restoredPath).not.toBe(active); expect(resolveStorageRoot(active, profile)).toBe(restored.restoredPath);
      const read = new DatabaseSync(path.join(restored.restoredPath, 'storage.db')); try { expect(read.prepare('SELECT value FROM records').get()?.value).toBe('preserved'); } finally { read.close(); }
      expect(fs.existsSync(path.join(restored.restoredPath, 'claude-profiles/private/.credentials.json'))).toBe(false); expect(fs.readFileSync(path.join(active, 'claude-profiles/private/.credentials.json'), 'utf8')).toBe('NEVER EXPORT');
    } finally { db.close(); }
  });
  it('rebases app-managed paths in restored SQLite while preserving external repositories', async () => {
    const root = fixture(); const active = path.join(root, 'data'); fs.mkdirSync(active); const report = path.join(active, 'coaching/reports/report');
    const db = new DatabaseSync(path.join(active, 'storage.db')); db.exec('CREATE TABLE workspace(id INTEGER PRIMARY KEY,snapshot TEXT); CREATE TABLE runs(runId TEXT,cwd TEXT);');
    const profileResume = { binding: { mode: 'independent', cwd: root }, config: { engine: 'claude', accountProfileId: 'work', resumeId: '11111111-2222-4333-8444-555555555555' } };
    const defaultResume = { binding: { mode: 'independent', cwd: root }, config: { engine: 'claude', resumeId: '11111111-2222-4333-8444-666666666666' } };
    db.prepare('INSERT INTO workspace VALUES(1,?)').run(JSON.stringify({ rootDirectory: root, sessions: [{ binding: { mode: 'independent', cwd: report } }, profileResume, defaultResume] }));
    db.prepare('INSERT INTO runs VALUES(?,?)').run('recorded', report);
    const service = new Backups(active, active, path.join(root, 'profile'), '1.6.0', { ready: async () => {}, exportFile: async () => null, importFile: async () => null, confirmRestore: async () => true });
    try {
      const created = await service.execute({ action: 'backup-create', includeLogs: false }) as any; const restored = await service.execute({ action: 'backup-restore', id: created.record.id }) as any;
      const read = new DatabaseSync(path.join(restored.restoredPath, 'storage.db'));
      try { const workspace = JSON.parse(String(read.prepare('SELECT snapshot FROM workspace').get()?.snapshot)); expect(workspace.rootDirectory).toBe(root); expect(workspace.sessions[0].binding.cwd).toBe(path.join(restored.restoredPath, 'coaching/reports/report')); expect(read.prepare('SELECT cwd FROM runs').get()?.cwd).toBe(workspace.sessions[0].binding.cwd);
        // A named profile's conversations are not in backups, so its channel starts afresh; the default account's still resumes.
        expect(workspace.sessions[1].config).toEqual({ engine: 'claude', accountProfileId: 'work' }); expect(workspace.sessions[2].config.resumeId).toBe(defaultResume.config.resumeId); } finally { read.close(); }
      expect(db.prepare('SELECT cwd FROM runs').get()?.cwd).toBe(report);
    } finally { db.close(); }
  });
  it('keeps managed worktree paths pointing at the live checkouts after a restore', async () => {
    const root = fixture(); const active = path.join(root, 'data'); fs.mkdirSync(active); const tree = path.join(active, 'worktrees', randomUUID());
    fs.writeFileSync(path.join(active, 'worktrees.json'), JSON.stringify([{ id: path.basename(tree), repository: path.join(root, 'repo'), directory: tree, branch: 'coding-hub/x', createdAt: new Date().toISOString() }]));
    const service = new Backups(active, active, path.join(root, 'profile'), '1.6.0', { ready: async () => {}, exportFile: async () => null, importFile: async () => null, confirmRestore: async () => true });
    const created = await service.execute({ action: 'backup-create', includeLogs: false }) as any; const restored = await service.execute({ action: 'backup-restore', id: created.record.id }) as any;
    expect(JSON.parse(fs.readFileSync(path.join(restored.restoredPath, 'worktrees.json'), 'utf8'))[0].directory).toBe(tree);
  });
  it('rejects tampered content and path traversal before activating a restore', async () => {
    const root = fixture(); const file = path.join(root, 'bad.gz'); const profile = path.join(root, 'profile'); const bytes = Buffer.from('bad');
    const manifest = { version: 1, record: { id: randomUUID(), createdAt: new Date().toISOString(), appVersion: '1.6.0', files: 1, bytes: bytes.length, includesLogs: false }, entries: [{ path: '../outside', hash: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') }] };
    fs.writeFileSync(file, gzipSync(JSON.stringify(manifest)));
    const service = new Backups(root, root, profile, '1.6.0', { ready: async () => {}, exportFile: async () => null, importFile: async () => file, confirmRestore: async () => true });
    await expect(service.execute({ action: 'backup-import' })).rejects.toMatchObject({ code: 'BACKUP_PATH' }); expect(resolveStorageRoot(root, profile)).toBe(root); expect(fs.existsSync(path.join(profile, 'storage-location.json'))).toBe(false);
    manifest.entries[0].path = 'preferences.json'; manifest.entries[0].hash = '0'.repeat(64); fs.writeFileSync(file, gzipSync(JSON.stringify(manifest)));
    await expect(service.execute({ action: 'backup-import' })).rejects.toMatchObject({ code: 'BACKUP_HASH' });
  });
});
describe('native history and task scope', () => {
  it('discovers profile conversations without loading full prompts and validates resume identity and directories', async () => {
    const root = fixture(); const profiles = new ClaudeProfiles(root); const account = profiles.create('Work'); const folder = path.join(profiles.directory(account.id), 'projects/project'); fs.mkdirSync(folder, { recursive: true }); const id = randomUUID(); fs.writeFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({ type: 'user', cwd: root, sessionId: id, message: { content: 'Private prompt not listed' } }) + '\n');
    const sessions = new NativeSessions(profiles); const found = (await sessions.list()).find((item) => item.id === id)!; expect(found.profileId).toBe(account.id); expect(JSON.stringify(found)).not.toContain('Private prompt'); expect((await sessions.execute({ action: 'native-resume', key: found.key }) as any).directory).toBe(root); await expect(sessions.execute({ action: 'native-resume', key: 'unknown' })).rejects.toThrow('no longer available');
  });
  it('lists the newest conversations from every CLI, and finds an older one by its id', async () => {
    const root = fixture(); const claude = path.join(root, 'claude'); const codex = path.join(root, 'codex'); vi.stubEnv('CODEX_HOME', codex);
    try {
      const folder = path.join(claude, 'projects', 'project'); fs.mkdirSync(folder, { recursive: true }); const write = (file: string, at: number) => { fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: root }) + '\n'); fs.utimesSync(file, at, at); };
      const ids = Array.from({ length: 520 }, () => randomUUID()); ids.forEach((id, index) => write(path.join(folder, id + '.jsonl'), 1_000_000 + index));
      const newest = ids[0]; write(path.join(folder, newest + '.jsonl'), 3_000_000); const oldest = ids[1];
      const rollouts = path.join(codex, 'sessions', '2026', '10', '26'); fs.mkdirSync(rollouts, { recursive: true }); const thread = randomUUID();
      fs.writeFileSync(path.join(rollouts, `rollout-${thread}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: root } }) + '\n'); fs.utimesSync(path.join(rollouts, `rollout-${thread}.jsonl`), 2_000_000, 2_000_000);
      const sessions = new NativeSessions(new ClaudeProfiles(root), [], claude); const listed = await sessions.list();
      expect(listed).toHaveLength(500); expect(listed[0].id).toBe(newest); expect(listed[1]).toMatchObject({ id: thread, engine: 'codex' });
      expect(listed.some((item) => item.id === oldest)).toBe(false); expect(sessions.source('claude', oldest)).toBe(path.join(folder, oldest + '.jsonl'));
    } finally { vi.unstubAllEnvs(); }
  });
  it('detects nested overlaps and lets a task be marked done without notes', async () => {
    expect(scopesOverlap(['src/**'], ['src/ui/**'])).toBe(true); expect(scopesOverlap(['src/**'], ['docs/**'])).toBe(false); expect(matchesScope('src/a.ts', ['src/**'])).toBe(true); expect(matchesScope('secret.txt', ['src/**'])).toBe(false);
    const root = fixture(); const verification = new Verification(root, async () => true); const tasks = new Tasks(root, verification);
    await tasks.execute({ action: 'task-save', title: 'Done', directory: root, sessionId: null, scope: ['src/**'], status: 'done', notes: '', verificationId: null });
    await tasks.execute({ action: 'task-remove', id: tasks.list()[0].id }); expect(tasks.list()).toEqual([]);
    const record = await tasks.execute({ action: 'task-save', title: 'Task', directory: root, sessionId: null, scope: ['src/**'], status: 'queued', notes: '', verificationId: null }) as any; expect(tasks.list()[0].id).toBe(record.id);
    // Folder scopes saved before stricter validation (`src/`) stay readable; empty and dot segments are still rejected.
    await tasks.execute({ action: 'task-save', title: 'Folder', directory: root, sessionId: null, scope: ['src/'], status: 'queued', notes: '', verificationId: null }); expect(tasks.list()).toHaveLength(2);
    for (const bad of ['src//a.ts', 'src/./a.ts']) await expect(tasks.execute({ action: 'task-save', title: 'Bad', directory: root, sessionId: null, scope: [bad], status: 'queued', notes: '', verificationId: null })).rejects.toThrow();
  });
  it('sends a task as one message, and follows what its agent changes from then on', async () => {
    expect(taskPrompt({ title: 'Add a dark mode switch', details: 'In Settings.\nKeep the current look as default.', scope: ['src/settings/**'] })).toBe('Task: Add a dark mode switch. In Settings. Keep the current look as default. Change only these files or folders: src/settings/**. If the task needs others, ask me first. ' + SIGNAL_INSTRUCTION);
    expect(taskPrompt({ title: 'Fix the footer.', scope: ['**'] })).toBe('Task: Fix the footer. ' + SIGNAL_INSTRUCTION);
    const root = fixture(); const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root });
    git('init'); fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a'); fs.writeFileSync(path.join(root, 'README.md'), 'r'); git('add', '.'); git('commit', '-m', 'base');
    fs.writeFileSync(path.join(root, 'README.md'), 'already changed before the task');
    const tasks = new Tasks(fixture(), new Verification(fixture(), async () => true)); const session = randomUUID();
    const saved = await tasks.execute({ action: 'task-save', title: 'Settings', directory: root, sessionId: session, scope: ['src/**'], status: 'queued', notes: '', verificationId: null }) as any;
    const sent = await tasks.execute({ action: 'task-send', id: saved.id }) as any; expect(sent.task.status).toBe('active'); expect(sent.prompt).toContain('src/**');
    expect(sent.task.sendId).toMatch(/^t-[0-9a-f]{8}$/); expect(sent.prompt.startsWith(`Task ${sent.task.sendId}: Settings.`)).toBe(true);
    const again = await tasks.execute({ action: 'task-send', id: saved.id }) as any; expect(again.task.sendId).not.toBe(sent.task.sendId); expect(again.prompt).toContain(again.task.sendId);
    // A task saved while a send waits for git status is kept: the send writes back the list as it is then.
    const sending = tasks.execute({ action: 'task-send', id: saved.id });
    const meanwhile = await tasks.execute({ action: 'task-save', title: 'Saved meanwhile', directory: root, sessionId: null, scope: ['**'], status: 'queued', notes: '', verificationId: null }) as any;
    await sending; expect(tasks.list().map((item) => item.id).sort()).toEqual([saved.id, meanwhile.id].sort());
    await tasks.execute({ action: 'task-remove', id: meanwhile.id });
    expect(await tasks.execute({ action: 'task-watch' })).toEqual({ changed: { [saved.id]: [] }, warnings: [] });
    // The agent changes its file, and one outside its task.
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'changed'); fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const watched = await tasks.execute({ action: 'task-watch' }) as any;
    expect(watched.changed[saved.id].sort()).toEqual(['package.json', 'src/a.ts']); expect(watched.warnings).toEqual([{ taskIds: [saved.id], text: "Changed package.json outside this task's files." }]);
    // A second limited task over the same files: both are told.
    const other = await tasks.execute({ action: 'task-save', title: 'Styles', directory: root, sessionId: randomUUID(), scope: ['src/a.ts'], status: 'queued', notes: '', verificationId: null }) as any;
    await tasks.execute({ action: 'task-send', id: other.id }); fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'changed again');
    const both = await tasks.execute({ action: 'task-watch' }) as any;
    expect(both.warnings.some((warning: { taskIds: string[]; text: string }) => warning.taskIds.length === 2 && /same files|src\/a\.ts/.test(warning.text))).toBe(true);
    expect((await tasks.execute({ action: 'task-status', id: saved.id, status: 'review' }) as any).status).toBe('review');
    // A channel that stopped leaves its task in Working, marked; sending it again or moving it by hand clears the mark.
    const stopped = await tasks.execute({ action: 'task-status', id: other.id, status: 'active', outcome: 'stopped' }) as any; expect(stopped).toMatchObject({ status: 'active', outcome: 'stopped' });
    expect((await tasks.execute({ action: 'task-save', id: other.id, title: 'Styles, renamed', directory: root, sessionId: other.sessionId, scope: ['src/a.ts'], status: 'active', notes: '', verificationId: null }) as any).outcome).toBe('stopped');
    expect((await tasks.execute({ action: 'task-send', id: other.id }) as any).task.outcome).toBeUndefined();
    await tasks.execute({ action: 'task-status', id: other.id, status: 'review', outcome: 'quiet' }); expect((await tasks.execute({ action: 'task-status', id: other.id, status: 'done' }) as any).outcome).toBeUndefined();
    // A pull request belongs to the task it was opened for, and only a GitHub pull request address is taken; the details give branch and commit.
    await tasks.execute({ action: 'task-pr', id: saved.id, url: 'https://github.com/owner/repo/pull/7' }); await expect(tasks.execute({ action: 'task-pr', id: other.id, url: 'https://example.com/not-a-pr' })).rejects.toBeTruthy();
    const listed = tasks.list(); expect(listed.find((t) => t.id === saved.id)!.pullRequest).toBe('https://github.com/owner/repo/pull/7'); expect(listed.find((t) => t.id === other.id)!.pullRequest).toBeUndefined();
    const detail = await tasks.execute({ action: 'task-detail', id: saved.id }) as any; expect(detail.head).toMatch(/^[0-9a-f]{7,}$/); expect(typeof detail.branch).toBe('string');
    expect((await tasks.execute({ action: 'task-save', id: saved.id, title: 'Settings', directory: root, sessionId: saved.sessionId, scope: ['src/**'], status: 'review', notes: 'kept', verificationId: null }) as any).pullRequest).toBe('https://github.com/owner/repo/pull/7');
  });
});
describe('a task moved into a worktree', () => {
  it('lets go of a check from its old folder, which the host would refuse, and says so in its notes', async () => {
    const old = fixture(); const tree = fixture(); const verification = new Verification(fixture(), async () => true); const tasks = new Tasks(fixture(), verification);
    const profile = await verification.execute({ action: 'verification-save', name: 'Check', directory: old, steps: [{ label: 'Pass', tool: 'python', args: ['-c', 'print(1)'] }], timeoutSeconds: 10 }) as any;
    const check = await verification.execute({ action: 'verification-run', id: profile.id }) as any; expect(check.passed).toBe(true);
    const saved = await tasks.execute({ action: 'task-save', title: 'Fix it', directory: old, sessionId: null, scope: ['**'], status: 'queued', notes: 'Earlier note', verificationId: check.id }) as any;
    // What saveTask sends: the host keeps these fields itself.
    const fields = ({ sentAt: _s, baseline: _b, designRef: _d, createdAt: _c, outcome: _o, outcomeNote: _n, pullRequest: _p, sendId: _i, ...rest }: any) => rest;
    const channel = randomUUID();
    await expect(tasks.execute({ action: 'task-save', ...fields({ ...saved, sessionId: channel, directory: tree }) })).rejects.toMatchObject({ code: 'TASK_CHECK' });
    const moved = await tasks.execute({ action: 'task-save', ...fields(movedTask(saved, channel, tree)) }) as any;
    expect(moved).toMatchObject({ id: saved.id, sessionId: channel, verificationId: null, status: 'queued' }); expect(path.resolve(moved.directory)).toBe(path.resolve(tree));
    expect(moved.notes).toContain('Earlier note'); expect(moved.notes).toContain(`the check attached before (${check.id})`);
  });
});
describe('verification and experiment evidence', () => {
  it('executes approved argument arrays and saves passing results, while cancelled review runs nothing', async () => {
    const root = fixture(); let approved = false; const verification = new Verification(root, async () => approved);
    const profile = await verification.execute({ action: 'verification-save', name: 'Check', directory: root, steps: [{ label: 'Python assertion', tool: 'python', args: ['-c', 'print("verified")'] }], timeoutSeconds: 5 }) as any;
    expect(await verification.execute({ action: 'verification-run', id: profile.id })).toBeNull(); expect(verification.data().results).toHaveLength(0); approved = true;
    const result = await verification.execute({ action: 'verification-run', id: profile.id }) as any; expect(result.passed).toBe(true); expect(result.steps[0].output).toContain('verified'); expect(verification.data().results).toHaveLength(1);
  });
  it('does not leave verification stuck when a saved project directory disappears', async () => {
    const root = fixture(); const project = path.join(root, 'project'); fs.mkdirSync(project); const service = new Verification(root, async () => true);
    const profile = await service.execute({ action: 'verification-save', name: 'Missing folder', directory: project, steps: [{ label: 'Check', tool: 'python', args: ['-c', 'print(1)'] }], timeoutSeconds: 5 }) as any;
    fs.rmdirSync(project); await expect(service.execute({ action: 'verification-run', id: profile.id })).rejects.toBeTruthy(); expect(service.running).toBe(false);
  });
  it('records the files a check ran on, and says when they changed since or while it ran', async () => {
    const project = fixture(); const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project });
    git('init'); fs.writeFileSync(path.join(project, 'a.txt'), 'a'); git('add', '.'); git('commit', '-m', 'base');
    const service = new Verification(fixture(), async () => true);
    const quiet = await service.execute({ action: 'verification-save', name: 'Reads only', directory: project, steps: [{ label: 'Check', tool: 'python', args: ['-c', 'print(1)'] }], timeoutSeconds: 10 }) as any;
    const first = await service.execute({ action: 'verification-run', id: quiet.id }) as any; expect(first.tested).toMatchObject({ changedDuring: false });
    expect(await service.execute({ action: 'verification-fresh' })).toEqual({ [first.id]: 'current' });
    fs.writeFileSync(path.join(project, 'a.txt'), 'edited after the check');
    expect(await service.execute({ action: 'verification-fresh' })).toEqual({ [first.id]: 'changed' });
    const writes = await service.execute({ action: 'verification-save', name: 'Writes', directory: project, steps: [{ label: 'Edit', tool: 'python', args: ['-c', 'open("a.txt","w").write("edited by the check")'] }], timeoutSeconds: 10 }) as any;
    const during = await service.execute({ action: 'verification-run', id: writes.id }) as any; expect(during.tested.changedDuring).toBe(true);
    expect((await service.execute({ action: 'verification-fresh' }) as any)[during.id]).toBe('changed');
    // An edit of the same size with its time put back is still seen: the content is read, not just size and time.
    const again = await service.execute({ action: 'verification-run', id: quiet.id }) as any; expect((await service.execute({ action: 'verification-fresh' }) as any)[again.id]).toBe('current');
    const file = path.join(project, 'a.txt'); const { atime, mtime } = fs.statSync(file); const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('e', 'E')); fs.utimesSync(file, atime, mtime); expect(fs.statSync(file).size).toBe(Buffer.byteLength(text));
    expect((await service.execute({ action: 'verification-fresh' }) as any)[again.id]).toBe('changed');
  });
  it('cannot tell, rather than says current, when there are more changed files than it reads', async () => {
    const project = fixture(); execFileSync('git', ['init'], { cwd: project });
    for (let i = 0; i <= 5000; i++) fs.writeFileSync(path.join(project, `f${i}.txt`), String(i));
    expect(await repositoryState(project)).toBeNull();
    fs.rmSync(path.join(project, 'f5000.txt')); expect(await repositoryState(project)).toMatch(/^[0-9a-f]{64}$/);
  }, 60000);
  it('requires real run references and prevents counting one run twice in an experiment', () => {
    const root = fixture(); const id = randomUUID(); const service = new Experiments(root, (run) => run === id);
    const experiment = service.execute({ action: 'experiment-save', name: 'Scope', hypothesis: 'Explicit scope reduces rework', criterion: 'Tests pass with no fixes', promptA: 'Fix it', promptB: 'Fix this function and verify tests' }) as any;
    const trial = { action: 'trial-add', experimentId: experiment.id, variant: 'A', runId: id, minutes: 5, rework: 1, outcome: 'partial', evidence: 'One failing test corrected' }; service.execute(trial); expect(() => service.execute(trial)).toThrow('already'); expect(() => service.execute({ ...trial, runId: randomUUID() })).toThrow('recorded');
  });
});

it('loads and edits a saved task that still links to a removed design annotation, and no longer accepts new links', async () => {
 const root=fixture(), tasks=new Tasks(root,new Verification(root,async()=>true));
 const designRef={snapshotId:randomUUID(),annotationId:randomUUID()};
 const fields={title:'Design fix',directory:root,sessionId:null,scope:['src/**'],status:'queued',notes:'',verificationId:null};
 const id=randomUUID(); fs.writeFileSync(path.join(root,'tasks.json'),JSON.stringify([{...fields,id,designRef,createdAt:new Date().toISOString()}]));
 expect((await tasks.execute({action:'task-list'}) as any[]).map((task)=>task.id)).toEqual([id]);
 const updated=await tasks.execute({action:'task-save',...fields,id,title:'Updated design fix'}) as any;
 expect(updated.title).toBe('Updated design fix'); expect(updated.designRef).toEqual(designRef);
 await expect(tasks.execute({action:'task-save',...fields,designRef})).rejects.toThrow();
});

it('persists all steps of noisy verification without exceeding the JSON record limit', async () => {
 const root=fixture(), checks=new Verification(root,async()=>true);
 const profile=await checks.execute({action:'verification-save',name:'Noisy checks',directory:root,steps:Array.from({length:8},(_,i)=>({label:`Step ${i}`,tool:'python',args:['-c','import sys;sys.stdout.write(chr(1)*512000)']})),timeoutSeconds:5}) as any;
 const result=await checks.execute({action:'verification-run',id:profile.id}) as any;
 expect(result.passed).toBe(true); expect(result.steps).toHaveLength(8); expect(result.steps.some((step:any)=>step.truncated)).toBe(true);
 expect(checks.data().results[0].id).toBe(result.id); expect(fs.statSync(path.join(root,'verification.json')).size).toBeLessThanOrEqual(4*1024*1024);
});
