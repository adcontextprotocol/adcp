/**
 * Integration tests for the brand-domain resolver (Stage 1 of #4159).
 *
 * Asserts the read order: organization_domains.is_primary first, then
 * member_profiles.primary_brand_domain as a transition fallback. Single +
 * batch variants both covered.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, getPool, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  getBrandPrimaryDomain,
  getBrandPrimaryDomainsForOrgs,
} from '../../src/services/brand-domain-resolver.js';
import type { Pool } from 'pg';

const ORG_A = 'org_brand_resolver_a';
const ORG_B = 'org_brand_resolver_b';
const ORG_C = 'org_brand_resolver_c';

async function cleanup(pool: Pool) {
  const ids = [ORG_A, ORG_B, ORG_C];
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [ids]);
}

async function seedOrg(pool: Pool, orgId: string, name: string) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
     VALUES ($1, $2, false, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [orgId, name],
  );
}

async function seedDomain(pool: Pool, orgId: string, domain: string, isPrimary: boolean) {
  await pool.query(
    `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
     VALUES ($1, $2, true, $3, 'workos', NOW(), NOW())
     ON CONFLICT (domain) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
    [orgId, domain, isPrimary],
  );
}

async function seedProfile(pool: Pool, orgId: string, slug: string, brandPrimary: string | null) {
  await pool.query(
    `INSERT INTO member_profiles (workos_organization_id, slug, display_name, primary_brand_domain, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET primary_brand_domain = EXCLUDED.primary_brand_domain, updated_at = NOW()`,
    [orgId, slug, slug, brandPrimary],
  );
}

// Single beforeAll/afterAll pair shared across both describe blocks via
// vitest's file-scoped lifecycle. Avoids running migrations twice and
// initializing the pool twice (which races in the same process).
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

describe('getBrandPrimaryDomain', () => {
  beforeEach(async () => {
    await cleanup(pool);
  });

  it('returns the organization_domains.is_primary domain when one exists', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await seedDomain(pool, ORG_A, 'a.example', true);
    await seedDomain(pool, ORG_A, 'a-secondary.example', false);
    await seedProfile(pool, ORG_A, 'a-co', 'a.example');

    expect(await getBrandPrimaryDomain(ORG_A)).toBe('a.example');
  });

  it('prefers org_domains over a divergent member_profiles value', async () => {
    // Post-Stage-0 these should never diverge, but the resolver's contract
    // is: org_domains wins.
    await seedOrg(pool, ORG_A, 'A Co');
    await seedDomain(pool, ORG_A, 'a.example', true);
    await seedProfile(pool, ORG_A, 'a-co', 'a-old.example');

    expect(await getBrandPrimaryDomain(ORG_A)).toBe('a.example');
  });

  it('falls back to member_profiles.primary_brand_domain when no org_domains primary exists', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await seedProfile(pool, ORG_A, 'a-co', 'a-fallback.example');

    expect(await getBrandPrimaryDomain(ORG_A)).toBe('a-fallback.example');
  });

  it('returns null when neither source has a value', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await seedProfile(pool, ORG_A, 'a-co', null);

    expect(await getBrandPrimaryDomain(ORG_A)).toBeNull();
  });

  it('returns null when the org has no profile and no domains', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    expect(await getBrandPrimaryDomain(ORG_A)).toBeNull();
  });

  it('does not match a non-primary verified row', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await seedDomain(pool, ORG_A, 'a.example', false); // verified but not primary
    await seedProfile(pool, ORG_A, 'a-co', null);

    expect(await getBrandPrimaryDomain(ORG_A)).toBeNull();
  });

  it('returns an unverified is_primary=true row (verified is enforced at write time, not read)', async () => {
    // The resolver does not filter on verified — Stage 0's writers ensure
    // is_primary=true rows are also verified, and the publish-agent gate
    // re-checks verified independently. Document the contract here so a
    // future refactor that adds a verified filter is an intentional change.
    await seedOrg(pool, ORG_A, 'A Co');
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, false, true, 'workos', NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET verified = false, is_primary = true`,
      [ORG_A, 'a-unverified.example'],
    );
    await seedProfile(pool, ORG_A, 'a-co', null);
    expect(await getBrandPrimaryDomain(ORG_A)).toBe('a-unverified.example');
  });

  it('returns the first row but does not throw when multiple is_primary=true rows exist (data anomaly)', async () => {
    // The Stage 0 invariant says exactly one is_primary=true row per org.
    // If a future bug regresses it, the resolver should still produce a
    // valid primary (some primary is better than none) and surface the
    // anomaly via logger.error. This test documents the don't-crash
    // contract; the log assertion isn't checked here.
    await seedOrg(pool, ORG_A, 'A Co');
    await seedDomain(pool, ORG_A, 'a-1.example', true);
    await seedDomain(pool, ORG_A, 'a-2.example', true);

    const result = await getBrandPrimaryDomain(ORG_A);
    expect(result === 'a-1.example' || result === 'a-2.example').toBe(true);
  });
});

describe('getBrandPrimaryDomainsForOrgs', () => {
  beforeEach(async () => {
    await cleanup(pool);
  });

  it('returns an empty map for an empty input', async () => {
    expect(await getBrandPrimaryDomainsForOrgs([])).toEqual(new Map());
  });

  it('resolves a mix of org_domains and member_profiles fallbacks', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await seedOrg(pool, ORG_B, 'B Co');
    await seedOrg(pool, ORG_C, 'C Co');

    // ORG_A: primary on org_domains
    await seedDomain(pool, ORG_A, 'a.example', true);
    await seedProfile(pool, ORG_A, 'a-co', 'a.example');

    // ORG_B: only on member_profiles
    await seedProfile(pool, ORG_B, 'b-co', 'b-fallback.example');

    // ORG_C: no brand identity at all
    await seedProfile(pool, ORG_C, 'c-co', null);

    const result = await getBrandPrimaryDomainsForOrgs([ORG_A, ORG_B, ORG_C]);
    expect(result.get(ORG_A)).toBe('a.example');
    expect(result.get(ORG_B)).toBe('b-fallback.example');
    expect(result.has(ORG_C)).toBe(false);
  });

  it('does not include orgs with no brand identity in the result map', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await seedProfile(pool, ORG_A, 'a-co', null);

    const result = await getBrandPrimaryDomainsForOrgs([ORG_A]);
    expect(result.size).toBe(0);
  });
});
