/**
 * Shared utilities for Playwright smoke tests.
 *
 * Usage:
 *   import { TARGET_URL, assert, resetFailures, failureCount, login } from './helpers.js';
 */

export const TARGET_URL = process.env.TARGET_URL || 'http://localhost:55020';

let failures = 0;

export function resetFailures() {
  failures = 0;
}

export function failureCount() {
  return failures;
}

export function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures++;
  }
}

const DEV_USER_LABELS = {
  personal: 'Personal Account',
  admin: 'Admin Tester',
  member: 'Member User',
};

export async function login(page, userType) {
  await page.goto(`${TARGET_URL}/auth/logout`);
  await page.goto(`${TARGET_URL}/dev-login.html`);
  await page.waitForSelector(`text=${DEV_USER_LABELS[userType]}`);
  await page.click(`text=${DEV_USER_LABELS[userType]}`);
  await page.waitForURL('**/member*', { timeout: 15000 }).catch(() => {});
}

// Filters out noise from PostHog, missing favicons, and network blips.
export function filterConsoleErrors(errors, extraPatterns = []) {
  const defaultIgnored = ['posthog', 'net::ERR', 'favicon', 'Hub load error'];
  return errors.filter(e => ![...defaultIgnored, ...extraPatterns].some(p => e.includes(p)));
}

export async function checkDevServer(page) {
  const resp = await page.goto(`${TARGET_URL}/dev-login.html`);
  if (!resp || resp.status() !== 200) {
    console.error(`Dev server not reachable at ${TARGET_URL} (status: ${resp?.status()})`);
    console.error('Start with: docker compose up --build');
    process.exit(1);
  }
}
