/**
 * Integration tests for applyVerifiedBrandClaim — the brand-registry side
 * of the WorkOS-driven brand-claim flow (#3176).
 *
 * The route handler (POST /api/me/member-profile/brand-claim/verify) and the
 * organization_domain.verified webhook BOTH call this method after WorkOS
 * confirms the DNS challenge. Whichever lands first wins; the other is a
 * no-op. This suite pins that idempotency contract plus the orphan/fresh
 * branching that the route's adopt_prior_manifest flag exposes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import type { Pool } from 'pg';

const TEST_DOMAIN = 'claim-apply.example.com';
const ORG_A = 'org_test_apply_a';
const ORG_B = 'org_test_apply_b';
const USER_ON_DOMAIN = 'user_test_apply_on_domain';
const USER_UNVERIFIED = 'user_test_apply_unverified';

describe('applyVerifiedBrandClaim', () => {
  let pool: Pool;
  let brandDb: BrandDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    brandDb = new BrandDatabase();
  });

  async function cleanup() {
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id IN ($1, $2)', [USER_ON_DOMAIN, USER_UNVERIFIED]);
    await pool.query('DELETE FROM users WHERE workos_user_id IN ($1, $2)', [USER_ON_DOMAIN, USER_UNVERIFIED]);
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)', [ORG_A, ORG_B]);
  }

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal)
       VALUES ($1, 'Org A', false), ($2, 'Org B', false)
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG_A, ORG_B]
    );
  });

  it('creates a verified brand row when none exists, recording how it was verified', async () => {
    const result = await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A, 'dns');
    expect(result).toBeTruthy();
    expect(result!.workos_organization_id).toBe(ORG_A);
    expect(result!.domain_verified).toBe(true);
    expect(result!.domain_verification_method).toBe('dns');
    expect(result!.is_public).toBe(true);
  });

  it('is idempotent — second call with the same org is a no-op match', async () => {
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A, 'dns');
    const second = await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A, 'dns');
    expect(second).toBeTruthy();
    expect(second!.workos_organization_id).toBe(ORG_A);
    expect(second!.domain_verified).toBe(true);
  });

  it('transfers ownership when an unverified incumbent is replaced (matches WorkOS state)', async () => {
    // Seed an unverified incumbent — corresponds to the soft-claim case
    // before WorkOS verified the new claimant. WorkOS would reject the
    // create call upstream if both were verified, so the inline write only
    // ever transfers between unverified or unclaimed states.
    await pool.query(
      `INSERT INTO brands (domain, workos_organization_id, source_type, review_status, is_public, has_brand_manifest, domain_verified)
       VALUES ($1, $2, 'community', 'approved', TRUE, FALSE, FALSE)`,
      [TEST_DOMAIN, ORG_A]
    );
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B, 'dns');
    const row = await pool.query<{ workos_organization_id: string; domain_verified: boolean }>(
      'SELECT workos_organization_id, domain_verified FROM brands WHERE domain = $1',
      [TEST_DOMAIN]
    );
    expect(row.rows[0].workos_organization_id).toBe(ORG_B);
    expect(row.rows[0].domain_verified).toBe(true);
  });

  it('clears the orphan flag and resets manifest by default', async () => {
    // Seed an orphaned brand — prior owner relinquished, manifest preserved.
    await pool.query(
      `INSERT INTO brands (
         domain, brand_manifest, source_type, review_status,
         is_public, has_brand_manifest, manifest_orphaned, prior_owner_org_id
       ) VALUES ($1, $2, 'community', 'approved', FALSE, TRUE, TRUE, $3)`,
      [
        TEST_DOMAIN,
        JSON.stringify({ brands: [{ id: 'prior', logos: [{ url: 'https://prior.example.com/logo.png' }] }] }),
        ORG_A,
      ]
    );
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B, 'dns');
    const row = await pool.query<{
      manifest_orphaned: boolean;
      prior_owner_org_id: string | null;
      brand_manifest: Record<string, unknown>;
      has_brand_manifest: boolean;
    }>(
      'SELECT manifest_orphaned, prior_owner_org_id, brand_manifest, has_brand_manifest FROM brands WHERE domain = $1',
      [TEST_DOMAIN]
    );
    expect(row.rows[0].manifest_orphaned).toBe(false);
    expect(row.rows[0].prior_owner_org_id).toBeNull();
    expect(row.rows[0].has_brand_manifest).toBe(false);
    expect(row.rows[0].brand_manifest).toEqual({});
  });

  it('webhook sync (syncBrandDomainFromWorkos) does NOT clobber a manifest the inline route adopted', async () => {
    // Race the reviewer flagged: inline /verify writes adoptPriorManifest=true,
    // preserving the prior manifest. Then the WorkOS webhook fires for the
    // same verification and lands a second write. Without the split between
    // applyVerifiedBrandClaim (manifest-aware) and syncBrandDomainFromWorkos
    // (sync-only), the webhook would reset brand_manifest = '{}' and undo
    // the user's choice.
    await pool.query(
      `INSERT INTO brands (
         domain, brand_manifest, source_type, review_status,
         is_public, has_brand_manifest, manifest_orphaned, prior_owner_org_id
       ) VALUES ($1, $2, 'community', 'approved', FALSE, TRUE, TRUE, $3)`,
      [
        TEST_DOMAIN,
        JSON.stringify({ brands: [{ id: 'prior', logos: [{ url: 'https://prior.example.com/logo.png' }] }] }),
        ORG_A,
      ]
    );
    // 1. Inline /verify with adopt
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B, 'dns', { adoptPriorManifest: true });
    // 2. Webhook backstop fires (sync only)
    await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_B, 'dns');

    const row = await pool.query<{
      manifest_orphaned: boolean;
      brand_manifest: { brands?: Array<{ logos?: Array<{ url: string }> }> };
      has_brand_manifest: boolean;
    }>(
      'SELECT manifest_orphaned, brand_manifest, has_brand_manifest FROM brands WHERE domain = $1',
      [TEST_DOMAIN]
    );
    expect(row.rows[0].manifest_orphaned).toBe(false);
    expect(row.rows[0].has_brand_manifest).toBe(true);
    // Adopted manifest survives the webhook write.
    expect(row.rows[0].brand_manifest.brands?.[0]?.logos?.[0]?.url).toBe('https://prior.example.com/logo.png');
  });

  it('webhook sync claims and verifies an unowned DNS-verified domain', async () => {
    const result = await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'dns');
    expect(result).toBeTruthy();
    expect(result!.workos_organization_id).toBe(ORG_A);
    expect(result!.domain_verified).toBe(true);
    expect(result!.domain_verification_method).toBe('dns');
  });

  it('webhook sync is idempotent — repeated calls converge to the same end state', async () => {
    const first = await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'dns');
    const second = await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'dns');
    expect(first?.workos_organization_id).toBe(ORG_A);
    expect(second?.workos_organization_id).toBe(ORG_A);
    expect(first?.domain_verified).toBe(true);
    expect(second?.domain_verified).toBe(true);
  });

  it('keeps the organization\'s own manifest when it re-verifies a row it already holds', async () => {
    await pool.query(
      `INSERT INTO brands (domain, workos_organization_id, brand_manifest, source_type, review_status,
         is_public, has_brand_manifest, domain_verified, domain_verification_method)
       VALUES ($1, $2, $3, 'enriched', 'approved', TRUE, TRUE, FALSE, 'manual')`,
      [TEST_DOMAIN, ORG_A, JSON.stringify({ name: 'Own Brand' })],
    );
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A, 'dns');
    const row = await pool.query<{ brand_manifest: Record<string, unknown>; has_brand_manifest: boolean; domain_verification_method: string }>(
      'SELECT brand_manifest, has_brand_manifest, domain_verification_method FROM brands WHERE domain = $1',
      [TEST_DOMAIN],
    );
    expect(row.rows[0]).toEqual({
      brand_manifest: { name: 'Own Brand' },
      has_brand_manifest: true,
      domain_verification_method: 'dns',
    });
  });

  it('starts a new owner fresh even when the prior owner\'s row was not orphaned', async () => {
    await pool.query(
      `INSERT INTO brands (domain, workos_organization_id, brand_manifest, source_type, review_status,
         is_public, has_brand_manifest, domain_verified)
       VALUES ($1, $2, $3, 'community', 'approved', TRUE, TRUE, FALSE)`,
      [TEST_DOMAIN, ORG_A, JSON.stringify({ name: 'Prior Owner Brand' })],
    );
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B, 'dns');
    const row = await pool.query<{ brand_manifest: Record<string, unknown>; workos_organization_id: string }>(
      'SELECT brand_manifest, workos_organization_id FROM brands WHERE domain = $1',
      [TEST_DOMAIN],
    );
    expect(row.rows[0]).toEqual({ brand_manifest: {}, workos_organization_id: ORG_B });
  });

  it('preserves the prior manifest when adoptPriorManifest is true', async () => {
    await pool.query(
      `INSERT INTO brands (
         domain, brand_manifest, source_type, review_status,
         is_public, has_brand_manifest, manifest_orphaned, prior_owner_org_id
       ) VALUES ($1, $2, 'community', 'approved', FALSE, TRUE, TRUE, $3)`,
      [
        TEST_DOMAIN,
        JSON.stringify({ brands: [{ id: 'prior', logos: [{ url: 'https://prior.example.com/logo.png' }] }] }),
        ORG_A,
      ]
    );
    await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B, 'dns', { adoptPriorManifest: true });
    const row = await pool.query<{
      manifest_orphaned: boolean;
      brand_manifest: { brands?: Array<{ logos?: Array<{ url: string }> }> };
    }>(
      'SELECT manifest_orphaned, brand_manifest FROM brands WHERE domain = $1',
      [TEST_DOMAIN]
    );
    expect(row.rows[0].manifest_orphaned).toBe(false);
    expect(row.rows[0].brand_manifest.brands?.[0]?.logos?.[0]?.url).toBe('https://prior.example.com/logo.png');
  });
  describe('how a domain was verified', () => {
    async function addMember(
      userId: string,
      orgId: string,
      email: string,
      emailVerified: boolean,
      provisioningSource: string | null = 'invited',
    ) {
      await pool.query(
        'INSERT INTO users (workos_user_id, email, email_verified) VALUES ($1, $2, $3)',
        [userId, email, emailVerified],
      );
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, provisioning_source)
         VALUES ($1, $2, $3, $4)`,
        [userId, orgId, email, provisioningSource],
      );
    }

    async function row() {
      const result = await pool.query<{
        workos_organization_id: string | null;
        domain_verified: boolean;
        domain_verification_method: string | null;
        brand_manifest: Record<string, unknown>;
      }>(
        'SELECT workos_organization_id, domain_verified, domain_verification_method, brand_manifest FROM brands WHERE domain = $1',
        [TEST_DOMAIN],
      );
      return result.rows[0];
    }

    it('links an administrator-asserted domain to the org without verifying it, on every sync', async () => {
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({
        workos_organization_id: ORG_A,
        domain_verified: false,
        domain_verification_method: 'manual',
      });
    });

    it('keeps the community record when an administrator-asserted domain is linked', async () => {
      await pool.query(
        `INSERT INTO brands (domain, brand_manifest, source_type, review_status, is_public, has_brand_manifest)
         VALUES ($1, $2, 'enriched', 'approved', TRUE, TRUE)`,
        [TEST_DOMAIN, JSON.stringify({ name: 'Enriched Name' })],
      );
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect((await row()).brand_manifest).toEqual({ name: 'Enriched Name' });
    });

    it('verifies an administrator-asserted domain when a member has a verified email on it', async () => {
      await addMember(USER_ON_DOMAIN, ORG_A, `someone@${TEST_DOMAIN}`, true);
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'member_email' });
    });

    it('does not count a member whose email is unverified', async () => {
      await addMember(USER_UNVERIFIED, ORG_A, `someone@${TEST_DOMAIN}`, false);
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({ domain_verified: false, domain_verification_method: 'manual' });
    });

    it('leaves a row verified before the method was recorded to the reclassification script', async () => {
      await pool.query(
        `INSERT INTO brands (domain, workos_organization_id, source_type, review_status, is_public, domain_verified)
         VALUES ($1, $2, 'enriched', 'approved', TRUE, TRUE)`,
        [TEST_DOMAIN, ORG_A],
      );
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: null });

      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual', { reclassifyLegacy: true });
      expect(await row()).toMatchObject({ domain_verified: false, domain_verification_method: 'manual' });
    });

    it('records proof on a legacy row from a routine sync', async () => {
      await pool.query(
        `INSERT INTO brands (domain, workos_organization_id, source_type, review_status, is_public, domain_verified)
         VALUES ($1, $2, 'enriched', 'approved', TRUE, TRUE)`,
        [TEST_DOMAIN, ORG_A],
      );
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'dns');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'dns' });
    });

    it('does not let an administrator-asserted domain displace another org\'s verified row', async () => {
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'dns');
      const result = await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_B, 'manual');
      expect(result).toMatchObject({ workos_organization_id: ORG_A, domain_verified: true });
      expect(await row()).toMatchObject({
        workos_organization_id: ORG_A,
        domain_verified: true,
        domain_verification_method: 'dns',
      });
    });

    it('does not downgrade DNS or brand.json proof on a later administrator assertion', async () => {
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'dns');
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'dns' });

      const hosted = await brandDb.getHostedBrandByDomain(TEST_DOMAIN);
      await brandDb.updateHostedBrand(hosted!.id, { verified_by_brand_json_pointer: true });
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'brand_json' });
    });

    it('verifies an administrator-asserted domain when a member with an email on it joins later', async () => {
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      await addMember(USER_ON_DOMAIN, ORG_A, `someone@${TEST_DOMAIN}`, true);
      expect(await brandDb.promoteManualDomainsForMember(ORG_A, USER_ON_DOMAIN)).toEqual([TEST_DOMAIN]);
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'member_email' });
    });

    it('does not promote a domain for a member of another org', async () => {
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      await addMember(USER_ON_DOMAIN, ORG_B, `someone@${TEST_DOMAIN}`, true);
      expect(await brandDb.promoteManualDomainsForMember(ORG_A, USER_ON_DOMAIN)).toEqual([]);
      expect(await row()).toMatchObject({ domain_verified: false, domain_verification_method: 'manual' });
    });

    it('records brand.json pointer proof', async () => {
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      const hosted = await brandDb.getHostedBrandByDomain(TEST_DOMAIN);
      await brandDb.updateHostedBrand(hosted!.id, { verified_by_brand_json_pointer: true });
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'brand_json' });
    });
    it('does not count a member an org admin added without their consent', async () => {
      await addMember(USER_ON_DOMAIN, ORG_A, `someone@${TEST_DOMAIN}`, true, 'admin_added');
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({ domain_verified: false, domain_verification_method: 'manual' });
      expect(await brandDb.promoteManualDomainsForMember(ORG_A, USER_ON_DOMAIN)).toEqual([]);
    });

    it('counts a member whose membership predates provenance tracking', async () => {
      await addMember(USER_ON_DOMAIN, ORG_A, `Someone@${TEST_DOMAIN.toUpperCase()}`, true, null);
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'member_email' });
    });

    it('does not let member evidence take another org\'s verified row', async () => {
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'dns');
      await addMember(USER_ON_DOMAIN, ORG_B, `someone@${TEST_DOMAIN}`, true);
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_B, 'manual');
      expect(await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_B, 'member_email')).toBeNull();
      expect(await row()).toMatchObject({ workos_organization_id: ORG_A, domain_verification_method: 'dns' });
    });

    it('lets DNS proof move a verified row to a new org', async () => {
      await addMember(USER_ON_DOMAIN, ORG_A, `someone@${TEST_DOMAIN}`, true);
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_B, 'dns');
      expect(await row()).toMatchObject({
        workos_organization_id: ORG_B,
        domain_verified: true,
        domain_verification_method: 'dns',
      });
    });

    it('keeps a legacy row whose own brand.json was read as brand_json proof', async () => {
      await pool.query(
        `INSERT INTO brands (domain, workos_organization_id, source_type, review_status, is_public, domain_verified)
         VALUES ($1, $2, 'brand_json', 'approved', TRUE, TRUE)`,
        [TEST_DOMAIN, ORG_A],
      );
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'brand_json' });
    });

    async function insertLegacyPointerRow() {
      await pool.query(
        `INSERT INTO brands (domain, workos_organization_id, source_type, review_status, is_public, domain_verified)
         VALUES ($1, $2, 'brand_json', 'approved', TRUE, TRUE)`,
        [TEST_DOMAIN, ORG_A],
      );
    }

    it('records fresh member evidence on a legacy row whose brand.json was once read', async () => {
      await insertLegacyPointerRow();
      await addMember(USER_ON_DOMAIN, ORG_A, `someone@${TEST_DOMAIN}`, true);
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'member_email' });
    });

    it('records the claimed method on a legacy row whose brand.json was once read', async () => {
      await insertLegacyPointerRow();
      await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A, 'member_email');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'member_email' });
    });

    it('keeps a legacy row whose brand.json was read even when reclassifying', async () => {
      await insertLegacyPointerRow();
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual', { reclassifyLegacy: true });
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'brand_json' });
    });

    it('does not replace stronger proof with a member\'s email', async () => {
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'dns');
      await brandDb.applyVerifiedBrandClaim(TEST_DOMAIN, ORG_A, 'member_email');
      expect(await row()).toMatchObject({ domain_verified: true, domain_verification_method: 'dns' });
    });

    it('leaves a relinquished row orphaned on an administrator assertion', async () => {
      await pool.query(
        `INSERT INTO brands (domain, brand_manifest, source_type, review_status, is_public,
           has_brand_manifest, manifest_orphaned, prior_owner_org_id)
         VALUES ($1, $2, 'community', 'approved', FALSE, TRUE, TRUE, $3)`,
        [TEST_DOMAIN, JSON.stringify({ name: 'Prior' }), ORG_B],
      );
      await brandDb.syncBrandDomainFromWorkos(TEST_DOMAIN, ORG_A, 'manual');
      const result = await pool.query<{ manifest_orphaned: boolean; is_public: boolean; prior_owner_org_id: string | null }>(
        'SELECT manifest_orphaned, is_public, prior_owner_org_id FROM brands WHERE domain = $1',
        [TEST_DOMAIN],
      );
      expect(result.rows[0]).toEqual({ manifest_orphaned: true, is_public: false, prior_owner_org_id: ORG_B });
    });
  });
});
