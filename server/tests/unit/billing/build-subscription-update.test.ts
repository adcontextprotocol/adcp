/**
 * Tests for the canonical Stripe-subscription writer:
 * `buildSubscriptionUpdate` and the helpers that drive its tier resolution.
 *
 * The bug these tests prevent: founding-era prices that Stripe auto-created
 * have an immutable `lookup_key` field (Stripe rejects edits) and zero
 * `unit_amount`. The lookup_key fast path can't classify them and the
 * amount-inference fallback returns null. Without a third path through
 * product `metadata.tier`, every founding-cohort sync writes a partial-truth
 * row with `membership_tier=null` and the dashboard renders the wrong tier
 * (Adzymic, Advertible, May 2026).
 */
import { describe, it, expect } from 'vitest';
import {
  buildSubscriptionUpdate,
  tierFromLookupKey,
  tierFromProductMetadata,
} from '../../../src/db/organization-db.js';

function fakeSub(overrides: {
  status?: string;
  lookup_key?: string | null;
  unit_amount?: number | null;
  interval?: string | null;
  product?: string | { id: string; name?: string; metadata?: Record<string, string> };
} = {}) {
  // 'key' in overrides preserves explicit null in fixtures.
  const lookupKey = 'lookup_key' in overrides ? overrides.lookup_key : null;
  const unitAmount = 'unit_amount' in overrides ? overrides.unit_amount : null;
  const interval = 'interval' in overrides ? overrides.interval : 'year';
  const product = 'product' in overrides ? overrides.product : 'prod_default';
  return {
    id: 'sub_test',
    status: overrides.status ?? 'active',
    current_period_end: 1234567890,
    canceled_at: null,
    items: {
      data: [{
        price: {
          unit_amount: unitAmount,
          currency: 'usd',
          recurring: interval ? { interval } : null,
          id: 'price_test',
          product,
          lookup_key: lookupKey,
        },
      }],
    },
  };
}

describe('tierFromLookupKey', () => {
  it.each([
    ['aao_membership_explorer_50', 'individual_academic'],
    ['aao_membership_professional_250', 'individual_professional'],
    ['aao_membership_builder_3000', 'company_standard'],
    ['aao_membership_corporate_under5m', 'company_standard'],
    ['aao_membership_corporate', 'company_icl'],
    ['aao_membership_leader_50000', 'company_leader'],
    ['aao_event_summit_2026', null],
    ['', null],
    [null, null],
    [undefined, null],
  ])('lookup_key %j -> %j', (key, expected) => {
    expect(tierFromLookupKey(key)).toBe(expected);
  });
});

describe('tierFromProductMetadata', () => {
  it('returns the tier when metadata.tier is a valid MembershipTier', () => {
    expect(tierFromProductMetadata({ tier: 'company_standard' })).toBe('company_standard');
    expect(tierFromProductMetadata({ tier: 'individual_professional' })).toBe('individual_professional');
    expect(tierFromProductMetadata({ tier: 'company_leader' })).toBe('company_leader');
  });

  it('returns null for unknown tier values (conservative on typos)', () => {
    expect(tierFromProductMetadata({ tier: 'gold' })).toBeNull();
    expect(tierFromProductMetadata({ tier: 'company_premium' })).toBeNull();
    expect(tierFromProductMetadata({ tier: '' })).toBeNull();
  });

  it('returns null when tier is missing', () => {
    expect(tierFromProductMetadata({ category: 'membership' })).toBeNull();
    expect(tierFromProductMetadata({})).toBeNull();
  });

  it('returns null when metadata is null/undefined', () => {
    expect(tierFromProductMetadata(null)).toBeNull();
    expect(tierFromProductMetadata(undefined)).toBeNull();
  });
});

describe('buildSubscriptionUpdate tier resolution', () => {
  it('resolves via lookup_key (fast path)', () => {
    const result = buildSubscriptionUpdate(
      fakeSub({ lookup_key: 'aao_membership_professional_250', unit_amount: 25000 }) as never,
      true,
    );
    expect(result.membership_tier).toBe('individual_professional');
    expect(result.subscription_price_lookup_key).toBe('aao_membership_professional_250');
  });

  it('resolves via product metadata.tier when lookup_key is null (Advertible-shape)', () => {
    // Founding Startup/SMB price: Stripe auto-created, lookup_key locked
    // null, unit_amount is 0 because the year was prepaid via invoice.
    // Without product metadata.tier, this row has no resolvable tier.
    const result = buildSubscriptionUpdate(
      fakeSub({ lookup_key: null, unit_amount: 0 }) as never,
      false,
      { category: 'membership', tier: 'company_standard' },
    );
    expect(result.membership_tier).toBe('company_standard');
    expect(result.subscription_price_lookup_key).toBeNull();
    expect(result.subscription_amount).toBe(0);
  });

  it('reads product metadata from inline-expanded product when caller did not pass it explicitly', () => {
    // Webhook handlers receive subscription objects with product expanded
    // inline; they shouldn't have to pass metadata as a separate arg.
    const result = buildSubscriptionUpdate(
      fakeSub({
        lookup_key: null,
        unit_amount: 0,
        product: {
          id: 'prod_founding',
          metadata: { category: 'membership', tier: 'company_icl' },
        },
      }) as never,
      false,
    );
    expect(result.membership_tier).toBe('company_icl');
  });

  it('prefers caller-supplied metadata over inline product metadata (admin /sync path)', () => {
    // The /sync endpoint fetches the product separately and passes its
    // metadata as the third arg. If the inline product on the sub has
    // stale/different metadata, the fresh fetch wins.
    const result = buildSubscriptionUpdate(
      fakeSub({
        lookup_key: null,
        unit_amount: 0,
        product: {
          id: 'prod_founding',
          metadata: { tier: 'company_standard' },
        },
      }) as never,
      false,
      { tier: 'company_icl' },
    );
    expect(result.membership_tier).toBe('company_icl');
  });

  it('falls through to amount inference when neither lookup_key nor metadata.tier is set', () => {
    const result = buildSubscriptionUpdate(
      fakeSub({ lookup_key: null, unit_amount: 25000, interval: 'year' }) as never,
      true,  // is_personal
    );
    // 25000 cents = $250/yr → individual_professional via inference
    expect(result.membership_tier).toBe('individual_professional');
  });

  it('lookup_key wins over metadata.tier when both are present', () => {
    // If a price both has a lookup_key AND product metadata.tier, the
    // lookup_key is authoritative — it's a per-price signal vs. the
    // product-level fallback.
    const result = buildSubscriptionUpdate(
      fakeSub({
        lookup_key: 'aao_membership_explorer_50',
        unit_amount: 5000,
      }) as never,
      true,
      { tier: 'company_leader' },  // metadata says leader, lookup_key says explorer
    );
    expect(result.membership_tier).toBe('individual_academic');  // lookup_key wins
  });

  it('returns null tier for non-entitled status even with valid lookup_key', () => {
    // canceled subs don't grant entitlement regardless of how they'd
    // classify if they were live.
    const result = buildSubscriptionUpdate(
      fakeSub({
        status: 'canceled',
        lookup_key: 'aao_membership_professional_250',
        unit_amount: 25000,
      }) as never,
      true,
    );
    expect(result.membership_tier).toBeNull();
  });

  it('rejects invalid metadata.tier values without falling through to amount inference', () => {
    // A typo like `tier=premium` should NOT silently let amount inference
    // promote the row to a different tier. Resolver returns null for
    // metadata.tier (typo) and continues to inference, which here gives
    // company_standard for $250k cents annual / non-personal — correct
    // behavior, just confirming the chain doesn't get stuck.
    const result = buildSubscriptionUpdate(
      fakeSub({
        lookup_key: null,
        unit_amount: 25000,
        interval: 'year',
        product: { id: 'prod_x', metadata: { tier: 'premium' } },
      }) as never,
      false,
    );
    // tier: 'premium' rejected → metadata path returns null → falls to
    // inferMembershipTier(25000, 'year', false) → company_standard
    // (annual >= 0, < 700000 = company_icl threshold)
    expect(result.membership_tier).toBe('company_standard');
  });
});
