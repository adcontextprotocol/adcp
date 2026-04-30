/**
 * Tests for the registered integrity invariants.
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
import { stripeSubReflectedInOrgRowInvariant } from '../../../src/audit/integrity/invariants/stripe-sub-reflected-in-org-row.js';
import { workosMembershipRowExistsInWorkosInvariant } from '../../../src/audit/integrity/invariants/workos-membership-row-exists-in-workos.js';
import { ALL_INVARIANTS, getInvariantByName } from '../../../src/audit/integrity/invariants/index.js';
import type { InvariantContext } from '../../../src/audit/integrity/types.js';

const EXPECTED_INVARIANT_COUNT = 7;

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
  it('registers all invariants under unique names', () => {
    expect(ALL_INVARIANTS).toHaveLength(EXPECTED_INVARIANT_COUNT);
    const names = ALL_INVARIANTS.map((i) => i.name);
    expect(new Set(names).size).toBe(EXPECTED_INVARIANT_COUNT);
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
// stripe-sub-reflected-in-org-row
// ─────────────────────────────────────────────────────────────────────────

describe('stripe-sub-reflected-in-org-row', () => {
  function membershipSub(overrides: Partial<{
    id: string;
    status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';
    customer: string;
    lookup_key: string;
    unit_amount: number;
  }> = {}) {
    return {
      id: overrides.id ?? 'sub_1',
      status: overrides.status ?? 'active',
      customer: overrides.customer ?? 'cus_1',
      items: {
        data: [{
          price: {
            lookup_key: overrides.lookup_key ?? 'aao_membership_professional_250',
            unit_amount: overrides.unit_amount ?? 25000,
          },
        }],
      },
    };
  }

  /**
   * `for await ... of stripe.subscriptions.list(...)` consumes the auto-paginating
   * iterator. Mock returns an async-iterable. First call ⇒ active subs, second ⇒ trialing.
   */
  function mockSubsListWith(activeSubs: unknown[], trialingSubs: unknown[] = []): void {
    mockStripeSubsList
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() { for (const s of activeSubs) yield s; },
      }))
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() { for (const s of trialingSubs) yield s; },
      }));
  }

  it('passes when every live membership sub is reflected in its org row', async () => {
    mockSubsListWith([membershipSub()]);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        workos_organization_id: 'org_1',
        name: 'Acme',
        stripe_customer_id: 'cus_1',
        subscription_status: 'active',
        stripe_subscription_id: 'sub_1',
      }],
    });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.checked).toBe(1);
    expect(result.violations).toEqual([]);
  });

  it('flags Lina-shape: paid sub live in Stripe, DB row has subscription_status NULL', async () => {
    mockSubsListWith([membershipSub({ id: 'sub_lina', customer: 'cus_lina' })]);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        workos_organization_id: 'org_lina',
        name: "Lina Georg's Workspace",
        stripe_customer_id: 'cus_lina',
        subscription_status: null,
        stripe_subscription_id: null,
      }],
    });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].subject_type).toBe('organization');
    expect(result.violations[0].subject_id).toBe('org_lina');
    expect(result.violations[0].message).toContain('denied entitlement');
    expect(result.violations[0].details?.db_subscription_status).toBeNull();
    expect(result.violations[0].details?.stripe_status).toBe('active');
    expect(result.violations[0].remediation_hint).toContain('/api/admin/accounts/org_lina/sync');
  });

  it('flags trialing subs the same way as active', async () => {
    mockSubsListWith([], [membershipSub({ status: 'trialing', id: 'sub_t', customer: 'cus_t' })]);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        workos_organization_id: 'org_t',
        name: 'Trial Co',
        stripe_customer_id: 'cus_t',
        subscription_status: null,
        stripe_subscription_id: null,
      }],
    });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].details?.stripe_status).toBe('trialing');
  });

  it('flags orphan customer (paid sub, no AAO org linked) as warning, not critical', async () => {
    mockSubsListWith([membershipSub({ id: 'sub_orphan', customer: 'cus_orphan' })]);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
    expect(result.violations[0].subject_type).toBe('customer');
    expect(result.violations[0].subject_id).toBe('cus_orphan');
    expect(result.violations[0].message).toContain('not linked to any AAO organization');
    expect(result.violations[0].remediation_hint).toContain('Do not auto-link');
  });

  it('skips non-membership subs (other product lookup_keys)', async () => {
    mockSubsListWith([
      membershipSub({ id: 'sub_one_off', lookup_key: 'aao_event_summit_2026', customer: 'cus_evt' }),
    ]);
    // The DB query should not even be issued for non-membership subs — they're filtered before the SQL.
    // But if the implementation issues it anyway, return empty so we still see no violation.
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.checked).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it('skips subs with no lookup_key (probably misconfigured)', async () => {
    const sub = membershipSub();
    (sub.items.data[0].price as { lookup_key: string | null }).lookup_key = null;
    mockSubsListWith([sub]);
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.checked).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it('does not flag a row with subscription_status="past_due" — dunning still grants entitlement', async () => {
    mockSubsListWith([membershipSub({ status: 'active', customer: 'cus_pd' })]);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        workos_organization_id: 'org_pd',
        name: 'PastDue Co',
        stripe_customer_id: 'cus_pd',
        subscription_status: 'past_due',
        stripe_subscription_id: 'sub_1',
      }],
    });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.violations).toEqual([]);
  });

  it('flags a row that drifted to "canceled" while Stripe still says active', async () => {
    mockSubsListWith([membershipSub({ customer: 'cus_drift' })]);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        workos_organization_id: 'org_drift',
        name: 'Drift Co',
        stripe_customer_id: 'cus_drift',
        subscription_status: 'canceled',
        stripe_subscription_id: 'sub_1',
      }],
    });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].details?.db_subscription_status).toBe('canceled');
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
