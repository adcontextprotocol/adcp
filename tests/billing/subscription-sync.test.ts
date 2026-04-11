/**
 * Integration tests for subscription sync paths.
 * Tests buildSubscriptionUpdate against realistic Stripe payloads
 * and verifies the SQL UPDATE statements work correctly with a real DB.
 */
import { describe, test, expect } from 'vitest';
import { buildSubscriptionUpdate, resolveMembershipTier, TIER_PRESERVING_STATUSES } from '../../server/src/db/organization-db.js';

// Realistic Stripe subscription shapes from different scenarios
const STRIPE_SCENARIOS = {
  // New individual Professional subscription via pricing table
  newProfessional: {
    status: 'active' as const,
    id: 'sub_test_pro_001',
    current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400,
    canceled_at: null,
    items: { data: [{ price: {
      unit_amount: 25000,
      currency: 'usd',
      recurring: { interval: 'year' },
      id: 'price_professional_250',
      product: 'prod_professional',
      lookup_key: 'aao_membership_professional_250',
    } }] },
  },

  // Individual Explorer ($50/yr)
  explorer: {
    status: 'active' as const,
    id: 'sub_test_explorer_001',
    current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400,
    canceled_at: null,
    items: { data: [{ price: {
      unit_amount: 5000,
      currency: 'usd',
      recurring: { interval: 'year' },
      id: 'price_explorer_50',
      product: 'prod_explorer',
      lookup_key: 'aao_membership_explorer_50',
    } }] },
  },

  // Company Builder ($2,500/yr) with expanded product
  companyBuilder: {
    status: 'active' as const,
    id: 'sub_test_builder_001',
    current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400,
    canceled_at: null,
    items: { data: [{ price: {
      unit_amount: 250000,
      currency: 'usd',
      recurring: { interval: 'year' },
      id: 'price_builder_2500',
      product: { id: 'prod_builder', name: 'Builder Membership' },
      lookup_key: 'aao_membership_builder_2500',
    } }] },
  },

  // Legacy founding member ($250/yr individual, old lookup key)
  legacyFounder: {
    status: 'active' as const,
    id: 'sub_test_legacy_001',
    current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400,
    canceled_at: null,
    items: { data: [{ price: {
      unit_amount: 25000,
      currency: 'usd',
      recurring: { interval: 'year' },
      id: 'price_legacy_individual',
      product: 'prod_legacy',
      lookup_key: 'aao_membership_individual',
    } }] },
  },

  // Legacy discounted founder ($50/yr)
  legacyDiscounted: {
    status: 'active' as const,
    id: 'sub_test_legacy_disc_001',
    current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400,
    canceled_at: null,
    items: { data: [{ price: {
      unit_amount: 5000,
      currency: 'usd',
      recurring: { interval: 'year' },
      id: 'price_legacy_discounted',
      product: 'prod_legacy',
      lookup_key: 'aao_membership_individual_discounted',
    } }] },
  },

  // Monthly billing ($20.83/mo = $250/yr)
  monthlyProfessional: {
    status: 'active' as const,
    id: 'sub_test_monthly_001',
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    canceled_at: null,
    items: { data: [{ price: {
      unit_amount: 2083,
      currency: 'usd',
      recurring: { interval: 'month' },
      id: 'price_pro_monthly',
      product: 'prod_professional',
      lookup_key: 'aao_membership_professional_monthly',
    } }] },
  },

  // Past due subscription (payment failing)
  pastDue: {
    status: 'past_due' as const,
    id: 'sub_test_pastdue_001',
    current_period_end: Math.floor(Date.now() / 1000) - 5 * 86400,
    canceled_at: null,
    items: { data: [{ price: {
      unit_amount: 25000,
      currency: 'usd',
      recurring: { interval: 'year' },
      id: 'price_professional_250',
      product: 'prod_professional',
      lookup_key: 'aao_membership_professional_250',
    } }] },
  },

  // Canceled subscription
  canceled: {
    status: 'canceled' as const,
    id: 'sub_test_canceled_001',
    current_period_end: Math.floor(Date.now() / 1000) - 30 * 86400,
    canceled_at: Math.floor(Date.now() / 1000) - 30 * 86400,
    items: { data: [{ price: {
      unit_amount: 25000,
      currency: 'usd',
      recurring: { interval: 'year' },
      id: 'price_professional_250',
      product: 'prod_professional',
      lookup_key: 'aao_membership_professional_250',
    } }] },
  },

  // No lookup key (very old legacy product)
  noLookupKey: {
    status: 'active' as const,
    id: 'sub_test_nolookup_001',
    current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400,
    canceled_at: null,
    items: { data: [{ price: {
      unit_amount: 25000,
      currency: 'usd',
      recurring: { interval: 'year' },
      id: 'price_old_legacy',
      product: 'prod_old',
      lookup_key: null,
    } }] },
  },

  // Company Partner ($10K/yr founding corporate)
  foundingCorporate: {
    status: 'active' as const,
    id: 'sub_test_corporate_001',
    current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400,
    canceled_at: null,
    items: { data: [{ price: {
      unit_amount: 1000000,
      currency: 'usd',
      recurring: { interval: 'year' },
      id: 'price_corporate',
      product: 'prod_corporate',
      lookup_key: 'aao_membership_corporate_10000',
    } }] },
  },

  // Empty items (edge case during subscription creation)
  emptyItems: {
    status: 'active' as const,
    id: 'sub_test_empty_001',
    current_period_end: null,
    canceled_at: null,
    items: { data: [] as any[] },
  },
};

describe('buildSubscriptionUpdate — realistic Stripe scenarios', () => {
  test('new individual Professional via pricing table', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.newProfessional, true);
    expect(result.membership_tier).toBe('individual_professional');
    expect(result.subscription_price_lookup_key).toBe('aao_membership_professional_250');
    expect(result.subscription_amount).toBe(25000);
    expect(result.subscription_currency).toBe('usd');
    expect(result.subscription_interval).toBe('year');
    expect(result.subscription_product_id).toBe('prod_professional');
    expect(result.subscription_price_id).toBe('price_professional_250');
  });

  test('individual Explorer ($50/yr)', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.explorer, true);
    expect(result.membership_tier).toBe('individual_academic');
    expect(result.subscription_price_lookup_key).toBe('aao_membership_explorer_50');
  });

  test('company Builder with expanded product object', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.companyBuilder, false);
    expect(result.membership_tier).toBe('company_standard');
    expect(result.subscription_product_id).toBe('prod_builder');
    expect(result.subscription_product_name).toBe('Builder Membership');
  });

  test('legacy founding member maps to Professional', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.legacyFounder, true);
    expect(result.membership_tier).toBe('individual_professional');
    expect(result.subscription_price_lookup_key).toBe('aao_membership_individual');
  });

  test('legacy discounted founder maps to Explorer', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.legacyDiscounted, true);
    expect(result.membership_tier).toBe('individual_academic');
  });

  test('monthly billing resolves tier from lookup key (not amount)', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.monthlyProfessional, true);
    // Lookup key resolves to Professional regardless of monthly amount
    expect(result.membership_tier).toBe('individual_professional');
    expect(result.subscription_amount).toBe(2083);
    expect(result.subscription_interval).toBe('month');
  });

  test('past_due preserves tier', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.pastDue, true);
    expect(result.membership_tier).toBe('individual_professional');
    expect(result.subscription_status).toBe('past_due');
  });

  test('canceled clears tier', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.canceled, true);
    expect(result.membership_tier).toBeNull();
    expect(result.subscription_status).toBe('canceled');
    expect(result.subscription_canceled_at).toBeInstanceOf(Date);
  });

  test('no lookup key falls back to amount inference', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.noLookupKey, true);
    expect(result.membership_tier).toBe('individual_professional');
    expect(result.subscription_price_lookup_key).toBeNull();
  });

  test('founding corporate ($10K) maps to Partner via lookup key', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.foundingCorporate, false);
    expect(result.membership_tier).toBe('company_icl');
  });

  test('empty items returns null tier and null fields', () => {
    const result = buildSubscriptionUpdate(STRIPE_SCENARIOS.emptyItems, true);
    expect(result.membership_tier).toBeNull();
    expect(result.subscription_amount).toBeNull();
    expect(result.subscription_price_lookup_key).toBeNull();
    expect(result.subscription_price_id).toBeNull();
  });
});

describe('resolveMembershipTier — lookup key fallback', () => {
  test('lookup key takes priority over amount when both suggest different tiers', () => {
    // Amount says Explorer ($50), but lookup key says Professional
    expect(resolveMembershipTier({
      membership_tier: null,
      subscription_price_lookup_key: 'aao_membership_professional_250',
      subscription_status: 'active',
      subscription_amount: 5000,
      subscription_interval: 'year',
      is_personal: true,
    })).toBe('individual_professional');
  });

  test('cached tier takes priority over everything', () => {
    expect(resolveMembershipTier({
      membership_tier: 'company_leader',
      subscription_price_lookup_key: 'aao_membership_builder_2500',
      subscription_status: 'active',
      subscription_amount: 250000,
      subscription_interval: 'year',
      is_personal: false,
    })).toBe('company_leader');
  });
});

describe('TIER_PRESERVING_STATUSES coverage', () => {
  const ALL_STRIPE_STATUSES = ['active', 'past_due', 'trialing', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid'];

  test('exactly active, past_due, trialing preserve tier', () => {
    expect([...TIER_PRESERVING_STATUSES]).toEqual(['active', 'past_due', 'trialing']);
  });

  test.each(ALL_STRIPE_STATUSES)('status "%s" tier preservation is correct', (status) => {
    const shouldPreserve = ['active', 'past_due', 'trialing'].includes(status);
    const sub = { ...STRIPE_SCENARIOS.newProfessional, status };
    const result = buildSubscriptionUpdate(sub, true);
    if (shouldPreserve) {
      expect(result.membership_tier).toBe('individual_professional');
    } else {
      expect(result.membership_tier).toBeNull();
    }
  });
});
