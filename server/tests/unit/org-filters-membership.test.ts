import { describe, it, expect } from 'vitest';
import { isPayingMembership } from '../../src/db/org-filters.js';

describe('isPayingMembership', () => {
  it('returns true for active, non-canceled subscription', () => {
    expect(isPayingMembership({ subscription_status: 'active', subscription_canceled_at: null })).toBe(true);
  });

  it('returns false for active but canceled subscription (canceled-but-in-period)', () => {
    expect(isPayingMembership({ subscription_status: 'active', subscription_canceled_at: new Date() })).toBe(false);
  });

  it('returns false for null subscription_status', () => {
    expect(isPayingMembership({ subscription_status: null, subscription_canceled_at: null })).toBe(false);
  });

  it('returns false for non-active status', () => {
    expect(isPayingMembership({ subscription_status: 'canceled', subscription_canceled_at: null })).toBe(false);
  });
});
