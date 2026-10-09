import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isEmailUnavailable } from '../../src/routes/account-linking-errors.js';

const DASHBOARD_SETTINGS_FILE = path.resolve(
  __dirname,
  '../../public/dashboard-settings.html'
);

// The executable identity-mutation-route-containment suite covers this route's
// refusal before provider and database access. Keep helper/UI coverage here.

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

describe('Link email recovery UI', () => {
  const html = fs.readFileSync(DASHBOARD_SETTINGS_FILE, 'utf-8');

  it('prefers the server recovery message over the generic error', () => {
    expect(html).toMatch(/data\.message \|\| data\.error \|\| 'Failed to send verification'/);
  });

  it('shows the recovery message safely with an actionable support link', () => {
    expect(html).toContain('href="mailto:support@agenticadvertising.org"');
    expect(html).toMatch(/linkEmailWarningMessage'\)\.textContent = message/);
    expect(html).toMatch(/linkEmailWarning'\)\.style\.display = 'block'/);
  });

  it('does not promise to merge existing accounts through self-service', () => {
    expect(html).toContain("Existing accounts can't be combined through this form");
    expect(html).not.toContain('your accounts will be merged');
  });
});
