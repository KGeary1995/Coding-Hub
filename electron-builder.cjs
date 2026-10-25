module.exports = {
  appId: 'com.codinghub.desktop',
  productName: 'AI Coding Hub',
  forceCodeSigning: Boolean(process.env.CSC_LINK),
  directories: { output: 'release', buildResources: 'assets' },
  // node-pty starts workers and a console-list helper from real filesystem paths.
  asar: false,
  // node-pty 1.1 ships stable Node-API Windows x64 binaries in its npm package.
  // Rebuilding on the Linux packaging host would replace them with Linux binaries.
  npmRebuild: false,
  files: [
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
  ],
  win: {
    // Only the Windows x64 terminal binding ships in the Windows package.
    files: ['!node_modules/node-pty/prebuilds/win32-arm64/**', '!node_modules/node-pty/prebuilds/darwin-*/**'],
    // electron-builder 26 only accepts publisherName under signtoolOptions; directly under win it fails validation.
    ...(process.env.WINDOWS_PUBLISHER_NAME ? { signtoolOptions: { publisherName: process.env.WINDOWS_PUBLISHER_NAME } } : {}),
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    icon: 'assets/icon.ico',
    signExecutable: Boolean(process.env.CSC_LINK),
  },
  mac: {
    // One disk image per processor: Apple silicon (arm64) and Intel (x64). Each keeps its own node-pty binding.
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    icon: 'assets/icon.png',
    category: 'public.app-category.developer-tools',
    files: ['!node_modules/node-pty/prebuilds/win32-*/**'],
    // Ad-hoc signed: Apple silicon runs only signed code, and no Apple Developer ID is configured. macOS asks once to
    // allow the app (System Settings → Privacy & Security → Open Anyway). A Developer ID would also need notarization.
    identity: '-',
    hardenedRuntime: false,
  },
  dmg: { artifactName: 'AI-Coding-Hub-${version}-macOS-${arch}.${ext}' },
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
    artifactName: 'AI-Coding-Hub-${version}-Windows-${arch}-Setup.${ext}',
  },
  portable: { requestExecutionLevel: 'user', artifactName: 'AI-Coding-Hub-${version}-Windows-${arch}-Portable.${ext}' },
};
