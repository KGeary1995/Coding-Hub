import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { HandoffImport, inlineStylesheets, readZip } from './handoff';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-handoff-'))); roots.push(root); return root; };

/** Minimal ZIP writer for fixtures: deflated entries, optional symbolic-link mode. */
function zip(entries: { name: string; data?: string; link?: boolean }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data ?? ''); const body = deflateRawSync(raw); const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.link ? 0o120777 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name); offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('Claude Design handoff bundles', () => {
  it('reads deflated ZIP entries, skips links and rejects paths that escape the bundle', () => {
    const root = temp(); const file = path.join(root, 'bundle.zip');
    fs.writeFileSync(file, zip([{ name: 'site/index.html', data: '<h1>Hi</h1>' }, { name: 'site/link', data: '/etc/passwd', link: true }]));
    expect(readZip(file)).toEqual([{ path: 'site/index.html', data: Buffer.from('<h1>Hi</h1>') }]);
    for (const name of ['../evil.txt', '/abs.txt', 'C:/win.txt', 'a/.git/config']) { fs.writeFileSync(file, zip([{ name, data: 'x' }])); expect(() => readZip(file)).toThrow(/unsafe path/); }
    fs.writeFileSync(file, 'not a zip'); expect(() => readZip(file)).toThrow(/not a readable ZIP/);
  });
  it('inlines only the bundle\'s own stylesheets', () => {
    const files = new Map([['css/app.css', Buffer.from('h1{color:red}')]]);
    const html = inlineStylesheets('<link rel="stylesheet" href="css/app.css"><link rel="stylesheet" href="https://cdn.example/x.css">', 'index.html', files);
    expect(html).toContain('<style>h1{color:red}</style>'); expect(html).toContain('https://cdn.example/x.css');
  });
  it('copies a bundle into a new project folder, saves its preview and never overwrites an earlier import', async () => {
    const root = temp(); const project = path.join(root, 'project'); fs.mkdirSync(project); const file = path.join(root, 'Checkout Flow.zip');
    fs.writeFileSync(file, zip([{ name: 'checkout/README.md', data: 'Build with React' }, { name: 'checkout/index.html', data: '<link rel="stylesheet" href="style.css"><main>Pay</main>' }, { name: 'checkout/style.css', data: 'main{padding:4px}' }]));
    const saved: string[] = [];
    const service = new HandoffImport(path.join(root, 'scratch'), async () => file, async (title, _notes, directory, preview) => { saved.push(fs.readFileSync(preview, 'utf8')); expect(directory).toBe(project); return { id: 'snapshot', title } as never; });
    const first = await service.execute({ action: 'handoff-import', source: 'zip', projectDirectory: project });
    expect(first).toMatchObject({ relative: 'design-handoff/checkout-flow', readme: 'design-handoff/checkout-flow/README.md', files: 3, warning: null });
    expect(fs.readFileSync(path.join(project, 'design-handoff', 'checkout-flow', 'index.html'), 'utf8')).toContain('<main>Pay</main>');
    expect(saved[0]).toContain('<style>main{padding:4px}</style>'); expect(fs.readdirSync(path.join(root, 'scratch'))).toEqual([]);
    const second = await service.execute({ action: 'handoff-import', source: 'zip', projectDirectory: project });
    expect(second?.relative).toBe('design-handoff/checkout-flow-2');
    await expect(service.execute({ action: 'handoff-import', source: 'zip', projectDirectory: path.join(root, 'missing') })).rejects.toMatchObject({ code: 'INVALID_DIRECTORY' });
  });
  it('imports an extracted folder and keeps the copy when the preview cannot be archived', async () => {
    const root = temp(); const project = path.join(root, 'project'); fs.mkdirSync(project); const bundle = path.join(root, 'bundle'); fs.mkdirSync(path.join(bundle, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'shots', 'home.png'), 'png'); fs.mkdirSync(path.join(bundle, '.git')); fs.writeFileSync(path.join(bundle, '.git', 'config'), 'secret');
    const service = new HandoffImport(path.join(root, 'scratch'), async () => bundle, async () => { throw new Error('Archive full'); });
    const result = await service.execute({ action: 'handoff-import', source: 'folder', projectDirectory: project });
    expect(result?.snapshot).toBeNull(); expect(result?.warning).toContain('Archive full'); expect(result?.files).toBe(1);
    expect(fs.existsSync(path.join(project, 'design-handoff', 'bundle', '.git'))).toBe(false);
  });
});
