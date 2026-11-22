import type { HubPreferences } from '../../shared/hub';
import { BUILT_IN_PRESETS, checkSeats, isBuiltInPreset, MAX_TABLE_PRESETS, type TablePreset } from '../../shared/table-seats';
import { hubCall, useHubStore } from './hub-store';

/** The tables the person can start: the two built in, then their own (kept in this computer's preferences; device sync does not carry them). */
export const tablePresets = (preferences: HubPreferences = useHubStore.getState().preferences): TablePreset[] => [...BUILT_IN_PRESETS, ...(preferences.tablePresets ?? [])];
export function useTablePresets(): TablePreset[] {
  const own = useHubStore((state) => state.preferences.tablePresets);
  return [...BUILT_IN_PRESETS, ...(own ?? [])];
}

/** The seat that leads a table: the builder at a hierarchy, the first seat at a discussion. */
export const leadIndex = (preset: TablePreset) => preset.kind === 'hierarchy' ? preset.seats.findIndex((seat) => seat.duties?.includes('build')) : 0;
/** Why this preset cannot be saved or started, or null. */
export const checkPreset = (preset: TablePreset): string | null => {
  if (!preset.name.trim()) return 'Give the table a name.';
  if (preset.kind === 'discussion' && preset.driver !== undefined && (preset.driver < 0 || preset.driver >= preset.seats.length)) return 'The seat that edits is not at the table.';
  return checkSeats(preset.kind, preset.seats, Math.max(0, leadIndex(preset)), preset.kind === 'discussion' ? preset.driver ?? 0 : undefined);
};

/** Reads the latest preferences from the host, changes the person's presets, saves, and updates the window. The error message, or null. */
async function changePresets(change: (own: TablePreset[]) => TablePreset[] | string): Promise<string | null> {
  try {
    // The host's copy, not the window's: a setting changed meanwhile (another window, a sync) is never written over.
    const latest = await hubCall<HubPreferences>({ action: 'preferences' });
    const next = change(latest.tablePresets ?? []); if (typeof next === 'string') return next;
    const preferences: HubPreferences = { ...latest, tablePresets: next };
    await hubCall({ action: 'save-preferences', preferences });
    useHubStore.getState().setPreferences(preferences);
    return null;
  } catch (error) { return error instanceof Error ? error.message : 'The table could not be saved.'; }
}

/** Adds the preset, or replaces the one with its id. Refuses a built-in id, seats that make no table, and more than MAX_TABLE_PRESETS. */
export async function savePreset(preset: TablePreset): Promise<string | null> {
  if (isBuiltInPreset(preset.id)) return 'The tables Trace comes with cannot be changed. Save a copy under a new name.';
  const why = checkPreset(preset); if (why) return why;
  return changePresets((own) => own.some((item) => item.id === preset.id) ? own.map((item) => item.id === preset.id ? preset : item) : own.length >= MAX_TABLE_PRESETS ? `You can keep at most ${MAX_TABLE_PRESETS} tables. Delete one first.` : [...own, preset]);
}
/** Removes one of the person's own tables. Tables already open keep their seats. */
export async function deletePreset(id: string): Promise<string | null> {
  if (isBuiltInPreset(id)) return 'The tables Trace comes with cannot be deleted.';
  return changePresets((own) => own.filter((item) => item.id !== id));
}
