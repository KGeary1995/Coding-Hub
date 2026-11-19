const os = require('node:os');
const path = require('node:path');
/**
 * Spread into the environment of every Trace a test starts. A fresh storage folder has no preferences.json, and on
 * Windows Trace then uses G:\My Drive\Coding Hub: where that folder exists, the test's notes and session summaries were
 * mirrored into the person's real Google Drive. With this the folder is none (defaultDriveDirectory in
 * electron/services/hub/preferences.ts); a test that syncs chooses a temporary folder itself. Gemini CLI's conversations
 * are looked for in a folder that does not exist, so Session history never lists the person's own.
 */
exports.NO_DRIVE = Object.freeze({ CODING_HUB_DEFAULT_DRIVE_DIR: '', CODING_HUB_GEMINI_HOME: path.join(os.tmpdir(), 'trace-test-no-gemini') });
