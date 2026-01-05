import { test, expect, Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.use({
  viewport: { width: 390, height: 844 }, // iPhone 12 Pro dimensions
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
  hasTouch: true,
  isMobile: true,
});

// Helper to check for horizontal overflow
async function checkNoHorizontalOverflow(page: Page, pageName: string) {
  const hasOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });

  if (hasOverflow) {
    console.log(`WARNING: ${pageName} has horizontal overflow!`);
  }

  return !hasOverflow;
}

test.describe('Mobile Site-Wide Check', () => {

  test('onboarding page displays correctly on mobile', async ({ page }) => {
    await page.goto(`${BASE_URL}/onboarding.html`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/pages/onboarding-mobile.png', fullPage: true });

    const noOverflow = await checkNoHorizontalOverflow(page, 'onboarding');
    expect(noOverflow).toBe(true);
  });

  test('membership page displays correctly on mobile', async ({ page }) => {
    await page.goto(`${BASE_URL}/membership.html`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/pages/membership-mobile.png', fullPage: true });

    const noOverflow = await checkNoHorizontalOverflow(page, 'membership');
    expect(noOverflow).toBe(true);
  });

  test('terms page displays correctly on mobile', async ({ page }) => {
    await page.goto(`${BASE_URL}/legal/terms.html`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/pages/terms-mobile.png', fullPage: true });

    const noOverflow = await checkNoHorizontalOverflow(page, 'terms');
    expect(noOverflow).toBe(true);
  });

  test('privacy page displays correctly on mobile', async ({ page }) => {
    await page.goto(`${BASE_URL}/legal/privacy.html`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/pages/privacy-mobile.png', fullPage: true });

    const noOverflow = await checkNoHorizontalOverflow(page, 'privacy');
    expect(noOverflow).toBe(true);
  });

  test('members page displays correctly on mobile', async ({ page }) => {
    await page.goto(`${BASE_URL}/members.html`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/pages/members-mobile.png', fullPage: true });

    const noOverflow = await checkNoHorizontalOverflow(page, 'members');
    expect(noOverflow).toBe(true);
  });

  test('about page displays correctly on mobile', async ({ page }) => {
    await page.goto(`${BASE_URL}/about.html`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/pages/about-mobile.png', fullPage: true });

    const noOverflow = await checkNoHorizontalOverflow(page, 'about');
    expect(noOverflow).toBe(true);
  });

  test('homepage displays correctly on mobile', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/pages/homepage-mobile.png', fullPage: true });

    const noOverflow = await checkNoHorizontalOverflow(page, 'homepage');
    expect(noOverflow).toBe(true);
  });
});

test.describe('Mobile Registration Flow', () => {

  test('organization profile modal displays correctly on mobile', async ({ page }) => {
    // First, login as admin to set up a test organization without billing info
    await page.goto(`${BASE_URL}/dev-login.html`);
    await page.waitForLoadState('networkidle');

    // Debug: take screenshot to see what's on screen
    await page.screenshot({ path: 'tests/screenshots/00-dev-login-mobile.png' });

    // Click on Admin Tester (first user card) - try different selectors
    const userCard = page.locator('.user-card').first();
    await userCard.waitFor({ state: 'visible', timeout: 10000 });
    await userCard.click();
    await page.waitForURL('**/dashboard**', { timeout: 15000 });

    // Take screenshot of dashboard
    await page.screenshot({ path: 'tests/screenshots/01-admin-dashboard.png' });

    // Now we need to create a scenario where the profile modal shows
    // The modal shows when: org is not personal, no active subscription, missing company_type or revenue_tier

    // Let's directly test the modal by injecting it via JavaScript
    // First navigate to dashboard.html
    await page.goto(`${BASE_URL}/dashboard.html`);
    await page.waitForLoadState('networkidle');

    // Force show the profile modal for testing
    await page.evaluate(() => {
      const modal = document.getElementById('profileModal');
      if (modal) {
        modal.classList.add('show');
        modal.style.display = 'flex';
      }
    });

    // Wait for modal to be visible
    await page.waitForSelector('#profileModal.show', { state: 'visible' });

    // Take screenshot of the modal on mobile
    await page.screenshot({ path: 'tests/screenshots/02-profile-modal-mobile.png', fullPage: true });

    // Verify the modal is visible
    const modal = page.locator('#profileModal');
    await expect(modal).toBeVisible();

    // Check that the modal title is visible
    const title = page.locator('#profileModal h2, #profileModalTitle');
    await expect(title).toContainText('Tell Us About Your Organization');

    // Verify radio options are visible and not cut off
    const radioOptions = page.locator('.profile-radio-option');
    const count = await radioOptions.count();
    expect(count).toBeGreaterThan(0);

    // Check that the first radio option title is fully visible (not truncated)
    const firstOptionTitle = page.locator('.profile-radio-option-title').first();
    await expect(firstOptionTitle).toBeVisible();

    // Check bounding box to ensure it's within viewport
    const viewport = page.viewportSize();
    const titleBox = await firstOptionTitle.boundingBox();

    if (titleBox && viewport) {
      // Title should be within the viewport width
      expect(titleBox.x).toBeGreaterThanOrEqual(0);
      expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(viewport.width + 10); // small tolerance
    }

    // Check that the Continue button is visible
    const continueBtn = page.locator('#profileModal button, #saveProfileBtn');
    await expect(continueBtn.first()).toBeVisible();

    // Select an organization type
    await page.click('.profile-radio-option:has-text("AI & Tech Platforms")');
    await page.waitForSelector('.profile-radio-option.selected:has-text("AI & Tech Platforms")');
    await page.screenshot({ path: 'tests/screenshots/03-org-type-selected.png' });

    // Select a revenue tier
    await page.click('.profile-radio-option:has-text("Under $1M")');
    await page.waitForSelector('.profile-radio-option.selected:has-text("Under $1M")');
    await page.screenshot({ path: 'tests/screenshots/04-revenue-selected.png' });

    console.log('Mobile profile modal test passed!');
  });

  test('membership page displays correctly on mobile', async ({ page }) => {
    // Login first
    await page.goto(`${BASE_URL}/dev-login.html`);
    await page.waitForLoadState('networkidle');
    const userCard = page.locator('.user-card').first();
    await userCard.waitFor({ state: 'visible', timeout: 10000 });
    await userCard.click();
    await page.waitForURL('**/dashboard**', { timeout: 15000 });

    // Go to membership page
    await page.goto(`${BASE_URL}/dashboard-membership.html`);
    await page.waitForLoadState('networkidle');

    await page.screenshot({ path: 'tests/screenshots/05-membership-page-mobile.png', fullPage: true });

    // Force show the profile modal on this page too
    await page.evaluate(() => {
      const modal = document.getElementById('profileModal');
      if (modal) {
        modal.classList.add('show');
        modal.style.display = 'flex';
      }
    });

    await page.waitForTimeout(500);
    await page.screenshot({ path: 'tests/screenshots/06-membership-modal-mobile.png', fullPage: true });

    // Verify modal content fits on mobile
    const modalBody = page.locator('.profile-modal-body');
    await expect(modalBody).toBeVisible();

    // Check viewport bounds
    const viewport = page.viewportSize();
    const bodyBox = await modalBody.boundingBox();

    if (bodyBox && viewport) {
      // Modal body should fit within viewport
      expect(bodyBox.width).toBeLessThanOrEqual(viewport.width);
    }
  });
});
