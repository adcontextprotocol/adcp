/**
 * Tests for OrganizationDatabase.findStripeCustomerMismatches.
 *
 * The detector surfaces Stripe customers that look like duplicates of an
 * org's linked customer. Three signals (metadata, email, name+active-sub)
 * with priority ordering — the first signal in priority order wins per pair.
 *
 * The ResponsiveAds case (#3200) had two customers with identical name and
 * email: one linked + one orphan with an active sub generating a duplicate
 * $2,500 invoice. Metadata-only detection didn't surface it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StripeCustomerSummary } from '../../src/billing/stripe-client.js';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const {
  mockListAllStripeCustomers,
  mockListLiveSubCustomerIds,
  mockPoolQuery,
} = vi.hoisted(() => ({
  mockListAllStripeCustomers: vi.fn<any>(),
  mockListLiveSubCustomerIds: vi.fn<any>(),
  mockPoolQuery: vi.fn<any>(),
}));

vi.mock('../../src/billing/stripe-client.js', () => ({
  listAllStripeCustomers: () => mockListAllStripeCustomers(),
  listCustomerIdsWithLiveSubscriptions: () => mockListLiveSubCustomerIds(),
  // listCustomersWithOrgIds is unused by the detector but imported elsewhere
  listCustomersWithOrgIds: vi.fn().mockResolvedValue([]),
  getStripeSubscriptionInfo: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
  }),
}));

const { OrganizationDatabase } = await import('../../src/db/organization-db.js');

function makeCustomer(overrides: Partial<StripeCustomerSummary> & { id: string }): StripeCustomerSummary {
  return {
    id: overrides.id,
    email: overrides.email ?? null,
    name: overrides.name ?? null,
    metadataWorkosOrgId: overrides.metadataWorkosOrgId ?? null,
    deleted: overrides.deleted ?? false,
  };
}

describe('findStripeCustomerMismatches', () => {
  let db: InstanceType<typeof OrganizationDatabase>;

  beforeEach(() => {
    mockListAllStripeCustomers.mockReset();
    mockListLiveSubCustomerIds.mockReset();
    mockPoolQuery.mockReset();
    db = new OrganizationDatabase();
  });

  it('returns nothing when no orgs have a linked Stripe customer', async () => {
    mockListAllStripeCustomers.mockResolvedValue([]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set());
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const result = await db.findStripeCustomerMismatches();

    expect(result).toEqual([]);
  });

  it('detects metadata-based mismatch (orphan metadata points at org)', async () => {
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({ id: 'cus_linked', email: 'a@x.com', name: 'Org A' }),
      makeCustomer({
        id: 'cus_orphan',
        email: 'b@x.com',
        name: 'Different Name',
        metadataWorkosOrgId: 'org_A',
      }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set());
    mockPoolQuery.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_A', name: 'Org A', stripe_customer_id: 'cus_linked' }],
    });

    const result = await db.findStripeCustomerMismatches();

    expect(result).toEqual([
      {
        org_id: 'org_A',
        org_name: 'Org A',
        db_customer_id: 'cus_linked',
        stripe_metadata_customer_id: 'cus_orphan',
        match_reason: 'metadata',
      },
    ]);
  });

  it('detects email-based mismatch (case-insensitive)', async () => {
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({ id: 'cus_linked', email: 'matt@responsiveads.com', name: 'ResponsiveAds' }),
      makeCustomer({ id: 'cus_orphan', email: 'MATT@RESPONSIVEADS.COM', name: 'Different Name' }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set());
    mockPoolQuery.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_R', name: 'ResponsiveAds', stripe_customer_id: 'cus_linked' }],
    });

    const result = await db.findStripeCustomerMismatches();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      org_id: 'org_R',
      stripe_metadata_customer_id: 'cus_orphan',
      match_reason: 'email',
    });
  });

  it('detects name-based mismatch only when the orphan has a live subscription', async () => {
    // Two customers share a name. Without an active sub, the candidate
    // doesn't qualify (shared names are common; would false-positive).
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({ id: 'cus_linked', email: 'a@x.com', name: 'Acme Inc' }),
      makeCustomer({ id: 'cus_inert', email: 'b@y.com', name: 'Acme Inc' }),
      makeCustomer({ id: 'cus_active', email: 'c@z.com', name: 'Acme Inc' }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set(['cus_active']));
    mockPoolQuery.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_acme', name: 'Acme Inc', stripe_customer_id: 'cus_linked' }],
    });

    const result = await db.findStripeCustomerMismatches();

    // Only cus_active surfaces; cus_inert is filtered out by the live-sub gate.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      stripe_metadata_customer_id: 'cus_active',
      match_reason: 'name',
    });
  });

  it('responsiveads-shape: linked + orphan share both name and email; reports as email (priority)', async () => {
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({
        id: 'cus_UFKmlsAXbHz0XZ',
        email: 'matt@responsiveads.com',
        name: 'ResponsiveAds',
      }),
      makeCustomer({
        id: 'cus_Tma6KyBEy5EJWG',
        email: 'matt@responsiveads.com',
        name: 'ResponsiveAds',
      }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set(['cus_Tma6KyBEy5EJWG']));
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          workos_organization_id: 'org_responsiveads',
          name: 'ResponsiveAds',
          stripe_customer_id: 'cus_UFKmlsAXbHz0XZ',
        },
      ],
    });

    const result = await db.findStripeCustomerMismatches();

    // One mismatch — email match wins over name match per priority order.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      org_id: 'org_responsiveads',
      db_customer_id: 'cus_UFKmlsAXbHz0XZ',
      stripe_metadata_customer_id: 'cus_Tma6KyBEy5EJWG',
      match_reason: 'email',
    });
  });

  it('priority: metadata wins over email when both signals match the same orphan', async () => {
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({ id: 'cus_linked', email: 'shared@x.com', name: 'Same Co' }),
      makeCustomer({
        id: 'cus_orphan',
        email: 'shared@x.com',
        name: 'Same Co',
        metadataWorkosOrgId: 'org_A',
      }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set(['cus_orphan']));
    mockPoolQuery.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_A', name: 'Same Co', stripe_customer_id: 'cus_linked' }],
    });

    const result = await db.findStripeCustomerMismatches();

    expect(result).toHaveLength(1);
    expect(result[0].match_reason).toBe('metadata');
  });

  it('does not match itself when an org\'s own linked customer has its own metadata pointer', async () => {
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({
        id: 'cus_linked',
        email: 'a@x.com',
        name: 'Org A',
        metadataWorkosOrgId: 'org_A',
      }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set());
    mockPoolQuery.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_A', name: 'Org A', stripe_customer_id: 'cus_linked' }],
    });

    const result = await db.findStripeCustomerMismatches();

    expect(result).toEqual([]);
  });

  it('does not match by email when one or both customers have no email', async () => {
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({ id: 'cus_linked', email: null, name: 'Org A' }),
      makeCustomer({ id: 'cus_other', email: null, name: 'Other Co' }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set());
    mockPoolQuery.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_A', name: 'Org A', stripe_customer_id: 'cus_linked' }],
    });

    const result = await db.findStripeCustomerMismatches();

    expect(result).toEqual([]);
  });

  it('skips deleted Stripe customers (both as linked and as candidate)', async () => {
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({ id: 'cus_linked', email: 'a@x.com', name: 'Org A', deleted: true }),
      makeCustomer({ id: 'cus_other', email: 'a@x.com', name: 'Org A' }),
      makeCustomer({ id: 'cus_deleted_dup', email: 'b@y.com', name: 'Org B', deleted: true }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set());
    mockPoolQuery.mockResolvedValue({
      rows: [
        { workos_organization_id: 'org_A', name: 'Org A', stripe_customer_id: 'cus_linked' },
        { workos_organization_id: 'org_B', name: 'Org B', stripe_customer_id: 'cus_normal_b' },
      ],
    });

    const result = await db.findStripeCustomerMismatches();

    // Linked customer for org_A is deleted → email/name passes skip.
    // Candidate cus_deleted_dup is deleted → not considered.
    // No metadata match, no other signal → empty.
    expect(result).toEqual([]);
  });

  it('detects metadata mismatch even when the linked Stripe customer is missing (deleted in Stripe)', async () => {
    // Legacy compat: the old detector ran metadata pass without requiring
    // the linked customer to be present. Keep that behavior so cleanup
    // tooling can still surface orphan metadata after a customer delete.
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({
        id: 'cus_orphan',
        email: 'a@x.com',
        name: 'Org A',
        metadataWorkosOrgId: 'org_A',
      }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set());
    mockPoolQuery.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_A', name: 'Org A', stripe_customer_id: 'cus_missing' }],
    });

    const result = await db.findStripeCustomerMismatches();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      stripe_metadata_customer_id: 'cus_orphan',
      match_reason: 'metadata',
    });
  });

  it('returns multiple orphans when one org has several duplicates', async () => {
    mockListAllStripeCustomers.mockResolvedValue([
      makeCustomer({ id: 'cus_linked', email: 'a@x.com', name: 'Org A' }),
      makeCustomer({ id: 'cus_orphan_email', email: 'a@x.com', name: 'X' }),
      makeCustomer({
        id: 'cus_orphan_meta',
        email: 'unrelated@y.com',
        name: 'Y',
        metadataWorkosOrgId: 'org_A',
      }),
    ]);
    mockListLiveSubCustomerIds.mockResolvedValue(new Set());
    mockPoolQuery.mockResolvedValue({
      rows: [{ workos_organization_id: 'org_A', name: 'Org A', stripe_customer_id: 'cus_linked' }],
    });

    const result = await db.findStripeCustomerMismatches();

    expect(result).toHaveLength(2);
    const reasons = result.map((m) => m.match_reason).sort();
    expect(reasons).toEqual(['email', 'metadata']);
  });
});
