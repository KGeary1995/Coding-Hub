const fs = require('node:fs/promises');

/**
 * Removes a smoke test's temporary folder. On Windows a process the test started can still hold the folder for a few
 * seconds after the app closes (EBUSY), so it retries for about 5 s (rm waits retryDelay × attempt: 90 + 180 + … + 900
 * ms); if the folder still cannot go, it says so and leaves it, because a throw from `finally` would replace the test's
 * own failure or fail a test that passed.
 */
async function removeFolder(folder, remove = fs.rm) {
  try { await remove(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 90 }); }
  catch (error) { console.warn(`Could not remove the test folder ${folder} (${error.code ?? error.message}); delete it by hand.`); }
}

module.exports = { removeFolder };
