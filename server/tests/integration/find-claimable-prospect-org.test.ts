/**
 * Integration tests for findClaimableProspectOrgForDomain — the auth/callback
 * helper that surfaces sales-touched prospect orgs at signup so users can
 * claim them instead of silently being routed to a personal workspace
 * (Voise Tech failure mode).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { findClaimableProspectOrgForDomain } from '../../src/db/org-filters.js';
import type { Pool } from 'pg';

const ORG_PROSPECT_BY_EMAIL_DOMAIN = 'org_claim_prospect_email_test';
const ORG_PROSPECT_BY_VERIFIED_DOMAIN = 'org_claim_prospect_verified_test';
const ORG_PAYING = 'org_claim_paying_test';
const ORG_HAS_MEMBERS = 'org_claim_has_members_test';
const ORG_PERSONAL = 'org_claim_personal_test';

const TEST_ORGS = [
  ORG_PROSPECT_BY_EMAIL_DOMAIN,
  ORG_PROSPECT_BY_VERIFIED_DOMAIN,
  ORG_PAYING,
  ORG_HAS_MEMBERS,
  ORG_PERSONAL,
];

const VOISE_DOMAIN = 'voiseclaim.test';
const ORPHAN_DOMAIN = 'orphan-noone-here.test';
const PAYING_DOMAIN = 'paying-co.test';
const ALREADY_CLAIMED_DOMAIN = 'claimed-co.test';
const PERSONAL_DOMAIN = 'personal-only.test';

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [TEST_ORGS]);
}

async function seedOrg(
  pool: Pool,
  orgId: string,
  opts: {
    is_personal?: boolean;
    email_domain?: string | null;
    subscription_status?: string | null;
  } = {},
) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, email_domain, subscription_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET is_personal = EXCLUDED.is_personal,
           email_domain = EXCLUDED.email_domain,
           subscription_status = EXCLUDED.subscription_status`,
    [orgId, `Org ${orgId}`, opts.is_personal ?? false, opts.email_domain ?? null, opts.subscription_status ?? null],
  );
}

async function seedDomain(pool: Pool, orgId: string, domain: string, verified = true) {
  await pool.query(
    `INSERT INTO organization_domains (workos_organization_id, domain, is_primary, verified, source, created_at, updated_at)
     VALUES ($1, $2, true, $3, 'workos', NOW(), NOW())
     ON CONFLICT (domain) DO UPDATE
       SET workos_organization_id = $1, verified = $3`,
    [orgId, domain, verified],
  );
}

async function seedMembership(pool: Pool, orgId: string) {
  await pool.query(
    `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, created_at, updated_at, synced_at)
     VALUES ($1, $2, $3, $4, 'member', 'contributor', NOW(), NOW(), NOW())
     ON CONFLICT DO NOTHING`,
    ['user_existing_member', orgId, 'om_existing', 'existing@member.test'],
  );
}

describe('findClaimableProspectOrgForDomain', () => {
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

  afterEach(async () => {
    await cleanup(pool);
  });

  it('returns null for a domain with no matching org', async () => {
    expect(await findClaimableProspectOrgForDomain(ORPHAN_DOMAIN)).toBeNull();
  });

  it('matches a prospect org by organizations.email_domain', async () => {
    await seedOrg(pool, ORG_PROSPECT_BY_EMAIL_DOMAIN, { email_domain: VOISE_DOMAIN });

    const result = await findClaimableProspectOrgForDomain(VOISE_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.organization_id).toBe(ORG_PROSPECT_BY_EMAIL_DOMAIN);
    expect(result!.matched_domain).toBe(VOISE_DOMAIN);
  });

  it('matches a prospect org by verified organization_domains row', async () => {
    await seedOrg(pool, ORG_PROSPECT_BY_VERIFIED_DOMAIN);
    await seedDomain(pool, ORG_PROSPECT_BY_VERIFIED_DOMAIN, VOISE_DOMAIN, true);

    const result = await findClaimableProspectOrgForDomain(VOISE_DOMAIN);

    expect(result).not.toBeNull();
    expect(result!.organization_id).toBe(ORG_PROSPECT_BY_VERIFIED_DOMAIN);
  });

  it('does not match an unverified organization_domains row', async () => {
    await seedOrg(pool, ORG_PROSPECT_BY_VERIFIED_DOMAIN);
    await seedDomain(pool, ORG_PROSPECT_BY_VERIFIED_DOMAIN, VOISE_DOMAIN, false);

    const result = await findClaimableProspectOrgForDomain(VOISE_DOMAIN);

    expect(result).toBeNull();
  });

  it('does not match an org with an active subscription (auto-link path handles those)', async () => {
    await seedOrg(pool, ORG_PAYING, { email_domain: PAYING_DOMAIN, subscription_status: 'active' });

    const result = await findClaimableProspectOrgForDomain(PAYING_DOMAIN);

    expect(result).toBeNull();
  });

  it('does not match an org that already has members (anti-hijack)', async () => {
    await seedOrg(pool, ORG_HAS_MEMBERS, { email_domain: ALREADY_CLAIMED_DOMAIN });
    await seedMembership(pool, ORG_HAS_MEMBERS);

    const result = await findClaimableProspectOrgForDomain(ALREADY_CLAIMED_DOMAIN);

    expect(result).toBeNull();
  });

  it('does not match a personal org even when the domain matches', async () => {
    await seedOrg(pool, ORG_PERSONAL, { is_personal: true, email_domain: PERSONAL_DOMAIN });
    // (personal orgs intentionally have email_domain NULL in production, but
    // belt-and-braces — even if one slipped through, claiming it should fail.)

    const result = await findClaimableProspectOrgForDomain(PERSONAL_DOMAIN);

    expect(result).toBeNull();
  });

  it('normalizes the input domain (case + whitespace)', async () => {
    await seedOrg(pool, ORG_PROSPECT_BY_EMAIL_DOMAIN, { email_domain: VOISE_DOMAIN });

    const result = await findClaimableProspectOrgForDomain(`  ${VOISE_DOMAIN.toUpperCase()}  `);

    expect(result).not.toBeNull();
    expect(result!.organization_id).toBe(ORG_PROSPECT_BY_EMAIL_DOMAIN);
  });
});
