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
    '!node_modules/node-pty/prebuilds/win32-arm64/**',
    '!node_modules/node-pty/prebuilds/darwin-x64/**',
    '!node_modules/node-pty/prebuilds/darwin-arm64/**',
  ],
  win: {
    // electron-builder 26 only accepts publisherName under signtoolOptions; directly under win it fails validation.
    ...(process.env.WINDOWS_PUBLISHER_NAME ? { signtoolOptions: { publisherName: process.env.WINDOWS_PUBLISHER_NAME } } : {}),
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    icon: 'assets/icon.ico',
    signExecutable: Boolean(process.env.CSC_LINK),
  },
  publish: [{ provider: 'github', owner: 'KGeary1995', repo: 'Coding-Hub', releaseType: 'draft' }],
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
