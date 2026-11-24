import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { NativeConversation, NativeResume, NativeSearch } from '../../../shared/workbench';
import type { ClaudeProfiles } from '../cli/claude-profiles';
import { HubError } from '../cli/engine-adapter';
import { directory } from './local-store';
import { geminiConversationFile, geminiConversations } from '../cli/gemini-conversations';
import type { ChatHistoryMessage } from '../../../shared/chat';
import { geminiHistory, historyOf } from '../chat/transcript';
import { findWords, mayContain } from './native-search';
/** At most this many conversations are listed, the most recent first. */
const LISTED = 500;
/** Each CLI home (and Claude profile) is searched through at most this many folder entries. */
const VISITED_PER_SOURCE = 20000;
/** A search inside conversations stops at this many that match, skips files larger than `bytes`, and returns what it has after `ms`. */
export const SEARCH_LIMITS = { results: 50, bytes: 20 * 1024 * 1024, ms: 8000 };
interface Source { engine: 'claude' | 'codex' | 'gemini'; root: string; profileId?: string }
interface Candidate { source: Source; file: string; id: string; modified: number }

export class NativeSessions {
  private sources = new Map<string, string>();
  /** `hidden`: folders whose conversations are Trace's own (live coaching's reviews), left out of the list. */
  constructor(private profiles: ClaudeProfiles, private hidden: string[] = [], private claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), private gemini: { list: typeof geminiConversations; file: typeof geminiConversationFile } = { list: geminiConversations, file: geminiConversationFile }) {}
  private roots(): Source[] {
    return [{ engine: 'claude', root: this.claudeHome }, { engine: 'codex', root: process.env.CODEX_HOME ?? path.join(homedir(), '.codex') }, ...this.profiles.list().map((profile) => ({ engine: 'claude' as const, root: this.profiles.directory(profile.id), profileId: profile.id }))];
  }
  /**
   * Every conversation file in one CLI home, with when it last changed; files are only named and dated here, not read.
   * Each home has its own budget, so a large history in one cannot hide another's.
   */
  private candidates(source: Source, id?: string): Candidate[] {
    const found: Candidate[] = []; let visited = 0;
    const scan = (root: string, depth: number) => {
      if (depth > 6 || visited >= VISITED_PER_SOURCE) return;
      let entries: fs.Dirent[]; try { if (fs.lstatSync(root).isSymbolicLink()) return; entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (++visited > VISITED_PER_SOURCE) break;
        const file = path.join(root, entry.name); if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { scan(file, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || (id && !entry.name.includes(id))) continue;
        const match = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]; if (!match || !z.uuid().safeParse(match).success) continue;
        try { found.push({ source, file, id: match, modified: fs.statSync(file).mtimeMs }); } catch { /* Removed meanwhile. */ }
      }
    };
    for (const folder of source.engine === 'claude' ? ['projects'] : ['sessions', 'archived_sessions']) scan(path.join(source.root, folder), 0);
    return found;
  }
  /** The same as `candidates`, without blocking the app while a large history is walked. */
  private async listed(source: Source): Promise<Candidate[]> {
    const found: Candidate[] = []; let visited = 0;
    const scan = async (root: string, depth: number) => {
      if (depth > 6 || visited >= VISITED_PER_SOURCE) return;
      let entries: fs.Dirent[]; try { if ((await fs.promises.lstat(root)).isSymbolicLink()) return; entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (++visited > VISITED_PER_SOURCE) break;
        const file = path.join(root, entry.name); if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await scan(file, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const match = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]; if (!match || !z.uuid().safeParse(match).success) continue;
        try { found.push({ source, file, id: match, modified: (await fs.promises.stat(file)).mtimeMs }); } catch { /* Removed meanwhile. */ }
      }
    };
    for (const folder of source.engine === 'claude' ? ['projects'] : ['sessions', 'archived_sessions']) await scan(path.join(source.root, folder), 0);
    return found;
  }
  /** A conversation's details, read from the start of its file; null when the file cannot be read. */
  private async describe({ source, file, id }: Candidate): Promise<NativeConversation | null> {
    try {
      const handle = await fs.promises.open(file, 'r'); let text: string; let modified: Date;
      try { const stat = await handle.stat(); modified = stat.mtime; const buffer = Buffer.alloc(Math.min(stat.size, 131072)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); text = buffer.subarray(0, bytesRead).toString('utf8'); } finally { await handle.close(); }
      let cwd: string | null = null;
      for (const line of text.split('\n').slice(0, 120)) try { const event = JSON.parse(line); const value = source.engine === 'codex' && event.type === 'session_meta' ? event.payload?.cwd : event.cwd; if (typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')) { cwd = value.slice(0, 4096); break; } } catch {}
      return { key: `${source.engine}:${source.profileId ?? 'default'}:${id}`, id, engine: source.engine, ...(source.profileId ? { profileId: source.profileId } : {}), directory: cwd, title: `${source.engine === 'claude' ? 'Claude' : 'Codex'} · ${cwd ? path.basename(cwd) : 'Conversation'} · ${id.slice(0, 8)}`, modifiedAt: modified.toISOString() };
    } catch { return null; /* Partial or unreadable CLI files are skipped. */ }
  }
  /** The most recent conversations across every CLI home, newest first; read without blocking the app. */
  async list(): Promise<NativeConversation[]> {
    const sources = new Map<string, string>(); const result: NativeConversation[] = [];
    const candidates = (await Promise.all(this.roots().map((source) => this.listed(source)))).flat();
    // Gemini CLI keeps a list of its conversations (agy's own database), so they are named there, not found as files.
    const gemini = this.gemini.list(); const geminiSource: Source = { engine: 'gemini', root: '' };
    const all: (Candidate & { directory?: string | null })[] = [...candidates, ...gemini.map((item) => ({ source: geminiSource, file: item.file, id: item.id, modified: Number.isFinite(item.modified) ? item.modified : 0, directory: item.directory }))].sort((a, b) => b.modified - a.modified);
    for (const candidate of all) {
      if (result.length >= LISTED) break;
      if (candidate.source.engine === 'gemini') {
        const folder = candidate.directory ?? null; if (folder && this.hidden.some((hidden) => path.resolve(folder).toLowerCase() === path.resolve(hidden).toLowerCase())) continue;
        sources.set(`gemini:default:${candidate.id}`, candidate.file);
        result.push({ key: `gemini:default:${candidate.id}`, id: candidate.id, engine: 'gemini', directory: folder, title: `Gemini · ${folder ? path.basename(folder) : 'Conversation'} · ${candidate.id.slice(0, 8)}`, modifiedAt: new Date(candidate.modified).toISOString() });
        continue;
      }
      const key = `${candidate.source.engine}:${candidate.source.profileId ?? 'default'}:${candidate.id}`; if (sources.has(key)) continue;
      const conversation = await this.describe(candidate); if (!conversation || this.hidden.some((folder) => conversation.directory && path.resolve(conversation.directory).toLowerCase() === path.resolve(folder).toLowerCase())) continue;
      sources.set(key, candidate.file); result.push(conversation);
    }
    this.sources = sources;
    return result;
  }
  /** A known conversation's file, found by its id however old it is (not only if it is among the listed ones). */
  source(engine: 'claude' | 'codex' | 'gemini', id: string, profileId?: string): string | undefined {
    if (engine === 'gemini') return this.gemini.file(id);
    // The last listing usually has it; looking it up again walks the whole history.
    const listed = this.sources.get(`${engine}:${profileId ?? 'default'}:${id}`); if (listed && fs.existsSync(listed)) return listed;
    const home = this.roots().find((source) => source.engine === engine && source.profileId === profileId); if (!home) return undefined;
    return this.candidates(home, id).filter((candidate) => candidate.id === id).sort((a, b) => b.modified - a.modified)[0]?.file;
  }
  /**
   * The listed Claude Code, Codex and Gemini conversations whose messages contain `query` (ignoring case), newest first, with where.
   * Only what the person and the agent wrote is searched, not tool output. Each file is read once, Claude's and Codex's
   * without blocking the app (Gemini's is a small database, read at once), and the search stops at the limits, saying so with `partial`.
   */
  async search(query: string, limits = SEARCH_LIMITS): Promise<NativeSearch> {
    const deadline = Date.now() + limits.ms; const items = await this.list(); const read = new Set<string>(); const results: NativeSearch['results'] = []; let skipped = 0; let partial = false;
    for (const item of items) {
      if (results.length >= limits.results || Date.now() >= deadline) { partial = true; break; }
      const file = this.sources.get(item.key); if (!file || read.has(file)) continue; read.add(file);
      let messages: ChatHistoryMessage[];
      try {
        if ((await fs.promises.stat(file)).size > limits.bytes) { skipped++; continue; }
        // Gemini's words are inside protobuf in a database, so there is no raw text to check first with mayContain.
        if (item.engine === 'gemini') { const history = geminiHistory(file); if (!history) continue; messages = history; }
        else { const raw = await fs.promises.readFile(file, 'utf8'); if (!mayContain(raw, query)) continue; messages = historyOf(item.engine, raw.split('\n')).messages; }
      } catch { continue; /* Removed meanwhile. */ }
      const found = findWords(messages, query); if (found.matches) results.push({ ...item, ...found });
    }
    return { query, results, partial, skipped };
  }
  async execute(input: unknown): Promise<NativeConversation[] | NativeResume | NativeSearch> {
    const request = z.discriminatedUnion('action', [z.object({ action: z.literal('native-list') }).strict(), z.object({ action: z.literal('native-resume'), key: z.string().max(200), directory: z.string().max(4096).optional() }).strict(), z.object({ action: z.literal('native-search'), query: z.string().trim().min(2, 'Type at least 2 characters to search inside conversations.').max(200) }).strict()]).parse(input);
    if (request.action === 'native-search') return this.search(request.query);
    const items = await this.list(); if (request.action === 'native-list') return items;
    const conversation = items.find((item) => item.key === request.key); if (!conversation) throw new HubError('NATIVE_SESSION', 'The CLI conversation is no longer available. Refresh the list.');
    const selected = request.directory ?? conversation.directory; if (!selected) throw new HubError('NATIVE_SESSION', 'Choose a project folder for this conversation.');
    return { conversation, directory: directory(selected) };
  }
}
