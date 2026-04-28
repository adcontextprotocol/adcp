/**
 * Integration tests for findPayingOrgForDomain — the auto-link target
 * resolver that walks brands.house_domain to inherit verified-domain
 * coverage from a paying parent org.
 *
 * Real-world driver: AnalyticsIQ employees couldn't auto-link to Alliant's
 * paid org because the auto-link path matched on direct verified-domain
 * only, while resolveEffectiveMembership (post-link inheritance check)
 * walked the brand hierarchy. This helper closes that asymmetry.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { findPayingOrgForDomain } from '../../src/db/org-filters.js';
import type { Pool } from 'pg';

const TEST_PARENT_ORG = 'org_paying_parent_test';
const TEST_DIRECT_ORG = 'org_paying_direct_test';
const PARENT_DOMAIN = 'parent-co.test';
const CHILD_DOMAIN = 'child-co.test';
const GRANDCHILD_DOMAIN = 'grandchild-co.test';
const ORPHAN_DOMAIN = 'orphan-co.test';

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [
    [TEST_PARENT_ORG, TEST_DIRECT_ORG],
  ]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [
    [TEST_PARENT_ORG, TEST_DIRECT_ORG],
  ]);
  await pool.query('DELETE FROM brands WHERE domain IN ($1, $2, $3, $4)', [
    PARENT_DOMAIN, CHILD_DOMAIN, GRANDCHILD_DOMAIN, ORPHAN_DOMAIN,
  ]);
}

async function seedPayingOrg(pool: Pool, orgId: string, domain: string, opts: {
  subscription_status?: string;
  canceled?: boolean;
  auto_provision_direct?: boolean;
  auto_provision_hierarchy?: boolean;
} = {}) {
  await pool.query(
    `INSERT INTO organizations (
       workos_organization_id, name, subscription_status, subscription_canceled_at,
       auto_provision_verified_domain, auto_provision_brand_hierarchy_children,
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET subscription_status = EXCLUDED.subscription_status,
           subscription_canceled_at = EXCLUDED.subscription_canceled_at,
           auto_provision_verified_domain = EXCLUDED.auto_provision_verified_domain,
           auto_provision_brand_hierarchy_children = EXCLUDED.auto_provision_brand_hierarchy_children`,
    [
      orgId,
      `Org ${orgId}`,
      opts.subscription_status ?? 'active',
      opts.canceled ? new Date() : null,
      opts.auto_provision_direct ?? true,
      opts.auto_provision_hierarchy ?? false,
    ],
  );
  await pool.query(
    `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
     VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
     ON CONFLICT (domain) DO UPDATE SET verified = true, workos_organization_id = $1`,
    [orgId, domain],
  );
}

async function seedBrandHierarchy(pool: Pool, child: string, parent: string, opts: {
  confidence?: 'high' | 'low';
  last_validated?: Date | null;
} = {}) {
  await pool.query(
    `INSERT INTO brands (domain, brand_name, house_domain, source_type, brand_manifest, last_validated, created_at, updated_at)
     VALUES ($1, $2, $3, 'enriched', $4, $5, NOW(), NOW())
     ON CONFLICT (domain) DO UPDATE
       SET house_domain = EXCLUDED.house_domain,
           brand_manifest = EXCLUDED.brand_manifest,
           last_validated = EXCLUDED.last_validated`,
    [
      child,
      child,
      parent,
      JSON.stringify({ classification: { confidence: opts.confidence ?? 'high' } }),
      opts.last_validated === undefined ? new Date() : opts.last_validated,
    ],
  );
}

describe('findPayingOrgForDomain', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
  });

  it('returns null for a domain with no matching org and no hierarchy', async () => {
    const result = await findPayingOrgForDomain(ORPHAN_DOMAIN);
    expect(result).toBeNull();
  });

  it('returns the paying org for a direct verified-domain match', async () => {
    await seedPayingOrg(pool, TEST_DIRECT_ORG, CHILD_DOMAIN);

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.organization_id).toBe(TEST_DIRECT_ORG);
    expect(result!.is_inherited).toBe(false);
    expect(result!.matched_domain).toBe(CHILD_DOMAIN);
    expect(result!.hierarchy_chain).toEqual([CHILD_DOMAIN]);
    expect(result!.auto_provision_direct_allowed).toBe(true);
    expect(result!.auto_provision_hierarchy_allowed).toBe(false); // default
  });

  it('walks brands.house_domain to inherit from a paying parent', async () => {
    await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN);
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN);

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.organization_id).toBe(TEST_PARENT_ORG);
    expect(result!.is_inherited).toBe(true);
    expect(result!.matched_domain).toBe(PARENT_DOMAIN);
    expect(result!.hierarchy_chain).toEqual([CHILD_DOMAIN, PARENT_DOMAIN]);
  });

  it('walks two hops (grandchild → child → parent)', async () => {
    await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN);
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN);
    await seedBrandHierarchy(pool, GRANDCHILD_DOMAIN, CHILD_DOMAIN);

    const result = await findPayingOrgForDomain(GRANDCHILD_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.organization_id).toBe(TEST_PARENT_ORG);
    expect(result!.is_inherited).toBe(true);
    expect(result!.matched_domain).toBe(PARENT_DOMAIN);
    expect(result!.hierarchy_chain).toEqual([GRANDCHILD_DOMAIN, CHILD_DOMAIN, PARENT_DOMAIN]);
  });

  it('does not traverse low-confidence brand classifications', async () => {
    await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN);
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN, { confidence: 'low' });

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    expect(result).toBeNull();
  });

  it('does not traverse brand-hierarchy edges older than the 180-day TTL', async () => {
    await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN);
    // last_validated set to 200 days ago — past the freshness window.
    const stale = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN, { last_validated: stale });

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    expect(result).toBeNull();
  });

  it('does not match a parent whose subscription is not active', async () => {
    await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN, { subscription_status: 'canceled' });
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN);

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    expect(result).toBeNull();
  });

  it('does not match a parent with subscription_canceled_at set', async () => {
    await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN, { canceled: true });
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN);

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    expect(result).toBeNull();
  });

  it('surfaces both opt-in flags from the resolved parent for caller-side gating', async () => {
    // Parent has direct=true (default), hierarchy=true (opted in).
    await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN, {
      auto_provision_direct: true,
      auto_provision_hierarchy: true,
    });
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN);

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.is_inherited).toBe(true);
    expect(result!.auto_provision_direct_allowed).toBe(true);
    expect(result!.auto_provision_hierarchy_allowed).toBe(true);
  });

  it('reports auto_provision flags=false when the resolved parent has opted out', async () => {
    await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN, {
      auto_provision_direct: false,
      auto_provision_hierarchy: false,
    });
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN);

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    // Helper still returns the match — caller decides what to do with it.
    // (autoLinkByVerifiedDomain checks both flags and bails before creating a membership.)
    expect(result).not.toBeNull();
    expect(result!.auto_provision_direct_allowed).toBe(false);
    expect(result!.auto_provision_hierarchy_allowed).toBe(false);
  });

  it('protects against cycles in brand.house_domain', async () => {
    // a.com → b.com → a.com — no infinite loop.
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN);
    await seedBrandHierarchy(pool, PARENT_DOMAIN, CHILD_DOMAIN);

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    // Neither domain has a paying org seeded, so no match — but more
    // importantly the call must terminate.
    expect(result).toBeNull();
  });

  it('stops at the depth limit (max 4 hops up)', async () => {
    // Chain longer than the 5-depth bound (depth starts at 1, predicate
    // is depth < 5, so we visit depths 1..5). Paying org at depth 6 must
    // not be reachable.
    const D1 = 'd1.test', D2 = 'd2.test', D3 = 'd3.test', D4 = 'd4.test', D5 = 'd5.test';
    try {
      await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN);
      await seedBrandHierarchy(pool, D1, D2);
      await seedBrandHierarchy(pool, D2, D3);
      await seedBrandHierarchy(pool, D3, D4);
      await seedBrandHierarchy(pool, D4, D5);
      await seedBrandHierarchy(pool, D5, PARENT_DOMAIN); // 6 hops away

      const result = await findPayingOrgForDomain(D1);
      expect(result).toBeNull();
    } finally {
      await pool.query('DELETE FROM brands WHERE domain = ANY($1)', [[D1, D2, D3, D4, D5]]);
    }
  });

  it('prefers the shallower (direct) match when both direct and hierarchical paths exist', async () => {
    // Direct match on CHILD_DOMAIN.
    await seedPayingOrg(pool, TEST_DIRECT_ORG, CHILD_DOMAIN);
    // Also a hierarchy via parent.
    await seedPayingOrg(pool, TEST_PARENT_ORG, PARENT_DOMAIN);
    await seedBrandHierarchy(pool, CHILD_DOMAIN, PARENT_DOMAIN);

    const result = await findPayingOrgForDomain(CHILD_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.organization_id).toBe(TEST_DIRECT_ORG);
    expect(result!.is_inherited).toBe(false);
  });

  it('is case-insensitive on the input domain', async () => {
    await seedPayingOrg(pool, TEST_DIRECT_ORG, CHILD_DOMAIN);

    const result = await findPayingOrgForDomain(CHILD_DOMAIN.toUpperCase());

    expect(result).not.toBeNull();
    expect(result!.organization_id).toBe(TEST_DIRECT_ORG);
  });

  it('returns null for empty/whitespace input', async () => {
    expect(await findPayingOrgForDomain('')).toBeNull();
    expect(await findPayingOrgForDomain('   ')).toBeNull();
  });
});
