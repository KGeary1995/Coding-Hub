import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { NativeConversation, NativeResume } from '../../../shared/workbench';
import type { ClaudeProfiles } from '../cli/claude-profiles';
import { HubError } from '../cli/engine-adapter';
import { directory } from './local-store';
export class NativeSessions {
  private sources = new Map<string, string>();
  constructor(private profiles: ClaudeProfiles) {}
  list(): NativeConversation[] {
    this.sources.clear(); const result: NativeConversation[] = []; let visited = 0;
    const roots = [{ engine: 'claude' as const, root: process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), profileId: undefined as string | undefined }, { engine: 'codex' as const, root: process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), profileId: undefined as string | undefined }, ...this.profiles.list().map((profile) => ({ engine: 'claude' as const, root: this.profiles.directory(profile.id), profileId: profile.id }))];
    for (const source of roots) {
      const scan = (root: string, depth: number) => {
        if (depth > 6 || visited >= 4000 || result.length >= 500) return;
        let entries: fs.Dirent[]; try { if (fs.lstatSync(root).isSymbolicLink()) return; entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (++visited > 4000 || result.length >= 500) break;
          const file = path.join(root, entry.name); if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { scan(file, depth + 1); continue; }
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const id = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]; if (!id || !z.uuid().safeParse(id).success) continue;
          try {
            const fd = fs.openSync(file, 'r'); let text: string; try { const buffer = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 131072)); const size = fs.readSync(fd, buffer, 0, buffer.length, 0); text = buffer.subarray(0, size).toString('utf8'); } finally { fs.closeSync(fd); }
            let cwd: string | null = null;
            for (const line of text.split('\n').slice(0, 120)) try { const event = JSON.parse(line); const value = source.engine === 'codex' && event.type === 'session_meta' ? event.payload?.cwd : event.cwd; if (typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')) { cwd = value.slice(0, 4096); break; } } catch {}
            const key = `${source.engine}:${source.profileId ?? 'default'}:${id}`;
            if (this.sources.has(key)) continue;
            this.sources.set(key, file); result.push({ key, id, engine: source.engine, ...(source.profileId ? { profileId: source.profileId } : {}), directory: cwd, title: `${source.engine === 'claude' ? 'Claude' : 'Codex'} · ${cwd ? path.basename(cwd) : 'Conversation'} · ${id.slice(0, 8)}`, modifiedAt: fs.statSync(file).mtime.toISOString() });
          } catch { /* Partial or unreadable CLI files are skipped. */ }
        }
      };
      for (const folder of source.engine === 'claude' ? ['projects'] : ['sessions', 'archived_sessions']) scan(path.join(source.root, folder), 0);
    }
    return result.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
  source(engine: 'claude' | 'codex', id: string, profileId?: string): string | undefined { this.list(); return this.sources.get(`${engine}:${profileId ?? 'default'}:${id}`); }
  execute(input: unknown): NativeConversation[] | NativeResume {
    const request = z.discriminatedUnion('action', [z.object({ action: z.literal('native-list') }).strict(), z.object({ action: z.literal('native-resume'), key: z.string().max(200), directory: z.string().max(4096).optional() }).strict()]).parse(input);
    const items = this.list(); if (request.action === 'native-list') return items;
    const conversation = items.find((item) => item.key === request.key); if (!conversation) throw new HubError('NATIVE_SESSION', 'The CLI conversation is no longer available. Refresh the list.');
    const selected = request.directory ?? conversation.directory; if (!selected) throw new HubError('NATIVE_SESSION', 'Choose a project directory for this conversation.');
    return { conversation, directory: directory(selected) };
  }
}
