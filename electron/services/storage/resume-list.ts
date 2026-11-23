import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { load, save } from '../workbench/local-store';

/**
 * The channels running when Trace last quit, so the next start can start them again on their conversations (1.32.0;
 * before, every channel came back stopped). Written as Trace quits, before it stops them (the saved workspace by then
 * shows each one stopped), and read once by the first workspace load, which removes it: a later load (a reload) or a
 * start after a crash, which never wrote it, starts nothing.
 */
const FILE = 'resume-on-start.json';
const schema = z.object({ sessions: z.array(z.string().min(1).max(100)).max(64), savedAt: z.iso.datetime() }).strict();

export function saveResume(root: string, sessionIds: string[]) {
  const sessions = [...new Set(sessionIds)].slice(0, 64);
  if (!sessions.length) { fs.rmSync(path.join(root, FILE), { force: true }); return; }
  save(root, FILE, { sessions, savedAt: new Date().toISOString() });
}

/** The list, once: it is removed whether or not it could be read, so a bad file never starts channels on every launch. */
export function takeResume(root: string): string[] {
  try { return load(root, FILE, schema, { sessions: [], savedAt: new Date(0).toISOString() }).sessions; }
  catch { return []; }
  finally { try { fs.rmSync(path.join(root, FILE), { force: true }); } catch { /* Read-only: it is read again next time. */ } }
}
