import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent } from '../../../shared/chat';
import { RoundTables, type TableHost } from './round-table';

const CLAUDE = '11111111-1111-4111-8111-111111111111'; const CODEX = '22222222-2222-4222-8222-222222222222';

/** Two running chats in one folder; records what the coordinator sends and sets. */
function setup(options: { cwd?: string; engines?: ['claude' | 'codex', 'claude' | 'codex'] } = {}) {
  const [a, b] = options.engines ?? ['claude', 'codex'];
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex'; cwd: string; owner: number }> = {
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
  return { tables, sent, modes, answers, interrupted, say, done, last };
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

  it('stops busy agents when the person writes again, then sends the new message to both', () => {
    const { tables, sent, interrupted, say, done } = setup();
    tables.open(1, CLAUDE, CODEX, 'claude', 2);
    tables.send(CLAUDE, 'First', []); say(CLAUDE, 'Working'); done(CLAUDE);
    tables.send(CLAUDE, 'Actually, second', []);
    expect(interrupted).toEqual([CODEX]); expect(sent).toHaveLength(2);
    done(CODEX);
    expect(sent.slice(2).map((item) => [item.runId, item.text])).toEqual([[CLAUDE, 'Actually, second'], [CODEX, 'Actually, second']]);
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
    expect(() => tables.send(CLAUDE, 'x', [])).toThrow('no Round Table');
  });
});
