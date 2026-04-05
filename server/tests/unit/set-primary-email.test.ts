import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Static analysis test for the set-primary-email endpoint.
 * Verifies the route handler exists and follows the correct swap pattern.
 */

const ACCOUNT_LINKING_FILE = path.resolve(
  __dirname,
  '../../src/routes/account-linking.ts'
);

const DASHBOARD_SETTINGS_FILE = path.resolve(
  __dirname,
  '../../public/dashboard-settings.html'
);

describe('Set primary email endpoint', () => {
  const source = fs.readFileSync(ACCOUNT_LINKING_FILE, 'utf-8');

  it('registers a PUT /primary route on the router', () => {
    expect(source).toMatch(/router\.put\(\s*['"]\/primary['"]/);
  });

  it('requires authentication and rate limiting', () => {
    expect(source).toMatch(/router\.put\(\s*['"]\/primary['"],\s*requireAuth,\s*verifyExecuteLimiter/);
  });

  it('validates email is a verified alias before swapping', () => {
    expect(source).toMatch(/user_email_aliases/);
    expect(source).toMatch(/workos_user_id = \$1 AND LOWER\(email\) = \$2 AND verified_at IS NOT NULL/);
  });

  it('updates WorkOS as source of truth', () => {
    expect(source).toMatch(/workos\.userManagement\.updateUser/);
  });

  it('swaps emails in a transaction', () => {
    // Must use BEGIN/COMMIT for atomicity
    expect(source).toMatch(/BEGIN/);
    expect(source).toMatch(/COMMIT/);
    // Must update users table
    expect(source).toMatch(/UPDATE users SET email/);
    // Must delete alias for new primary
    expect(source).toMatch(/DELETE FROM user_email_aliases/);
    // Must insert old primary as alias
    expect(source).toMatch(/INSERT INTO user_email_aliases[\s\S]*?VALUES/);
  });

  it('locks alias row with FOR UPDATE to prevent races', () => {
    expect(source).toMatch(/FOR UPDATE/);
  });

  it('does DB swap before WorkOS update so rollback is clean', () => {
    // WorkOS updateUser must appear after the DB operations but before COMMIT
    const beginIdx = source.indexOf("'BEGIN'");
    const commitIdx = source.indexOf("'COMMIT'");
    const workosIdx = source.indexOf('workos.userManagement.updateUser', beginIdx);
    expect(workosIdx).toBeGreaterThan(beginIdx);
    expect(workosIdx).toBeLessThan(commitIdx);
  });

  it('rolls back on error', () => {
    expect(source).toMatch(/ROLLBACK/);
  });
});

describe('Set primary email UI', () => {
  const html = fs.readFileSync(DASHBOARD_SETTINGS_FILE, 'utf-8');

  it('renders a "Make primary" button for each alias', () => {
    expect(html).toMatch(/make-primary-btn/);
    expect(html).toMatch(/Make primary/);
  });

  it('calls PUT /api/me/linked-emails/primary', () => {
    expect(html).toMatch(/\/api\/me\/linked-emails\/primary/);
    expect(html).toMatch(/method:\s*['"]PUT['"]/);
  });

  it('confirms before changing primary', () => {
    expect(html).toMatch(/confirm\(/);
  });

  it('disables buttons during request to prevent double-click', () => {
    expect(html).toMatch(/b\.disabled = true/);
    expect(html).toMatch(/b\.disabled = false/);
  });

  it('reloads linked emails after success', () => {
    expect(html).toMatch(/loadLinkedEmails\(\)/);
  });
});
