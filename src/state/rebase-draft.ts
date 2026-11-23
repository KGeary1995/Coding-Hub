/**
 * A form's unsaved copy after the saved values change underneath it (saved from another card, such as Sync's "Use this
 * folder", or synced from another computer): each field the person has not edited takes the new value, and each field
 * they have edited keeps theirs. Before 1.31.7 Settings kept its whole old copy once anything was edited, so the next Save
 * put back the old values of fields changed elsewhere, such as the Drive folder.
 */
export function rebaseDraft<T extends object>(draft: T, previous: T, next: T): T {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (same(draft, previous)) return next;
  const out = { ...draft } as Record<string, unknown>; const was = previous as unknown as Record<string, unknown>; const now = next as unknown as Record<string, unknown>; const mine = draft as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (same(was[key], now[key]) || !same(mine[key], was[key])) continue;
    if (key in now) out[key] = now[key]; else delete out[key];
  }
  return out as unknown as T;
}
