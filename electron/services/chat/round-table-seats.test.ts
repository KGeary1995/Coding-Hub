import { describe, expect, it } from 'vitest';
import type { ChatEnvelope, ChatEvent } from '../../../shared/chat';
import { chatRequestSchema } from '../../../shared/schemas';
import { RoundTables, type TableHost } from './round-table';

const A = '11111111-1111-4111-8111-111111111111'; const B = '22222222-2222-4222-8222-222222222222'; const C = '33333333-3333-4333-8333-333333333333'; const D = '44444444-4444-4444-8444-444444444444';

/** Four running chats in one folder (Claude, Codex, Claude, Codex); records what the coordinator sends and sets. */
function setup() {
  const runs: Record<string, { sessionId: string; engine: 'claude' | 'codex' | 'gemini'; cwd: string; owner: number; busy?: boolean; permissions?: 'ask' | 'edits' | 'full' }> = {
    [A]: { sessionId: 'a', engine: 'claude', cwd: '/p', owner: 1 }, [B]: { sessionId: 'b', engine: 'codex', cwd: '/p', owner: 1 },
    [C]: { sessionId: 'c', engine: 'claude', cwd: '/p', owner: 1 }, [D]: { sessionId: 'd', engine: 'codex', cwd: '/p', owner: 1 },
  };
  const sent: { runId: string; text: string }[] = []; const modes: Record<string, boolean> = {}; const answers: { runId: string; requestId: string; allow: boolean }[] = []; const interrupted: string[] = []; const events: ChatEnvelope[] = [];
  const host: TableHost = { run: (id) => runs[id] ?? null, send: (runId, text) => { sent.push({ runId, text }); }, setReadOnly: (id, readOnly) => { modes[id] = readOnly; }, answer: (runId, requestId, allow) => { answers.push({ runId, requestId, allow }); }, interrupt: (id) => { interrupted.push(id); }, emit: (_o, envelope) => { events.push(envelope); } };
  const tables = new RoundTables(host);
  const reply = (runId: string, text: string) => {
    tables.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'assistant', messageId: `m-${Math.random()}`, blocks: [{ type: 'text', text }] } });
    tables.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'done', isError: false, error: null } });
  };
  const ask = (runId: string, requestId: string, toolName: string) => tables.observe({ sessionId: runs[runId].sessionId, runId, event: { type: 'permission', requestId, toolName, description: '', input: {}, canAllowEdits: true } });
  const last = () => (events.filter((envelope) => envelope.event.type === 'table').at(-1)!.event as Extract<ChatEvent, { type: 'table' }>).table!;
  const to = (runId: string) => sent.filter((item) => item.runId === runId);
  return { tables, runs, sent, modes, answers, interrupted, events, reply, ask, last, to };
}
const three = [{ sessionId: 'b', runId: B }, { sessionId: 'c', runId: C, name: 'Opus' }];

describe('a discussion table with three seats', () => {
  it('asks every seat, gives each the others’ answers by name, and ends early when all agree', () => {
    const { tables, sent, reply, last, to } = setup();
    expect(tables.open(1, A, three, 'a', 3)).toMatchObject({ seats: [{ sessionId: 'a', engine: 'claude' }, { sessionId: 'b', engine: 'codex' }, { sessionId: 'c', name: 'Opus' }], driverSeat: 'a', partner: { sessionId: 'b' }, driver: 'claude' });
    tables.send(A, 'Plan the cache.', []);
    expect(sent.map((item) => item.runId)).toEqual([A, B, C]);
    expect(to(A)[0].text).toContain('with the person, Codex and Opus. The others call you Claude Code.'); expect(to(A)[0].text).toContain('You are the driver');
    expect(to(B)[0].text).toContain('You are a reviewer: read files, give your own view of what the person asked and check the plan and work of the driver, Claude Code,'); expect(to(B)[0].text).toContain("When Trace shows you the others' answers, reply to them briefly");
    reply(A, 'Use an LRU.'); reply(B, 'Add a TTL.'); expect(sent).toHaveLength(3);
    reply(C, 'Both.');
    // Round 1: each gets the two other answers, labelled.
    expect(to(A)[1].text).toContain('[Trace Round Table · round 1 of 3] Codex answered:\n\nAdd a TTL.\n\nOpus answered:\n\nBoth.');
    expect(to(C)[1].text).toContain('Claude Code answered:\n\nUse an LRU.\n\nCodex answered:\n\nAdd a TTL.');
    reply(A, 'AGREE'); reply(B, 'AGREE'); reply(C, '**AGREE**');
    // All agree: no further round, and the driver alone does the work.
    expect(sent).toHaveLength(7); expect(to(A)[2].text).toContain('the discussion is over: you all agree] Now carry out'); expect(last()).toMatchObject({ phase: 'acting', agreed: true, round: 1 });
    reply(A, 'Built the cache.'); expect(sent).toHaveLength(7); expect(last()).toMatchObject({ phase: 'idle', agreed: true, round: 1 });
  });
  it('is not agreed while one seat still disagrees', () => {
    const { tables, sent, reply, last } = setup(); tables.open(1, A, three, 'a', 1);
    tables.send(A, 'Go', []); reply(A, 'x'); reply(B, 'y'); reply(C, 'z');
    reply(A, 'AGREE'); reply(B, 'AGREE'); reply(C, 'No: the TTL is too short.');
    // The rounds are used up: the driver does the work, and is shown the objection it has not seen yet.
    expect(sent).toHaveLength(7); expect(sent[6].runId).toBe(A); expect(sent[6].text).toContain('Opus answered:\n\nNo: the TTL is too short.'); expect(sent[6].text).toContain('Codex answered:\n\nAGREE (nothing to add)');
    expect(last()).toMatchObject({ phase: 'acting', agreed: false });
  });
  it('lets the driver be any seat by its session, keeps the others read-only, and declines their edits by name', () => {
    const { tables, modes, answers, ask } = setup();
    tables.open(1, A, three, 'c', 1);
    expect(modes).toEqual({ [A]: true, [B]: true, [C]: false });
    expect(ask(B, 'r1', 'File changes')).toBe('Trace declined File changes for Codex: the reviewer does not edit files. Swap the driver to let it.');
    expect(ask(A, 'r2', 'Edit')).toContain('for Claude Code:'); expect(ask(C, 'r3', 'Edit')).toBeNull();
    expect(answers).toEqual([{ runId: B, requestId: 'r1', allow: false }, { runId: A, requestId: 'r2', allow: false }]);
    // By seat, and by engine as before 1.26 (the first seat of that agent).
    tables.setDriver(A, 'b'); expect(modes).toEqual({ [A]: true, [B]: false, [C]: true });
    tables.setDriver(A, 'claude'); expect(modes).toEqual({ [A]: false, [B]: true, [C]: true });
    expect(() => tables.setDriver(A, 'nobody')).toThrow(/must sit at this Round Table/);
  });
  it('seats a Gemini agent as a reviewer: it hears the others and its edits are declined; swapped in, it is the seat that edits (from 1.39)', () => {
    const { tables, runs, modes, answers, ask, reply, to, last } = setup(); runs[B].engine = 'gemini';
    tables.open(1, A, [{ sessionId: 'a', runId: A }, { sessionId: 'b', runId: B }], 'a', 1);
    expect(modes).toEqual({ [A]: false, [B]: true }); expect(last().seats!.map((seat) => seat.engine)).toEqual(['claude', 'gemini']);
    // What Gemini CLI asks to write (its protocol names any file change so) is declined, as for any reviewer.
    expect(ask(B, 'r1', 'File changes')).toBe('Trace declined File changes for Gemini: the reviewer does not edit files. Swap the driver to let it.');
    expect(answers).toEqual([{ runId: B, requestId: 'r1', allow: false }]);
    // Swapped in, by its seat or by its agent: it edits, and the lead reviews.
    tables.setDriver(A, 'b'); expect(modes).toEqual({ [A]: true, [B]: false }); expect(last()).toMatchObject({ driverSeat: 'b', driver: 'gemini' }); expect(ask(B, 'r2', 'File changes')).toBeNull();
    tables.setDriver(A, 'a'); expect(modes).toEqual({ [A]: false, [B]: true }); tables.setDriver(A, 'gemini'); expect(last()).toMatchObject({ driverSeat: 'b', driver: 'gemini' }); tables.setDriver(A, 'a');
    // A message goes to both, and each then reads what the other said.
    tables.send(A, 'What is this project?', []); expect(to(B).at(-1)!.text).toContain('What is this project?');
    reply(A, 'A scratch project.'); reply(B, 'About lighthouses.');
    expect(to(A).at(-1)!.text).toContain('About lighthouses.'); expect(to(B).at(-1)!.text).toContain('A scratch project.');
  });
  it('records every reviewer’s findings and the driver’s answers', async () => {
    const { tables, reply, last } = setup(); tables.open(1, A, three, 'a', 1);
    tables.send(A, 'Review it.', []); reply(A, 'Done.'); reply(B, 'FINDING high a.ts:1 — leak'); reply(C, 'FINDING low b.ts:2 — typo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(last().findings).toMatchObject([{ id: 'F1', text: 'leak' }, { id: 'F2', text: 'typo' }]);
  });
  it('adds the person’s instructions to that seat’s brief only', () => {
    const { tables, to } = setup();
    tables.open(1, A, [{ sessionId: 'b', runId: B, instructions: 'Focus on security.' }], 'a', 1); tables.send(A, 'Go', []);
    expect(to(B)[0].text).toContain("[The person's own instructions for you at this table]\nFocus on security."); expect(to(A)[0].text).not.toContain('Focus on security.');
    // Two seats read as before 1.26: no name of its own, the old wording.
    expect(to(A)[0].text).toContain('You are in one conversation with the person and Codex. Trace passes each of you what the other says.'); expect(to(A)[0].text).not.toContain('call you');
  });
  it('has the lead sum up for every newcomer when the conversation is under way', () => {
    const { tables, sent, reply, runs } = setup();
    tables.observe({ sessionId: runs[A].sessionId, runId: A, event: { type: 'user', text: 'Build it', images: 0 } }); reply(A, 'Started.');
    tables.open(1, A, three, 'a', 2);
    expect(sent).toEqual([{ runId: A, text: expect.stringContaining('Codex and Opus are joining now. Write a short summary of this conversation for them') }]);
    reply(A, 'Summary.');
    expect(sent.slice(1).map((item) => item.runId)).toEqual([B, C]); expect(sent[2].text).toContain("Claude Code's summary:\n\nSummary.");
  });
  it('closes when any seat’s run ends, and finds the table by any seat', () => {
    const { tables, modes, last } = setup(); tables.open(1, A, three, 'a', 1);
    expect(tables.isSeated(C)).toBe(true); expect(() => tables.open(1, D, [{ runId: C }], 'claude', 1)).toThrow(/already at a Round Table/);
    tables.ended(C); expect(last()).toBeNull(); expect(modes).toEqual({ [A]: false, [B]: false, [C]: false }); expect(tables.isSeated(A)).toBe(false);
  });
  it('refuses a chat seated twice, and a table of one', () => {
    const { tables } = setup();
    expect(() => tables.open(1, A, [{ runId: B }, { runId: B }], 'a', 1)).toThrow(/seated twice/);
    expect(() => tables.open(1, A, [{ runId: A }], 'a', 1)).toThrow(/at least two agents/);
  });
});

describe('changing a discussion table’s seats', () => {
  it('adds and removes seats while idle: the newcomer gets the latest messages, the one who left may edit again and is not stopped', () => {
    const { tables, sent, modes, interrupted, reply, last, to } = setup();
    tables.open(1, A, [{ sessionId: 'b', runId: B }], 'a', 0); tables.send(A, 'First question.', []); reply(A, 'First answer.'); reply(B, 'Agreed.');
    const state = tables.setSeats(A, [{ sessionId: 'a', runId: A }, { sessionId: 'c', runId: C, name: 'Opus', instructions: 'Be brief.' }]);
    expect(state.seats!.map((seat) => seat.sessionId)).toEqual(['a', 'c']); expect(last().seats![1]).toMatchObject({ name: 'Opus', instructions: 'Be brief.' });
    expect(modes[B]).toBe(false); expect(modes[C]).toBe(true); expect(interrupted).toEqual([]);
    const before = sent.length; tables.send(A, 'Second question.', []);
    expect(sent.slice(before).map((item) => item.runId)).toEqual([A, C]);
    // Everyone is briefed again; the newcomer with the latest messages, word for word, before the new one.
    expect(to(A).at(-1)!.text).toContain('[Trace Round Table]'); expect(to(A).at(-1)!.text).not.toContain('The latest messages');
    const joined = to(C)[0].text; expect(joined).toContain('You are joining a conversation already under way. The latest messages:\n\nThe person: First question.\n\nClaude Code: First answer.');
    expect(joined).toContain('Be brief.'); expect(joined.endsWith('Second question.')).toBe(true); expect(joined.indexOf('Second question.')).toBe(joined.length - 'Second question.'.length);
  });
  it('is refused while an agent works, without the lead, or with a chat at another table; a driver who leaves hands over to the lead', () => {
    const { tables, reply } = setup();
    tables.open(1, A, [{ sessionId: 'b', runId: B }], 'b', 0); tables.send(A, 'Go', []);
    expect(() => tables.setSeats(A, [{ sessionId: 'a', runId: A }, { sessionId: 'c', runId: C }])).toThrow(/once the agents have finished/);
    reply(A, 'a'); reply(B, 'b');
    expect(() => tables.setSeats(A, [{ sessionId: 'b', runId: B }, { sessionId: 'c', runId: C }])).toThrow(/keeps its seat/);
    tables.open(1, C, [{ runId: D }], 'claude', 0);
    expect(() => tables.setSeats(A, [{ sessionId: 'a', runId: A }, { sessionId: 'd', runId: D }])).toThrow(/already at a Round Table/);
    expect(tables.setSeats(A, [{ sessionId: 'a', runId: A }, { sessionId: 'b', runId: B, name: 'Reviewer' }])).toMatchObject({ driverSeat: 'b', seats: [{ sessionId: 'a' }, { sessionId: 'b', name: 'Reviewer' }] });
    tables.close(C);
    expect(tables.setSeats(A, [{ sessionId: 'a', runId: A }, { sessionId: 'c', runId: C }])).toMatchObject({ driverSeat: 'a', driver: 'claude' });
    expect(tables.setSeats(A, [{ sessionId: 'a', runId: A }, { sessionId: 'c', runId: C }, { sessionId: 'd', runId: D }], 'd')).toMatchObject({ driverSeat: 'd', driver: 'codex', partner: { sessionId: 'c' } });
  });
});

describe('the requests for seats', () => {
  const ref = { sessionId: 'a', runId: A };
  it('accepts table-open with seats, table-seats and table-driver with a seat, and refuses what does not fit', () => {
    expect(chatRequestSchema.safeParse({ action: 'table-open', ...ref, partner: { sessionId: 'b', runId: B }, driver: 'claude', rounds: 2, seats: [ref, { sessionId: 'b', runId: B, name: 'Reviewer', instructions: 'Check the tests.' }, { sessionId: 'c', runId: C }], driverSeat: 'a' }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ action: 'table-open', ...ref, partner: { sessionId: 'b', runId: B }, driver: 'claude', rounds: 2, kind: 'hierarchy', seats: [{ ...ref, duties: ['build'] }, { sessionId: 'b', runId: B, duties: ['plan', 'review', 'final'] }] }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ action: 'table-seats', ...ref, seats: [ref, { sessionId: 'c', runId: C, duties: ['challenge'] }], driverSeat: 'c' }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ action: 'table-driver', ...ref, driver: 'codex', seat: 'b' }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ action: 'table-seats', ...ref, seats: [ref] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ action: 'table-seats', ...ref, seats: [ref, { sessionId: 'c', runId: C, duties: ['cook'] }] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ action: 'table-seats', ...ref, seats: [ref, { sessionId: 'c', runId: C, name: 'x'.repeat(41) }] }).success).toBe(false);
  });
});
