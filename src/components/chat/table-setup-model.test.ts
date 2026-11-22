import { describe, expect, it, vi } from 'vitest';
import { BUILT_IN_PRESETS, type TablePreset } from '../../../shared/table-seats';
import type { EditableSeat } from '../../runtime/round-table';
import { addSeat, type Draft, draftFromPreset, draftFromTable, draftProblem, patchSeat, pickPreset, placeholders, removePreset, removeSeat, roomNote, runSetup, saveAsPreset, setDriver, setDuty, type SetupDeps, toPlan, toPreset, updatePreset, withKind } from './table-setup-model';

const discussion = BUILT_IN_PRESETS.find((preset) => preset.kind === 'discussion')!; const hierarchy = BUILT_IN_PRESETS.find((preset) => preset.kind === 'hierarchy')!;
const mine: TablePreset = { id: 'mine-1', name: 'Two reviewers', kind: 'hierarchy', rounds: 3, seats: [{ engine: 'claude', model: '', duties: ['build'] }, { engine: 'claude', model: '', duties: ['plan'] }, { engine: 'codex', model: '', duties: ['review'] }, { engine: 'claude', model: '', duties: ['review'] }] };
const deps = (failure: string | null = null): SetupDeps & { calls: unknown[][] } => { const calls: unknown[][] = []; return { calls, startTable: async (...args) => { calls.push(['start', ...args]); return failure; }, openTable: async (...args) => { calls.push(['open', ...args]); return failure; }, changeSeats: async (...args) => { calls.push(['change', ...args]); return failure; } }; };

describe('picking a preset', () => {
  it('starts from the built-in table of a kind, or the person’s last-used one while it exists', () => {
    const presets = [...BUILT_IN_PRESETS, mine];
    expect(pickPreset(presets, 'hierarchy', null).id).toBe('hierarchy'); expect(pickPreset(presets, 'hierarchy', 'mine-1').id).toBe('mine-1');
    // Gone, or of the other kind: the built-in.
    expect(pickPreset(BUILT_IN_PRESETS as TablePreset[], 'hierarchy', 'mine-1').id).toBe('hierarchy'); expect(pickPreset(presets, 'discussion', 'mine-1').id).toBe('discussion');
  });
  it('edits a copy: the preset keeps its seats, and a built-in table’s name is left for the person to give', () => {
    const draft = draftFromPreset(hierarchy); draft.seats[0].name = 'Changed';
    expect(hierarchy.seats[0].name).toBeUndefined(); expect(draft.name).toBe(''); expect(draftFromPreset(mine).name).toBe('Two reviewers'); expect(draft.seats.map((seat) => seat.lead)).toEqual([true, false, false]);
  });
  it('fixes the lead seat to the chat a table is opened on: its agent and model, which cannot be changed here', () => {
    const draft = draftFromPreset(discussion, { engine: 'codex', model: 'gpt-x' });
    expect(draft.seats[0]).toMatchObject({ engine: 'codex', model: 'gpt-x', keepsAgent: true, keepsModel: true, lead: true }); expect(draft.seats[1]).toMatchObject({ keepsAgent: false, keepsModel: false });
    // A hierarchy’s lead is the builder, wherever the person’s preset puts it.
    const builderLast: TablePreset = { ...mine, seats: [mine.seats[1], mine.seats[2], mine.seats[0]] };
    expect(draftFromPreset(builderLast, { engine: 'claude', model: '' }).seats.map((seat) => seat.lead)).toEqual([false, false, true]);
  });
  it('switches kind to the other built-in table on the same lead', () => {
    const draft = withKind(draftFromPreset(discussion, { engine: 'codex', model: '' }), BUILT_IN_PRESETS as TablePreset[], 'hierarchy', { engine: 'codex', model: '' });
    expect(draft.kind).toBe('hierarchy'); expect(draft.seats[0]).toMatchObject({ engine: 'codex', duties: ['build'] }); expect(withKind(draft, [], 'hierarchy')).toBe(draft);
  });
});

describe('adding and removing seats', () => {
  it('adds the other agent at a discussion and a Codex reviewer at a hierarchy, and stops at the room there is', () => {
    const added = addSeat(draftFromPreset(discussion), 8); expect(added.seats).toHaveLength(3); expect(added.seats[2]).toMatchObject({ engine: 'claude', duties: [] });
    expect(addSeat(draftFromPreset(hierarchy), 8).seats[3]).toMatchObject({ engine: 'codex', duties: ['review'] });
    expect(addSeat(draftFromPreset(discussion), 2).seats).toHaveLength(2);
  });
  it('says how many more fit, and why none does', () => {
    const draft = draftFromPreset(discussion);
    expect(roomNote(draft, 5, 8)).toEqual({ left: 3, text: '3 more seats fit.' }); expect(roomNote(draft, 3, 8).text).toBe('1 more seat fits.');
    expect(roomNote(draft, 2, 8)).toMatchObject({ left: 0 }); expect(roomNote(draft, 2, 8).text).toContain('Close a channel'); expect(roomNote(addSeat(draft, 8), 8, 8).left).toBe(5);
    expect(roomNote({ ...draft, seats: Array(8).fill(draft.seats[0]) }, 8, 8).text).toBe('A Round Table seats at most 8 agents.');
  });
  it('never removes the lead, and keeps the same seat editing when another is removed', () => {
    let draft = addSeat(addSeat(draftFromPreset(discussion), 8), 8); expect(removeSeat(draft, 0)).toBe(draft);
    draft = setDriver(draft, 2); expect(removeSeat(draft, 1).driver).toBe(1); expect(removeSeat(draft, 2).driver).toBe(0); expect(removeSeat(setDriver(draft, 0), 1).driver).toBe(0);
  });
});

describe('what a table needs, in words', () => {
  it('says a hierarchy needs a duty on every seat, one planner, at most one final review, and a builder that only builds', () => {
    const draft = draftFromPreset(mine);
    expect(draftProblem(draft)).toBeNull();
    expect(draftProblem(setDuty(draft, 2, 'review', false))).toContain('Give every seat something to do');
    expect(draftProblem(setDuty(draft, 2, 'plan', true))).toContain('exactly one planner'); expect(draftProblem(setDuty(setDuty(draft, 2, 'plan', true), 3, 'plan', true))).toContain('exactly one planner');
    expect(draftProblem(setDuty(setDuty(draft, 2, 'final', true), 3, 'final', true))).toContain('Only one seat gives the final review');
    expect(draftProblem(setDuty(draft, 1, 'plan', false))).toContain('Give every seat something to do');
    expect(draftProblem(patchSeat(patchSeat(draft, 1, { duties: ['review'] }), 2, { duties: ['review'] }))).toContain('exactly one planner');
  });
  it('locks the lead’s duties: it builds, and only that; no other seat can take Build', () => {
    const draft = draftFromPreset(mine);
    expect(setDuty(draft, 0, 'review', true)).toBe(draft); expect(setDuty(draft, 0, 'build', false)).toBe(draft); expect(setDuty(draft, 2, 'build', true)).toBe(draft);
  });
  it('lets a hierarchy go without challengers, reviewers or a final reviewer', () => {
    expect(draftProblem(draftFromPreset({ ...mine, seats: mine.seats.slice(0, 2) }))).toBeNull();
  });
  it('wants one seat that edits at a discussion, rounds in range, and a model that is an identifier', () => {
    const draft = draftFromPreset(discussion);
    expect(draftProblem({ ...draft, driver: 5 })).toBe('Choose the agent that edits files.'); expect(draftProblem({ ...draft, rounds: 6 })).toBe('Rounds are between 0 and 5.'); expect(draftProblem({ ...draft, rounds: 0 })).toBeNull();
    expect(draftProblem({ ...draftFromPreset(hierarchy), rounds: 0 })).toBe('Rounds are between 1 and 5.');
    expect(draftProblem(patchSeat(draft, 1, { model: 'Opus 5.5' }))).toContain('is not a model identifier'); expect(draftProblem(patchSeat(draft, 1, { name: 'x'.repeat(41) }))).toContain('at most 40 characters');
  });
  it('shows each seat’s default name where its own is blank, numbering the seats that would share one', () => {
    expect(placeholders(draftFromPreset(discussion))).toEqual(['Claude Code', 'Codex']); expect(placeholders(draftFromPreset(mine))).toEqual(['Builder', 'Planner', 'Reviewer', 'Reviewer 2']);
  });
});

describe('starting, opening and applying', () => {
  it('Start sends the edited preset to startTable, and remembers nothing but the preset used', async () => {
    const calls = deps(); const draft = patchSeat(patchSeat(draftFromPreset(mine), 2, { name: ' Skeptic ', instructions: 'Check security.', model: ' gpt-5 ' }), 3, { model: 'claude-opus-5-5' });
    expect(await runSetup({ type: 'new', table: 'hierarchy' }, { ...draft, rounds: 4, name: 'Mine' }, calls)).toBeNull();
    expect(calls.calls).toHaveLength(1); const [kind, preset] = calls.calls[0] as ['start', TablePreset]; expect(kind).toBe('start');
    expect(preset).toMatchObject({ id: 'mine-1', name: 'Mine', kind: 'hierarchy', rounds: 4 }); expect(preset.seats[2]).toEqual({ engine: 'codex', model: 'gpt-5', name: 'Skeptic', instructions: 'Check security.', duties: ['review'] }); expect(preset.seats[3].model).toBe('claude-opus-5-5');
  });
  it('a table on a chat goes to openTable with that chat as the lead, a discussion with its driver', async () => {
    const calls = deps(); const draft = setDriver(addSeat(draftFromPreset(discussion, { engine: 'claude', model: '' }), 8), 2);
    expect(await runSetup({ type: 'chat', leadId: 'chat-1' }, draft, calls)).toBeNull();
    const [kind, lead, preset] = calls.calls[0] as ['open', string, TablePreset]; expect(kind).toBe('open'); expect(lead).toBe('chat-1'); expect(preset).toMatchObject({ kind: 'discussion', driver: 2 }); expect(preset.seats).toHaveLength(3);
  });
  it('does not call the host with seats that make no table, and returns why; a host’s refusal comes back as it is', async () => {
    const calls = deps(); const broken = setDuty(draftFromPreset(mine), 2, 'review', false);
    expect(await runSetup({ type: 'new' }, broken, calls)).toContain('Give every seat something to do'); expect(calls.calls).toEqual([]);
    expect(await runSetup({ type: 'edit', leadId: 'x' }, draftFromPreset(discussion), deps('The Round Table is working. Try again when it is idle.'))).toBe('The Round Table is working. Try again when it is idle.');
  });
  it('Apply sends changeSeats a plan that names the seats that stay, adds those without a session, and sets the driver and rounds', async () => {
    const seats: EditableSeat[] = [{ engine: 'claude', model: '', session: 'lead', lead: true, driver: true, status: 'running' }, { engine: 'codex', model: 'gpt-5', name: 'Skeptic', session: 'b', lead: false, driver: false, status: 'running' }];
    const calls = deps(); let draft = draftFromTable(seats, 'discussion', 2); expect(draft.driver).toBe(0); expect(draft.seats[1]).toMatchObject({ keepsAgent: true, session: 'b' });
    draft = setDriver(patchSeat(addSeat(draft, 8), 1, { model: 'gpt-6' }), 1); draft = { ...draft, rounds: 3 };
    expect(await runSetup({ type: 'edit', leadId: 'lead' }, draft, calls)).toBeNull();
    const [kind, lead, plan] = calls.calls[0] as ['change', string, ReturnType<typeof toPlan>]; expect(kind).toBe('change'); expect(lead).toBe('lead');
    expect(plan).toEqual({ seats: [{ engine: 'claude', model: '', session: 'lead' }, { engine: 'codex', model: 'gpt-6', name: 'Skeptic', session: 'b' }, { engine: 'claude', model: '' }], driver: 1, rounds: 3 });
  });
  it('a hierarchy’s plan has duties and no driver', () => {
    const plan = toPlan({ ...draftFromPreset(mine), rounds: 3 }); expect(plan.driver).toBeUndefined(); expect(plan.rounds).toBe(3); expect(plan.seats[3]).toEqual({ engine: 'claude', model: '', duties: ['review'] });
    expect(toPreset(draftFromPreset(discussion)).driver).toBe(0);
  });
});

describe('the person’s own tables', () => {
  const store = () => { const saved: TablePreset[] = []; const deleted: string[] = []; return { saved, deleted, savePreset: vi.fn(async (preset: TablePreset) => { saved.push(preset); return null; }), deletePreset: vi.fn(async (id: string) => { deleted.push(id); return null; }) }; };
  it('Save as preset keeps the draft under a new id, and needs a name and seats that make a table', async () => {
    const keep = store(); const draft: Draft = { ...draftFromPreset(hierarchy), name: 'Mine' };
    expect(await saveAsPreset({ ...draft, name: '  ' }, 'new-id', keep)).toContain('Give the table a name'); expect(keep.savePreset).not.toHaveBeenCalled();
    expect(await saveAsPreset(patchSeat(draft, 2, { duties: [] }), 'new-id', keep)).toContain('Give every seat something to do');
    expect(await saveAsPreset(draft, 'new-id', keep)).toBeNull(); expect(keep.saved[0]).toMatchObject({ id: 'new-id', name: 'Mine', kind: 'hierarchy' });
  });
  it('Update preset replaces the person’s own table and never a built-in one', async () => {
    const keep = store(); expect(await updatePreset({ ...draftFromPreset(mine), rounds: 5 }, keep)).toBeNull(); expect(keep.saved[0]).toMatchObject({ id: 'mine-1', rounds: 5 });
    expect(await updatePreset({ ...draftFromPreset(hierarchy), name: 'x' }, keep)).toContain('cannot be changed'); expect(keep.savePreset).toHaveBeenCalledTimes(1);
  });
  it('Delete preset asks the store, which refuses the built-in ones; its message comes back', async () => {
    const keep = store(); expect(await removePreset('mine-1', keep)).toBeNull(); expect(keep.deleted).toEqual(['mine-1']);
    expect(await removePreset('mine-1', { ...keep, deletePreset: async () => 'The tables Trace comes with cannot be deleted.' })).toBe('The tables Trace comes with cannot be deleted.');
  });
});
