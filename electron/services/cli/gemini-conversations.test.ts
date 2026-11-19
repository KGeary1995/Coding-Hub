import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { geminiConversationFile, geminiConversations, geminiConversationSince, geminiTime } from './gemini-conversations';
import { parseGeminiModels } from './model-catalog';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
/** agy's own data folder as 1.5.12 lays it out: the summary list (its real columns, fewer of them) and one file per conversation. */
function home(rows: { id: string; folder: string | null; at: string; depth?: number; parent?: string }[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agy-')); homes.push(root); fs.mkdirSync(path.join(root, 'conversations'));
  const database = new DatabaseSync(path.join(root, 'conversation_summaries.db'));
  database.exec('CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,PRIMARY KEY (`conversation_id`))');
  for (const row of rows) {
    database.prepare('INSERT INTO conversation_summaries(conversation_id,title,last_modified_time,workspace_uris,parent_conversation_id,nesting_depth) VALUES(?,?,?,?,?,?)').run(row.id, 'Private title', row.at, JSON.stringify(row.folder ? [pathToFileURL(row.folder).href] : []), row.parent ?? '', row.depth ?? 0);
    fs.writeFileSync(path.join(root, 'conversations', `${row.id}.db`), '');
  }
  database.close(); return root;
}
const A = '7912ead9-5b11-4648-97cd-206300d499d7'; const B = 'caf3f572-52a4-467c-8bc0-c7621834d34a'; const C = '4bc61dda-c49d-4037-a006-51a82664c8d7';
const project = path.resolve(os.tmpdir(), 'trace-project'); const other = path.resolve(os.tmpdir(), 'trace-other');

describe('Gemini CLI conversations', () => {
  it('reads agy’s times', () => {
    expect(geminiTime('2026-11-19 04:57:55.8761094+00:00')).toBe(Date.parse('2026-11-19T04:57:55.876Z'));
    expect(geminiTime('2026-11-19 04:57:55+00:00')).toBe(Date.parse('2026-11-19T04:57:55Z')); expect(geminiTime(5)).toBeNaN();
  });
  it('lists the person’s own conversations newest first, with their folder, and no titles or subagents', () => {
    const root = home([{ id: A, folder: project, at: '2026-11-19 04:57:55.8761094+00:00' }, { id: B, folder: null, at: '2026-11-19 05:00:00.0000000+00:00' }, { id: C, folder: project, at: '2026-11-19 06:00:00+00:00', depth: 1, parent: A }]);
    const list = geminiConversations(root);
    expect(list.map((item) => [item.id, item.directory])).toEqual([[B, null], [A, project]]);
    expect(list[1].file).toBe(path.join(root, 'conversations', `${A}.db`)); expect(JSON.stringify(list)).not.toContain('Private title');
  });
  it('reads agy’s list without making files beside it, in WAL mode as agy keeps it', () => {
    const root = home([{ id: A, folder: project, at: '2026-11-19 05:00:00+00:00' }]);
    const list = path.join(root, 'conversation_summaries.db'); const wal = new DatabaseSync(list); wal.exec('PRAGMA journal_mode=WAL'); wal.close();
    for (const extra of ['-wal', '-shm']) fs.rmSync(list + extra, { force: true });
    expect(geminiConversations(root).map((item) => item.id)).toEqual([A]);
    expect(fs.readdirSync(root).sort()).toEqual(['conversation_summaries.db', 'conversations']);
  });
  it('gives an empty list for a missing or unreadable list, never an error', () => {
    expect(geminiConversations(path.join(os.tmpdir(), 'trace-no-agy-here'))).toEqual([]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agy-')); homes.push(root); fs.writeFileSync(path.join(root, 'conversation_summaries.db'), 'not a database');
    expect(geminiConversations(root)).toEqual([]);
  });
  it('finds the conversation a run wrote to: the only one in its folder changed since it started', () => {
    const since = Date.parse('2026-11-19T05:00:00Z');
    const root = home([{ id: A, folder: project, at: '2026-11-19 05:10:00+00:00' }, { id: B, folder: other, at: '2026-11-19 05:20:00+00:00' }, { id: C, folder: project, at: '2026-11-19 04:00:00+00:00' }]);
    expect(geminiConversationSince(project, since, root)).toBe(A);
    expect(geminiConversationSince(path.join(os.tmpdir(), 'elsewhere'), since, root)).toBeNull();
    // Two Gemini channels in one folder cannot be told apart, so neither is chosen.
    const two = home([{ id: A, folder: project, at: '2026-11-19 05:10:00+00:00' }, { id: C, folder: project, at: '2026-11-19 05:11:00+00:00' }]);
    expect(geminiConversationSince(project, since, two)).toBeNull();
  });
  it('resumes only a conversation agy still has, by a real ID', () => {
    const root = home([{ id: A, folder: project, at: '2026-11-19 05:10:00+00:00' }]);
    expect(geminiConversationFile(A, root)).toBe(path.join(root, 'conversations', `${A}.db`));
    expect(geminiConversationFile(B, root)).toBeUndefined(); expect(geminiConversationFile('../../x', root)).toBeUndefined();
  });
});

describe('Gemini CLI models', () => {
  it('reads `agy models`: one ID and name per line, after its first line', () => {
    expect(parseGeminiModels('Fetching available models...\r\ngemini-4-neon-high\tGemini 4 Neon (High)\r\ngemini-4-argon-high\tGemini 4 Argon (High)\r\n\r\n')).toEqual([{ model: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)' }, { model: 'gemini-4-argon-high', displayName: 'Gemini 4 Argon (High)' }]);
  });
  it('leaves out IDs that could be read as flags, and repeats', () => {
    expect(parseGeminiModels('--yolo\tBad\nok-model\tOK\nok-model\tAgain\n')).toEqual([{ model: 'ok-model', displayName: 'OK' }]);
  });
});
