import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DesignPreview, DesignResponse, DesignSnapshot } from '../../../shared/design';
import { HubError } from '../cli/engine-adapter';
const snapshotSchema = z.object({ id: z.uuid(), designId: z.uuid(), version: z.number().int().min(1), title: z.string().trim().min(1).max(100), notes: z.string().max(4000), projectDirectory: z.string().max(4096).nullable(), createdAt: z.iso.datetime(), kind: z.enum(['html', 'image']), sourceName: z.string().max(255), mime: z.enum(['text/html', 'image/png', 'image/jpeg', 'image/webp']) }).strict();
const requestSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('list') }).strict(), z.object({ action: z.literal('read'), id: z.uuid() }).strict(), z.object({ action: z.literal('import'), title: snapshotSchema.shape.title, notes: snapshotSchema.shape.notes, projectDirectory: snapshotSchema.shape.projectDirectory, designId: z.uuid().optional() }).strict()]);
export class DesignArchive {
  private readonly root: string;
  constructor(storageRoot: string, private pickFile: () => Promise<string | null>, private validImage: (bytes: Buffer) => boolean) {
    if (!path.isAbsolute(storageRoot)) throw new HubError('DESIGN_STORAGE', 'Design storage requires an absolute directory.');
    this.root = path.join(storageRoot, 'designs');
  }
  private ensure() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(this.root).isDirectory() || fs.lstatSync(this.root).isSymbolicLink()) throw new HubError('DESIGN_STORAGE', 'The archive must be a local directory, not a link.');
  }
  private bounded(file: string, limit: number): Buffer {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > limit) throw new HubError('DESIGN_SIZE', 'Choose a regular HTML file up to 1 MiB or an image up to 8 MiB.');
      const buffer = Buffer.alloc(stat.size); let offset = 0;
      while (offset < buffer.length) { const size = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!size) throw new Error('File changed'); offset += size; }
      return buffer;
    } finally { fs.closeSync(fd); }
  }
  private record(id: string) { return snapshotSchema.parse(JSON.parse(this.bounded(path.join(this.root, id + '.json'), 16384).toString('utf8'))); }
  private summary(record: z.infer<typeof snapshotSchema>): DesignSnapshot { const { mime: _mime, ...snapshot } = record; return snapshot; }
  list(): DesignSnapshot[] {
    this.ensure();
    const files = fs.readdirSync(this.root).filter((file) => /^[0-9a-f-]{36}\.json$/i.test(file));
    if (files.length > 200) throw new HubError('DESIGN_LIMIT', 'This archive exceeds the 200-version limit. Existing files were preserved.');
    try { return files.map((file) => { const id = file.slice(0, -5); const record = this.record(id); if (record.id !== id) throw new Error('Invalid identity'); return this.summary(record); }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version); }
    catch { throw new HubError('DESIGN_STORAGE', 'Some archive metadata could not be read. Existing previews were preserved.'); }
  }
  private read(id: string): DesignPreview {
    if (!this.list().some((item) => item.id === id)) throw new HubError('DESIGN_NOT_FOUND', 'Select an available saved design version.');
    const record = this.record(id); const bytes = this.bounded(path.join(this.root, id + '.asset'), record.kind === 'html' ? 1048576 : 8388608);
    return { snapshot: this.summary(record), content: record.kind === 'html' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('base64'), mime: record.mime };
  }
  async execute(input: unknown): Promise<DesignResponse> {
    const parsed = requestSchema.safeParse(input); if (!parsed.success) throw new HubError('INVALID_DESIGN_REQUEST', 'Invalid design archive request.');
    const request = parsed.data;
    if (request.action === 'list') return this.list();
    if (request.action === 'read') return this.read(request.id);
    const before = this.list();
    if (before.length >= 200) throw new HubError('DESIGN_LIMIT', 'Up to 200 saved design versions are supported.');
    if (request.designId && !before.some((item) => item.designId === request.designId)) throw new HubError('DESIGN_NOT_FOUND', 'The design selected for a new version is unavailable.');
    if (request.projectDirectory && (!path.isAbsolute(request.projectDirectory) || request.projectDirectory.includes('\0'))) throw new HubError('INVALID_DIRECTORY', 'Choose an absolute project directory.');
    const file = await this.pickFile(); if (!file) return null;
    const extension = path.extname(file).toLowerCase(); const html = ['.html', '.htm'].includes(extension);
    if (!html && !['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw new HubError('DESIGN_FORMAT', 'Import a self-contained HTML file or PNG, JPEG, or WebP screenshot.');
    const bytes = this.bounded(file, html ? 1048576 : 8388608);
    let mime: z.infer<typeof snapshotSchema>['mime'] = 'text/html';
    if (html) { try { if (new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')) throw new Error(); } catch { throw new HubError('DESIGN_FORMAT', 'The HTML file must contain valid UTF-8 text.'); } }
    else {
      if (!this.validImage(bytes)) throw new HubError('DESIGN_FORMAT', 'The selected image could not be decoded or is too large.');
      if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
      else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
      else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
      else throw new HubError('DESIGN_FORMAT', 'Only PNG, JPEG, and WebP images are supported.');
    }
    // Recheck after the OS dialog, because another import may have completed.
    const existing = this.list(); if (existing.length >= 200) throw new HubError('DESIGN_LIMIT', 'Up to 200 saved design versions are supported.');
    const designId = request.designId ?? randomUUID(); const id = randomUUID();
    const record = { id, designId, version: Math.max(0, ...existing.filter((item) => item.designId === designId).map((item) => item.version)) + 1, title: request.title, notes: request.notes, projectDirectory: request.projectDirectory, createdAt: new Date().toISOString(), kind: html ? 'html' as const : 'image' as const, sourceName: path.basename(file), mime };
    const asset = path.join(this.root, id + '.asset'); const metadata = path.join(this.root, id + '.json');
    try { fs.writeFileSync(asset, bytes, { flag: 'wx', mode: 0o600 }); fs.writeFileSync(metadata, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (fs.existsSync(asset)) fs.unlinkSync(asset); if (fs.existsSync(metadata)) fs.unlinkSync(metadata); throw error; }
    return this.read(id);
  }
}
