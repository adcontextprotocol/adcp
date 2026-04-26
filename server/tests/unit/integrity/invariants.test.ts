/**
 * Tests for the five Phase-1 integrity invariants.
 *
 * Each test covers the happy path (no violations) and the failure mode the
 * invariant exists to detect. Mocks the DB pool, Stripe, and WorkOS through
 * the InvariantContext shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripeCustomerOrgMetadataBidirectionalInvariant } from '../../../src/audit/integrity/invariants/stripe-customer-org-metadata-bidirectional.js';
import { oneActiveStripeSubPerOrgInvariant } from '../../../src/audit/integrity/invariants/one-active-stripe-sub-per-org.js';
import { stripeCustomerResolvesInvariant } from '../../../src/audit/integrity/invariants/stripe-customer-resolves.js';
import { orgRowMatchesLiveStripeSubInvariant } from '../../../src/audit/integrity/invariants/org-row-matches-live-stripe-sub.js';
import { workosMembershipRowExistsInWorkosInvariant } from '../../../src/audit/integrity/invariants/workos-membership-row-exists-in-workos.js';
import { ALL_INVARIANTS, getInvariantByName } from '../../../src/audit/integrity/invariants/index.js';
import type { InvariantContext } from '../../../src/audit/integrity/types.js';

const mockPoolQuery = vi.fn();
const mockStripeCustomersRetrieve = vi.fn();
const mockStripeSubsList = vi.fn();
const mockStripeSubsRetrieve = vi.fn();
const mockWorkosListMemberships = vi.fn();

function makeCtx(): InvariantContext {
  return {
    pool: { query: mockPoolQuery } as unknown as InvariantContext['pool'],
    stripe: {
      customers: { retrieve: mockStripeCustomersRetrieve },
      subscriptions: { list: mockStripeSubsList, retrieve: mockStripeSubsRetrieve },
    } as unknown as InvariantContext['stripe'],
    workos: {
      userManagement: { listOrganizationMemberships: mockWorkosListMemberships },
    } as unknown as InvariantContext['workos'],
    logger: {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as InvariantContext['logger'],
  };
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockStripeCustomersRetrieve.mockReset();
  mockStripeSubsList.mockReset();
  mockStripeSubsRetrieve.mockReset();
  mockWorkosListMemberships.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────
// Registry sanity
// ─────────────────────────────────────────────────────────────────────────

describe('invariants registry', () => {
  it('registers all five Phase-1 invariants under unique names', () => {
    expect(ALL_INVARIANTS).toHaveLength(5);
    const names = ALL_INVARIANTS.map((i) => i.name);
    expect(new Set(names).size).toBe(5);
  });

  it('resolves invariants by name', () => {
    expect(getInvariantByName('one-active-stripe-sub-per-org')).toBe(oneActiveStripeSubPerOrgInvariant);
    expect(getInvariantByName('does-not-exist')).toBeUndefined();
  });

  it('every invariant has a non-empty description and a valid severity', () => {
    for (const inv of ALL_INVARIANTS) {
      expect(inv.description.length).toBeGreaterThan(20);
      expect(['critical', 'warning', 'info']).toContain(inv.severity);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// stripe-customer-org-metadata-bidirectional
// ─────────────────────────────────────────────────────────────────────────

describe('stripe-customer-org-metadata-bidirectional', () => {
  it('passes when every customer is metadata-stamped with the correct org id', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_1', name: 'Acme', stripe_customer_id: 'cus_1' }],
    });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({
      id: 'cus_1',
      email: 'a@b',
      metadata: { workos_organization_id: 'org_1' },
    });

    const result = await stripeCustomerOrgMetadataBidirectionalInvariant.check(makeCtx());

    expect(result.checked).toBe(1);
    expect(result.violations).toEqual([]);
  });

  it('flags a customer whose metadata points to a different org (Triton-shape)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_triton', name: 'Triton', stripe_customer_id: 'cus_triton' }],
    });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({
      id: 'cus_triton',
      email: 'erik@encypher.com',
      metadata: { workos_organization_id: 'org_encypher' }, // wrong!
    });

    const result = await stripeCustomerOrgMetadataBidirectionalInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].subject_id).toBe('org_triton');
    expect(result.violations[0].message).toContain('org_encypher');
    expect(result.violations[0].details?.metadata_workos_organization_id).toBe('org_encypher');
  });

  it('flags a customer with no workos_organization_id metadata at all', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_x', name: 'Test', stripe_customer_id: 'cus_x' }],
    });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({ id: 'cus_x', email: 'a@b', metadata: {} });

    const result = await stripeCustomerOrgMetadataBidirectionalInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toContain('no workos_organization_id metadata stamped');
  });

  it('skips deleted Stripe customers (the resolve invariant handles those)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_x', name: 'X', stripe_customer_id: 'cus_x' }],
    });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({ id: 'cus_x', deleted: true });

    const result = await stripeCustomerOrgMetadataBidirectionalInvariant.check(makeCtx());
    expect(result.violations).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// one-active-stripe-sub-per-org
// ─────────────────────────────────────────────────────────────────────────

describe('one-active-stripe-sub-per-org', () => {
  it('passes when a customer has exactly one live subscription', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_1', name: 'Acme', stripe_customer_id: 'cus_1' }],
    });
    mockStripeSubsList.mockResolvedValueOnce({
      data: [
        { id: 'sub_1', status: 'active', items: { data: [{ price: { lookup_key: 'aao_x', unit_amount: 1000 } }] }, created: 1 },
      ],
    });

    const result = await oneActiveStripeSubPerOrgInvariant.check(makeCtx());
    expect(result.violations).toEqual([]);
  });

  it('flags Triton-shape: two simultaneous active subscriptions', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_triton', name: 'Triton', stripe_customer_id: 'cus_triton' }],
    });
    mockStripeSubsList.mockResolvedValueOnce({
      data: [
        { id: 'sub_corporate', status: 'active', items: { data: [{ price: { lookup_key: 'aao_membership_corporate_5m', unit_amount: 1000000 } }] }, created: 1 },
        { id: 'sub_builder', status: 'active', items: { data: [{ price: { lookup_key: 'aao_membership_builder_3000', unit_amount: 300000 } }] }, created: 2 },
      ],
    });

    const result = await oneActiveStripeSubPerOrgInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].subject_id).toBe('org_triton');
    expect(result.violations[0].message).toContain('2 live subscriptions');
    const subs = result.violations[0].details?.subscriptions as Array<{ id: string }>;
    expect(subs.map((s) => s.id).sort()).toEqual(['sub_builder', 'sub_corporate']);
  });

  it('treats trialing and past_due as live (would-stack)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_x', name: 'X', stripe_customer_id: 'cus_x' }],
    });
    mockStripeSubsList.mockResolvedValueOnce({
      data: [
        { id: 'sub_a', status: 'trialing', items: { data: [{ price: { lookup_key: 'a', unit_amount: 100 } }] }, created: 1 },
        { id: 'sub_b', status: 'past_due', items: { data: [{ price: { lookup_key: 'b', unit_amount: 200 } }] }, created: 2 },
      ],
    });

    const result = await oneActiveStripeSubPerOrgInvariant.check(makeCtx());
    expect(result.violations).toHaveLength(1);
  });

  it('does not flag canceled subscriptions', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_x', name: 'X', stripe_customer_id: 'cus_x' }],
    });
    mockStripeSubsList.mockResolvedValueOnce({
      data: [
        { id: 'sub_active', status: 'active', items: { data: [{ price: { lookup_key: 'a', unit_amount: 100 } }] }, created: 1 },
        { id: 'sub_old', status: 'canceled', items: { data: [{ price: { lookup_key: 'old', unit_amount: 50 } }] }, created: 0 },
      ],
    });

    const result = await oneActiveStripeSubPerOrgInvariant.check(makeCtx());
    expect(result.violations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// stripe-customer-resolves
// ─────────────────────────────────────────────────────────────────────────

describe('stripe-customer-resolves', () => {
  it('passes when every customer resolves and is not deleted', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_1', name: 'Acme', stripe_customer_id: 'cus_1' }],
    });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({ id: 'cus_1' });

    const result = await stripeCustomerResolvesInvariant.check(makeCtx());
    expect(result.violations).toEqual([]);
  });

  it('flags a deleted customer', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_1', name: 'Acme', stripe_customer_id: 'cus_1' }],
    });
    mockStripeCustomersRetrieve.mockResolvedValueOnce({ id: 'cus_1', deleted: true });

    const result = await stripeCustomerResolvesInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].message).toContain('deleted');
  });

  it('flags a 404 (customer never existed or was hard-deleted)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_1', name: 'Acme', stripe_customer_id: 'cus_gone' }],
    });
    const notFound = Object.assign(new Error('No such customer'), { code: 'resource_missing', statusCode: 404 });
    mockStripeCustomersRetrieve.mockRejectedValueOnce(notFound);

    const result = await stripeCustomerResolvesInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].message).toContain('non-existent');
  });

  it('records a transient warning on Stripe API errors that aren\'t 404', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_organization_id: 'org_1', name: 'Acme', stripe_customer_id: 'cus_1' }],
    });
    mockStripeCustomersRetrieve.mockRejectedValueOnce(Object.assign(new Error('rate limit'), { code: 'rate_limit', statusCode: 429 }));

    const result = await stripeCustomerResolvesInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// org-row-matches-live-stripe-sub
// ─────────────────────────────────────────────────────────────────────────

describe('org-row-matches-live-stripe-sub', () => {
  function orgRow(overrides: Partial<{
    subscription_status: string; subscription_amount: number; subscription_price_lookup_key: string;
  }> = {}) {
    return {
      workos_organization_id: 'org_1',
      name: 'Acme',
      stripe_subscription_id: 'sub_1',
      subscription_status: 'active',
      subscription_amount: 1000000,
      subscription_price_lookup_key: 'aao_membership_corporate_5m',
      ...overrides,
    };
  }

  function stripeSub(overrides: Partial<{
    status: string; lookup_key: string; unit_amount: number;
  }> = {}) {
    return {
      id: 'sub_1',
      status: overrides.status ?? 'active',
      items: {
        data: [{
          price: {
            lookup_key: overrides.lookup_key ?? 'aao_membership_corporate_5m',
            unit_amount: overrides.unit_amount ?? 1000000,
          },
        }],
      },
    };
  }

  it('passes when row mirrors live Stripe state', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [orgRow()] });
    mockStripeSubsRetrieve.mockResolvedValueOnce(stripeSub());

    const result = await orgRowMatchesLiveStripeSubInvariant.check(makeCtx());
    expect(result.violations).toEqual([]);
  });

  it('flags amount drift', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [orgRow({ subscription_amount: 300000 })] });
    mockStripeSubsRetrieve.mockResolvedValueOnce(stripeSub());

    const result = await orgRowMatchesLiveStripeSubInvariant.check(makeCtx());
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
    const m = result.violations[0].details?.mismatches as Record<string, { row: unknown; stripe: unknown }>;
    expect(m.amount).toEqual({ row: 300000, stripe: 1000000 });
  });

  it('flags lookup_key drift', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [orgRow({ subscription_price_lookup_key: 'aao_membership_builder_3000' })] });
    mockStripeSubsRetrieve.mockResolvedValueOnce(stripeSub());

    const result = await orgRowMatchesLiveStripeSubInvariant.check(makeCtx());
    expect(result.violations).toHaveLength(1);
    const m = result.violations[0].details?.mismatches as Record<string, unknown>;
    expect(m.lookup_key).toBeDefined();
  });

  it('flags status drift', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [orgRow({ subscription_status: 'active' })] });
    mockStripeSubsRetrieve.mockResolvedValueOnce(stripeSub({ status: 'past_due' }));

    const result = await orgRowMatchesLiveStripeSubInvariant.check(makeCtx());
    expect(result.violations).toHaveLength(1);
  });

  it('escalates to critical when the Stripe subscription is gone (404)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [orgRow()] });
    mockStripeSubsRetrieve.mockRejectedValueOnce(Object.assign(new Error('no sub'), { code: 'resource_missing', statusCode: 404 }));

    const result = await orgRowMatchesLiveStripeSubInvariant.check(makeCtx());
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].message).toContain('non-existent');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// workos-membership-row-exists-in-workos
// ─────────────────────────────────────────────────────────────────────────

describe('workos-membership-row-exists-in-workos', () => {
  it('passes when every sampled membership row resolves in WorkOS', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_user_id: 'u_1', workos_organization_id: 'org_1', workos_membership_id: 'mem_1', status: 'active' }],
    });
    mockWorkosListMemberships.mockResolvedValueOnce({ data: [{ id: 'mem_1' }] });

    const result = await workosMembershipRowExistsInWorkosInvariant.check(makeCtx());
    expect(result.checked).toBe(1);
    expect(result.violations).toEqual([]);
  });

  it('flags rows that no longer exist in WorkOS', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_user_id: 'u_stale', workos_organization_id: 'org_1', workos_membership_id: 'mem_stale', status: 'active' }],
    });
    mockWorkosListMemberships.mockResolvedValueOnce({ data: [] });

    const result = await workosMembershipRowExistsInWorkosInvariant.check(makeCtx());
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
    expect(result.violations[0].subject_type).toBe('membership');
    expect(result.violations[0].subject_id).toBe('u_stale:org_1');
  });

  it('records a warning when WorkOS lookup fails', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ workos_user_id: 'u_1', workos_organization_id: 'org_1', workos_membership_id: 'mem_1', status: 'active' }],
    });
    mockWorkosListMemberships.mockRejectedValueOnce(new Error('WorkOS down'));

    const result = await workosMembershipRowExistsInWorkosInvariant.check(makeCtx());
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
    expect(result.violations[0].message).toContain('WorkOS down');
  });

  it('respects a custom sampleSize via context options', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await workosMembershipRowExistsInWorkosInvariant.check({
      ...makeCtx(),
      options: { sampleSize: 50 },
    });

    expect(mockPoolQuery).toHaveBeenCalledWith(expect.any(String), [50]);
  });
});
