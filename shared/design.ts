export interface DesignSnapshot { id: string; designId: string; version: number; title: string; notes: string; projectDirectory: string | null; createdAt: string; kind: 'html' | 'image'; sourceName: string }
export interface DesignPreview { snapshot: DesignSnapshot; content: string; mime: string }
export type DesignRequest = { action: 'list' } | { action: 'read'; id: string } | { action: 'import'; title: string; notes: string; projectDirectory: string | null; designId?: string } | { action: 'handoff-import'; source: 'zip' | 'folder'; projectDirectory: string };
/** A Claude Design handoff bundle copied into the project (relative paths use forward slashes). */
export interface HandoffResult { directory: string; relative: string; readme: string | null; snapshot: DesignSnapshot | null; files: number; warning: string | null }
export type DesignResponse = DesignSnapshot[] | DesignPreview | HandoffResult | null;
