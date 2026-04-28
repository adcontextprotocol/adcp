/**
 * Playwright smoke tests for /certification.
 *
 * Requires:
 *   - Local dev server running (`docker compose up --build`)
 *   - Playwright installed (`npx playwright install chromium`)
 *
 * Usage:
 *   node tests/e2e/certification.smoke.js
 *   TARGET_URL=http://localhost:3000 node tests/e2e/certification.smoke.js
 */

import { chromium } from 'playwright';
import { TARGET_URL, assert, failureCount, login, filterConsoleErrors, checkDevServer } from './helpers.js';

async function testCertification(page, consoleErrors, userType) {
  console.log(`\n=== Certification dashboard: ${userType} ===`);
  await login(page, userType);

  await page.goto(`${TARGET_URL}/certification`);
  await page.waitForSelector('#learning-container', { state: 'visible', timeout: 20000 });

  console.log('DOM:');
  assert(await page.$('#adcp-nav') !== null, 'Nav rendered');
  assert(await page.$('#learning-container') !== null, 'Learning container present');
  assert(await page.$('#adcp-footer') !== null, 'Footer rendered');

  console.log('Console:');
  const errors = filterConsoleErrors(consoleErrors);
  assert(errors.length === 0, `No unexpected console errors${errors.length ? ': ' + errors.join('; ') : ''}`);

  await page.screenshot({ path: `/tmp/smoke-certification-${userType}.png`, fullPage: true });
}

(async () => {
  console.log(`Certification dashboard smoke tests against ${TARGET_URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    await checkDevServer(page);

    for (const userType of ['personal', 'admin']) {
      consoleErrors.length = 0;
      await testCertification(page, consoleErrors, userType);
    }

    console.log(`\n${'='.repeat(40)}`);
    if (failureCount() === 0) {
      console.log('All checks passed');
    } else {
      console.log(`${failureCount()} check(s) failed`);
    }
  } catch (err) {
    console.error('\nTest crashed:', err.message);
    await page.screenshot({ path: '/tmp/smoke-certification-crash.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  process.exit(failureCount() > 0 ? 1 : 0);
})();
