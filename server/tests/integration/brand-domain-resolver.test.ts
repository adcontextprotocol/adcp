/**
 * Integration tests for the brand-domain resolver.
 *
 * Reads `organization_domains.is_primary=true` only — the
 * member_profiles.primary_brand_domain fallback was removed when the
 * column was dropped (Stage 2 of #4159). Single + batch variants both
 * covered.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, getPool, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  getBrandPrimaryDomain,
  getBrandPrimaryDomainsForOrgs,
  getBrandPrimaryDomainRecord,
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

    expect(await getBrandPrimaryDomain(ORG_A)).toBe('a.example');
  });

  it('returns null when no org_domains primary row exists', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await seedDomain(pool, ORG_A, 'a.example', false);
    expect(await getBrandPrimaryDomain(ORG_A)).toBeNull();
  });

  it('returns null when the org has no domains at all', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    expect(await getBrandPrimaryDomain(ORG_A)).toBeNull();
  });

  it('getBrandPrimaryDomainRecord returns { domain, verified: false } for an unverified is_primary row', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, false, true, 'workos', NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET verified = false, is_primary = true`,
      [ORG_A, 'a-unverified.example'],
    );
    const record = await getBrandPrimaryDomainRecord(ORG_A);
    expect(record?.domain).toBe('a-unverified.example');
    expect(record?.verified).toBe(false);
  });

  it('getBrandPrimaryDomainRecord returns { domain, verified: true } for a verified is_primary row', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await seedDomain(pool, ORG_A, 'a.example', true);
    const record = await getBrandPrimaryDomainRecord(ORG_A);
    expect(record?.domain).toBe('a.example');
    expect(record?.verified).toBe(true);
  });

  it('getBrandPrimaryDomainRecord returns null when no is_primary row exists', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    expect(await getBrandPrimaryDomainRecord(ORG_A)).toBeNull();
  });

  it('returns the first row but does not throw when multiple is_primary=true rows exist (data anomaly)', async () => {
    // The invariant is exactly one is_primary=true row per org. If a
    // future bug regresses it, the resolver should still produce a valid
    // primary (some primary is better than none) and surface the anomaly
    // via logger.error. This test documents the don't-crash contract;
    // the log assertion isn't checked here.
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

  it('resolves a mix of orgs with and without primaries', async () => {
    await seedOrg(pool, ORG_A, 'A Co');
    await seedOrg(pool, ORG_B, 'B Co');
    await seedOrg(pool, ORG_C, 'C Co');

    // ORG_A: primary on org_domains
    await seedDomain(pool, ORG_A, 'a.example', true);

    // ORG_B: only a non-primary verified row
    await seedDomain(pool, ORG_B, 'b.example', false);

    // ORG_C: no domains at all

    const result = await getBrandPrimaryDomainsForOrgs([ORG_A, ORG_B, ORG_C]);
    expect(result.get(ORG_A)).toBe('a.example');
    expect(result.has(ORG_B)).toBe(false);
    expect(result.has(ORG_C)).toBe(false);
  });
});
