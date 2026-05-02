/**
 * Tests for the membership-price predicate + sub picker shared between
 * the integrity invariant, the /sync endpoint, and (future) the cron
 * reconciler. The bug this prevents is the inline `subscriptions.data[0]`
 * pattern that picks the wrong sub when a customer has a non-membership
 * sub stacked alongside a real membership.
 */
import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  isMembershipLookupKey,
  isMembershipProductByMetadata,
  isMembershipSub,
  pickMembershipSub,
  pickMembershipSubWithProductFetch,
} from '../../../src/billing/membership-prices.js';

function fakeSub(overrides: {
  id?: string;
  status?: Stripe.Subscription.Status;
  lookup_key?: string | null;
  product?: string | { id: string; metadata?: Record<string, string>; deleted?: boolean };
} = {}): Stripe.Subscription {
  // 'lookup_key' in overrides preserves explicit null (vs ?? which would
  // substitute the default for null too). Tests need to assert behavior
  // against missing lookup_keys.
  const lookupKey = 'lookup_key' in overrides ? overrides.lookup_key : 'aao_membership_professional_250';
  const product = 'product' in overrides ? overrides.product : 'prod_default';
  return {
    id: overrides.id ?? 'sub_x',
    status: overrides.status ?? 'active',
    items: {
      data: [{
        price: { lookup_key: lookupKey, product },
      }],
    },
  } as unknown as Stripe.Subscription;
}

describe('isMembershipLookupKey', () => {
  it.each([
    ['aao_membership_explorer_50', true],
    ['aao_membership_professional_250', true],
    ['aao_membership_builder_3000', true],
    ['aao_membership_member_15000', true],
    ['aao_membership_leader_50000', true],
    ['aao_invoice_corporate_2025', true],
    ['aao_membership_individual_discounted', true],
    ['aao_event_summit_2026', false],
    ['some_other_product', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('lookup_key %j -> %j', (key, expected) => {
    expect(isMembershipLookupKey(key)).toBe(expected);
  });
});

describe('isMembershipProductByMetadata', () => {
  it('true when product metadata.category === "membership"', () => {
    expect(isMembershipProductByMetadata({ id: 'prod_x', metadata: { category: 'membership' } } as never))
      .toBe(true);
  });
  it('false when product is a string id (caller did not expand)', () => {
    expect(isMembershipProductByMetadata('prod_x')).toBe(false);
  });
  it('false when metadata is absent', () => {
    expect(isMembershipProductByMetadata({ id: 'prod_x' } as never)).toBe(false);
  });
  it('false when category is something else', () => {
    expect(isMembershipProductByMetadata({ id: 'prod_x', metadata: { category: 'event' } } as never))
      .toBe(false);
  });
  it('false when product is null/undefined', () => {
    expect(isMembershipProductByMetadata(null)).toBe(false);
    expect(isMembershipProductByMetadata(undefined)).toBe(false);
  });
  it('false when product is a deleted product', () => {
    expect(isMembershipProductByMetadata({ id: 'prod_x', deleted: true } as never)).toBe(false);
  });
});

describe('isMembershipSub', () => {
  it('true when first item has a membership lookup_key', () => {
    expect(isMembershipSub(fakeSub())).toBe(true);
  });
  it('false when first item has a non-membership lookup_key and no product metadata', () => {
    expect(isMembershipSub(fakeSub({ lookup_key: 'aao_event_ticket' }))).toBe(false);
  });
  it('false when lookup_key is missing and product is a string id', () => {
    expect(isMembershipSub(fakeSub({ lookup_key: null }))).toBe(false);
  });
  it('true when lookup_key is missing but product metadata.category=membership (founding-era)', () => {
    // Founding Startup/SMB and Corporate prices were created in the Stripe
    // Dashboard before the lookup_key convention. They carry the
    // category=membership metadata on the product instead. Without this
    // path, pickMembershipSub silently filters them out.
    const sub = fakeSub({
      lookup_key: null,
      product: { id: 'prod_founding', metadata: { category: 'membership' } },
    });
    expect(isMembershipSub(sub)).toBe(true);
  });
  it('false when lookup_key is missing and product metadata.category is event', () => {
    const sub = fakeSub({
      lookup_key: null,
      product: { id: 'prod_event', metadata: { category: 'event' } },
    });
    expect(isMembershipSub(sub)).toBe(false);
  });
});

describe('pickMembershipSub', () => {
  it('returns null on empty list', () => {
    expect(pickMembershipSub([])).toBeNull();
  });

  it('returns null when no item is a membership sub', () => {
    const subs = [
      fakeSub({ id: 'sub_event', lookup_key: 'aao_event_ticket' }),
      fakeSub({ id: 'sub_other', lookup_key: 'unrelated_product' }),
    ];
    expect(pickMembershipSub(subs)).toBeNull();
  });

  it('picks the membership sub when stacked with a non-membership sub (the data[0] bug)', () => {
    // Order matters: non-membership listed first. data[0] would pick the wrong one.
    const subs = [
      fakeSub({ id: 'sub_event', lookup_key: 'aao_event_ticket' }),
      fakeSub({ id: 'sub_member', lookup_key: 'aao_membership_explorer_50' }),
    ];
    expect(pickMembershipSub(subs)?.id).toBe('sub_member');
  });

  it('picks the membership sub when it appears first too', () => {
    const subs = [
      fakeSub({ id: 'sub_member', lookup_key: 'aao_membership_explorer_50' }),
      fakeSub({ id: 'sub_event', lookup_key: 'aao_event_ticket' }),
    ];
    expect(pickMembershipSub(subs)?.id).toBe('sub_member');
  });

  it('prefers active over trialing when (anomalously) two membership subs exist', () => {
    // This is itself a one-active-stripe-sub-per-org violation — the picker
    // breaks the tie deterministically rather than letting Stripe ordering decide.
    const subs = [
      fakeSub({ id: 'sub_trial', status: 'trialing', lookup_key: 'aao_membership_explorer_50' }),
      fakeSub({ id: 'sub_active', status: 'active', lookup_key: 'aao_membership_professional_250' }),
    ];
    expect(pickMembershipSub(subs)?.id).toBe('sub_active');
  });

  it('returns the trialing sub when no active membership exists', () => {
    const subs = [
      fakeSub({ id: 'sub_trial', status: 'trialing', lookup_key: 'aao_membership_explorer_50' }),
    ];
    expect(pickMembershipSub(subs)?.id).toBe('sub_trial');
  });

  it('picks a founding sub identified by product metadata when lookup_key is missing', () => {
    // Mirrors the Adzymic/Advertible/Bidcliq/Equativ shape (May 2026): real
    // Stripe sub on a founding-era price with no lookup_key, only product
    // metadata. Without the metadata fallback the picker returns null and
    // /sync silently fails.
    const subs = [
      fakeSub({
        id: 'sub_founding',
        lookup_key: null,
        product: { id: 'prod_founding_corp', metadata: { category: 'membership' } },
      }),
    ];
    expect(pickMembershipSub(subs)?.id).toBe('sub_founding');
  });
});

describe('pickMembershipSubWithProductFetch', () => {
  it('returns the lookup_key match without invoking fetchProduct (fast path)', async () => {
    const fetchProduct = vi.fn();
    const subs = [
      fakeSub({ id: 'sub_member', lookup_key: 'aao_membership_explorer_50', product: 'prod_x' }),
    ];
    const result = await pickMembershipSubWithProductFetch(subs, fetchProduct);
    expect(result?.id).toBe('sub_member');
    expect(fetchProduct).not.toHaveBeenCalled();
  });

  it('falls back to product metadata when no lookup_key matches', async () => {
    // Adzymic / Advertible / Bidcliq / Equativ shape: founding-era sub
    // with no aao_membership_ lookup_key, but the product is tagged
    // category=membership. The async picker fetches the product and
    // recovers the classification.
    const fetchProduct = vi.fn().mockResolvedValue({
      id: 'prod_founding_corp',
      metadata: { category: 'membership' },
    });
    const subs = [
      fakeSub({ id: 'sub_founding', lookup_key: null, product: 'prod_founding_corp' }),
    ];
    const result = await pickMembershipSubWithProductFetch(subs, fetchProduct);
    expect(result?.id).toBe('sub_founding');
    expect(fetchProduct).toHaveBeenCalledWith('prod_founding_corp');
  });

  it('returns null when neither lookup_key nor product metadata matches', async () => {
    const fetchProduct = vi.fn().mockResolvedValue({
      id: 'prod_event',
      metadata: { category: 'event' },
    });
    const subs = [
      fakeSub({ id: 'sub_event', lookup_key: null, product: 'prod_event' }),
    ];
    const result = await pickMembershipSubWithProductFetch(subs, fetchProduct);
    expect(result).toBeNull();
  });

  it('skips a candidate whose product fetch throws (does not crash the whole sync)', async () => {
    // One bad fetch shouldn't tank the rest. The next candidate's product
    // is a real membership; the picker should still find it.
    const fetchProduct = vi.fn()
      .mockRejectedValueOnce(new Error('Stripe transient'))
      .mockResolvedValueOnce({
        id: 'prod_founding',
        metadata: { category: 'membership' },
      });
    const subs = [
      fakeSub({ id: 'sub_bad', lookup_key: null, product: 'prod_bad' }),
      fakeSub({ id: 'sub_good', lookup_key: null, product: 'prod_founding' }),
    ];
    const result = await pickMembershipSubWithProductFetch(subs, fetchProduct);
    expect(result?.id).toBe('sub_good');
  });

  it('skips a sub whose price.product is not a string (already expanded by caller)', async () => {
    // If a caller does expand the product inline, the sync function
    // doesn't need a fetch — but pickMembershipSub (sync) would have
    // caught it on the fast path. Here we cover the edge: expanded but
    // non-membership. fetchProduct should not be called.
    const fetchProduct = vi.fn();
    const subs = [
      fakeSub({
        id: 'sub_expanded_event',
        lookup_key: null,
        product: { id: 'prod_event', metadata: { category: 'event' } },
      }),
    ];
    const result = await pickMembershipSubWithProductFetch(subs, fetchProduct);
    expect(result).toBeNull();
    expect(fetchProduct).not.toHaveBeenCalled();
  });
});
