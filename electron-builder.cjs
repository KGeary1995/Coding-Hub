const { product } = require('./scripts/product.cjs');
const { name: productName, prefix } = product();
const macIdentity = process.env.MAC_SIGNING_IDENTITY;
// Only the built app ships. A platform's own `files` replaces this list rather than adding to it (a list of only
// exclusions there packed the whole source tree), so each platform repeats it before its exclusions.
const common = [
  'dist/**/*',
  'dist-electron/**/*',
  'package.json',
  '!**/*.map',
  '!**/*.test.*',
  '!**/*.pdb',
  '!node_modules/node-pty/build/**',
  '!node_modules/node-pty/src/**',
  '!node_modules/node-pty/deps/**',
  '!node_modules/node-pty/scripts/**',
  '!node_modules/node-pty/typings/**',
  '!node_modules/node-pty/third_party/**',
];

module.exports = {
  appId: 'com.codinghub.desktop',
  // The app ID stays as it was, so installs from before the rename to Trace upgrade in place.
  productName,
  forceCodeSigning: Boolean(process.env.CSC_LINK),
  directories: { output: 'release', buildResources: 'assets' },
  // node-pty starts workers and a console-list helper from real filesystem paths.
  asar: false,
  // node-pty 1.1 ships stable Node-API Windows x64 binaries in its npm package.
  // Rebuilding on the Linux packaging host would replace them with Linux binaries.
  npmRebuild: false,
  files: common,
  win: {
    // Only the Windows x64 terminal binding ships in the Windows package.
    files: [...common, '!node_modules/node-pty/prebuilds/win32-arm64/**', '!node_modules/node-pty/prebuilds/darwin-*/**'],
    // electron-builder 26 only accepts publisherName under signtoolOptions; directly under win it fails validation.
    ...(process.env.WINDOWS_PUBLISHER_NAME ? { signtoolOptions: { publisherName: process.env.WINDOWS_PUBLISHER_NAME } } : {}),
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    icon: 'assets/icon.ico',
    signExecutable: Boolean(process.env.CSC_LINK),
  },
  mac: {
    // One disk image per processor: Apple silicon (arm64) and Intel (x64). Each keeps its own node-pty binding.
    // A Developer ID build also makes the zips and latest-mac.yml that installed Macs update themselves from; macOS
    // installs an update only when it is signed by the same developer, so ad-hoc builds have no use for them.
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, ...(macIdentity ? [{ target: 'zip', arch: ['arm64', 'x64'] }] : [])],
    icon: 'assets/icon.png',
    category: 'public.app-category.developer-tools',
    files: [...common, '!node_modules/node-pty/prebuilds/win32-*/**'],
    // MAC_SIGNING_IDENTITY (a Developer ID Application name, e.g. "Kyle Geary (73DB29GHV2)") signs with the hardened
    // runtime, and APPLE_KEYCHAIN_PROFILE (from `xcrun notarytool store-credentials`) or APPLE_API_KEY / APPLE_ID also
    // notarizes, so macOS opens the app without asking. Without them the app is ad-hoc signed (Apple silicon runs only
    // signed code) and macOS asks once to allow it (System Settings → Privacy & Security → Open Anyway).
    identity: macIdentity || '-',
    hardenedRuntime: Boolean(macIdentity),
    ...(macIdentity ? { entitlements: 'assets/entitlements.mac.plist', entitlementsInherit: 'assets/entitlements.mac.plist' } : {}),
    notarize: Boolean(macIdentity && (process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_API_KEY || process.env.APPLE_ID)),
  },
  // A signed disk image, so Gatekeeper accepts the download itself; notarize it after the build (see README).
  dmg: { artifactName: prefix + '-${version}-macOS-${arch}.${ext}', sign: Boolean(macIdentity) },
  zip: { artifactName: prefix + '-${version}-macOS-${arch}.${ext}' },
  // Tells the packaged app it may update itself on a Mac (see updatesEnabled).
  ...(macIdentity ? { extraMetadata: { traceMacUpdates: true } } : {}),
  // Installers are published to a public downloads repository so installed copies can check it without credentials;
  // the source repository stays private. See docs/windows-releases.md.
  publish: [{ provider: 'github', owner: 'KGeary1995', repo: 'trace-releases', releaseType: 'release' }],
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    artifactName: prefix + '-${version}-Windows-${arch}-Setup.${ext}',
  },
  portable: { requestExecutionLevel: 'user', artifactName: prefix + '-${version}-Windows-${arch}-Portable.${ext}' },
};
