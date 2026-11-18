import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creating symbolic links needs Developer Mode or an elevated session on Windows; tests that need one are skipped without it. */
export const canSymlink = (() => { const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-link-')); try { fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link')); return true; } catch { return false; } finally { fs.rmSync(probe, { recursive: true, force: true }); } })();
