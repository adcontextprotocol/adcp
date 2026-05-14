/**
 * Unit test for the bootstrap rate-limiter skip predicate.
 *
 * The integration suite at server/tests/integration/member-profile-bootstrap.test.ts
 * mocks `memberProfileBootstrapRateLimiter` to a no-op so it can exercise
 * the route without a Postgres-backed limit store; that means the limiter's
 * dispatch contract — "rate-limit bootstrap-shape bodies, skip everything
 * else" — is not exercised end-to-end. This file pins the rule directly,
 * bypassing the express-rate-limit machinery.
 */
import { describe, it, expect } from 'vitest';
import { isMemberProfileBootstrapBody } from '../../src/middleware/rate-limit.js';

describe('isMemberProfileBootstrapBody', () => {
  it('returns true for a minimal bootstrap body', () => {
    expect(
      isMemberProfileBootstrapBody({
        organization_name: 'Acme',
        corporate_domain: 'acme.example',
      }),
    ).toBe(true);
  });

  it('returns true for a full bootstrap body with optional fields', () => {
    expect(
      isMemberProfileBootstrapBody({
        organization_name: 'Acme',
        company_type: 'publisher',
        revenue_tier: '5m_50m',
        corporate_domain: 'acme.example',
        marketing_opt_in: true,
        membership_tier: 'individual_academic',
      }),
    ).toBe(true);
  });

  it('returns false for the legacy dashboard body (display_name + slug)', () => {
    expect(
      isMemberProfileBootstrapBody({
        display_name: 'Acme Profile',
        slug: 'acme',
        tagline: 'we make ads',
      }),
    ).toBe(false);
  });

  it('returns false for a hybrid body (organization_name + display_name) — defers to the legacy handler', () => {
    expect(
      isMemberProfileBootstrapBody({
        organization_name: 'Acme',
        corporate_domain: 'acme.example',
        display_name: 'Acme Profile',
      }),
    ).toBe(false);
  });

  it('returns false when slug alone is present alongside bootstrap fields', () => {
    expect(
      isMemberProfileBootstrapBody({
        organization_name: 'Acme',
        corporate_domain: 'acme.example',
        slug: 'acme',
      }),
    ).toBe(false);
  });

  it('returns false for empty / non-object bodies', () => {
    expect(isMemberProfileBootstrapBody({})).toBe(false);
    expect(isMemberProfileBootstrapBody(undefined)).toBe(false);
    expect(isMemberProfileBootstrapBody(null)).toBe(false);
    expect(isMemberProfileBootstrapBody('not-an-object')).toBe(false);
    expect(isMemberProfileBootstrapBody(42)).toBe(false);
  });

  it('returns false when only one of the two required fields is a string', () => {
    expect(
      isMemberProfileBootstrapBody({
        organization_name: 'Acme',
      }),
    ).toBe(false);
    expect(
      isMemberProfileBootstrapBody({
        corporate_domain: 'acme.example',
      }),
    ).toBe(false);
  });

  it('returns false when the required fields are present but not strings', () => {
    expect(
      isMemberProfileBootstrapBody({
        organization_name: 42,
        corporate_domain: 'acme.example',
      }),
    ).toBe(false);
    expect(
      isMemberProfileBootstrapBody({
        organization_name: 'Acme',
        corporate_domain: { hostname: 'acme.example' },
      }),
    ).toBe(false);
  });
});
