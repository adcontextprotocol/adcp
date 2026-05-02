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
import { everyEntitledOrgHasResolvableTierInvariant } from '../../../src/audit/integrity/invariants/every-entitled-org-has-resolvable-tier.js';
import { ALL_INVARIANTS, getInvariantByName } from '../../../src/audit/integrity/invariants/index.js';
import type { InvariantContext } from '../../../src/audit/integrity/types.js';

const EXPECTED_INVARIANT_COUNT = 8;

const mockPoolQuery = vi.fn();
const mockStripeCustomersRetrieve = vi.fn();
const mockStripeSubsList = vi.fn();
const mockStripeSubsRetrieve = vi.fn();
const mockStripeProductsRetrieve = vi.fn();
const mockWorkosListMemberships = vi.fn();

function makeCtx(): InvariantContext {
  return {
    pool: { query: mockPoolQuery } as unknown as InvariantContext['pool'],
    stripe: {
      customers: { retrieve: mockStripeCustomersRetrieve },
      subscriptions: { list: mockStripeSubsList, retrieve: mockStripeSubsRetrieve },
      products: { retrieve: mockStripeProductsRetrieve },
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
  mockStripeProductsRetrieve.mockReset();
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
    lookup_key: string | null;
    unit_amount: number;
    product: string | { id: string; metadata?: Record<string, string> };
  }> = {}) {
    const lookupKey = 'lookup_key' in overrides ? overrides.lookup_key : 'aao_membership_professional_250';
    const product = 'product' in overrides ? overrides.product : 'prod_default';
    return {
      id: overrides.id ?? 'sub_1',
      status: overrides.status ?? 'active',
      customer: overrides.customer ?? 'cus_1',
      items: {
        data: [{
          price: {
            lookup_key: lookupKey,
            unit_amount: overrides.unit_amount ?? 25000,
            product,
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
        subscription_price_lookup_key: 'aao_membership_professional_250',
        subscription_amount: 25000,
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

  it('skips subs with no lookup_key AND no membership product metadata', async () => {
    // Truly non-membership subs (event tickets, one-offs) shouldn't be in scope.
    // Confirms the metadata fallback doesn't accidentally widen the filter to
    // every sub on the AAO Stripe account.
    const sub = membershipSub({
      lookup_key: null,
      product: { id: 'prod_event', metadata: { category: 'event' } },
    });
    mockSubsListWith([sub]);
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.checked).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it('flags Bidcliq-shape: founding Startup/SMB sub ($2.5K) with no lookup_key but membership product metadata, customer not linked', async () => {
    // Bidcliq (May 2026): founding-era Startup/SMB Stripe sub whose price
    // lacks the aao_membership_ lookup_key convention. The product carries
    // category=membership metadata. Pre-fix this filter excluded them; the
    // orphan-customer detection downstream never saw them, so admins had no
    // signal that paying customers weren't linked to AAO orgs.
    //
    // `product` is a string id here, matching what Stripe actually returns
    // post the expand-depth fix. The invariant resolves it via the
    // `isMembershipSubWithProductFetch` fallback (one `products.retrieve`).
    const sub = membershipSub({
      id: 'sub_bidcliq',
      customer: 'cus_bidcliq',
      lookup_key: null,
      unit_amount: 250000,
      product: 'prod_founding_smb',
    });
    mockSubsListWith([sub]);
    mockStripeProductsRetrieve.mockResolvedValueOnce({
      id: 'prod_founding_smb',
      metadata: { category: 'membership' },
    });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no AAO org linked to cus_bidcliq

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(mockStripeProductsRetrieve).toHaveBeenCalledWith('prod_founding_smb');
    expect(result.checked).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
    expect(result.violations[0].subject_type).toBe('customer');
    expect(result.violations[0].subject_id).toBe('cus_bidcliq');
    // Substring asserted intentionally: this string is the admin-facing
    // signal for the orphan-customer remediation path. Treat as load-bearing.
    expect(result.violations[0].message).toContain('not linked to any AAO organization');
  });

  it('flags Equativ-shape: founding Corporate sub ($10K) with metadata-only classification, customer not linked', async () => {
    // Equativ (May 2026): corporate-tier founding sub at the higher amount.
    // Confirms the metadata fallback isn't accidentally specialized to the
    // Startup/SMB price level — any membership-tagged product at any
    // amount must be in scope.
    const sub = membershipSub({
      id: 'sub_equativ',
      customer: 'cus_equativ',
      lookup_key: null,
      unit_amount: 1000000,
      product: 'prod_founding_corp',
    });
    mockSubsListWith([sub]);
    mockStripeProductsRetrieve.mockResolvedValueOnce({
      id: 'prod_founding_corp',
      metadata: { category: 'membership' },
    });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(mockStripeProductsRetrieve).toHaveBeenCalledWith('prod_founding_corp');
    expect(result.checked).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('warning');
    expect(result.violations[0].subject_id).toBe('cus_equativ');
    expect(result.violations[0].details?.unit_amount).toBe(1000000);
  });

  it('caches product fetches across subs that share a product id (one retrieve, not N)', async () => {
    // Two founding-era subs on the same Stripe product. The per-run
    // productCache in the invariant should fold them into a single
    // products.retrieve. Without the cache, an account with the
    // Startup/SMB cohort would multiply Stripe API calls per audit run.
    const sub1 = membershipSub({
      id: 'sub_a', customer: 'cus_a', lookup_key: null, product: 'prod_founding_smb',
    });
    const sub2 = membershipSub({
      id: 'sub_b', customer: 'cus_b', lookup_key: null, product: 'prod_founding_smb',
    });
    mockSubsListWith([sub1, sub2]);
    mockStripeProductsRetrieve.mockResolvedValueOnce({
      id: 'prod_founding_smb',
      metadata: { category: 'membership' },
    });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(mockStripeProductsRetrieve).toHaveBeenCalledTimes(1);
    expect(result.checked).toBe(2);
    expect(result.violations).toHaveLength(2);
  });

  it('skips a sub whose product fetch fails (Stripe transient) — does not throw the whole audit', async () => {
    // Founding-era sub whose products.retrieve rejects. The helper swallows
    // and returns false; invariant continues. Behavior trade-off: a flaky
    // Stripe momentarily hides a real founding-era sub from the audit run,
    // but the next run will catch it. Worse alternative would be throwing
    // and losing the rest of the audit's findings.
    const sub = membershipSub({
      id: 'sub_flaky', customer: 'cus_flaky', lookup_key: null, product: 'prod_flaky',
    });
    mockSubsListWith([sub]);
    mockStripeProductsRetrieve.mockRejectedValueOnce(new Error('Stripe transient'));

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
        subscription_price_lookup_key: 'aao_membership_professional_250',
        subscription_amount: 25000,
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

// ─────────────────────────────────────────────────────────────────────────
// every-entitled-org-has-resolvable-tier
// ─────────────────────────────────────────────────────────────────────────

describe('every-entitled-org-has-resolvable-tier', () => {
  function row(overrides: Partial<{
    workos_organization_id: string;
    name: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    membership_tier: string | null;
    subscription_status: string | null;
    subscription_price_lookup_key: string | null;
    subscription_amount: number | null;
    subscription_interval: string | null;
    is_personal: boolean;
  }> = {}) {
    // `'key' in overrides` preserves explicit null in test fixtures; `??`
    // would substitute the default when the caller intentionally passed
    // null (the Adzymic-shape case).
    return {
      workos_organization_id: overrides.workos_organization_id ?? 'org_1',
      name: overrides.name ?? 'Acme',
      stripe_customer_id: 'stripe_customer_id' in overrides ? overrides.stripe_customer_id : 'cus_1',
      stripe_subscription_id:
        'stripe_subscription_id' in overrides ? overrides.stripe_subscription_id : 'sub_1',
      membership_tier: 'membership_tier' in overrides ? overrides.membership_tier : null,
      subscription_status:
        'subscription_status' in overrides ? overrides.subscription_status : 'active',
      subscription_price_lookup_key:
        'subscription_price_lookup_key' in overrides
          ? overrides.subscription_price_lookup_key
          : 'aao_membership_professional_250',
      subscription_amount:
        'subscription_amount' in overrides ? overrides.subscription_amount : 25000,
      subscription_interval:
        'subscription_interval' in overrides ? overrides.subscription_interval : 'year',
      is_personal: overrides.is_personal ?? false,
    };
  }

  it('passes when every entitled org resolves to a non-null tier', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        row({ membership_tier: 'company_standard' }),
        row({
          workos_organization_id: 'org_2',
          name: 'Builder Co',
          membership_tier: null, // null column but lookup_key resolves
          subscription_price_lookup_key: 'aao_membership_corporate_under5m',
        }),
      ],
    });

    const result = await everyEntitledOrgHasResolvableTierInvariant.check(makeCtx());

    expect(result.checked).toBe(2);
    expect(result.violations).toEqual([]);
  });

  it('flags Adzymic-shape: status=active but lookup_key/amount/sub_id all null', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        row({
          workos_organization_id: 'org_adzymic',
          name: 'Adzymic',
          stripe_subscription_id: null,
          membership_tier: null,
          subscription_status: 'active',
          subscription_price_lookup_key: null,
          subscription_amount: null,
          subscription_interval: null,
          is_personal: false,
        }),
      ],
    });

    const result = await everyEntitledOrgHasResolvableTierInvariant.check(makeCtx());

    expect(result.checked).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].subject_type).toBe('organization');
    expect(result.violations[0].subject_id).toBe('org_adzymic');
    expect(result.violations[0].message).toContain('tier pending sync');
    expect(result.violations[0].details?.subscription_status).toBe('active');
    expect(result.violations[0].details?.subscription_price_lookup_key).toBeNull();
    expect(result.violations[0].remediation_hint).toContain('/sync');
  });

  it('flags trialing and past_due rows with NULL product fields the same way', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        row({
          workos_organization_id: 'org_trial',
          name: 'Trial Co',
          subscription_status: 'trialing',
          subscription_price_lookup_key: null,
          subscription_amount: null,
          stripe_subscription_id: null,
        }),
        row({
          workos_organization_id: 'org_pd',
          name: 'PastDue Co',
          subscription_status: 'past_due',
          subscription_price_lookup_key: null,
          subscription_amount: null,
          stripe_subscription_id: null,
        }),
      ],
    });

    const result = await everyEntitledOrgHasResolvableTierInvariant.check(makeCtx());
    expect(result.violations).toHaveLength(2);
    expect(result.violations.every((v) => v.severity === 'critical')).toBe(true);
  });

  it('does not flag when membership_tier column itself is set, even if lookup_key is null', async () => {
    // Backfill 332 set membership_tier directly from amount-based inference;
    // those rows resolve via the cached column even when lookup_key is null.
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        row({
          membership_tier: 'company_icl',
          subscription_price_lookup_key: null,
          subscription_amount: 1000000,
        }),
      ],
    });

    const result = await everyEntitledOrgHasResolvableTierInvariant.check(makeCtx());
    expect(result.violations).toEqual([]);
  });

  it('does not query non-entitled rows', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await everyEntitledOrgHasResolvableTierInvariant.check(makeCtx());

    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toEqual(expect.arrayContaining(['active', 'trialing', 'past_due']));
    // The query must filter to entitled statuses; canceled/incomplete rows
    // shouldn't be in scope.
    expect(params[0]).not.toContain('canceled');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// stripe-sub-reflected-in-org-row — Adzymic-shape regression
// (existing tests above cover Lina-shape with status=NULL; this one covers
//  partial-truth where status='active' but key fields are NULL.)
// ─────────────────────────────────────────────────────────────────────────

describe('stripe-sub-reflected-in-org-row partial-truth', () => {
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
            lookup_key: overrides.lookup_key ?? 'aao_membership_corporate_under5m',
            unit_amount: overrides.unit_amount ?? 250000,
          },
        }],
      },
    };
  }

  function mockSubsListWith(activeSubs: unknown[], trialingSubs: unknown[] = []): void {
    mockStripeSubsList
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() { for (const s of activeSubs) yield s; },
      }))
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() { for (const s of trialingSubs) yield s; },
      }));
  }

  it('flags Adzymic-shape: status=active in DB but stripe_subscription_id and lookup_key NULL', async () => {
    mockSubsListWith([membershipSub({ id: 'sub_adz', customer: 'cus_adz' })]);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        workos_organization_id: 'org_adz',
        name: 'Adzymic',
        stripe_customer_id: 'cus_adz',
        subscription_status: 'active',
        stripe_subscription_id: null,
        subscription_price_lookup_key: null,
        subscription_amount: null,
      }],
    });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].subject_id).toBe('org_adz');
    expect(result.violations[0].message).toContain('partial-truth');
    expect(result.violations[0].details?.partial_truth).toBe(true);
    expect(result.violations[0].details?.db_subscription_status).toBe('active');
    expect(result.violations[0].details?.db_subscription_price_lookup_key).toBeNull();
  });

  it('does not flag a row with status=active AND populated lookup_key + sub_id (fully reflected)', async () => {
    mockSubsListWith([membershipSub({ customer: 'cus_ok' })]);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        workos_organization_id: 'org_ok',
        name: 'OK Co',
        stripe_customer_id: 'cus_ok',
        subscription_status: 'active',
        stripe_subscription_id: 'sub_1',
        subscription_price_lookup_key: 'aao_membership_corporate_under5m',
        subscription_amount: 250000,
      }],
    });

    const result = await stripeSubReflectedInOrgRowInvariant.check(makeCtx());
    expect(result.violations).toEqual([]);
  });
});
