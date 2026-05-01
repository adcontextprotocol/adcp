/**
 * Tests for the membership-price predicate + sub picker shared between
 * the integrity invariant, the /sync endpoint, and (future) the cron
 * reconciler. The bug this prevents is the inline `subscriptions.data[0]`
 * pattern that picks the wrong sub when a customer has a non-membership
 * sub stacked alongside a real membership.
 */
import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import {
  isMembershipLookupKey,
  isMembershipSub,
  pickMembershipSub,
} from '../../../src/billing/membership-prices.js';

function fakeSub(overrides: {
  id?: string;
  status?: Stripe.Subscription.Status;
  lookup_key?: string | null;
} = {}): Stripe.Subscription {
  // 'lookup_key' in overrides preserves explicit null (vs ?? which would
  // substitute the default for null too). Tests need to assert behavior
  // against missing lookup_keys.
  const lookupKey = 'lookup_key' in overrides ? overrides.lookup_key : 'aao_membership_professional_250';
  return {
    id: overrides.id ?? 'sub_x',
    status: overrides.status ?? 'active',
    items: {
      data: [{
        price: { lookup_key: lookupKey },
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

describe('isMembershipSub', () => {
  it('true when first item has a membership lookup_key', () => {
    expect(isMembershipSub(fakeSub())).toBe(true);
  });
  it('false when first item has a non-membership lookup_key', () => {
    expect(isMembershipSub(fakeSub({ lookup_key: 'aao_event_ticket' }))).toBe(false);
  });
  it('false when lookup_key is missing', () => {
    expect(isMembershipSub(fakeSub({ lookup_key: null }))).toBe(false);
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
});
