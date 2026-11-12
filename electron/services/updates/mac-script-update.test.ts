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

describe('a copy from the disk image that fails part way', () => {
  // Runs the script itself in bash: the download and checksum pass, the disk image mounts, and ditto copies only
  // Info.plist (naming the right version) before it fails. The Mac tools are shell functions put at the top of the
  // script, which bash prefers to any program whatever PATH holds (Git Bash's own wrapper puts its curl first).
  // A bash that runs scripts as macOS would: on Windows Git Bash at its own path (the first `bash` on PATH can be
  // WSL's, which cannot see Windows folders), elsewhere the system's. None found: skipped.
  const bash = (() => {
    const candidate = process.platform === 'win32' ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((root) => path.join(root!, 'Git', 'bin', 'bash.exe')).find((file) => fs.existsSync(file)) : 'bash';
    if (!candidate) return null;
    try { execFileSync(candidate, ['--version']); return candidate; } catch { return null; }
  })();
  it.skipIf(!bash)('never reaches the point where Trace is quit and replaced, and detaches the disk image', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mac-run-')); const mount = path.join(root, 'volume'); const marks = path.join(root, 'marks');
    fs.mkdirSync(path.join(mount, 'Trace.app', 'Contents', 'MacOS'), { recursive: true }); fs.mkdirSync(marks);
    const posix = (file: string) => file.replace(/\\/g, '/'); const log = path.join(root, 'update.log'); const script = path.join(root, 'update.sh');
    const tools = [
      'uname() { echo arm64; }',
      'curl() { while [ $# -gt 0 ]; do [ "$1" = -o ] && echo image > "$2"; shift; done; return 0; }',
      'openssl() { echo digest; }',
      `base64() { cat >/dev/null; echo '${ARM}'; }`,
      `hdiutil() { if [ "$1" = attach ]; then printf '/dev/disk9\\tApple_HFS\\t%s\\n' '${posix(mount)}'; else touch '${posix(marks)}/detached'; fi; }`,
      'ditto() { mkdir -p "$2/Contents"; echo plist > "$2/Contents/Info.plist"; return 1; }',
      'defaults() { echo 1.21.1; }',
      ...['osascript', 'pkill', 'open', 'xattr'].map((name) => `${name}() { touch '${posix(marks)}/${name}'; }`),
    ].join('\n');
    // The stand-in's mount point is the test folder, not /Volumes/, and the script's own log goes there too, so a
    // failure shows where the script stopped.
    const text = macUpdateScript('1.21.1', 47821, { arm64: ARM, x64: INTEL })
      .replace("'/\\/Volumes\\//{print $NF}'", "'{print $NF}'").replace('exec >>/tmp/trace-update.log', `exec >>'${posix(log)}'`)
      .replace('set -u\n', `set -u\n${tools}\n`);
    fs.writeFileSync(script, text);
    try {
      let failed = false;
      try { execFileSync(bash!, [script], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { failed = true; }
      const said = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(no log)';
      // It stopped at the copy, with the reason: not earlier (which would not test the copy) and not later.
      expect(said).toContain('could not copy Trace.app from the disk image; Trace left as it was');
      expect(failed).toBe(true);
      expect(fs.existsSync(path.join(marks, 'detached')), said).toBe(true);
      // Trace was never asked to quit, so nothing was moved or replaced.
      for (const name of ['osascript', 'pkill', 'open', 'xattr']) expect(fs.existsSync(path.join(marks, name)), said).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
