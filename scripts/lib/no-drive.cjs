const os = require('node:os');
const path = require('node:path');
/**
 * Spread into the environment of every Trace a test starts. A fresh storage folder has no preferences.json, and on
 * Windows Trace then uses G:\My Drive\Coding Hub: where that folder exists, the test's notes and session summaries were
 * mirrored into the person's real Google Drive. With this the folder is none (defaultDriveDirectory in
 * electron/services/hub/preferences.ts); a test that syncs chooses a temporary folder itself. Gemini CLI's conversations
 * are looked for in a folder that does not exist, so Session history never lists the person's own, and Gemini CLI itself
 * counts as not installed, so the person's own agy is never run (or asked for its sign-in or limits) by a test. The
 * getting started guide counts as hidden, so it never covers what a test clicks. And Trace's window stays hidden
 * (CODING_HUB_TEST_HIDDEN: loaded and driven, never shown or in the Dock), so a test on the person's computer does not
 * open Trace over their work; CODING_HUB_TEST_SHOW=1 shows it, to watch a test. A CI runner has no person's screen, so
 * there it shows as before: a never-shown window on Windows keeps a size the runner's screen would have trimmed, and the
 * desktop smoke's Needs you check failed with it (PR #147, 2026-11-25).
 */
exports.TEST_HIDDEN = process.env.CODING_HUB_TEST_SHOW === '1' || process.env.CI === 'true' ? '0' : '1';
exports.NO_DRIVE = Object.freeze({ CODING_HUB_DEFAULT_DRIVE_DIR: '', CODING_HUB_GEMINI_HOME: path.join(os.tmpdir(), 'trace-test-no-gemini'), CODING_HUB_TEST_NO_GEMINI: '1', CODING_HUB_TEST_NO_GUIDE: '1', CODING_HUB_TEST_HIDDEN: exports.TEST_HIDDEN });
