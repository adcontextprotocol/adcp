/**
 * Integration tests for the member-facing /api/me/organization/domains
 * surface. Covers list + set-primary. After Stage 2 of #4159,
 * `organization_domains.is_primary` is the single source of truth for
 * both brand identity and org-membership inference, so a single PUT
 * unambiguously sets the primary (Media.net escalation #321).
 *
 * Auth in dev mode reads from the local organization_memberships seed
 * (resolveUserOrgMembership dev bypass), so we seed memberships rather
 * than mocking WorkOS.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Set DEV_USER_* env vars BEFORE auth.ts module-evaluates them — auth.ts
// caches DEV_MODE_ENABLED at module load. vi.hoisted runs before all imports
// in the file, so this beats ESM hoisting.
vi.hoisted(() => {
  process.env.DEV_USER_EMAIL = process.env.DEV_USER_EMAIL || 'admin@test.local';
  process.env.DEV_USER_ID = process.env.DEV_USER_ID || 'user_dev_admin_001';
});

// Replace `requireAuth` with a test stub that reads the user id from
// x-test-user. The real requireAuth reads a signed WorkOS session cookie
// (or static admin key); forging either just to exercise route logic is
// noise. The auth surface itself is covered elsewhere.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    requireAuth: (req: any, _res: any, next: any) => {
      const userId = req.headers['x-test-user'];
      if (typeof userId === 'string') req.user = { id: userId };
      return next();
    },
  };
});

import express from 'express';
import request from 'supertest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createMeOrganizationDomainsRouter } from '../../src/routes/me-organization-domains.js';
import type { Pool } from 'pg';

const TEST_ORG = 'org_me_domains_test';
const OWNER_USER = 'user_dev_admin_001';
const MEMBER_USER = 'user_dev_member_001';

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM brands WHERE domain LIKE $1', ['me-domains-%.test']);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG]);
}

async function seedOrgWithDomains(pool: Pool, domains: Array<{ domain: string; verified: boolean; is_primary: boolean; source?: string }>) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
     VALUES ($1, $2, false, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [TEST_ORG, 'Me Domains Test Co'],
  );
  for (const d of domains) {
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET verified = EXCLUDED.verified, is_primary = EXCLUDED.is_primary, source = EXCLUDED.source`,
      [TEST_ORG, d.domain, d.verified, d.is_primary, d.source ?? 'workos'],
    );
  }
}

async function seedProfile(pool: Pool) {
  await pool.query(
    `INSERT INTO member_profiles (workos_organization_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [TEST_ORG, 'me-domains-test', 'Me Domains Test Co'],
  );
}

async function seedMembership(pool: Pool, userId: string, role: 'owner' | 'admin' | 'member') {
  await pool.query(
    `INSERT INTO organization_memberships (
       workos_user_id, workos_organization_id, workos_membership_id,
       email, first_name, last_name, role, seat_type, provisioning_source,
       synced_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Test', 'User', $5, 'contributor', 'manual', NOW(), NOW(), NOW())
     ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, TEST_ORG, `om_${userId}_${TEST_ORG}`, `${userId}@test.local`, role],
  );
}

function buildApp(invalidateMemberContextCache: () => void) {
  const app = express();
  app.use(express.json());
  // requireAuth is replaced via vi.mock above; it reads x-test-user from
  // the request headers and populates req.user.
  const router = createMeOrganizationDomainsRouter({
    workos: null,
    invalidateMemberContextCache,
  });
  app.use('/api/me/organization/domains', router);
  return app;
}

describe('GET /api/me/organization/domains + PUT /:domain/primary', () => {
  let pool: Pool;
  let cacheInvalidations: number;
  let app: ReturnType<typeof buildApp>;

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
    cacheInvalidations = 0;
    app = buildApp(() => { cacheInvalidations += 1; });
  });

  it('lists verified domains with is_primary and is_brand_primary flags', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
      { domain: 'me-domains-2.test', verified: true, is_primary: false },
      { domain: 'me-domains-pending.test', verified: false, is_primary: false },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .get('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(200);
    expect(res.body.primary_brand_domain).toBe('me-domains-1.test');
    expect(res.body.domains).toHaveLength(3);
    const byDomain = Object.fromEntries(res.body.domains.map((d: any) => [d.domain, d]));
    expect(byDomain['me-domains-1.test']).toMatchObject({ is_primary: true, verified: true, is_brand_primary: true, claimable: true });
    expect(byDomain['me-domains-2.test']).toMatchObject({ is_primary: false, verified: true, is_brand_primary: false, claimable: true });
    expect(byDomain['me-domains-pending.test']).toMatchObject({ verified: false });
  });

  it('PUT primary moves organization_domains.is_primary and updates organizations.email_domain', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
      { domain: 'me-domains-2.test', verified: true, is_primary: false },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .put('/api/me/organization/domains/me-domains-2.test/primary?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, primary_domain: 'me-domains-2.test' });
    expect(cacheInvalidations).toBe(1);

    const od = await pool.query<{ domain: string; is_primary: boolean }>(
      `SELECT domain, is_primary FROM organization_domains WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    const od_by = Object.fromEntries(od.rows.map((r) => [r.domain, r.is_primary]));
    expect(od_by['me-domains-2.test']).toBe(true);
    expect(od_by['me-domains-1.test']).toBe(false);

    const org = await pool.query<{ email_domain: string }>(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(org.rows[0].email_domain).toBe('me-domains-2.test');
  });

  it('rejects PUT primary from a non-owner/admin member', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
      { domain: 'me-domains-2.test', verified: true, is_primary: false },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, MEMBER_USER, 'member');

    const res = await request(app)
      .put('/api/me/organization/domains/me-domains-2.test/primary?org=' + TEST_ORG)
      .set('x-test-user', MEMBER_USER);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not authorized');

    // No write happened.
    const od = await pool.query<{ domain: string; is_primary: boolean }>(
      `SELECT domain, is_primary FROM organization_domains WHERE workos_organization_id = $1 AND is_primary = true`,
      [TEST_ORG],
    );
    expect(od.rows[0].domain).toBe('me-domains-1.test');
  });

  it('rejects PUT primary on an unverified domain', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
      { domain: 'me-domains-pending.test', verified: false, is_primary: false },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .put('/api/me/organization/domains/me-domains-pending.test/primary?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('domain_not_verified');
  });

  it('refuses PUT primary for source != workos (admin-imported / manual rows)', async () => {
    // After Stage 2 of #4159, is_primary drives both org-membership
    // inference and brand identity. We hold the bar at WorkOS DNS proof:
    // an admin-imported verified=true row shouldn't be promotable via
    // member self-service — that would let an admin escalate brand
    // identity by importing a row.
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true, source: 'workos' },
      { domain: 'me-domains-imported.test', verified: true, is_primary: false, source: 'import' },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .put('/api/me/organization/domains/me-domains-imported.test/primary?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('domain_not_workos_verified');

    // is_primary unchanged — the original WorkOS-verified domain stays primary.
    const od = await pool.query<{ domain: string; is_primary: boolean }>(
      `SELECT domain, is_primary FROM organization_domains WHERE workos_organization_id = $1 AND is_primary = true`,
      [TEST_ORG],
    );
    expect(od.rows[0].domain).toBe('me-domains-1.test');
  });

  it('returns 404 for a domain not on this org', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .put('/api/me/organization/domains/some-other.test/primary?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(404);
  });
});
