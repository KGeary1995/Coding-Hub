import fs from 'node:fs';
import os from 'node:os';
import { setBackupRoot } from './electron/services/hub/file-backups';

// macOS reaches its temp folder through a symlink (/var -> /private/var). The services resolve or refuse symlinked
// paths, so tests compare against the real path: point TMPDIR (read by os.tmpdir() on every call) at it.
if (process.platform !== 'win32') process.env.TMPDIR = fs.realpathSync(os.tmpdir());

// Backups of edited configuration go to Trace's data folder (file-backups.ts): a scratch one in tests, never the real one.
setBackupRoot(`${os.tmpdir()}/trace-test-backups`);
