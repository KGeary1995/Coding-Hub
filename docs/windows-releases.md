# Windows installation and releases

## Build a candidate

On a Windows desktop with Node >=22.13 installed, run `npm ci`, then `npm run dist:win`. Build candidates on Windows using the **Windows release candidate** GitHub Actions workflow too. It runs on pushes to main and supports manual dispatch. The workflow executes unit/release tests, production desktop smoke tests using fixture CLIs, package verification, and an isolated installed-app upgrade/uninstall test. It uploads artifacts without creating tags or publishing releases.

Each attempt packages into a unique `release/.build-<id>/` staging folder. The previous `win-unpacked` is never renamed or deleted, so a running older unpacked app cannot lock the new build. Once verified, artifacts are promoted to `release/`, with metadata last. `last-build.json` identifies the verified staging directory for `npm run verify:win`. If an installer EXE itself is open and locked, close it and retry; its staged candidate remains available. Old staging folders can be manually archived after closing apps that use them.

Outputs in `release/`:

- `AI-Coding-Hub-<version>-Windows-x64-Setup.exe`: per-user installer, adjustable install directory, shortcuts, uninstaller.
- `AI-Coding-Hub-<version>-Windows-x64-Setup.exe.blockmap`: differential update data.
- `AI-Coding-Hub-<version>-Windows-x64-Portable.exe`: optional manual-update edition.
- `latest.yml`: stable update metadata with SHA-512 integrity hashes.

`npm run verify:win` validates installer hashes, metadata version/provider, Windows PE architecture, node-pty helper binaries, renderer assets, host/preload, and packaged updater dependencies. It does not execute the installer. Linux cross-packaging needs a functioning Wine runtime as well as verified electron-builder helper downloads. In this cloud run, Wine failed while extracting the generated uninstaller, so a complete Windows package was not verified. Use the provided Windows workflow or a native Windows desktop for the release candidate. This limitation does not affect source builds.

Install the Setup edition without elevating privileges. Source installations can continue to use npm. Source, installed, and portable editions share the default local storage directory `~/.coding-hub`; the app's single-instance lock protects simultaneous use.

## Signing

Unsigned builds are suitable for local review but may trigger Windows trust prompts. For distributed releases, configure a Windows Authenticode certificate using electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables. The workflow reads the optional `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` GitHub secrets. Put credentials in secure settings, never source or chat.

When CSC_LINK is present, executable signing and forceCodeSigning are enabled: signing failures fail the build. electron-builder supplies the certificate publisher metadata for electron-updater's default Windows verification. Retain the same publisher identity for future upgrades. TLS validation and updater checksum validation are never disabled. Unsigned local builds do not establish a trusted publisher identity; metadata hashes alone do not authenticate a release publisher.

## Publish a reviewed release

The fixed update source is the public stable releases of `KGeary1995/Coding-Hub`. Do not embed a GitHub token into the app. Private repository feeds require a separately designed authenticated distribution channel and are not supported by this workflow.

1. Bump package.json and the root/package entry in package-lock.json together.
2. Run the Windows candidate workflow from the intended source revision and inspect its artifacts.
3. Test Setup installation, authenticated Claude/Codex CLI launch, uninstall, and an upgrade on a native Windows machine.
4. Prepare a GitHub release tagged `v<package version>` with the Setup EXE, its blockmap, and latest.yml. Portable EXE can be attached as an optional download. Keep the release as a draft while reviewing it.
5. Publish as a stable, non-prerelease only after review. Preserve the exact asset names and bytes referenced by latest.yml.

The workflow does not publish anything automatically. Existing installed clients cannot discover drafts or prereleases. A missing release or missing assets causes a recoverable update error; it does not affect sessions. Manual installer upgrades are available even when the update service is offline.

## Update behavior and validation

Installed Windows editions check 30 seconds after startup and every four hours; the preference is saved locally in `updates.json`. Settings can disable automatic checks or run a manual check. Downloads are explicit, include progress, and retain updater integrity verification. Installation always requires a restart confirmation, no active or pending CLI launches, and a successful workspace flush. Normal exit never installs a downloaded update. Failed install startup unlocks CLI launch again.

Test a real upgrade with two signed stable release versions on native Windows: install the earlier version, populate settings/history/rules, discover and download the newer version, verify active-session blocking and cancel, then restart/install and verify data. Also test a disconnected network, missing feed assets, checksum failure, and publisher mismatch. Unit tests exercise these state transitions with a fake updater; the Linux desktop smoke validates the real bridge and disabled source-edition UI. Those checks do not claim a real published-feed upgrade was performed.

## Native installation test

The workflow builds the candidate and a baseline package labelled 1.2.0 from the same source. `npm run test:install` silently installs the baseline, launches its actual installed executable, seeds real PTY/history/usage/rules/memory/preferences through fixture CLIs, closes it, upgrades with the candidate installer, compares stored data through the native bridge, then uninstalls and checks retained data. Its report distinguishes fixture CLIs and manual installer upgrades from authenticated provider completions and published-feed updates. This tests installer/data compatibility between package versions, not migrations from every historical source version.

The runner writes `release/windows-install-report.json`, including completed checks, success/failure, and explicitly unverified provider/Drive/feed behavior. The workflow uploads the report on success or failure. For manual execution, use an isolated Windows VM and `npm run test:install -- --isolated-windows-vm`; do not run this registration-changing test alongside a personal installed copy. The cloud Linux instance cannot execute this test, and GitHub API access currently prevents dispatching it from this session. Signing requires your certificate in secure workflow secrets.

## Certificate-required signed build (1.7)

Configure `CSC_LINK` (certificate path/base64 supported by electron-builder) and `CSC_KEY_PASSWORD` securely in your Windows build environment. Set `WINDOWS_PUBLISHER_NAME` to the public certificate name returned by Authenticode. In GitHub, use secrets `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` and repository variable `WINDOWS_PUBLISHER_NAME`; never commit private keys or passwords.

Run `npm.cmd run dist:win:signed`, or manually dispatch **Signed Windows release verification** after configuring those settings. Native Windows and a trusted signing certificate are required. The build verifies trusted Authenticode signatures and expected publisher names for Setup, Portable, and the unpacked app before promoting artifacts. It writes `windows-signature-report.json` with public signer details and SHA-256 hashes. A failed signing check leaves previous release output intact.

The workflow builds a signed baseline and current release from the same source, exercises installed upgrade/data retention, and uploads verification reports. This fixture baseline checks installer mechanics; test a real previous release separately before publication. The workflow never publishes automatically. No certificate or signed artifact is provided by the source release. Support & releases in the app can export redacted CLI diagnostics and inspect the running Windows executable signature.
