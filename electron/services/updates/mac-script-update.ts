import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DOWNLOADS_URL } from '../../../shared/updates';
import { HubError } from '../cli/engine-adapter';

/** Whether `candidate` (x.y.z) is newer than `current`: a Mac ahead of the feed (a test build) is never taken back. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parts = (version: string) => version.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
/**
 * A Mac release in the feed: its version, and the sha512 (base64, as electron-builder lists it) of each chip's disk
 * image. Every release publishes the disk images; update zips only some (1.21.0 and older made them only when signed).
 */
export interface MacRelease { version: string; sha512: { arm64?: string; x64?: string } }
/** Reads latest-mac.yml: the version and each disk image's sha512. */
export function parseMacFeed(text: string): MacRelease | null {
  const version = /^version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m.exec(text)?.[1]; if (!version) return null;
  const sha512: MacRelease['sha512'] = {}; let url = '';
  for (const line of text.split(/\r?\n/)) {
    const named = /^\s*-?\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line); if (named) { url = named[1]; continue; }
    // A line that is not indented ends the `files:` list (the top-level path/sha512 is the default file, not a chip's).
    if (/^\S/.test(line)) { url = ''; continue; }
    const sum = /^\s+sha512:\s*['"]?([A-Za-z0-9+/=]{80,100})['"]?\s*$/.exec(line);
    const arch = /-macOS-(arm64|x64)\.dmg$/.exec(url)?.[1] as 'arm64' | 'x64' | undefined;
    if (sum && arch && url === `Trace-${version}-macOS-${arch}.dmg`) sha512[arch] = sum[1];
  }
  return { version, sha512 };
}
/** The newest Mac release in the public feed's latest-mac.yml, or null when it cannot be read. */
export async function latestMacRelease(fetcher: typeof fetch = fetch): Promise<MacRelease | null> {
  try {
    const response = await fetcher(`${DOWNLOADS_URL}/download/latest-mac.yml`, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return response.ok ? parseMacFeed(await response.text()) : null;
  } catch { return null; }
}
/** The newest version in the public feed's latest-mac.yml, or null when it cannot be read. */
export async function latestMacVersion(fetcher: typeof fetch = fetch): Promise<string | null> { return (await latestMacRelease(fetcher))?.version ?? null; }

/**
 * Installs Trace `version` on a Mac that cannot update itself (a copy not signed with Trace's Developer ID). Everything
 * is downloaded and checked before Trace is touched: the release's disk image for this Mac's chip, whose sha512 must
 * match the feed's (`sha512`), so a damaged or replaced download is never installed. After the swap it waits until the
 * new Trace answers on its own port (`port`, which linked computers and phones reach it through); if it does not within
 * two minutes, the old app is put back and opened. It writes what it did to /tmp/trace-update.log.
 */
export function macUpdateScript(version: string, port: number, sha512: MacRelease['sha512']): string {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isInteger(port)) throw new Error('Invalid version or port.');
  const sum = (value: string | undefined) => value && /^[A-Za-z0-9+/=]{80,100}$/.test(value) ? value : '';
  return `#!/bin/bash
set -u
exec >>/tmp/trace-update.log 2>&1; echo "== $(date) updating to ${version}"
V=${version}; ARCH=x64; SHA='${sum(sha512.x64)}'; [ "$(uname -m)" = arm64 ] && { ARCH=arm64; SHA='${sum(sha512.arm64)}'; }
[ -n "$SHA" ] || { echo "the feed lists no checksum for this Mac's download; Trace left as it was"; exit 1; }
WORK=$(mktemp -d /tmp/trace-update.XXXXXX) || { echo "no work folder; Trace left as it was"; exit 1; }
DMG="$WORK/Trace-$V.dmg"; STAGE="$WORK/stage"; APP=/Applications/Trace.app; OLD="$WORK/Trace-previous.app"
answers() { for i in $(seq 1 120); do code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:${port}/api/hello); [ "$code" != "000" ] && return 0; sleep 1; done; return 1; }
restore() { echo "$1; restoring the previous version"; pkill -x Trace; sleep 2; rm -rf "$APP"; mv "$OLD" "$APP"; open -a "$APP"; exit 1; }
curl -fsSL -o "$DMG" "${DOWNLOADS_URL.replace('/latest', '')}/download/v$V/Trace-$V-macOS-$ARCH.dmg" || { echo "download failed; Trace left as it was"; exit 1; }
[ "$(openssl dgst -sha512 -binary "$DMG" | base64)" = "$SHA" ] || { echo "download does not match the feed's checksum; Trace left as it was"; exit 1; }
MNT=$(hdiutil attach -nobrowse -noautoopen -readonly "$DMG" | awk -F'\\t' '/\\/Volumes\\//{print $NF}')
[ -d "$MNT/Trace.app" ] || { echo "disk image did not mount; Trace left as it was"; exit 1; }
mkdir -p "$STAGE"; ditto "$MNT/Trace.app" "$STAGE/Trace.app"; hdiutil detach "$MNT" -quiet
[ -d "$STAGE/Trace.app" ] || { echo "the disk image holds no Trace.app; Trace left as it was"; exit 1; }
[ "$(defaults read "$STAGE/Trace.app/Contents/Info.plist" CFBundleShortVersionString)" = "$V" ] || { echo "staged app is not $V; Trace left as it was"; exit 1; }
osascript -e 'quit app "Trace"'
for i in $(seq 1 90); do pgrep -xq Trace || break; sleep 1; done
if pgrep -xq Trace; then echo "Trace did not quit (a dialog may be open); left as it was"; exit 1; fi
mv "$APP" "$OLD" || { echo "could not move the old app"; open -a "$APP"; exit 1; }
if ! mv "$STAGE/Trace.app" "$APP"; then echo "swap failed"; mv "$OLD" "$APP"; open -a "$APP"; exit 1; fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
open -a "$APP" || restore "the new app did not open"
answers || restore "the new app did not answer on port ${port} within two minutes"
rm -rf "$WORK"; echo "updated to $V"
`;
}

/**
 * Starts the script on its own, so it carries on when it quits Trace: written to Trace's storage folder and run
 * detached from Trace's process.
 */
export function startMacUpdate(storage: string, version: string, port: number, sha512: MacRelease['sha512']) {
  if (process.platform !== 'darwin') throw new HubError('UPDATES_DISABLED', 'Only a Mac installs updates this way.');
  const file = path.join(storage, 'trace-update.sh'); fs.writeFileSync(file, macUpdateScript(version, port, sha512), { mode: 0o700 });
  const child = spawn('/bin/bash', [file], { detached: true, stdio: 'ignore' }); child.unref();
}
