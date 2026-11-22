import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_PRESETS, MAX_TABLE_PRESETS, type TablePreset } from '../../shared/table-seats';
import { DEFAULT_PREFERENCES, type HubPreferences } from '../../shared/hub';
import { useHubStore } from './hub-store';
import { deletePreset, savePreset, tablePresets } from './table-presets';

const mine = (id: string, extra: Partial<TablePreset> = {}): TablePreset => ({ id, name: `Table ${id}`, kind: 'discussion', rounds: 2, driver: 0, seats: [{ engine: 'claude', model: '' }, { engine: 'codex', model: '' }, { engine: 'claude', model: 'opus-y', name: 'Third' }], ...extra });
/** A host that keeps preferences as the person's other windows may have changed them. */
function host(initial: HubPreferences = DEFAULT_PREFERENCES) {
  let stored = initial; const saved: HubPreferences[] = [];
  const hub = vi.fn(async (request: { action: string; preferences?: HubPreferences }) => {
    if (request.action === 'preferences') return { ok: true, value: stored };
    if (request.action === 'save-preferences') { stored = request.preferences!; saved.push(stored); return { ok: true, value: null }; }
    return { ok: false, error: { code: 'X', message: 'Unexpected.' } };
  });
  vi.stubGlobal('window', { codingHub: { hub } });
  return { hub, saved, change: (next: HubPreferences) => { stored = next; } };
}
beforeEach(() => useHubStore.setState({ preferences: DEFAULT_PREFERENCES }));
afterEach(() => vi.unstubAllGlobals());

describe('Round Table presets', () => {
  it('lists the built-in tables first, then the person’s own', async () => {
    host(); expect(tablePresets().map((preset) => preset.id)).toEqual(BUILT_IN_PRESETS.map((preset) => preset.id));
    expect(await savePreset(mine('a'))).toBeNull(); expect(tablePresets().map((preset) => preset.id)).toEqual([...BUILT_IN_PRESETS.map((preset) => preset.id), 'a']);
  });
  it('adds, replaces by id, and deletes', async () => {
    const { saved } = host();
    expect(await savePreset(mine('a'))).toBeNull(); expect(await savePreset(mine('b'))).toBeNull(); expect(await savePreset(mine('a', { name: 'Renamed', rounds: 4 }))).toBeNull();
    expect(saved.at(-1)!.tablePresets!.map((preset) => [preset.id, preset.name, preset.rounds])).toEqual([['a', 'Renamed', 4], ['b', 'Table b', 2]]);
    expect(useHubStore.getState().preferences.tablePresets).toHaveLength(2);
    expect(await deletePreset('a')).toBeNull(); expect(saved.at(-1)!.tablePresets!.map((preset) => preset.id)).toEqual(['b']); expect(await deletePreset('gone')).toBeNull();
  });
  it('refuses a built-in id, seats that make no table and a name that is empty, saving nothing', async () => {
    const { saved } = host();
    expect(await savePreset({ ...mine('discussion') })).toMatch(/cannot be changed/); expect(await deletePreset('hierarchy')).toMatch(/cannot be deleted/);
    expect(await savePreset(mine('x', { seats: [{ engine: 'claude', model: '' }] }))).toMatch(/at least two/);
    expect(await savePreset(mine('x', { driver: 5 }))).toMatch(/seat that edits/);
    expect(await savePreset(mine('x', { name: '  ' }))).toMatch(/name/);
    const hierarchy = (duties: ('plan' | 'build' | 'review')[][]): TablePreset => ({ id: 'h', name: 'H', kind: 'hierarchy', rounds: 2, seats: duties.map((duty) => ({ engine: 'claude' as const, model: '', duties: duty })) });
    expect(await savePreset(hierarchy([['plan'], ['review']]))).toMatch(/exactly one builder/);
    expect(await savePreset(hierarchy([['build', 'review'], ['plan']]))).toMatch(/only builds/);
    expect(await savePreset(hierarchy([['build'], ['plan'], ['review']]))).toBeNull();
    expect(saved).toHaveLength(1);
  });
  it('keeps at most MAX_TABLE_PRESETS, though one of them can still be replaced', async () => {
    host({ ...DEFAULT_PREFERENCES, tablePresets: Array.from({ length: MAX_TABLE_PRESETS }, (_, index) => mine(`p${index}`)) });
    expect(await savePreset(mine('one-more'))).toMatch(/at most 20/); expect(await savePreset(mine('p3', { name: 'Same slot' }))).toBeNull();
  });
  it('reads the latest preferences from the host first, so a setting changed meanwhile is not written over', async () => {
    const { saved, change } = host(); useHubStore.setState({ preferences: { ...DEFAULT_PREFERENCES, terminalFontSize: 12 } });
    change({ ...DEFAULT_PREFERENCES, terminalFontSize: 18, dailyTokens: 5 });
    expect(await savePreset(mine('a'))).toBeNull(); expect(saved[0]).toMatchObject({ terminalFontSize: 18, dailyTokens: 5 }); expect(useHubStore.getState().preferences.terminalFontSize).toBe(18);
  });
  it('returns the host’s message when saving fails, and leaves the window as it was', async () => {
    const { hub } = host(); hub.mockImplementation(async () => ({ ok: false, error: { code: 'X', message: 'Settings are locked.' } }));
    expect(await savePreset(mine('a'))).toBe('Settings are locked.'); expect(useHubStore.getState().preferences.tablePresets).toBeUndefined();
  });
});
