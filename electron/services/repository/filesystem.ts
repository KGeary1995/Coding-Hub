import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DirectoryEntry, DirectoryListing, FilePreview, RepositoryContext } from '../../../shared/types';
import { openRepositorySchema, repositoryPathSchema, repositoryReferenceSchema } from '../../../shared/schemas';
import { HubError } from '../cli/engine-adapter';

export const FILE_PREVIEW_LIMIT = 1024 * 1024;
export const DIRECTORY_ENTRY_LIMIT = 500;

export function validateRelativePath(relative: string, allowRoot = false) {
  const segments = relative.split(process.platform === 'win32' ? /[\\/]/ : /\//);
  if ((!relative && !allowRoot) || relative.includes('\0') || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[a-z]:/i.test(relative)
    || (relative && segments.some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git'))) {
    throw new HubError('INVALID_PATH', 'Choose a path inside the selected project. Git metadata is not available in the file browser.');
  }
}

/** Disallow symbolic links and verify canonical containment before reading local files. */
export async function scopedPath(root: string, relative: string, allowRoot = false) {
  validateRelativePath(relative, allowRoot);
  const rootNow = await realpath(root);
  if (rootNow !== root) throw new HubError('PROJECT_MOVED', 'The project directory changed. Select it again.');
  let current = root;
  for (const part of relative ? relative.split(process.platform === 'win32' ? /[\\/]/ : /\//) : []) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new HubError('SYMLINK_UNAVAILABLE', 'Symbolic links are shown but not opened in the file browser.');
  }
  const resolved = await realpath(current);
  const within = path.relative(root, resolved);
  if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) throw new HubError('INVALID_PATH', 'This path is outside the selected project.');
  return resolved;
}

export async function readTextFile(root: string, relative: string): Promise<FilePreview> {
  const file = await scopedPath(root, relative);
  if (!(await lstat(file)).isFile()) throw new HubError('NOT_A_FILE', 'Choose a regular file to preview.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new HubError('NOT_A_FILE', 'Choose a regular file to preview.');
    const buffer = Buffer.alloc(Math.min(metadata.size, FILE_PREVIEW_LIMIT + 4));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const truncated = metadata.size > FILE_PREVIEW_LIMIT;
    let bytes = buffer.subarray(0, Math.min(length, FILE_PREVIEW_LIMIT));
    let encoding: FilePreview['encoding'] = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    if (truncated && encoding === 'utf-8') {
      let end = bytes.length;
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      bytes = bytes.subarray(0, end);
    } else if (encoding !== 'utf-8') {
      bytes = bytes.subarray(0, bytes.length - bytes.length % 2);
      if (truncated && bytes.length >= 2) {
        const last = encoding === 'utf-16le' ? bytes.readUInt16LE(bytes.length - 2) : bytes.readUInt16BE(bytes.length - 2);
        if (last >= 0xd800 && last <= 0xdbff) bytes = bytes.subarray(0, bytes.length - 2);
      }
    }
    let text: string | null = null;
    try {
      if (encoding === 'utf-8' && bytes.includes(0)) throw new Error('Binary content');
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      if (text.includes('\0')) text = null;
    } catch { /* Binary or unsupported text encoding: do not render replacement data as source. */ }
    return { path: relative, text, encoding: text === null ? null : encoding, binary: text === null, size: metadata.size, truncated };
  } finally { await handle.close(); }
}

export class RepositoryFiles {
  private contexts = new Map<string, RepositoryContext & { owner: number }>();
  private epochs = new Map<number, number>();

  async open(owner: number, payload: unknown): Promise<RepositoryContext> {
    const parsed = openRepositorySchema.safeParse(payload);
    if (!parsed.success || !path.isAbsolute(parsed.data.directory)) throw new HubError('INVALID_DIRECTORY', 'Choose an absolute local project directory.');
    const epoch = this.epochs.get(owner) ?? 0;
    try {
      const directory = await realpath(parsed.data.directory);
      if (!(await stat(directory)).isDirectory()) throw new Error('Not a directory');
      if (directory.split(path.sep).some((part) => part.toLowerCase() === '.git')) throw new HubError('INVALID_DIRECTORY', 'Choose the project working directory rather than Git metadata.');
      if ((this.epochs.get(owner) ?? 0) !== epoch) throw new HubError('STALE_REPOSITORY', 'The repository view closed before this request completed.');
      if ([...this.contexts.values()].filter((context) => context.owner === owner).length >= 8) throw new HubError('REPOSITORY_LIMIT', 'Close an existing repository view before opening another.');
      const context = { id: randomUUID(), directory, owner };
      this.contexts.set(context.id, context);
      return { id: context.id, directory };
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError('DIRECTORY_UNAVAILABLE', 'The project directory could not be opened. Check that it exists and is readable.');
    }
  }

  owned(owner: number, payload: unknown): RepositoryContext {
    const parsed = repositoryReferenceSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_REPOSITORY', 'Invalid repository reference.');
    const context = this.contexts.get(parsed.data.repositoryId);
    if (!context || context.owner !== owner) throw new HubError('STALE_REPOSITORY', 'This repository view is no longer available. Select the project again.');
    return { id: context.id, directory: context.directory };
  }

  close(owner: number, payload: unknown) {
    const context = this.owned(owner, payload);
    this.contexts.delete(context.id);
  }

  closeOwner(owner: number) {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    for (const [id, context] of this.contexts) if (context.owner === owner) this.contexts.delete(id);
  }

  private request(owner: number, payload: unknown) {
    const parsed = repositoryPathSchema.safeParse(payload);
    if (!parsed.success) throw new HubError('INVALID_PATH', 'Invalid project file request.');
    const context = this.owned(owner, { repositoryId: parsed.data.repositoryId });
    return { root: context.directory, relative: parsed.data.path };
  }

  async list(owner: number, payload: unknown): Promise<DirectoryListing> {
    const { root, relative } = this.request(owner, payload);
    try {
      const directory = await scopedPath(root, relative, true);
      const entries: DirectoryEntry[] = [];
      let limited = false;
      const stream = await opendir(directory);
      for await (const entry of stream) {
        if (entry.name.toLowerCase() === '.git') continue;
        if (entries.length >= DIRECTORY_ENTRY_LIMIT) { limited = true; break; }
        entries.push({ name: entry.name, path: relative ? `${relative}/${entry.name}` : entry.name,
          kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
      }
      entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
      return { path: relative, entries, limited };
    } catch (error) { if (error instanceof HubError) throw error; throw new HubError('DIRECTORY_UNAVAILABLE', 'This directory could not be read. Refresh if the project changed.'); }
  }

  async read(owner: number, payload: unknown): Promise<FilePreview> {
    const { root, relative } = this.request(owner, payload);
    try { return await readTextFile(root, relative); }
    catch (error) { if (error instanceof HubError) throw error; throw new HubError('FILE_UNAVAILABLE', 'This file could not be read. Refresh if it moved or was deleted.'); }
  }
}
