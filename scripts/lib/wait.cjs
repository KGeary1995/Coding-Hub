// Waits until a check run in the page resolves to a truthy value. Use it for checks that call the app's async API:
// Playwright's waitForFunction does not await a promise, so an async check counts as passed at once.
async function waitForPage(page, check, arg, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(check, arg)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

module.exports = { waitForPage };
