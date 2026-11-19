/**
 * Spread into the environment of every Trace a test starts. A fresh storage folder has no preferences.json, and on
 * Windows Trace then uses G:\My Drive\Coding Hub: where that folder exists, the test's notes and session summaries were
 * mirrored into the person's real Google Drive. With this the folder is none (defaultDriveDirectory in
 * electron/services/hub/preferences.ts); a test that syncs chooses a temporary folder itself.
 */
exports.NO_DRIVE = Object.freeze({ CODING_HUB_DEFAULT_DRIVE_DIR: '' });
