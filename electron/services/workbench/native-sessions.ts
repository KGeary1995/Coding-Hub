import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { NativeConversation, NativeResume } from '../../../shared/workbench';
import type { ClaudeProfiles } from '../cli/claude-profiles';
import { HubError } from '../cli/engine-adapter';
import { directory } from './local-store';
/** At most this many conversations are listed, the most recent first. */
const LISTED = 500;
/** Each CLI home (and Claude profile) is searched through at most this many folder entries. */
const VISITED_PER_SOURCE = 20000;
interface Source { engine: 'claude' | 'codex'; root: string; profileId?: string }
interface Candidate { source: Source; file: string; id: string; modified: number }

export class NativeSessions {
  private sources = new Map<string, string>();
  constructor(private profiles: ClaudeProfiles) {}
  private roots(): Source[] {
    return [{ engine: 'claude', root: process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude') }, { engine: 'codex', root: process.env.CODEX_HOME ?? path.join(homedir(), '.codex') }, ...this.profiles.list().map((profile) => ({ engine: 'claude' as const, root: this.profiles.directory(profile.id), profileId: profile.id }))];
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
  /** A conversation's details, read from the start of its file; null when the file cannot be read. */
  private describe({ source, file, id }: Candidate): NativeConversation | null {
    try {
      const fd = fs.openSync(file, 'r'); let text: string; try { const buffer = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 131072)); const size = fs.readSync(fd, buffer, 0, buffer.length, 0); text = buffer.subarray(0, size).toString('utf8'); } finally { fs.closeSync(fd); }
      let cwd: string | null = null;
      for (const line of text.split('\n').slice(0, 120)) try { const event = JSON.parse(line); const value = source.engine === 'codex' && event.type === 'session_meta' ? event.payload?.cwd : event.cwd; if (typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')) { cwd = value.slice(0, 4096); break; } } catch {}
      return { key: `${source.engine}:${source.profileId ?? 'default'}:${id}`, id, engine: source.engine, ...(source.profileId ? { profileId: source.profileId } : {}), directory: cwd, title: `${source.engine === 'claude' ? 'Claude' : 'Codex'} · ${cwd ? path.basename(cwd) : 'Conversation'} · ${id.slice(0, 8)}`, modifiedAt: fs.statSync(file).mtime.toISOString() };
    } catch { return null; /* Partial or unreadable CLI files are skipped. */ }
  }
  /** The most recent conversations across every CLI home, newest first. */
  list(): NativeConversation[] {
    this.sources.clear(); const result: NativeConversation[] = [];
    const candidates = this.roots().flatMap((source) => this.candidates(source)).sort((a, b) => b.modified - a.modified);
    for (const candidate of candidates) {
      if (result.length >= LISTED) break;
      const key = `${candidate.source.engine}:${candidate.source.profileId ?? 'default'}:${candidate.id}`; if (this.sources.has(key)) continue;
      const conversation = this.describe(candidate); if (!conversation) continue;
      this.sources.set(key, candidate.file); result.push(conversation);
    }
    return result;
  }
  /** A known conversation's file, found by its id however old it is (not only if it is among the listed ones). */
  source(engine: 'claude' | 'codex', id: string, profileId?: string): string | undefined {
    const home = this.roots().find((source) => source.engine === engine && source.profileId === profileId); if (!home) return undefined;
    return this.candidates(home, id).filter((candidate) => candidate.id === id).sort((a, b) => b.modified - a.modified)[0]?.file;
  }
  execute(input: unknown): NativeConversation[] | NativeResume {
    const request = z.discriminatedUnion('action', [z.object({ action: z.literal('native-list') }).strict(), z.object({ action: z.literal('native-resume'), key: z.string().max(200), directory: z.string().max(4096).optional() }).strict()]).parse(input);
    const items = this.list(); if (request.action === 'native-list') return items;
    const conversation = items.find((item) => item.key === request.key); if (!conversation) throw new HubError('NATIVE_SESSION', 'The CLI conversation is no longer available. Refresh the list.');
    const selected = request.directory ?? conversation.directory; if (!selected) throw new HubError('NATIVE_SESSION', 'Choose a project directory for this conversation.');
    return { conversation, directory: directory(selected) };
  }
}
