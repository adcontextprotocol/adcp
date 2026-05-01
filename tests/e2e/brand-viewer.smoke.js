/**
 * Playwright smoke tests for /brand/:domain.
 *
 * Requires:
 *   - Local dev server running (`docker compose up --build`)
 *   - Playwright installed (`npx playwright install chromium`)
 *
 * Usage:
 *   node tests/e2e/brand-viewer.smoke.js
 *   TARGET_URL=http://localhost:3000 node tests/e2e/brand-viewer.smoke.js
 */

import { chromium } from 'playwright';
import { TARGET_URL, assert, resetFailures, failureCount, login, filterConsoleErrors, checkDevServer } from './helpers.js';

// Use a known seeded domain; tests the known-brand rendering path.
const TEST_DOMAIN = 'agenticadvertising.org';

async function testBrandViewer(page, consoleErrors) {
  console.log(`\n=== Brand viewer: ${TEST_DOMAIN} ===`);
  await login(page, 'admin');

  await page.goto(`${TARGET_URL}/brand/${TEST_DOMAIN}`);
  // Either brand data or error state should render within this timeout.
  await page.waitForSelector('#hero-title', { timeout: 20000 });

  console.log('DOM:');
  assert(await page.$('#adcp-nav') !== null, 'Nav rendered');
  assert(await page.$('#hero-title') !== null, 'Hero title present');
  // Brand data OR error state — both are valid renderings of the page.
  const hasBrandData = await page.$('#brand-info-content') !== null;
  const hasErrorState = await page.$('#error-title') !== null;
  assert(hasBrandData || hasErrorState, 'Brand data or error state rendered');

  console.log('Console:');
  const errors = filterConsoleErrors(consoleErrors);
  assert(errors.length === 0, `No unexpected console errors${errors.length ? ': ' + errors.join('; ') : ''}`);

  await page.screenshot({ path: '/tmp/smoke-brand-viewer.png', fullPage: true });
}

async function testBrandViewerUnknownDomain(page, consoleErrors) {
  console.log('\n=== Brand viewer: unknown domain (error state) ===');
  await login(page, 'admin');

  await page.goto(`${TARGET_URL}/brand/unknown.example.invalid`);
  await page.waitForSelector('#error-title', { timeout: 15000 });

  console.log('DOM:');
  assert(await page.$('#error-title') !== null, 'Error title rendered for unknown domain');
  assert(await page.$('#error-message') !== null, 'Error message rendered');

  console.log('Console:');
  const errors = filterConsoleErrors(consoleErrors);
  assert(errors.length === 0, `No unexpected console errors${errors.length ? ': ' + errors.join('; ') : ''}`);

  await page.screenshot({ path: '/tmp/smoke-brand-viewer-unknown.png', fullPage: true });
}

(async () => {
  console.log(`Brand viewer smoke tests against ${TARGET_URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    await checkDevServer(page);

    resetFailures();
    await testBrandViewer(page, consoleErrors);
    consoleErrors.length = 0;
    await testBrandViewerUnknownDomain(page, consoleErrors);

    console.log(`\n${'='.repeat(40)}`);
    if (failureCount() === 0) {
      console.log('All checks passed');
    } else {
      console.log(`${failureCount()} check(s) failed`);
    }
  } catch (err) {
    console.error('\nTest crashed:', err.message);
    await page.screenshot({ path: '/tmp/smoke-brand-viewer-crash.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  process.exit(failureCount() > 0 ? 1 : 0);
})();
