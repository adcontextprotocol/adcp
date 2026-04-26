/**
 * Playwright smoke tests for /community.
 *
 * Requires:
 *   - Local dev server running (`docker compose up --build`)
 *   - Playwright installed (`npx playwright install chromium`)
 *
 * Usage:
 *   node tests/e2e/community-hub.smoke.js
 *   TARGET_URL=http://localhost:3000 node tests/e2e/community-hub.smoke.js
 */

import { chromium } from 'playwright';
import { TARGET_URL, assert, resetFailures, failureCount, login, filterConsoleErrors, checkDevServer } from './helpers.js';

async function testCommunityHub(page, consoleErrors, userType) {
  console.log(`\n=== Community hub: ${userType} ===`);
  await login(page, userType);

  await page.goto(`${TARGET_URL}/community`);
  await page.waitForSelector('#adcp-nav', { state: 'visible', timeout: 15000 });
  // Give dynamic content time to hydrate.
  await page.waitForTimeout(2000);

  console.log('DOM:');
  assert(await page.$('#adcp-nav') !== null, 'Nav rendered');
  assert(await page.$('#adcp-footer') !== null, 'Footer rendered');
  // Page should not crash with a blank body.
  const bodyText = await page.evaluate(() => document.body.innerText);
  assert(bodyText.length > 50, 'Page has substantial content');

  console.log('Console:');
  const errors = filterConsoleErrors(consoleErrors);
  assert(errors.length === 0, `No unexpected console errors${errors.length ? ': ' + errors.join('; ') : ''}`);

  await page.screenshot({ path: `/tmp/smoke-community-hub-${userType}.png`, fullPage: true });
}

(async () => {
  console.log(`Community hub smoke tests against ${TARGET_URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    await checkDevServer(page);

    for (const userType of ['personal', 'member']) {
      resetFailures();
      consoleErrors.length = 0;
      await testCommunityHub(page, consoleErrors, userType);
    }

    console.log(`\n${'='.repeat(40)}`);
    if (failureCount() === 0) {
      console.log('All checks passed');
    } else {
      console.log(`${failureCount()} check(s) failed`);
    }
  } catch (err) {
    console.error('\nTest crashed:', err.message);
    await page.screenshot({ path: '/tmp/smoke-community-hub-crash.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  process.exit(failureCount() > 0 ? 1 : 0);
})();
