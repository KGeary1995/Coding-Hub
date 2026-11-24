import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, checkSeats, defaultSeatName, hiddenSeatIds, isBuiltInPreset, savedSeats, seatNames, type SeatSettings } from './table-seats';
import { chatRequestSchema, savedWorkspaceSchema, tablePresetSchema } from './schemas';

const RUN = '11111111-1111-4111-8111-111111111111';

describe('Round Table seats', () => {
  it('accepts the built-in presets, as seats and as saved presets', () => {
    for (const preset of BUILT_IN_PRESETS) {
      const lead = preset.kind === 'hierarchy' ? preset.seats.findIndex((seat) => seat.duties?.includes('build')) : 0;
      expect(checkSeats(preset.kind, preset.seats, lead)).toBeNull();
      expect(tablePresetSchema.safeParse(preset).success).toBe(true);
      expect(isBuiltInPreset(preset.id)).toBe(true);
    }
    expect(isBuiltInPreset('mine')).toBe(false);
  });

  it('seats Gemini in any seat (from 1.39): it may lead, be the seat that edits, and build', () => {
    const claude = { engine: 'claude' as const }; const gemini = { engine: 'gemini' as const };
    // A discussion: Gemini reviews beside the lead, leads, or edits.
    expect(checkSeats('discussion', [claude, gemini], 0, 0)).toBeNull(); expect(checkSeats('discussion', [claude, gemini, gemini], 0, 0)).toBeNull();
    expect(checkSeats('discussion', [gemini, claude], 0, 0)).toBeNull(); expect(checkSeats('discussion', [gemini, claude], 0, 1)).toBeNull(); expect(checkSeats('discussion', [claude, gemini], 0, 1)).toBeNull();
    // The seat that edits must be one of the seats.
    expect(checkSeats('discussion', [gemini, claude], 0, 2)).toBe('Choose the agent that edits files.');
    // A hierarchy: it may plan, challenge, review, give the final review, and build (leading the table).
    const builder = { engine: 'claude' as const, duties: ['build' as const] };
    expect(checkSeats('hierarchy', [builder, { ...gemini, duties: ['plan', 'final'] }, { ...gemini, duties: ['challenge', 'review'] }], 0)).toBeNull();
    expect(checkSeats('hierarchy', [{ ...gemini, duties: ['build'] }, { ...claude, duties: ['plan', 'final'] }], 0)).toBeNull();
    // Building is still the lead's alone, whatever its agent.
    expect(checkSeats('hierarchy', [{ ...claude, duties: ['plan'] }, { ...gemini, duties: ['build'] }], 0)).toMatch(/builder leads/);
    expect(defaultSeatName(gemini, 'discussion')).toBe('Gemini'); expect(seatNames([claude, gemini, gemini], 'discussion')).toEqual(['Claude Code', 'Gemini', 'Gemini 2']);
  });
  it('takes any number of discussion seats from two to eight', () => {
    const seats = (count: number): SeatSettings[] => Array.from({ length: count }, () => ({}));
    expect(checkSeats('discussion', seats(1))).toMatch(/at least two/);
    expect(checkSeats('discussion', seats(2))).toBeNull();
    expect(checkSeats('discussion', seats(8))).toBeNull();
    expect(checkSeats('discussion', seats(9))).toMatch(/at most 8/);
    expect(checkSeats('discussion', [{ name: 'x'.repeat(41) }, {}])).toMatch(/name/);
    expect(checkSeats('discussion', [{ instructions: 'x'.repeat(4001) }, {}])).toMatch(/instructions/);
  });

  it('needs one builder who leads and only builds, and one planner, at a hierarchy', () => {
    const build: SeatSettings = { duties: ['build'] }; const plan: SeatSettings = { duties: ['plan'] };
    // The smallest hierarchy: a planner and a builder, no challenger, reviewer or final review.
    expect(checkSeats('hierarchy', [build, plan])).toBeNull();
    expect(checkSeats('hierarchy', [build, plan, { duties: ['review'] }, { duties: ['review', 'challenge'] }, { duties: ['final'] }])).toBeNull();
    // A planner may also review and give the final review: every seat but the builder is read-only.
    expect(checkSeats('hierarchy', [build, { duties: ['plan', 'challenge', 'review', 'final'] }])).toBeNull();
    expect(checkSeats('hierarchy', [build, plan, {}])).toMatch(/something to do/);
    expect(checkSeats('hierarchy', [plan, { duties: ['review'] }])).toMatch(/exactly one builder/);
    expect(checkSeats('hierarchy', [build, build, plan])).toMatch(/exactly one builder/);
    expect(checkSeats('hierarchy', [plan, build])).toMatch(/builder leads/);
    expect(checkSeats('hierarchy', [plan, build], 1)).toBeNull();
    expect(checkSeats('hierarchy', [{ duties: ['build', 'plan'] }, { duties: ['review'] }])).toMatch(/only builds/);
    expect(checkSeats('hierarchy', [build, { duties: ['review'] }])).toMatch(/exactly one planner/);
    expect(checkSeats('hierarchy', [build, plan, plan])).toMatch(/exactly one planner/);
    expect(checkSeats('hierarchy', [build, { duties: ['plan', 'final'] }, { duties: ['final'] }])).toMatch(/final review/);
    expect(checkSeats('hierarchy', [build, { duties: ['plan', 'plan'] }])).toMatch(/twice/);
  });

  it('names seats by what they do, and numbers seats that would share a name', () => {
    expect(defaultSeatName({ engine: 'codex', duties: ['challenge', 'review'] }, 'hierarchy')).toBe('Reviewer');
    expect(defaultSeatName({ engine: 'claude', duties: ['plan', 'final'] }, 'hierarchy')).toBe('Planner');
    expect(defaultSeatName({ engine: 'codex' }, 'discussion')).toBe('Codex');
    expect(seatNames([{ engine: 'claude', duties: ['build'] }, { engine: 'claude', duties: ['plan'] }, { engine: 'codex', duties: ['review'] }, { engine: 'claude', duties: ['review'] }, { engine: 'codex', name: ' Security ', duties: ['review'] }], 'hierarchy')).toEqual(['Builder', 'Planner', 'Reviewer', 'Reviewer 2', 'Security']);
    expect(seatNames([{ engine: 'claude' }, { engine: 'claude' }, { engine: 'codex', name: 'claude code' }], 'discussion')).toEqual(['Claude Code', 'Claude Code 2', 'claude code 3']);
  });

  it('reads a table saved before 1.26 as the seats it had then', () => {
    expect(hiddenSeatIds({ partner: 'p' }, 'lead')).toEqual(['p']);
    expect(hiddenSeatIds({ partner: 'r', planner: 'p' }, 'lead')).toEqual(['r', 'p']);
    expect(savedSeats({ partner: 'p' }, 'lead')).toEqual([{ session: 'lead' }, { session: 'p' }]);
    expect(savedSeats({ kind: 'hierarchy', partner: 'r', planner: 'p' }, 'lead')).toEqual([{ session: 'lead', duties: ['build'] }, { session: 'p', duties: ['plan', 'final'] }, { session: 'r', duties: ['challenge', 'review'] }]);
  });

  it('lists every saved seat but the lead as hidden, each once, the lead first when read back', () => {
    const table = { partner: 'a', seats: [{ session: 'a', name: 'First' }, { session: 'lead' }, { session: 'b' }, { session: 'a' }] };
    expect(hiddenSeatIds(table, 'lead')).toEqual(['a', 'b']);
    expect(savedSeats(table, 'lead').map((seat) => seat.session)).toEqual(['lead', 'a', 'b', 'a']);
    // A saved list without the lead's own entry still starts with the lead.
    expect(savedSeats({ kind: 'hierarchy', partner: 'a', seats: [{ session: 'a', duties: ['plan'] }, { session: 'b', duties: ['review'] }] }, 'lead')[0]).toEqual({ session: 'lead', duties: ['build'] });
  });

  it('takes the new table requests, and refuses seats that are not settings', () => {
    const base = { sessionId: 'lead', runId: RUN };
    const seats = [{ ...base, name: 'Lead' }, { sessionId: 'two', runId: RUN, instructions: 'Check the tests.' }, { sessionId: 'three', runId: RUN }];
    expect(chatRequestSchema.safeParse({ ...base, action: 'table-open', partner: { sessionId: 'two', runId: RUN }, driver: 'claude', rounds: 2, seats, driverSeat: 'two' }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ ...base, action: 'table-seats', seats }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ ...base, action: 'table-seats', seats: seats.slice(0, 1) }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...base, action: 'table-seats', seats: [...seats.slice(0, 2), { sessionId: 'three', runId: RUN, duties: ['edit'] }] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...base, action: 'table-driver', driver: 'claude', seat: 'two' }).success).toBe(true);
    // A request from a phone or linked computer on an older Trace, without seats, is still taken.
    expect(chatRequestSchema.safeParse({ ...base, action: 'table-open', partner: { sessionId: 'two', runId: RUN }, driver: 'claude', rounds: 2 }).success).toBe(true);
  });

  it('saves a workspace whose table has more hidden seats than a partner and a planner, without a tile each', () => {
    const config = { engine: 'codex' as const, chat: true, model: '', reasoningEffort: null };
    const session = (id: string) => ({ id, title: id, binding: { mode: 'workspace' as const }, createdAt: '2026-11-21T00:00:00.000Z', config });
    const workspace = { version: 1 as const, rootDirectory: null, layoutMode: 'columns' as const, focusedSessionId: 'lead',
      tiles: [{ sessionId: 'lead', x: 0, y: 0, w: 12, h: 20, minW: 3, minH: 10 }],
      sessions: [{ ...session('lead'), roundTable: { partner: 'a', driver: 'codex' as const, rounds: 2, driverSeat: 'b', seats: [{ session: 'lead' }, { session: 'a', name: 'Tests' }, { session: 'b' }, { session: 'c', instructions: 'Security only.' }] } }, session('a'), session('b'), session('c')] };
    expect(savedWorkspaceSchema.safeParse(workspace).success).toBe(true);
    // A seat that is in no table's list needs a tile like any channel.
    expect(savedWorkspaceSchema.safeParse({ ...workspace, sessions: [...workspace.sessions, session('d')] }).success).toBe(false);
  });
});
