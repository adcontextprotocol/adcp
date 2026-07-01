/**
 * Integration tests for GET /api/brands/:domain/ownership (#4741).
 *
 * Exercises the four observable states (community, verified, orphaned, plus
 * the not-found-but-treated-as-community case) and the auth-conditional
 * can_claim / can_manage hints.
 *
 * Run locally:
 *   DATABASE_URL=postgresql://adcp:localdev@localhost:53198/adcp_test \
 *     npx vitest run server/tests/integration/brand-ownership-route.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

let currentUserId: string | null = null;

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...actual,
    optionalAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      if (currentUserId !== null) {
        req.user = { id: currentUserId, email: `${currentUserId}@test.com` };
      }
      next();
    },
    requireAuth: (req: { user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (currentUserId === null) return res.status(401).json({ error: 'auth required' });
      req.user = { id: currentUserId, email: `${currentUserId}@test.com` };
      next();
    },
  };
});

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import { createBrandOwnershipRouter } from '../../src/routes/brand-ownership.js';

const RUN_SUFFIX = `${process.pid}-${Date.now()}`;
const OWNER_USER_ID = `user_test_brand_ownership_owner_${RUN_SUFFIX}`;
const OTHER_USER_ID = `user_test_brand_ownership_other_${RUN_SUFFIX}`;
const OWNER_ORG_ID = `org_test_brand_ownership_owner_${RUN_SUFFIX}`;
const OTHER_ORG_ID = `org_test_brand_ownership_other_${RUN_SUFFIX}`;

const VERIFIED_DOMAIN = `verified-${RUN_SUFFIX}.example.com`;
const COMMUNITY_DOMAIN = `community-${RUN_SUFFIX}.example.com`;
const ORPHANED_DOMAIN = `orphaned-${RUN_SUFFIX}.example.com`;
const MISSING_DOMAIN = `missing-${RUN_SUFFIX}.example.com`;

describe('GET /api/brands/:domain/ownership', () => {
  let pool: Pool;
  let app: express.Express;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Acme Corp', NOW(), NOW()), ($2, 'Other Corp', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [OWNER_ORG_ID, OTHER_ORG_ID],
    );

    // Cache primary org pointer for both users — resolvePrimaryOrganization
    // reads from users.primary_organization_id (denormalized, FK-enforced),
    // not from organization_memberships, so the membership rows below are
    // belt-and-suspenders for any consumer that prefers WorkOS-shaped joins.
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
       VALUES ($1, $3, $5, NOW(), NOW()), ($2, $4, $6, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET primary_organization_id = EXCLUDED.primary_organization_id`,
      [OWNER_USER_ID, OTHER_USER_ID, `${OWNER_USER_ID}@test.com`, `${OTHER_USER_ID}@test.com`, OWNER_ORG_ID, OTHER_ORG_ID],
    );

    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, created_at, updated_at)
       VALUES ($1, $3, $5, 'admin', NOW(), NOW()), ($2, $4, $6, 'admin', NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
      [OWNER_USER_ID, OTHER_USER_ID, OWNER_ORG_ID, OTHER_ORG_ID, `${OWNER_USER_ID}@test.com`, `${OTHER_USER_ID}@test.com`],
    );

    const brandDb = new BrandDatabase();
    app = express();
    app.use(express.json());
    app.use('/api', createBrandOwnershipRouter({ brandDb }));
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM brands WHERE domain IN ($1, $2, $3, $4)`,
      [VERIFIED_DOMAIN, COMMUNITY_DOMAIN, ORPHANED_DOMAIN, MISSING_DOMAIN],
    );
    await pool.query(
      `DELETE FROM organization_memberships WHERE workos_organization_id IN ($1, $2)`,
      [OWNER_ORG_ID, OTHER_ORG_ID],
    );
    await pool.query(
      `DELETE FROM users WHERE workos_user_id IN ($1, $2)`,
      [OWNER_USER_ID, OTHER_USER_ID],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)`,
      [OWNER_ORG_ID, OTHER_ORG_ID],
    );
    await closeDatabase();
  });

  beforeEach(async () => {
    currentUserId = null;
    await pool.query(`DELETE FROM brands WHERE domain IN ($1, $2, $3, $4)`,
      [VERIFIED_DOMAIN, COMMUNITY_DOMAIN, ORPHANED_DOMAIN, MISSING_DOMAIN]);
  });

  async function seedBrand(domain: string, fields: Record<string, unknown>) {
    const cols = ['domain', 'brand_name', 'source_type', 'is_public', 'has_brand_manifest', 'review_status', ...Object.keys(fields)];
    const vals = [domain, 'Test Brand', 'community', true, false, 'approved', ...Object.values(fields)];
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(`INSERT INTO brands (${cols.join(', ')}) VALUES (${placeholders})`, vals);
  }

  it('returns community for a brand with no owner', async () => {
    await seedBrand(COMMUNITY_DOMAIN, {});
    const res = await request(app).get(`/api/brands/${COMMUNITY_DOMAIN}/ownership`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      domain: COMMUNITY_DOMAIN,
      status: 'community',
      owner: null,
      can_claim: false,
      can_manage: false,
      authenticated: false,
    });
  });

  it('returns community (not 404) for a domain with no brand row at all', async () => {
    const res = await request(app).get(`/api/brands/${MISSING_DOMAIN}/ownership`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('community');
    expect(res.body.owner).toBeNull();
  });

  it('returns verified with owner name when a brand is claimed and DNS-verified', async () => {
    await seedBrand(VERIFIED_DOMAIN, {
      workos_organization_id: OWNER_ORG_ID,
      domain_verified: true,
    });
    const res = await request(app).get(`/api/brands/${VERIFIED_DOMAIN}/ownership`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'verified',
      owner: { name: 'Acme Corp' },
      authenticated: false,
      can_claim: false,
      can_manage: false,
    });
  });

  it('flags can_manage when the authenticated user belongs to the owning org', async () => {
    await seedBrand(VERIFIED_DOMAIN, {
      workos_organization_id: OWNER_ORG_ID,
      domain_verified: true,
    });
    currentUserId = OWNER_USER_ID;
    const res = await request(app).get(`/api/brands/${VERIFIED_DOMAIN}/ownership`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('verified');
    expect(res.body.can_manage).toBe(true);
    expect(res.body.can_claim).toBe(false);
    expect(res.body.manage_url).toBe(`/brand/builder?domain=${encodeURIComponent(VERIFIED_DOMAIN)}`);
    expect(res.body.claim_url).toBeNull();
  });

  it('does not let a user from another org manage a verified brand', async () => {
    await seedBrand(VERIFIED_DOMAIN, {
      workos_organization_id: OWNER_ORG_ID,
      domain_verified: true,
    });
    currentUserId = OTHER_USER_ID;
    const res = await request(app).get(`/api/brands/${VERIFIED_DOMAIN}/ownership`);
    expect(res.status).toBe(200);
    expect(res.body.can_manage).toBe(false);
    // A verified brand is not claimable by another org through this UX path.
    expect(res.body.can_claim).toBe(false);
  });

  it('lets any authenticated user claim a community brand', async () => {
    await seedBrand(COMMUNITY_DOMAIN, {});
    currentUserId = OTHER_USER_ID;
    const res = await request(app).get(`/api/brands/${COMMUNITY_DOMAIN}/ownership`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('community');
    expect(res.body.can_claim).toBe(true);
    expect(res.body.claim_url).toBe(`/brand/builder?domain=${encodeURIComponent(COMMUNITY_DOMAIN)}`);
  });

  it('reports orphaned status when prior owner relinquished', async () => {
    await seedBrand(ORPHANED_DOMAIN, {
      manifest_orphaned: true,
      prior_owner_org_id: OWNER_ORG_ID,
    });
    currentUserId = OTHER_USER_ID;
    const res = await request(app).get(`/api/brands/${ORPHANED_DOMAIN}/ownership`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('orphaned');
    // Owner is null for orphaned brands — prior_owner_org_id is internal state.
    expect(res.body.owner).toBeNull();
    expect(res.body.can_claim).toBe(true);
  });

  it('rejects malformed domains', async () => {
    const res = await request(app).get('/api/brands/not_a_domain/ownership');
    expect(res.status).toBe(400);
  });
});
