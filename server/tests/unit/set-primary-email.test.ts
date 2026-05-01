import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isEmailUnavailable } from '../../src/routes/account-linking-errors.js';

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
    expect(source).toMatch(/getWorkos\(\)\.userManagement\.updateUser/);
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

  it('updates WorkOS before the DB swap so a WorkOS rejection leaves DB state untouched', () => {
    const beginIdx = source.indexOf("'BEGIN'");
    const workosIdx = source.indexOf('getWorkos().userManagement.updateUser');
    expect(workosIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(workosIdx).toBeLessThan(beginIdx);
  });

  it('classifies WorkOS rejections via isEmailUnavailable and returns a friendly 409', () => {
    expect(source).toMatch(/isEmailUnavailable\(workosError\)/);
    expect(source).toMatch(/already associated with another account/);
  });

  it('rolls back on error', () => {
    expect(source).toMatch(/ROLLBACK/);
  });
});

describe('isEmailUnavailable', () => {
  it('matches WorkOS GenericServerException with "This email is not available" message', () => {
    expect(isEmailUnavailable({
      name: 'GenericServerException',
      status: 422,
      message: 'This email is not available.',
    })).toBe(true);
  });

  it('matches by code regardless of status', () => {
    expect(isEmailUnavailable({ code: 'email_already_exists' })).toBe(true);
    expect(isEmailUnavailable({ code: 'email_not_available' })).toBe(true);
  });

  it('matches a 409 conflict response', () => {
    expect(isEmailUnavailable({ status: 409, message: 'Conflict' })).toBe(true);
  });

  it('does NOT match a bare 422 with an unrelated validation message', () => {
    expect(isEmailUnavailable({
      status: 422,
      message: 'Password does not meet complexity requirements.',
    })).toBe(false);
  });

  it('does NOT match a generic server error', () => {
    expect(isEmailUnavailable({ status: 500, message: 'Internal server error' })).toBe(false);
  });

  it('does NOT match a vague "email already verified" message', () => {
    expect(isEmailUnavailable({ status: 422, message: 'Email already verified' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isEmailUnavailable(null)).toBe(false);
    expect(isEmailUnavailable(undefined)).toBe(false);
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
