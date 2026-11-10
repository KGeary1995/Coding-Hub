import type { MemoryNote } from './hub';

/**
 * Open items: to-dos and questions a session leaves for later, kept as ordinary memory notes so every Trace version and
 * Drive sync handle them unchanged. An item is a note titled "Open item: …"; resolving it writes a note titled
 * "Resolved: …" that supersedes it. An item nothing supersedes is still open. Notes stay immutable: history is kept.
 */
export const OPEN_PREFIX = 'Open item: ';
export const RESOLVED_PREFIX = 'Resolved: ';
/** Longest item text, so the title stays within a note's 200 characters. */
export const MAX_ITEM_TEXT = 200 - OPEN_PREFIX.length;
export interface OpenItem { id: string; text: string; details: string; author: MemoryNote['author']; createdAt: string }

export const isItemNote = (note: Pick<MemoryNote, 'title'>) => note.title.startsWith(OPEN_PREFIX) || note.title.startsWith(RESOLVED_PREFIX);
export const itemTitle = (text: string) => OPEN_PREFIX + text.trim().replace(/\s+/g, ' ').slice(0, MAX_ITEM_TEXT);
export const resolvedTitle = (item: Pick<MemoryNote, 'title'>) => (RESOLVED_PREFIX + item.title.slice(OPEN_PREFIX.length)).slice(0, 200);

/** The open items among a project's notes, newest first. */
export function openItems(notes: MemoryNote[]): OpenItem[] {
  const replaced = new Set(notes.flatMap((note) => note.supersedes ? [note.supersedes] : []));
  return notes.filter((note) => note.title.startsWith(OPEN_PREFIX) && !replaced.has(note.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((note) => ({ id: note.id, text: note.title.slice(OPEN_PREFIX.length), details: note.content, author: note.author, createdAt: note.createdAt }));
}
