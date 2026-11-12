import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNewerVersion, latestMacRelease, latestMacVersion, macUpdateScript, parseMacFeed } from './mac-script-update';

const ARM = 'A'.repeat(86) + '=='; const INTEL = 'B'.repeat(86) + '==';
describe('updating a Mac that cannot update itself', () => {
  it('writes a script that is valid bash, checks the download against the feed before it swaps, and puts the old version back if the new one does not answer', () => {
    const script = macUpdateScript('1.15.0', 47821, { arm64: ARM, x64: INTEL });
    expect(script).toContain('https://github.com/KGeary1995/trace-releases/releases/download/v$V/Trace-$V-macOS-$ARCH.dmg');
    expect(script).toContain(`SHA='${INTEL}'`); expect(script).toContain(`SHA='${ARM}'`);
    expect(script).toContain('openssl dgst -sha512 -binary "$DMG" | base64)" = "$SHA"');
    expect(script).toContain('http://127.0.0.1:47821/api/hello'); expect(script).toContain('restore "the new app did not answer');
    // The download, checksum, mounting and version check all come before Trace is quit.
    expect(script.indexOf('openssl dgst')).toBeLessThan(script.indexOf('hdiutil attach'));
    expect(script.indexOf('CFBundleShortVersionString')).toBeLessThan(script.indexOf("quit app \"Trace\""));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mac-')), 'update.sh'); fs.writeFileSync(file, script);
    try { execFileSync('bash', ['-n', file]); } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
    expect(() => macUpdateScript('1.15.0; rm -rf /', 47821, {})).toThrow();
    // A checksum that is not one (an injection attempt) is left out, and the script then stops before anything.
    expect(macUpdateScript('1.15.0', 47821, { x64: "x'; rm -rf / #" })).toContain("SHA=''");
  });
  it('reads the latest version and each chip’s disk image checksum from the Mac update feed, with or without update zips', async () => {
    // As 1.21.0 published it (an unsigned build): disk images only.
    const dmgOnly = `version: 1.21.0\nfiles:\n  - url: Trace-1.21.0-macOS-x64.dmg\n    sha512: ${INTEL}\n    size: 1\n  - url: Trace-1.21.0-macOS-arm64.dmg\n    sha512: ${ARM}\n    size: 2\npath: Trace-1.21.0-macOS-x64.dmg\nsha512: ${INTEL}\n`;
    expect(parseMacFeed(dmgOnly)).toEqual({ version: '1.21.0', sha512: { arm64: ARM, x64: INTEL } });
    // With update zips listed first (a signed build, and every build from 1.21.1): still the disk images' checksums.
    const yml = `version: 1.15.0\nfiles:\n  - url: Trace-1.15.0-macOS-arm64.zip\n    sha512: ${INTEL}\n    size: 1\n  - url: Trace-1.15.0-macOS-arm64.dmg\n    sha512: ${ARM}\n  - url: Trace-1.15.0-macOS-x64.zip\n    sha512: ${ARM}\n  - url: Trace-1.15.0-macOS-x64.dmg\n    sha512: ${INTEL}\npath: Trace-1.15.0-macOS-arm64.zip\nsha512: ${INTEL}\n`;
    expect(parseMacFeed(yml)).toEqual({ version: '1.15.0', sha512: { arm64: ARM, x64: INTEL } });
    const feed = async () => new Response(yml);
    expect(await latestMacVersion(feed as typeof fetch)).toBe('1.15.0');
    expect(await latestMacRelease((async () => new Response('', { status: 404 })) as typeof fetch)).toBeNull();
    // An older release's disk image in the list is not taken for this version's.
    expect(parseMacFeed('version: 1.16.0\nfiles:\n  - url: Trace-1.15.0-macOS-x64.dmg\n    sha512: ' + INTEL + '\n')).toEqual({ version: '1.16.0', sha512: {} });
  });
});

describe('which version a Mac is updated to', () => {
  it('only a newer one: a Mac ahead of the downloads page is never taken back', () => {
    expect(isNewerVersion('1.21.0', '1.20.0')).toBe(true); expect(isNewerVersion('1.20.10', '1.20.9')).toBe(true); expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.20.0', '1.20.0')).toBe(false); expect(isNewerVersion('1.20.0', '1.21.0')).toBe(false); expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
  });
});
