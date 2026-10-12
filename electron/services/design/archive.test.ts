import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesignArchive } from './archive';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-design-')); roots.push(root); const file = path.join(root, 'preview.html'); fs.writeFileSync(file, '<h1>First</h1>'); return { root, file, archive: new DesignArchive(root, async () => file, () => true) }; }
describe('local immutable design versions', () => {
  it('preserves old assets when the source changes and restores versions from disk', async () => {
    const { root, file, archive } = fixture(); const first = await archive.execute({ action: 'import', title: 'Home', notes: 'First draft', projectDirectory: null }) as any;
    fs.writeFileSync(file, '<h1>Second</h1>'); const next = await archive.execute({ action: 'import', title: 'Home', notes: 'Second draft', projectDirectory: null, designId: first.snapshot.designId }) as any;
    expect(next.snapshot.version).toBe(2); expect((await archive.execute({ action: 'read', id: first.snapshot.id }) as any).content).toContain('First');
    expect(new DesignArchive(root, async () => null, () => true).list()).toHaveLength(2);
  });
  it('rejects forged paths, binary HTML, and oversized files without adding a snapshot', async () => {
    const { archive, file } = fixture(); await expect(archive.execute({ action: 'read', id: '../escape' })).rejects.toMatchObject({ code: 'INVALID_DESIGN_REQUEST' });
    fs.writeFileSync(file, Buffer.from([0, 1, 2])); await expect(archive.execute({ action: 'import', title: 'Bad', notes: '', projectDirectory: null })).rejects.toMatchObject({ code: 'DESIGN_FORMAT' });
    fs.writeFileSync(file, Buffer.alloc(1048577)); await expect(archive.execute({ action: 'import', title: 'Big', notes: '', projectDirectory: null })).rejects.toMatchObject({ code: 'DESIGN_SIZE' }); expect(archive.list()).toEqual([]);
  });
});
