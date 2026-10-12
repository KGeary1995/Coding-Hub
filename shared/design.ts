export interface DesignSnapshot { id: string; designId: string; version: number; title: string; notes: string; projectDirectory: string | null; createdAt: string; kind: 'html' | 'image'; sourceName: string }
export interface DesignPreview { snapshot: DesignSnapshot; content: string; mime: string }
export type DesignRequest = { action: 'list' } | { action: 'read'; id: string } | { action: 'import'; title: string; notes: string; projectDirectory: string | null; designId?: string };
export type DesignResponse = DesignSnapshot[] | DesignPreview | null;
