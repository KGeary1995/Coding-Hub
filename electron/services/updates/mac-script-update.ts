import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DOWNLOADS_URL } from '../../../shared/updates';
import { HubError } from '../cli/engine-adapter';

/** The newest version in the public feed's latest-mac.yml, or null when it cannot be read. */
export async function latestMacVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`${DOWNLOADS_URL}/download/latest-mac.yml`, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    return /^version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m.exec(await response.text())?.[1] ?? null;
  } catch { return null; }
}

/**
 * Installs Trace `version` on a Mac that cannot update itself (a copy not signed with Trace's Developer ID). Everything
 * is downloaded and checked before Trace is touched. After the swap it waits until the new Trace answers on its own
 * port (`port`, which linked computers and phones reach it through); if it does not within two minutes, the old app
 * is put back and opened. It writes what it did to /tmp/trace-update.log.
 */
export function macUpdateScript(version: string, port: number): string {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isInteger(port)) throw new Error('Invalid version or port.');
  return `#!/bin/bash
set -u
exec >>/tmp/trace-update.log 2>&1; echo "== $(date) updating to ${version}"
V=${version}; ARCH=x64; [ "$(uname -m)" = arm64 ] && ARCH=arm64
DMG=/tmp/Trace-$V.dmg; STAGE=/tmp/trace-stage; APP=/Applications/Trace.app; OLD=/tmp/Trace-previous.app
answers() { for i in $(seq 1 120); do code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:${port}/api/hello); [ "$code" != "000" ] && return 0; sleep 1; done; return 1; }
restore() { echo "$1; restoring the previous version"; pkill -x Trace; sleep 2; rm -rf "$APP"; mv "$OLD" "$APP"; open -a "$APP"; exit 1; }
curl -fsSL -o "$DMG" "${DOWNLOADS_URL.replace('/latest', '')}/download/v$V/Trace-$V-macOS-$ARCH.dmg" || { echo "download failed; Trace left as it was"; exit 1; }
MNT=$(hdiutil attach -nobrowse -noautoopen -readonly "$DMG" | awk -F'\\t' '/\\/Volumes\\//{print $NF}')
[ -d "$MNT/Trace.app" ] || { echo "disk image did not mount; Trace left as it was"; exit 1; }
rm -rf "$STAGE"; mkdir -p "$STAGE"; ditto "$MNT/Trace.app" "$STAGE/Trace.app"; hdiutil detach "$MNT" -quiet
[ "$(defaults read "$STAGE/Trace.app/Contents/Info.plist" CFBundleShortVersionString)" = "$V" ] || { echo "staged app is not $V; Trace left as it was"; exit 1; }
osascript -e 'quit app "Trace"'
for i in $(seq 1 90); do pgrep -xq Trace || break; sleep 1; done
if pgrep -xq Trace; then echo "Trace did not quit (a dialog may be open); left as it was"; exit 1; fi
rm -rf "$OLD"; mv "$APP" "$OLD" || { echo "could not move the old app"; open -a "$APP"; exit 1; }
if ! mv "$STAGE/Trace.app" "$APP"; then echo "swap failed"; mv "$OLD" "$APP"; open -a "$APP"; exit 1; fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
open -a "$APP" || restore "the new app did not open"
answers || restore "the new app did not answer on port ${port} within two minutes"
rm -f "$DMG"; echo "updated to $V"
`;
}

/**
 * Starts the script on its own, so it carries on when it quits Trace: written to Trace's storage folder and run
 * detached from Trace's process.
 */
export function startMacUpdate(storage: string, version: string, port: number) {
  if (process.platform !== 'darwin') throw new HubError('UPDATES_DISABLED', 'Only a Mac installs updates this way.');
  const file = path.join(storage, 'trace-update.sh'); fs.writeFileSync(file, macUpdateScript(version, port), { mode: 0o700 });
  const child = spawn('/bin/bash', [file], { detached: true, stdio: 'ignore' }); child.unref();
}
