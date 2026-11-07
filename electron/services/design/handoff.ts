import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import type { HandoffResult } from '../../../shared/design';
import { HubError } from '../cli/engine-adapter';

const MAX_FILES = 2000;
const MAX_FILE = 25 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const requestSchema = z.object({ action: z.literal('handoff-import'), source: z.enum(['zip', 'folder']), projectDirectory: z.string().min(1).max(4096) }).strict();
interface Entry { path: string; data: Buffer }

/** Bundle paths must stay inside the copy: no absolute paths, drive letters, `..`, Git metadata or control characters. */
function safeRelative(name: string): string | null {
  const normal = name.replace(/\\/g, '/');
  if (!normal || normal.startsWith('/') || /^[a-z]:/i.test(normal) || /[\0-\x1f]/.test(normal)) return null;
  const parts = normal.split('/').filter((part, index, all) => !(part === '' && index === all.length - 1));
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) return null;
  return parts.join('/');
}
function budget() {
  let total = 0; let count = 0;
  return (size: number) => { count++; total += size; if (count > MAX_FILES || size > MAX_FILE || total > MAX_TOTAL) throw new HubError('HANDOFF_SIZE', 'The bundle exceeds 2,000 files, 25 MiB per file or 100 MiB in total.'); };
}

/** Reads a standard (non-ZIP64, unencrypted) archive with stored or deflated entries. Symbolic links are skipped. */
export function readZip(file: string): Entry[] {
  const size = fs.statSync(file).size; if (size > MAX_TOTAL + 1024 * 1024) throw new HubError('HANDOFF_SIZE', 'The bundle file is larger than 100 MiB.');
  const bytes = fs.readFileSync(file); const invalid = () => new HubError('HANDOFF_FORMAT', 'The file is not a readable ZIP bundle. Extract it and import the folder instead.');
  let end = -1; for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  if (end < 0) throw invalid();
  const count = bytes.readUInt16LE(end + 10); const directory = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directory === 0xffffffff) throw new HubError('HANDOFF_FORMAT', 'ZIP64 bundles are not supported. Extract it and import the folder instead.');
  const entries: Entry[] = []; const charge = budget(); let cursor = directory;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(cursor + 8); const method = bytes.readUInt16LE(cursor + 10); const compressed = bytes.readUInt32LE(cursor + 20); const expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28); const extra = bytes.readUInt16LE(cursor + 30); const comment = bytes.readUInt16LE(cursor + 32); const mode = bytes.readUInt32LE(cursor + 38) >>> 16; const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1'); cursor += 46 + nameLength + extra + comment;
    if (name.endsWith('/') || (mode & 0o170000) === 0o040000) continue;
    if ((mode & 0o170000) === 0o120000) continue;
    if (flags & 1) throw new HubError('HANDOFF_FORMAT', 'Encrypted bundles are not supported.');
    const relative = safeRelative(name); if (!relative) throw new HubError('HANDOFF_PATH', `The bundle contains an unsafe path: ${name.slice(0, 120)}`);
    charge(expanded);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28); const raw = bytes.subarray(start, start + compressed);
    if (raw.length !== compressed) throw invalid();
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) { try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, expanded) }); } catch { throw invalid(); } }
    else throw new HubError('HANDOFF_FORMAT', 'The bundle uses an unsupported ZIP compression method. Extract it and import the folder instead.');
    if (data.length !== expanded) throw invalid();
    entries.push({ path: relative, data });
  }
  return entries;
}

/** Copies a folder's regular files (links and .git folders are skipped). */
export function readFolder(root: string): Entry[] {
  const entries: Entry[] = []; const charge = budget();
  const walk = (folder: string, prefix: string, depth: number) => {
    if (depth > 20) throw new HubError('HANDOFF_SIZE', 'The bundle folder is nested too deeply.');
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      if (item.isSymbolicLink() || item.name === '.git') continue;
      const relative = prefix ? `${prefix}/${item.name}` : item.name; const file = path.join(folder, item.name);
      if (item.isDirectory()) { walk(file, relative, depth + 1); continue; }
      if (!item.isFile()) continue;
      const safe = safeRelative(relative); if (!safe) throw new HubError('HANDOFF_PATH', `The bundle contains an unsupported file name: ${relative.slice(0, 120)}`);
      charge(fs.statSync(file).size); entries.push({ path: safe, data: fs.readFileSync(file) });
    }
  };
  walk(root, '', 0); return entries;
}

/** A bundle zipped as one top-level folder is copied without that extra level. */
function stripSharedFolder(entries: Entry[]): Entry[] {
  const first = entries[0]?.path.split('/')[0];
  if (!first || !entries.every((entry) => entry.path.startsWith(first + '/'))) return entries;
  return entries.map((entry) => ({ ...entry, path: entry.path.slice(first.length + 1) }));
}
const depth = (file: string) => file.split('/').length;
const shallowest = (files: string[]) => [...files].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0] ?? null;
/**
 * Copies a Claude Design handoff bundle into the project's design-handoff folder for a coding agent to build from.
 * Nothing in the window calls it since the Design workspace was removed; the planned Claude tab will.
 */
export class HandoffImport {
  constructor(private pick: (source: 'zip' | 'folder') => Promise<string | null>) {}
  async execute(input: unknown): Promise<HandoffResult | null> {
    const parsed = requestSchema.safeParse(input); if (!parsed.success) throw new HubError('INVALID_DESIGN_REQUEST', 'Invalid handoff import request.');
    let project: string;
    try { project = fs.realpathSync(parsed.data.projectDirectory); if (!path.isAbsolute(parsed.data.projectDirectory) || !fs.statSync(project).isDirectory()) throw new Error(); }
    catch { throw new HubError('INVALID_DIRECTORY', 'Choose an existing project folder before importing a Claude Design bundle.'); }
    const source = await this.pick(parsed.data.source); if (!source) return null;
    const entries = stripSharedFolder(parsed.data.source === 'zip' ? readZip(source) : readFolder(source));
    if (!entries.length) throw new HubError('HANDOFF_EMPTY', 'The bundle contains no files.');
    // Copy into a new, uniquely named folder in the project so the coding agent can read it. Never overwrite.
    const parent = path.join(project, 'design-handoff');
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new HubError('HANDOFF_PATH', 'design-handoff must be a real folder, not a link.');
    fs.mkdirSync(parent, { recursive: true });
    const base = (path.basename(source).replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'design').slice(0, 60);
    let name = base; for (let suffix = 2; fs.existsSync(path.join(parent, name)); suffix++) name = `${base}-${suffix}`;
    const target = path.join(parent, name); fs.mkdirSync(target);
    try { for (const entry of entries) { const file = path.join(target, ...entry.path.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entry.data, { flag: 'wx' }); } }
    catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error instanceof HubError ? error : new HubError('HANDOFF_COPY', 'The bundle could not be copied into the project. Check for duplicate file names and folder permissions.'); }
    const readme = shallowest(entries.map((entry) => entry.path).filter((file) => /^readme(\.md|\.txt)?$/i.test(path.posix.basename(file))));
    const relative = path.relative(project, target).split(path.sep).join('/');
    return { directory: target, relative, readme: readme ? `${relative}/${readme}` : null, files: entries.length };
  }
}
