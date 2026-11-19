import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { setBackupRoot } from './electron/services/hub/file-backups';

// macOS reaches its temp folder through a symlink (/var -> /private/var). The services resolve or refuse symlinked
// paths, so tests compare against the real path: point TMPDIR (read by os.tmpdir() on every call) at it.
if (process.platform !== 'win32') process.env.TMPDIR = fs.realpathSync(os.tmpdir());
// Windows runners' temp path holds an 8.3 short name (C:\Users\RUNNER~1) that the services expand: use the long form.
else process.env.TEMP = process.env.TMP = fs.realpathSync.native(os.tmpdir());
// No Drive folder for a hub without saved preferences (defaultDriveDirectory): on Windows it would be the person's real
// G:\My Drive\Coding Hub. A test that syncs saves a temporary folder of its own.
process.env.CODING_HUB_DEFAULT_DRIVE_DIR = '';
// Gemini CLI's conversations (gemini-conversations.ts) are looked for in a folder that does not exist, never the person's.
process.env.CODING_HUB_GEMINI_HOME = path.join(os.tmpdir(), `trace-test-no-gemini-${randomUUID()}`);

// Backups of edited configuration go to Trace's data folder (file-backups.ts): a scratch one for each test file, never
// the real one, removed when the file's tests end so test runs do not pile up copies in the temp folder. It is only
// named here: keepBackup creates it on the first backup, because afterAll never runs for a file whose tests are all
// skipped or that fails to load, and a folder made up front would be left behind.
const backups = path.join(os.tmpdir(), `trace-test-backups-${randomUUID()}`);
setBackupRoot(backups);
afterAll(() => { try { fs.rmSync(backups, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Left for the temp folder's own cleanup. */ } });
