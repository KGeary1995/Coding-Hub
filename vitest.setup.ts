import fs from 'node:fs';
import os from 'node:os';

// macOS reaches its temp folder through a symlink (/var -> /private/var). The services resolve or refuse symlinked
// paths, so tests compare against the real path: point TMPDIR (read by os.tmpdir() on every call) at it.
if (process.platform !== 'win32') process.env.TMPDIR = fs.realpathSync(os.tmpdir());
