# Windows and Mac installation and releases

## Build a candidate

On a Windows desktop with Node >=22.13 installed, run `npm ci`, then `npm run dist:win`. Build candidates on Windows using the **Windows release candidate** GitHub Actions workflow too. It runs on pushes to main, on pull requests that are ready for review (drafts are skipped), and by manual dispatch. The workflow executes unit/release tests, production desktop smoke tests using fixture CLIs, package verification, and an isolated installed-app upgrade/uninstall test. It uploads artifacts without creating tags or publishing releases; publishing is the separate tag-driven **Release** workflow below.

Each attempt packages into a unique `release/.build-<id>/` staging folder. The previous `win-unpacked` is never renamed or deleted, so a running older unpacked app cannot lock the new build. Once verified, artifacts are promoted to `release/`, with metadata last. `last-build.json` identifies the verified staging directory for `npm run verify:win`. If an installer EXE itself is open and locked, close it and retry; its staged candidate remains available. Old staging folders can be manually archived after closing apps that use them.

Outputs in `release/`:

- `Trace-<version>-Windows-x64-Setup.exe`: per-user installer, adjustable install directory, shortcuts, uninstaller.
- `Trace-<version>-Windows-x64-Setup.exe.blockmap`: differential update data.
- `Trace-<version>-Windows-x64-Portable.exe`: optional manual-update edition.
- `latest.yml`: stable update metadata with SHA-512 integrity hashes.

`npm run verify:win` validates installer hashes, metadata version/provider, Windows PE architecture, node-pty helper binaries, renderer assets, host/preload, and packaged updater dependencies. It does not execute the installer. Linux cross-packaging needs a functioning Wine runtime as well as verified electron-builder helper downloads. Cross-packaging under Wine has failed while extracting the generated uninstaller, so build release candidates with the Windows workflow or on native Windows. This limitation does not affect source builds.

Install the Setup edition without elevating privileges. Source installations can continue to use npm. Source, installed, and portable editions share the default local storage directory `~/.coding-hub`; the app's single-instance lock protects simultaneous use.

## Signing

Unsigned builds are suitable for local review but may trigger Windows trust prompts. For distributed releases, configure a Windows Authenticode certificate using electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables. The workflow reads the optional `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` GitHub secrets. Put credentials in secure settings, never source or chat.

When CSC_LINK is present, executable signing and forceCodeSigning are enabled: signing failures fail the build. electron-builder supplies the certificate publisher metadata for electron-updater's default Windows verification. Retain the same publisher identity for future upgrades. TLS validation and updater checksum validation are never disabled. Unsigned local builds do not establish a trusted publisher identity; metadata hashes alone do not authenticate a release publisher.

## Publish a release

Installers are published on the public repository **KGeary1995/trace-releases**, which holds only release files; the source repository stays private. Installed Windows copies read `latest.yml` there without credentials (the feed is fixed in `electron-builder.cjs` and checked by `verify-windows-package.cjs`). Never embed a GitHub token in the app.

One-time setup:

1. Create the public repository `KGeary1995/trace-releases` with a README (a release needs at least one commit).
2. Create a fine-grained personal access token limited to that repository, with **Contents: Read and write**.
3. In this repository, add it as the Actions secret `RELEASES_TOKEN`.

Each release:

1. Bump the version: `npm version <x.y.z> --no-git-tag-version` (updates package.json and package-lock.json together), and update `docs/RELEASE_NOTES.md`.
2. Merge to main and let **Windows release candidate** pass on that commit (it runs the Windows smoke tests and the installer upgrade/uninstall test). **Release does not check this for you**: its Windows job runs only `npm test` and the package build, so this gate is the only place the Windows smoke and install tests run before publishing. Windows runners are slow; a single timeout in a heavy test can be retried with `gh run rerun <id> --failed` (see [troubleshooting](troubleshooting.md)).
3. Push the tag `v<x.y.z>` on that commit, or run **Release** by hand on main with **Publish** ticked (it then uses `v<package.json version>`). The workflow checks the tag matches package.json, builds the Windows Setup/Portable executables and the Mac disk images, starts a CLI in the packaged Mac app, and publishes everything on trace-releases with `docs/RELEASE_NOTES.md` as the description. A version that is already published is never replaced.

Running **Release** by hand without **Publish** builds and tests only. Asset names and bytes must not change after publishing: `latest.yml` refers to them by name and SHA-512.

## Mac disk images

`npm run dist:mac` (on a Mac) builds `Trace-<version>-macOS-arm64.dmg` (Apple silicon) and `…-macOS-x64.dmg` (Intel) into `release/mac` and checks each app: renderer, phone app, the node-pty binding for its processor, and an executable `spawn-helper` (without it no terminal starts). `npm run test:packaged -- "release/mac/mac-arm64/Trace.app/Contents/MacOS/Trace"` then starts a fixture CLI in the packaged app (the Intel app is at `release/mac/mac/Trace.app`; the Release workflow smoke-tests only the arm64 app). The output folder is deleted and rebuilt on every run; `TRACE_MAC_OUTPUT` overrides it.

Published apps are ad-hoc signed, because the Release workflow supplies no Apple credentials. macOS therefore blocks the first launch; **System Settings → Privacy & Security → Open Anyway** allows it once. A Developer ID ($99/year Apple Developer Program) plus notarization would remove that step and is also what in-app updates on macOS require; until then the Mac edition is updated from the downloads page (Settings → Application updates → Open downloads page). Local builds can be Developer ID signed and notarized: set `MAC_SIGNING_IDENTITY` (hardened runtime with `assets/entitlements.mac.plist`), plus `APPLE_KEYCHAIN_PROFILE`, `APPLE_API_KEY` or `APPLE_ID` to notarize; the build then checks the result with `stapler` and `spctl` (see the README). Opened from Finder, the app reads the login shell's PATH so it finds CLIs installed through Homebrew, nvm, Volta or a shell profile.

## Update behavior and validation

Installed Windows editions check 30 seconds after startup and every four hours; the preference is saved locally in `updates.json`. Settings can disable automatic checks or run a manual check. Downloads are explicit, include progress, and retain updater integrity verification. Installation always requires a restart confirmation, no active or pending CLI launches, and a successful workspace flush. Normal exit never installs a downloaded update. Failed install startup unlocks CLI launch again.

Test a real upgrade with two signed stable release versions on native Windows: install the earlier version, populate settings/history/rules, discover and download the newer version, verify active-session blocking and cancel, then restart/install and verify data. Also test a disconnected network, missing feed assets, checksum failure, and publisher mismatch. Unit tests exercise these state transitions with a fake updater; the Linux desktop smoke validates the real bridge and disabled source-edition UI. Those checks do not claim a real published-feed upgrade was performed.

## Native installation test

The workflow builds the candidate and a baseline package labelled 1.2.0 from the same source. The baseline is built with `TRACE_LEGACY_PRODUCT_NAME=1`, so it installs as **AI Coding Hub** like every install from before 1.11, and `test:install` looks for it under that name (`AI-Coding-Hub-<version>-Windows-x64-Setup.exe`). `npm run test:install` silently installs the baseline, launches its actual installed executable, seeds real PTY/history/usage/rules/memory/preferences through fixture CLIs, closes it, upgrades with the candidate installer, compares stored data through the native bridge, then uninstalls and checks retained data. Its report distinguishes fixture CLIs and manual installer upgrades from authenticated provider completions and published-feed updates. This tests installer/data compatibility between package versions, not migrations from every historical source version.

The runner writes `release/windows-install-report.json`, including completed checks, success/failure, and explicitly unverified provider/Drive/feed behavior. The workflow uploads the report on success or failure. For manual execution, use an isolated Windows VM and `npm run test:install -- --isolated-windows-vm`; do not run this registration-changing test alongside a personal installed copy. It needs native Windows; Linux and macOS cannot run it. Signing requires your certificate in secure workflow secrets.

## Certificate-required signed build (1.7)

Configure `CSC_LINK` (certificate path/base64 supported by electron-builder) and `CSC_KEY_PASSWORD` securely in your Windows build environment. Set `WINDOWS_PUBLISHER_NAME` to the public certificate name returned by Authenticode. In GitHub, use secrets `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` and repository variable `WINDOWS_PUBLISHER_NAME`; never commit private keys or passwords.

Run `npm.cmd run dist:win:signed`, or manually dispatch **Signed Windows release verification** after configuring those settings. Native Windows and a trusted signing certificate are required. The build verifies trusted Authenticode signatures and expected publisher names for Setup, Portable, and the unpacked app before promoting artifacts. It writes `windows-signature-report.json` with public signer details and SHA-256 hashes. A failed signing check leaves previous release output intact.

The workflow builds a signed baseline and current release from the same source, exercises installed upgrade/data retention, and uploads verification reports. `CODING_HUB_BASELINE_VERSION` selects the same baseline for both the signed build and the installation test (1.6.1 in the signed workflow; the ordinary workflow retains its 1.2.0 default). This fixture baseline checks installer mechanics; test a real previous release separately before publication. The workflow never publishes automatically. No certificate or signed artifact is provided by the source release. Support & releases in the app can export redacted CLI diagnostics and inspect the running Windows executable signature.
