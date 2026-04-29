import { describe, it, expect } from 'vitest';
import {
  API_ACCESS_TIERS,
  ACTIVE_SUBSCRIPTION_STATUSES,
  isApiAccessTier,
  isActiveSubscriptionStatus,
  tierLabel,
} from '../../src/services/membership-tiers.js';

describe('membership-tiers', () => {
  describe('API_ACCESS_TIERS', () => {
    it('matches the canonical heartbeat tier list', () => {
      // If this test fails, server/src/addie/jobs/compliance-heartbeat.ts
      // is also broken — they read from the same constant. Keep this test
      // as the contract: changing API access requires changing the constant.
      expect(API_ACCESS_TIERS).toEqual([
        'individual_professional',
        'company_standard',
        'company_icl',
        'company_leader',
      ]);
    });

    it('does not include explorer (free tier)', () => {
      expect(API_ACCESS_TIERS).not.toContain('explorer');
    });
  });

  describe('isApiAccessTier', () => {
    it('returns true for every tier in API_ACCESS_TIERS', () => {
      for (const tier of API_ACCESS_TIERS) {
        expect(isApiAccessTier(tier)).toBe(true);
      }
    });

    it('returns false for explorer (free tier)', () => {
      expect(isApiAccessTier('explorer')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isApiAccessTier(null)).toBe(false);
      expect(isApiAccessTier(undefined)).toBe(false);
    });

    it('returns false for unknown future tiers', () => {
      expect(isApiAccessTier('company_galactic')).toBe(false);
    });
  });

  describe('isActiveSubscriptionStatus', () => {
    it('accepts active, past_due, trialing — past_due intentionally counts as eligible', () => {
      expect(isActiveSubscriptionStatus('active')).toBe(true);
      expect(isActiveSubscriptionStatus('past_due')).toBe(true);
      expect(isActiveSubscriptionStatus('trialing')).toBe(true);
    });

    it('rejects canceled, unpaid, incomplete', () => {
      expect(isActiveSubscriptionStatus('canceled')).toBe(false);
      expect(isActiveSubscriptionStatus('unpaid')).toBe(false);
      expect(isActiveSubscriptionStatus('incomplete')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isActiveSubscriptionStatus(null)).toBe(false);
      expect(isActiveSubscriptionStatus(undefined)).toBe(false);
    });
  });

  describe('tierLabel', () => {
    it('returns human-readable labels for known tiers', () => {
      expect(tierLabel('explorer')).toBe('Explorer');
      expect(tierLabel('individual_professional')).toBe('Professional');
      expect(tierLabel('company_standard')).toBe('Builder');
      expect(tierLabel('company_icl')).toBe('Member');
      expect(tierLabel('company_leader')).toBe('Leader');
    });

    it('falls back to the raw enum for unknown tiers (forward-compat)', () => {
      expect(tierLabel('company_galactic')).toBe('company_galactic');
    });

    it('returns null for null/undefined', () => {
      expect(tierLabel(null)).toBeNull();
      expect(tierLabel(undefined)).toBeNull();
    });
  });

  it('subscription statuses match the heartbeat query', () => {
    expect(ACTIVE_SUBSCRIPTION_STATUSES).toEqual(['active', 'past_due', 'trialing']);
  });
});
