import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** Where Gemini CLI (agy) keeps its conversations; CODING_HUB_GEMINI_HOME points tests and smoke runs elsewhere. */
export const geminiHome = () => process.env.CODING_HUB_GEMINI_HOME || path.join(homedir(), '.gemini', 'antigravity-cli');
export interface GeminiConversation { id: string; directory: string | null; modified: number; file: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** agy's times ("2026-11-19 04:57:55.8761094+00:00") as milliseconds; NaN when unreadable. */
export function geminiTime(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')) : NaN;
}

/**
 * The person's own Gemini CLI conversations, newest first, from agy's summary list (conversation_summaries.db, read
 * only): each one's ID, first folder and last change. Titles are not read (they can quote a prompt), and subagents'
 * conversations are left out. Seen with agy 1.5.12; another layout gives an empty list rather than an error.
 */
export function geminiConversations(home = geminiHome(), limit = 500): GeminiConversation[] {
  const list = path.join(home, 'conversation_summaries.db'); if (!fs.existsSync(list)) return [];
  let database: DatabaseSync | null = null;
  try {
    // Opened read only, SQLite still makes the -wal and -shm files of a WAL database that lacks them (agy not running):
    // then the file is opened as immutable, which writes nothing. With both there (agy's own), they hold its newest rows.
    const live = fs.existsSync(`${list}-wal`) && fs.existsSync(`${list}-shm`);
    database = new DatabaseSync(live ? list : `${pathToFileURL(list).href}?immutable=1`, { readOnly: true });
    const rows = database.prepare("SELECT conversation_id id, workspace_uris uris, last_modified_time modified FROM conversation_summaries WHERE nesting_depth = 0 AND parent_conversation_id = '' ORDER BY last_modified_time DESC LIMIT ?").all(limit) as { id: unknown; uris: unknown; modified: unknown }[];
    return rows.flatMap((row) => {
      if (typeof row.id !== 'string' || !UUID.test(row.id)) return [];
      let directory: string | null = null;
      try { const first = (JSON.parse(String(row.uris)) as unknown[])[0]; if (typeof first === 'string' && first.startsWith('file:')) { const folder = fileURLToPath(first); if (path.isAbsolute(folder) && !folder.includes('\0')) directory = folder.slice(0, 4096); } } catch { /* No folder. */ }
      return [{ id: row.id.toLowerCase(), directory, modified: geminiTime(row.modified), file: path.join(home, 'conversations', `${row.id}.db`) }];
    });
  } catch { return []; } finally { try { database?.close(); } catch { /* Already closed. */ } }
}

const sameFolder = (a: string, b: string) => process.platform === 'win32' || process.platform === 'darwin' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/**
 * The conversation a run in `cwd` that started at `since` wrote to: the only one in that folder changed since then.
 * Two (another Gemini channel in the same folder) cannot be told apart, so neither is chosen.
 */
export function geminiConversationSince(cwd: string, since: number, home = geminiHome()): string | null {
  const found = geminiConversations(home, 50).filter((conversation) => conversation.directory && sameFolder(conversation.directory, cwd) && conversation.modified >= since - 1000);
  return found.length === 1 ? found[0].id : null;
}

/** A conversation's own file, when agy still has it: what resuming it needs. */
export function geminiConversationFile(id: string, home = geminiHome()): string | undefined {
  if (!UUID.test(id)) return undefined;
  const file = path.join(home, 'conversations', `${id}.db`); return fs.existsSync(file) ? file : undefined;
}
