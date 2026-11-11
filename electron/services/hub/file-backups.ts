import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

/** Backups kept per original file; older ones are removed when a new one is made. */
export const KEEP_BACKUPS = 20;
/** The file in each backup folder that names the original file, so a person can tell which file it backs up. */
export const ORIGINAL_NOTE = 'original-path.txt';
let root: string | null = null; let made = 0;
/** Trace's storage root (main.ts sets it at startup, after a restore's redirect); tests set their own. */
export function setBackupRoot(directory: string | null) { root = directory; }
/** Where backups of edited configuration and instruction files go: in Trace's own data, never beside the file (a project would show them as untracked files). */
export function backupRoot() { return path.join(root ?? process.env.CODING_HUB_STORAGE_DIR ?? path.join(homedir(), '.coding-hub'), 'config-backups'); }
/** One folder per original file: its folder and name, readable, and a hash of its full path, so two projects' CLAUDE.md never share one. */
export function backupFolder(file: string) {
  const full = path.resolve(file); const key = process.platform === 'win32' ? full.toLowerCase() : full;
  const label = `${path.basename(path.dirname(full))}_${path.basename(full)}`.replace(/[^\w.-]+/g, '_').slice(0, 80);
  return path.join(backupRoot(), `${label}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`);
}
/**
 * Keeps a private copy of a file's text before Trace replaces it. Throws when the copy cannot be written, so the edit
 * does not go ahead without one; trimming older copies never fails the edit.
 */
export function keepBackup(file: string, text: string) {
  const folder = backupFolder(file); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const note = path.join(folder, ORIGINAL_NOTE); if (!fs.existsSync(note)) fs.writeFileSync(note, path.resolve(file) + '\n', { mode: 0o600 });
  // Named to sort oldest first: the time, then a count, so two copies made in the same millisecond keep their order.
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(++made % 1e6).padStart(6, '0')}-${randomUUID().slice(0, 8)}${path.extname(file)}`;
  fs.writeFileSync(path.join(folder, name), text, { mode: 0o600, flag: 'wx' });
  try {
    const copies = fs.readdirSync(folder).filter((entry) => entry !== ORIGINAL_NOTE).sort();
    for (const old of copies.slice(0, Math.max(0, copies.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(folder, old));
  } catch { /* An old copy that cannot be removed now is removed next time. */ }
  return path.join(folder, name);
}
