import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { HandoffImport, readZip } from './handoff';

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
  it('copies a bundle into a new project folder and never overwrites an earlier import', async () => {
    const root = temp(); const project = path.join(root, 'project'); fs.mkdirSync(project); const file = path.join(root, 'Checkout Flow.zip');
    fs.writeFileSync(file, zip([{ name: 'checkout/README.md', data: 'Build with React' }, { name: 'checkout/index.html', data: '<link rel="stylesheet" href="style.css"><main>Pay</main>' }, { name: 'checkout/style.css', data: 'main{padding:4px}' }]));
    const service = new HandoffImport(async () => file);
    const first = await service.execute({ action: 'handoff-import', source: 'zip', projectDirectory: project });
    expect(first).toEqual({ directory: path.join(project, 'design-handoff', 'checkout-flow'), relative: 'design-handoff/checkout-flow', readme: 'design-handoff/checkout-flow/README.md', files: 3 });
    expect(fs.readFileSync(path.join(project, 'design-handoff', 'checkout-flow', 'index.html'), 'utf8')).toContain('<main>Pay</main>');
    const second = await service.execute({ action: 'handoff-import', source: 'zip', projectDirectory: project });
    expect(second?.relative).toBe('design-handoff/checkout-flow-2');
    await expect(service.execute({ action: 'handoff-import', source: 'zip', projectDirectory: path.join(root, 'missing') })).rejects.toMatchObject({ code: 'INVALID_DIRECTORY' });
  });
  it('imports an extracted folder without its Git metadata', async () => {
    const root = temp(); const project = path.join(root, 'project'); fs.mkdirSync(project); const bundle = path.join(root, 'bundle'); fs.mkdirSync(path.join(bundle, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'shots', 'home.png'), 'png'); fs.mkdirSync(path.join(bundle, '.git')); fs.writeFileSync(path.join(bundle, '.git', 'config'), 'secret');
    const service = new HandoffImport(async () => bundle);
    const result = await service.execute({ action: 'handoff-import', source: 'folder', projectDirectory: project });
    expect(result?.files).toBe(1); expect(result?.readme).toBeNull();
    expect(fs.existsSync(path.join(project, 'design-handoff', 'bundle', '.git'))).toBe(false);
  });
});
