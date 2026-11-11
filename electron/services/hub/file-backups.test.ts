import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupFolder, KEEP_BACKUPS, keepBackup, ORIGINAL_NOTE } from './file-backups';
import { updateConfig } from './config';

describe('backups of files Trace edits', () => {
  it('keeps them in Trace’s data, one folder per file, never beside the file', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-project-')); const file = path.join(project, '.mcp.json');
    fs.writeFileSync(file, '{"mcpServers":{}}\n');
    updateConfig(file, null, (data) => { data.mcpServers.one = { command: 'x' }; });
    expect(fs.readdirSync(project)).toEqual(['.mcp.json']);
    const folder = backupFolder(file); const copies = fs.readdirSync(folder).filter((name) => name !== ORIGINAL_NOTE);
    expect(copies).toHaveLength(1); expect(fs.readFileSync(path.join(folder, copies[0]), 'utf8')).toBe('{"mcpServers":{}}\n');
    expect(fs.readFileSync(path.join(folder, ORIGINAL_NOTE), 'utf8').trim()).toBe(path.resolve(file));
    // The same name in another project is another folder.
    expect(backupFolder(path.join(project, 'other', '.mcp.json'))).not.toBe(folder); expect(path.basename(folder)).toMatch(/_\.mcp\.json-[0-9a-f]{12}$/);
  });
  it('keeps the newest copies only', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backup-many-')), 'CLAUDE.md');
    for (let i = 0; i < KEEP_BACKUPS + 5; i++) keepBackup(file, `version ${i}`);
    const folder = backupFolder(file); const copies = fs.readdirSync(folder).filter((name) => name !== ORIGINAL_NOTE).sort();
    expect(copies).toHaveLength(KEEP_BACKUPS); expect(fs.readFileSync(path.join(folder, copies.at(-1)!), 'utf8')).toBe(`version ${KEEP_BACKUPS + 4}`);
    expect(copies.map((name) => fs.readFileSync(path.join(folder, name), 'utf8'))).not.toContain('version 0');
  });
});
