/** Imports a Claude Design handoff bundle into a project. Kept for the planned Claude tab; the Design workspace that used it was removed. */
export type DesignRequest = { action: 'handoff-import'; source: 'zip' | 'folder'; projectDirectory: string };
/** A Claude Design handoff bundle copied into the project (relative paths use forward slashes). */
export interface HandoffResult { directory: string; relative: string; readme: string | null; files: number }
export type DesignResponse = HandoffResult | null;
