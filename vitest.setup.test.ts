import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupRoot } from './electron/services/hub/file-backups';

describe('test setup', () => {
  // One shared folder that nothing removed grew by every run (13,000 files on one computer).
  it('gives each test file its own backup folder in the temp folder', () => {
    const folder = path.dirname(backupRoot());
    expect(path.dirname(folder)).toBe(os.tmpdir());
    expect(path.basename(folder)).toMatch(/^trace-test-backups-.+/);
  });
  // afterAll does not run for a file whose tests are all skipped, so a folder made up front would be left behind.
  it('creates the backup folder only when a test makes a backup', () => {
    expect(fs.existsSync(path.dirname(backupRoot()))).toBe(false);
  });
});
