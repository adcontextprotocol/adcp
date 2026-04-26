/**
 * Playwright smoke tests for /admin/newsletters/the_prompt.
 *
 * Note: /admin/digest redirects (301) to /admin/newsletters/the_prompt — this
 * test targets the canonical URL directly.
 *
 * Requires:
 *   - Local dev server running (`docker compose up --build`)
 *   - Playwright installed (`npx playwright install chromium`)
 *
 * Usage:
 *   node tests/e2e/admin-newsletter.smoke.js
 *   TARGET_URL=http://localhost:3000 node tests/e2e/admin-newsletter.smoke.js
 */

import { chromium } from 'playwright';
import { TARGET_URL, assert, resetFailures, failureCount, login, filterConsoleErrors, checkDevServer } from './helpers.js';

async function testAdminNewsletter(page, consoleErrors) {
  console.log('\n=== Admin newsletter editor ===');
  await login(page, 'admin');

  await page.goto(`${TARGET_URL}/admin/newsletters/the_prompt`);
  await page.waitForSelector('#nlTitle', { timeout: 15000 });

  console.log('DOM:');
  assert(await page.$('#nlTitle') !== null, 'Newsletter title present');
  assert(await page.$('#editMode') !== null, 'Edit mode container present');
  assert(await page.$('#sectionsContainer') !== null, 'Sections container present');
  assert(await page.$('#instructionInput') !== null, 'AI instruction input present');

  console.log('Redirect:');
  // Verify the old /admin/digest URL redirects correctly.
  const resp = await page.goto(`${TARGET_URL}/admin/digest`, { waitUntil: 'domcontentloaded' });
  const finalUrl = page.url();
  assert(finalUrl.includes('/admin/newsletters/the_prompt'), `Redirect from /admin/digest lands on canonical URL (got: ${finalUrl})`);

  console.log('Console:');
  const errors = filterConsoleErrors(consoleErrors);
  assert(errors.length === 0, `No unexpected console errors${errors.length ? ': ' + errors.join('; ') : ''}`);

  await page.screenshot({ path: '/tmp/smoke-admin-newsletter.png', fullPage: true });
}

(async () => {
  console.log(`Admin newsletter smoke tests against ${TARGET_URL}\n`);

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
    await testAdminNewsletter(page, consoleErrors);

    console.log(`\n${'='.repeat(40)}`);
    if (failureCount() === 0) {
      console.log('All checks passed');
    } else {
      console.log(`${failureCount()} check(s) failed`);
    }
  } catch (err) {
    console.error('\nTest crashed:', err.message);
    await page.screenshot({ path: '/tmp/smoke-admin-newsletter-crash.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  process.exit(failureCount() > 0 ? 1 : 0);
})();
