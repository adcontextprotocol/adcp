/**
 * Integration tests for the WorkOS verified-domain → member_profiles
 * auto-populate path. Verifies that when WorkOS marks a claimable domain
 * verified, `member_profiles.primary_brand_domain` gets set when null,
 * and is left alone when an existing brand-claim already pointed elsewhere.
 *
 * Driver: Media.net escalation (2026-05-06). Members with WorkOS-verified
 * email domains were hitting the publish-agent gate that requires
 * `primary_brand_domain`, even though their email domain was the obvious
 * brand identity. Auto-populate closes that surprise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { upsertOrganizationDomain } from '../../src/routes/workos-webhooks.js';
import type { Pool } from 'pg';

const TEST_ORG = 'org_wkos_brand_primary_test';
const PROFILE_SLUG = 'wkos-brand-primary-test';

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM brands WHERE domain LIKE $1', ['wkos-brand-primary-%.test']);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG]);
}

async function seedOrg(pool: Pool) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
     VALUES ($1, $2, false, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [TEST_ORG, 'Auto-Primary Test Co'],
  );
}

async function seedProfile(pool: Pool, primaryBrandDomain: string | null) {
  await pool.query(
    `INSERT INTO member_profiles (workos_organization_id, slug, display_name, primary_brand_domain, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET primary_brand_domain = EXCLUDED.primary_brand_domain, updated_at = NOW()`,
    [TEST_ORG, PROFILE_SLUG, 'Auto-Primary Test Co', primaryBrandDomain],
  );
}

describe('WorkOS verified-domain → member_profiles.primary_brand_domain', () => {
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
    await seedOrg(pool);
  });

  it('auto-populates primary_brand_domain when null and the verified domain is claimable', async () => {
    await seedProfile(pool, null);

    await upsertOrganizationDomain({
      id: 'od_test_1',
      organization_id: TEST_ORG,
      domain: 'wkos-brand-primary-1.test',
      state: 'verified',
    });

    const row = await pool.query(
      `SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(row.rows[0].primary_brand_domain).toBe('wkos-brand-primary-1.test');
  });

  it('does NOT clobber an existing primary_brand_domain (intentional brand-claim wins)', async () => {
    await seedProfile(pool, 'wkos-brand-primary-claimed.test');

    await upsertOrganizationDomain({
      id: 'od_test_2',
      organization_id: TEST_ORG,
      domain: 'wkos-brand-primary-different.test',
      state: 'verified',
    });

    const row = await pool.query(
      `SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(row.rows[0].primary_brand_domain).toBe('wkos-brand-primary-claimed.test');
  });

  it('does not crash when no member_profile exists yet (UPDATE is a no-op)', async () => {
    // No seedProfile — verifies the webhook tolerates the org-without-profile case.
    await expect(
      upsertOrganizationDomain({
        id: 'od_test_3',
        organization_id: TEST_ORG,
        domain: 'wkos-brand-primary-noprofile.test',
        state: 'verified',
      }),
    ).resolves.not.toThrow();
  });

  it('does not auto-populate from a non-claimable domain (e.g. shared platform)', async () => {
    await seedProfile(pool, null);

    // vercel.app is in SHARED_PLATFORM_DOMAINS — we should never let one
    // org auto-claim a hosting platform domain as their brand identity.
    await upsertOrganizationDomain({
      id: 'od_test_4',
      organization_id: TEST_ORG,
      domain: 'vercel.app',
      state: 'verified',
    });

    const row = await pool.query(
      `SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(row.rows[0].primary_brand_domain).toBeNull();
  });

  it('still auto-populates for a personal org (brand identity ≠ org-membership inference)', async () => {
    // Pin the explicit decision: a personal-tier user verifying a domain
    // SHOULD get primary_brand_domain set on their profile. The
    // squeeze-prevention concern (which gates is_primary on
    // organization_domains for personal orgs) is about org-membership
    // inference, not brand identity. An Individual Professional CAN own
    // and verify a brand — that's the entire purpose of the tier. If
    // someone later adds `if (isPersonal) return` to the auto-populate
    // path, this test fails and they have to revisit the rationale.
    await pool.query(
      `UPDATE organizations SET is_personal = true WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    await seedProfile(pool, null);

    await upsertOrganizationDomain({
      id: 'od_test_personal',
      organization_id: TEST_ORG,
      domain: 'wkos-brand-primary-personal.test',
      state: 'verified',
    });

    const row = await pool.query(
      `SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(row.rows[0].primary_brand_domain).toBe('wkos-brand-primary-personal.test');
  });

  it('does not auto-populate when the domain is pending (not yet verified)', async () => {
    await seedProfile(pool, null);

    await upsertOrganizationDomain({
      id: 'od_test_5',
      organization_id: TEST_ORG,
      domain: 'wkos-brand-primary-pending.test',
      state: 'pending',
    });

    const row = await pool.query(
      `SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(row.rows[0].primary_brand_domain).toBeNull();
  });
});
