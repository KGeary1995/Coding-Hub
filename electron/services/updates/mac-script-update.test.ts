import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestMacVersion, macUpdateScript } from './mac-script-update';

describe('updating a Mac that cannot update itself', () => {
  it('writes a script that is valid bash, checks before it swaps, and puts the old version back if the new one does not answer', () => {
    const script = macUpdateScript('1.15.0', 47821);
    expect(script).toContain('https://github.com/KGeary1995/trace-releases/releases/download/v$V/Trace-$V-macOS-$ARCH.dmg');
    expect(script).toContain('http://127.0.0.1:47821/api/hello'); expect(script).toContain('restore "the new app did not answer');
    // The download, mount and version check all come before Trace is quit.
    expect(script.indexOf('CFBundleShortVersionString')).toBeLessThan(script.indexOf("quit app \"Trace\""));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mac-')), 'update.sh'); fs.writeFileSync(file, script);
    try { execFileSync('bash', ['-n', file]); } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
    expect(() => macUpdateScript('1.15.0; rm -rf /', 47821)).toThrow();
  });
  it('reads the latest version from the Mac update feed', async () => {
    const feed = async () => new Response("version: 1.15.0\nfiles:\n  - url: Trace-1.15.0-macOS-arm64.dmg\n");
    expect(await latestMacVersion(feed as typeof fetch)).toBe('1.15.0');
    expect(await latestMacVersion((async () => new Response('', { status: 404 })) as typeof fetch)).toBeNull();
  });
});
