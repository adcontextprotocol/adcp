/**
 * Playwright smoke tests for /organization.
 *
 * Requires:
 *   - Local dev server running (`docker compose up --build`)
 *   - Playwright installed (`npx playwright install chromium`)
 *
 * Usage:
 *   node tests/e2e/organization-dashboard.smoke.js
 *   TARGET_URL=http://localhost:3000 node tests/e2e/organization-dashboard.smoke.js
 */

import { chromium } from 'playwright';
import { TARGET_URL, assert, resetFailures, failureCount, login, filterConsoleErrors, checkDevServer } from './helpers.js';

async function testOrgDashboard(page, consoleErrors, userType) {
  console.log(`\n=== Organization dashboard: ${userType} ===`);
  await login(page, userType);

  await page.goto(`${TARGET_URL}/organization`);
  await page.waitForSelector('#hub-content', { state: 'visible', timeout: 20000 });

  console.log('DOM:');
  assert(await page.$('#adcp-nav') !== null, 'Nav rendered');
  assert(await page.$('#hub-content') !== null, 'Hub content container present');
  assert(await page.$('#membership') !== null, 'Membership section present');
  assert(await page.$('#directory') !== null, 'Directory section present');

  console.log('Console:');
  const errors = filterConsoleErrors(consoleErrors);
  assert(errors.length === 0, `No unexpected console errors${errors.length ? ': ' + errors.join('; ') : ''}`);

  await page.screenshot({ path: `/tmp/smoke-org-dashboard-${userType}.png`, fullPage: true });
}

(async () => {
  console.log(`Organization dashboard smoke tests against ${TARGET_URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    await checkDevServer(page);

    for (const userType of ['admin', 'member']) {
      resetFailures();
      consoleErrors.length = 0;
      await testOrgDashboard(page, consoleErrors, userType);
    }

    console.log(`\n${'='.repeat(40)}`);
    if (failureCount() === 0) {
      console.log('All checks passed');
    } else {
      console.log(`${failureCount()} check(s) failed`);
    }
  } catch (err) {
    console.error('\nTest crashed:', err.message);
    await page.screenshot({ path: '/tmp/smoke-org-dashboard-crash.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  process.exit(failureCount() > 0 ? 1 : 0);
})();
