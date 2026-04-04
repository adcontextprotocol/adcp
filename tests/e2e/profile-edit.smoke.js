/**
 * Playwright smoke tests for the profile edit page.
 *
 * Requires:
 *   - Local dev server running (`docker compose up --build`)
 *   - Playwright installed (`npx playwright install chromium`)
 *
 * Usage:
 *   node tests/e2e/profile-edit.smoke.js                    # default localhost:55020
 *   TARGET_URL=http://localhost:3000 node tests/e2e/profile-edit.smoke.js
 */

import { chromium } from 'playwright';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:55020';

// Fields that must survive DOM restructuring for personal accounts
const PERSONAL_ACCOUNT_FIELDS = [
  'field-first-name', 'field-last-name',
  'field-is-public', 'field-slug', 'field-headline', 'field-bio',
  'field-city', 'field-linkedin-url', 'field-twitter-url',
  'field-github-username', 'field-coffee-chat', 'field-intros',
  'field-contact-email', 'field-contact-phone', 'field-contact-website',
  'offering-consulting', 'offering-other',
];

const ORG_ACCOUNT_FIELDS = [
  'field-first-name', 'field-last-name',
  'field-slug', 'field-headline', 'field-bio', 'field-city',
  'field-linkedin-url', 'field-twitter-url', 'field-github-username',
];

let failures = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures++;
  }
}

async function login(page, userType) {
  await page.goto(`${TARGET_URL}/auth/logout`);
  await page.goto(`${TARGET_URL}/dev-login.html`);
  const labels = {
    personal: 'Personal Account',
    admin: 'Admin Tester',
    member: 'Member User',
  };
  await page.waitForSelector(`text=${labels[userType]}`);
  await page.click(`text=${labels[userType]}`);
  await page.waitForURL('**/member*', { timeout: 15000 }).catch(() => {});
}

async function testPersonalAccount(page, consoleErrors) {
  console.log('\n=== Personal account: profile edit ===');
  await login(page, 'personal');

  await page.goto(`${TARGET_URL}/account`);
  await page.waitForSelector('#edit-content', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(2000);

  // All form fields survive restructure
  console.log('Form fields:');
  const missing = [];
  for (const id of PERSONAL_ACCOUNT_FIELDS) {
    if (!await page.$(`#${id}`)) missing.push(id);
  }
  assert(missing.length === 0, `All ${PERSONAL_ACCOUNT_FIELDS.length} fields present${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`);

  // Portrait section preserved
  console.log('Portrait:');
  assert(await page.$('#section-portrait-and-addie') !== null, 'Portrait section in DOM');

  // Section titles after restructure
  console.log('Section layout:');
  const titles = await page.$$eval('.edit-section-title', els => els.map(e => e.textContent));
  assert(titles.includes('Expertise and interests'), '"Expertise and interests" section');
  assert(titles.includes('Public listing'), '"Public listing" section');
  assert(titles.includes('Networking'), '"Networking" section');
  assert(!titles.includes('Preferences'), '"Preferences" renamed to "Networking"');

  // Page title changed
  const pageTitle = await page.$eval('.edit-title', el => el.textContent);
  assert(pageTitle === 'Your profile', `Page title is "${pageTitle}"`);

  // Save works
  console.log('Save:');
  await page.fill('#field-headline', 'Smoke test ' + Date.now());
  await page.click('#save-btn');
  const toast = await page.waitForSelector('.toast--visible', { timeout: 5000 }).catch(() => null);
  assert(toast !== null, 'Toast appeared');
  if (toast) {
    const text = await toast.textContent();
    assert(text.includes('saved'), `Toast says "${text}"`);
  }

  // No profile-edit console errors
  console.log('Console:');
  const profileErrors = consoleErrors.filter(e =>
    e.includes('handleSubmit') || e.includes('portrait') || e.includes('restructure')
  );
  assert(profileErrors.length === 0, `No profile-related console errors${profileErrors.length ? ': ' + profileErrors.join('; ') : ''}`);

  await page.screenshot({ path: '/tmp/smoke-profile-personal.png', fullPage: true });
}

async function testOrgAccount(page, consoleErrors) {
  console.log('\n=== Org account: profile edit ===');
  await login(page, 'admin');

  await page.goto(`${TARGET_URL}/account`);
  await page.waitForSelector('#edit-content', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(2000);

  // Form fields present
  console.log('Form fields:');
  const missing = [];
  for (const id of ORG_ACCOUNT_FIELDS) {
    if (!await page.$(`#${id}`)) missing.push(id);
  }
  assert(missing.length === 0, `All ${ORG_ACCOUNT_FIELDS.length} fields present${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`);

  // No personal-account sections
  console.log('Section layout:');
  const titles = await page.$$eval('.edit-section-title', els => els.map(e => e.textContent));
  assert(!titles.includes('Public listing'), 'No "Public listing" section');
  assert(!titles.includes('Networking'), 'No "Networking" section (keeps "Preferences")');

  // Save works
  console.log('Save:');
  await page.fill('#field-headline', 'Org smoke test ' + Date.now());
  await page.click('#save-btn');
  const toast = await page.waitForSelector('.toast--visible', { timeout: 5000 }).catch(() => null);
  assert(toast !== null, 'Toast appeared');
  if (toast) {
    const text = await toast.textContent();
    assert(text.includes('saved'), `Toast says "${text}"`);
  }

  await page.screenshot({ path: '/tmp/smoke-profile-org.png', fullPage: true });
}

async function testNameUpdate(page) {
  console.log('\n=== Name update flow ===');
  await login(page, 'personal');

  await page.goto(`${TARGET_URL}/account`);
  await page.waitForSelector('#edit-content', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(1000);

  // Name fields are populated
  const firstName = await page.$eval('#field-first-name', el => el.value);
  const lastName = await page.$eval('#field-last-name', el => el.value);
  assert(firstName.length > 0, `First name populated: "${firstName}"`);

  // Update name and save
  const ts = Date.now();
  await page.fill('#field-first-name', 'SmokeTest');
  await page.fill('#field-last-name', `User${ts}`);
  await page.click('#save-btn');
  const toast = await page.waitForSelector('.toast--visible', { timeout: 5000 }).catch(() => null);
  assert(toast !== null, 'Save toast appeared after name change');

  // Reload and verify name persisted
  await page.goto(`${TARGET_URL}/account`);
  await page.waitForSelector('#edit-content', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(1000);
  const updatedFirst = await page.$eval('#field-first-name', el => el.value);
  assert(updatedFirst === 'SmokeTest', `Name persisted after reload: "${updatedFirst}"`);

  // Restore original name
  await page.fill('#field-first-name', firstName);
  await page.fill('#field-last-name', lastName);
  await page.click('#save-btn');
  await page.waitForSelector('.toast--visible', { timeout: 5000 }).catch(() => null);

  await page.screenshot({ path: '/tmp/smoke-profile-name.png', fullPage: true });
}

async function testAccountSections(page) {
  console.log('\n=== Account sections (linked emails, notifications) ===');
  await login(page, 'personal');

  await page.goto(`${TARGET_URL}/account`);
  await page.waitForSelector('#edit-content', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(2000);

  // Linked emails section exists as collapsed details
  const linkedEmails = await page.$('details#linked-emails');
  assert(linkedEmails !== null, 'Linked emails section exists');

  // Notifications section exists as collapsed details
  const notifications = await page.$('details#notifications');
  assert(notifications !== null, 'Notifications section exists');

  // Open linked emails and check content loaded
  await page.click('details#linked-emails > summary');
  await page.waitForTimeout(1000);
  const emailsContent = await page.$eval('#linkedEmailsList', el => el.textContent);
  assert(!emailsContent.includes('Loading'), 'Linked emails loaded');

  // Open notifications and check content loaded
  await page.click('details#notifications > summary');
  await page.waitForTimeout(1000);
  const notifsContent = await page.$eval('#categoriesContainer', el => el.textContent);
  assert(!notifsContent.includes('Loading'), 'Notifications loaded');

  await page.screenshot({ path: '/tmp/smoke-profile-sections.png', fullPage: true });
}

async function testRedirect(page) {
  console.log('\n=== Old URL redirect ===');
  await login(page, 'personal');

  // Visit old profile edit URL
  await page.goto(`${TARGET_URL}/community/profile/edit`, { waitUntil: 'domcontentloaded' });
  const finalUrl = page.url();
  assert(finalUrl.includes('/account'), `Redirected to /account (got: ${finalUrl})`);

  // With query param
  await page.goto(`${TARGET_URL}/community/profile/edit?org=test123`, { waitUntil: 'domcontentloaded' });
  const finalUrl2 = page.url();
  assert(finalUrl2.includes('/account') && finalUrl2.includes('org=test123'), `Redirect preserves query params (got: ${finalUrl2})`);
}

(async () => {
  console.log(`Profile edit smoke tests against ${TARGET_URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!text.includes('posthog') && !text.includes('net::ERR') && !text.includes('favicon') && !text.includes('Hub load error')) {
        consoleErrors.push(text);
      }
    }
  });

  try {
    // Verify dev server is reachable
    const resp = await page.goto(`${TARGET_URL}/dev-login.html`);
    if (!resp || resp.status() !== 200) {
      console.error(`Dev server not reachable at ${TARGET_URL} (status: ${resp?.status()})`);
      console.error('Start with: docker compose up --build');
      process.exit(1);
    }

    await testRedirect(page);
    await testPersonalAccount(page, consoleErrors);
    await testOrgAccount(page, consoleErrors);
    await testNameUpdate(page);
    await testAccountSections(page);

    console.log(`\n${'='.repeat(40)}`);
    if (failures === 0) {
      console.log('All checks passed');
    } else {
      console.log(`${failures} check(s) failed`);
    }
  } catch (err) {
    console.error('\nTest crashed:', err.message);
    await page.screenshot({ path: '/tmp/smoke-profile-crash.png', fullPage: true }).catch(() => {});
    failures++;
  } finally {
    await browser.close();
  }

  process.exit(failures > 0 ? 1 : 0);
})();
