import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent } from '../../../shared/chat';
import { KEEP_IMAGES, RoundTables, type TableHost } from './round-table';

const CLAUDE = '11111111-1111-4111-8111-111111111111'; const CODEX = '22222222-2222-4222-8222-222222222222';

/** Two running chats in one folder; records what the coordinator sends and sets. */
function setup(options: { cwd?: string; engines?: ['claude' | 'codex', 'claude' | 'codex'] } = {}) {
  const [a, b] = options.engines ?? ['claude', 'codex'];
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex'; cwd: string; owner: number; permissions?: 'ask' | 'edits' | 'full' }> = {
    [CLAUDE]: { sessionId: 'lead', engine: a, cwd: '/project', owner: 1 },
    [CODEX]: { sessionId: 'partner', engine: b, cwd: options.cwd ?? '/project', owner: 1 },
  };
  const sent: { runId: string; text: string }[] = []; const modes: Record<string, boolean> = {}; const answers: { runId: string; requestId: string; allow: boolean }[] = [];
  const interrupted: string[] = []; const events: ChatEnvelope[] = [];
  const host: TableHost = {
    run: (runId) => runs[runId] ?? null,
    send: (runId, text) => { sent.push({ runId, text }); },
    setReadOnly: (runId, readOnly) => { modes[runId] = readOnly; },
    answer: (runId, requestId, allow) => { answers.push({ runId, requestId, allow }); },
    interrupt: (runId) => { interrupted.push(runId); },
    emit: (_owner, envelope) => { events.push(envelope); },
  };
  const tables = new RoundTables(host);
  const say = (runId: string, text: string) => { const event: ChatEvent = { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] }; tables.observe({ sessionId: runs[runId].sessionId, runId, event }); };
  const done = (runId: string) => tables.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'done', isError: false, error: null } });
  const last = () => events.filter((envelope) => envelope.event.type === 'table').at(-1)!.event as Extract<ChatEvent, { type: 'table' }>;
  return { tables, sent, modes, answers, interrupted, say, done, last, runs };
}

describe('Round Table', () => {
  it('sends the person’s message to both, then each the other’s answer, for the set number of rounds', () => {
    const { tables, sent, say, done, last } = setup();
    tables.open(1, CLAUDE, CODEX, 'claude', 1);
    tables.send(CLAUDE, 'How should phones start channels?', []);
    expect(sent.map((item) => item.runId)).toEqual([CLAUDE, CODEX]);
    expect(sent[0].text).toContain('You are the driver'); expect(sent[1].text).toContain('You are the reviewer'); expect(sent[1].text).toContain('How should phones start channels?');
    say(CLAUDE, 'A per-phone switch.'); done(CLAUDE);
    expect(sent).toHaveLength(2); expect(last().table).toMatchObject({ phase: 'answering', round: 0 });
    say(CODEX, 'Agree, plus Face ID.'); done(CODEX);
    // Round 1: each gets the other's answer, without the introduction again.
    expect(sent.slice(2)).toEqual([
      { runId: CLAUDE, text: expect.stringContaining('Codex answered:\n\nAgree, plus Face ID.') },
      { runId: CODEX, text: expect.stringContaining('Claude Code answered:\n\nA per-phone switch.') },
    ]);
    expect(sent[2].text).not.toContain('You are the driver'); expect(last().table).toMatchObject({ phase: 'discussing', round: 1 });
    say(CLAUDE, 'Fine.'); done(CLAUDE); say(CODEX, 'Fine too.'); done(CODEX);
    // Rounds used up: no third exchange.
    expect(sent).toHaveLength(4); expect(last().table).toMatchObject({ phase: 'idle', agreed: false });
  });

  it('ends the discussion early when both agents agree', () => {
    const { tables, sent, say, done, last } = setup();
    tables.open(1, CLAUDE, CODEX, 'claude', 3);
    tables.send(CLAUDE, 'Plan?', []); say(CLAUDE, 'Plan A'); done(CLAUDE); say(CODEX, 'Plan A too'); done(CODEX);
    say(CLAUDE, 'AGREE'); done(CLAUDE); say(CODEX, '**AGREE**.'); done(CODEX);
    expect(sent).toHaveLength(4); expect(last().table).toMatchObject({ phase: 'idle', agreed: true, round: 1 });
  });

  it('allows the reviewer’s commands at Full access only, still declines its edits, and leaves the driver’s to the person', () => {
    const { tables, answers, runs } = setup(); tables.open(1, CLAUDE, CODEX, 'codex', 0);
    const ask = (runId: string, requestId: string, toolName: string) => tables.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'permission', requestId, toolName, description: '', input: {}, canAllowEdits: false } });
    for (const level of ['ask', 'edits'] as const) { runs[CLAUDE].permissions = level; expect(ask(CLAUDE, `c-${level}`, 'Bash')).toBeNull(); }
    expect(answers).toEqual([]);
    runs[CLAUDE].permissions = 'full'; runs[CODEX].permissions = 'full';
    expect(ask(CLAUDE, 'c1', 'Bash')).toBe(''); expect(ask(CLAUDE, 'c2', 'Edit')).toContain('reviewer does not edit'); expect(ask(CODEX, 'x1', 'Shell')).toBeNull();
    expect(answers).toEqual([{ runId: CLAUDE, requestId: 'c1', allow: true }, { runId: CLAUDE, requestId: 'c2', allow: false }]);
  });
  it('keeps the reviewer read-only, declines its edits, and swaps roles without restarting', () => {
    const { tables, modes, answers, sent, say, done } = setup();
    tables.open(1, CLAUDE, CODEX, 'codex', 0);
    expect(modes).toEqual({ [CLAUDE]: true, [CODEX]: false });
    const declined = tables.observe({ sessionId: 'lead', runId: CLAUDE, event: { type: 'permission', requestId: 'r1', toolName: 'Edit', description: '', input: {}, canAllowEdits: true } });
    expect(declined).toContain('reviewer does not edit'); expect(answers).toEqual([{ runId: CLAUDE, requestId: 'r1', allow: false }]);
    // The driver's own approvals are left to the person.
    expect(tables.observe({ sessionId: 'partner', runId: CODEX, event: { type: 'permission', requestId: 'r2', toolName: 'File changes', description: '', input: {}, canAllowEdits: true } })).toBeNull();
    tables.setDriver(CLAUDE, 'claude');
    expect(modes).toEqual({ [CLAUDE]: false, [CODEX]: true });
    tables.send(CLAUDE, 'Go', []);
    expect(sent.at(-2)!.text).toContain('You are the driver'); expect(sent.at(-1)!.text).toContain('You are the reviewer');
    say(CLAUDE, 'Done'); done(CLAUDE); say(CODEX, 'Looks right'); done(CODEX);
    // No rounds: they answer the person only.
    expect(sent).toHaveLength(2);
  });

  it('lets busy agents finish when the person writes again, then sends the new messages to both together', () => {
    const { tables, sent, interrupted, say, done } = setup();
    tables.open(1, CLAUDE, CODEX, 'claude', 2);
    tables.send(CLAUDE, 'First', []); say(CLAUDE, 'Working'); done(CLAUDE);
    tables.send(CLAUDE, 'Actually, second', []); tables.send(CLAUDE, 'And third', []);
    expect(interrupted).toEqual([]); expect(sent).toHaveLength(2);
    say(CODEX, 'Still working'); done(CODEX);
    // The waiting messages go next, in place of a discussion round.
    expect(sent.slice(2).map((item) => [item.runId, item.text])).toEqual([[CLAUDE, 'Actually, second\n\nAnd third'], [CODEX, 'Actually, second\n\nAnd third']]);
  });

  it('refuses a waiting message that would take the images past ten, instead of dropping them', () => {
    const { tables } = setup(); const image = { mediaType: 'image/png' as const, data: 'AAAA' };
    tables.open(1, CLAUDE, CODEX, 'claude', 2);
    tables.send(CLAUDE, 'First', []); tables.send(CLAUDE, 'Six', Array(6).fill(image));
    expect(() => tables.send(CLAUDE, 'Five more', Array(5).fill(image))).toThrow(/at most 10/);
    expect(() => tables.send(CLAUDE, 'Four more', Array(4).fill(image))).not.toThrow();
  });

  it('still stops both agents on Stop', () => {
    const { tables, interrupted } = setup();
    tables.open(1, CLAUDE, CODEX, 'claude', 2);
    tables.send(CLAUDE, 'First', []); tables.stop(CLAUDE);
    expect(interrupted).toEqual([CLAUDE, CODEX]);
  });

  it('has the leading agent sum up a conversation already under way for the newcomer', () => {
    const { tables, sent, say, done, last } = setup();
    tables.observe({ sessionId: 'lead', runId: CLAUDE, event: { type: 'user', text: 'Build the phone chat view', images: 0 } });
    say(CLAUDE, 'Started on ChatView for the phone.');
    tables.open(1, CLAUDE, CODEX, 'claude', 2);
    expect(last().table.phase).toBe('joining');
    expect(sent).toEqual([{ runId: CLAUDE, text: expect.stringContaining('Codex is joining now') }]);
    say(CLAUDE, 'Goal: phone chat. State: ChatView started.'); done(CLAUDE);
    expect(sent[1].runId).toBe(CODEX);
    expect(sent[1].text).toContain('Goal: phone chat. State: ChatView started.');
    expect(sent[1].text).toContain('The person: Build the phone chat view');
    expect(sent[1].text).toContain('Claude Code: Started on ChatView for the phone.');
    // Its acknowledgement does not start a discussion.
    say(CODEX, 'Caught up.'); done(CODEX);
    expect(sent).toHaveLength(2); expect(last().table.phase).toBe('idle');
  });

  it('refuses two of the same agent, different folders, and a chat already at a table, and closes when a chat ends', () => {
    expect(() => setup({ engines: ['claude', 'claude'] }).tables.open(1, CLAUDE, CODEX, 'claude', 1)).toThrow('Claude Code and Codex');
    expect(() => setup({ cwd: '/other' }).tables.open(1, CLAUDE, CODEX, 'claude', 1)).toThrow('same folder');
    const { tables, modes, last } = setup();
    tables.open(1, CLAUDE, CODEX, 'claude', 1);
    expect(() => tables.open(1, CODEX, CLAUDE, 'claude', 1)).toThrow('already');
    tables.ended(CODEX);
    expect(last().table).toBeNull(); expect(modes).toEqual({ [CLAUDE]: false, [CODEX]: false });
    // A run that ended is not the person closing it: the window keeps the table to seat both again.
    expect(last().closed).toBeUndefined();
    expect(() => tables.send(CLAUDE, 'x', [])).toThrow('no Round Table');
  });
  it('marks a table the person closed, so every window forgets it and stops its partner', () => {
    const { tables, last } = setup();
    tables.open(1, CLAUDE, CODEX, 'claude', 1); tables.close(CLAUDE);
    expect(last()).toEqual({ type: 'table', table: null, closed: true });
  });
});

describe('Round Table review record', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  it('records the reviewer findings, passes them to the driver only after the files are noted, and follows them to verified', async () => {
    const { tables, sent, say, done, last } = setup(); let state = 'a'.repeat(64);
    (tables as unknown as { host: TableHost }).host.stateOf = async () => state;
    tables.open(1, CLAUDE, CODEX, 'claude', 3);
    tables.send(CLAUDE, 'Review the change.', []); expect(sent[1].text).toContain('FINDING high|medium|low');
    say(CLAUDE, 'I changed the parser.'); done(CLAUDE);
    say(CODEX, 'Two problems.\nFINDING high src/parse.ts:40 — drops the last line\nFINDING low docs/a.md — typo'); done(CODEX);
    // Nobody starts the next turn until the record and the files' state are in.
    expect(sent).toHaveLength(2); await settle();
    expect(last().table!.findings).toMatchObject([{ id: 'F1', severity: 'high', evidence: 'src/parse.ts:40', status: 'open', reviewedAt: 'a'.repeat(12) }, { id: 'F2', severity: 'low', status: 'open' }]);
    expect(last().table!.findings![0].filesChanged).toBeUndefined();
    const driverTurn = sent.find((item) => item.runId === CLAUDE && item.text.includes('Open findings'))!; expect(driverTurn.text).toContain('F1 (high, src/parse.ts:40): drops the last line');
    state = 'b'.repeat(64);
    say(CLAUDE, 'FIXED F1: kept the last line\nDECLINED F2: the typo is in a quote'); done(CLAUDE); say(CODEX, 'Waiting for the fix.'); done(CODEX); await settle();
    expect(last().table!.findings!.map((item) => item.status)).toEqual(['fixed', 'declined']); expect(last().table!.findings![0]).toMatchObject({ reviewedAt: 'a'.repeat(12), changedAt: 'b'.repeat(12) });
    expect(sent.at(-1)!.text).toContain('waiting for your check'); expect(sent.at(-1)!.runId).toBe(CODEX);
    say(CLAUDE, 'Done.'); done(CLAUDE); say(CODEX, 'VERIFIED F1\nREOPENED F2: it is not a quote'); done(CODEX); await settle();
    expect(last().table!.findings!.map((item) => item.status)).toEqual(['verified', 'open']);
  });
  it('marks a finding uncertain when files changed while it was reviewed, and reads answers before a waiting message goes', async () => {
    const { tables, sent, say, done, last } = setup(); let state = 'a'.repeat(64);
    (tables as unknown as { host: TableHost }).host.stateOf = async () => state;
    tables.open(1, CLAUDE, CODEX, 'claude', 3); tables.send(CLAUDE, 'Fix and review.', []);
    state = 'c'.repeat(64); // The driver edits while the reviewer reads.
    tables.send(CLAUDE, 'Also check the docs.', []);
    say(CLAUDE, 'Edited.'); done(CLAUDE); say(CODEX, 'FINDING medium src/x.ts:1 — off by one'); done(CODEX); await settle();
    expect(last().table!.findings![0]).toMatchObject({ id: 'F1', filesChanged: true, reviewedAt: 'c'.repeat(12) });
    expect(sent.slice(-2).map((item) => item.text)).toEqual([expect.stringContaining('Also check the docs.'), expect.stringContaining('Also check the docs.')]);
  });
});

describe('Round Table after a restart', () => {
  const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
  it('publishes a message queued while the agents work, so a restart before they finish keeps its text and images', () => {
    const before = setup(); before.tables.open(1, CLAUDE, CODEX, 'claude', 2); before.tables.send(CLAUDE, 'Start.', []);
    before.tables.send(CLAUDE, 'Then check the docs.', [image]);
    const saved = before.last().table!; expect(saved).toMatchObject({ waiting: 'Then check the docs.', waitingImages: [image] });
    // Trace quits before either agent finishes; the window saved that state, and the table opens again from it.
    const after = setup(); after.tables.open(1, CLAUDE, CODEX, 'claude', 2, { findings: saved.findings, waiting: saved.waiting, waitingImages: saved.waitingImages });
    expect(after.last().table).toMatchObject({ waiting: 'Then check the docs.', waitingKept: true }); expect(after.sent).toHaveLength(0);
    expect(() => after.tables.send(CLAUDE, 'Something new', [])).toThrow(/Send it or drop it first/);
    after.tables.waiting(CLAUDE, true);
    expect(after.sent.map((item) => item.runId)).toEqual([CLAUDE, CODEX]); expect(after.sent[0].text).toContain('Then check the docs.');
    expect(after.last().table!.waiting).toBeUndefined();
  });
  it('keeps findings, and an image-only message, and says when images are too large to keep', () => {
    const { tables, sent, last } = setup();
    const finding = { id: 'F1', severity: 'high' as const, evidence: 'a.ts:1', text: 'bug', status: 'fixed' as const, response: 'done', check: '', reviewedAt: 'aaaaaaaaaaaa', changedAt: null, round: 1, at: '2026-11-10T00:00:00.000Z' };
    tables.open(1, CLAUDE, CODEX, 'claude', 2, { findings: [finding], waitingImages: [image] });
    expect(last().table).toMatchObject({ findings: [finding], waiting: '', waitingImages: [image], waitingKept: true });
    tables.stop(CLAUDE); expect(last().table!.waitingKept).toBe(true); tables.waiting(CLAUDE, false); expect(sent).toHaveLength(0); expect(last().table!.waiting).toBeUndefined();
    const big = setup(); big.tables.open(1, CLAUDE, CODEX, 'claude', 2); big.tables.send(CLAUDE, 'Go.', []);
    big.tables.send(CLAUDE, 'Look at these.', [{ mediaType: 'image/png', data: 'A'.repeat(KEEP_IMAGES + 4) }]);
    expect(big.last().table).toMatchObject({ waiting: 'Look at these.', waitingImagesDropped: 1 }); expect(big.last().table!.waitingImages).toBeUndefined();
  });
});
