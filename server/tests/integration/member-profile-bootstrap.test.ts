/**
 * Integration tests for the REST bootstrap path on `POST /api/me/member-profile`.
 *
 * The legacy dashboard flow (display_name + slug body) is unaffected by this
 * dispatch and remains covered by other suites. This file exercises only the
 * spec-shape branch documented in static/openapi/registry.yaml.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/auth.js')>(
    '../../src/middleware/auth.js',
  );
  return {
    ...actual,
    requireAuth: (_req: any, _res: any, next: any) => next(),
  };
});

// Bypass the bootstrap rate limiter — its CachedPostgresStore would otherwise
// retain state across tests in the same suite and across suites in the same
// process. Each individual test still exercises the limiter's `skip` rule
// (legacy bodies vs. bootstrap bodies) implicitly through the route dispatch.
vi.mock('../../src/middleware/rate-limit.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/rate-limit.js')>(
    '../../src/middleware/rate-limit.js',
  );
  return {
    ...actual,
    memberProfileBootstrapRateLimiter: (_req: any, _res: any, next: any) => next(),
  };
});

import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MemberDatabase } from '../../src/db/member-db.js';
import { OrganizationDatabase } from '../../src/db/organization-db.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import { createMemberProfileRouter } from '../../src/routes/member-profiles.js';

const TEST_PREFIX = 'org_member_profile_boot';

describe('POST /api/me/member-profile (REST bootstrap)', () => {
  let pool: Pool;
  let app: express.Application;
  let memberDb: MemberDatabase;
  let orgDb: OrganizationDatabase;
  let brandDb: BrandDatabase;
  let currentUserEmail = 'owner@acme.example';
  let currentUserId = 'user_boot_owner';

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_registry',
      max: 5,
    });
    await runMigrations();

    memberDb = new MemberDatabase();
    orgDb = new OrganizationDatabase();
    brandDb = new BrandDatabase();

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = {
        id: currentUserId,
        email: currentUserEmail,
        firstName: 'Test',
        lastName: 'User',
      };
      next();
    });

    const fakeWorkos = {
      userManagement: {
        listOrganizationMemberships: async ({ userId }: { userId: string }) => {
          const rows = await pool.query<{ workos_organization_id: string; role: string }>(
            `SELECT workos_organization_id, role FROM organization_memberships WHERE workos_user_id = $1`,
            [userId],
          );
          return {
            data: rows.rows.map((r) => ({
              userId,
              organizationId: r.workos_organization_id,
              status: 'active' as const,
              role: { slug: r.role || 'owner' },
            })),
          };
        },
      },
      organizations: {
        getOrganization: async (orgId: string) => {
          const row = await pool.query<{ name: string }>(
            `SELECT name FROM organizations WHERE workos_organization_id = $1`,
            [orgId],
          );
          return { id: orgId, name: row.rows[0]?.name ?? 'Unknown' };
        },
      },
    } as any;

    app.use(
      '/api/me/member-profile',
      createMemberProfileRouter({
        memberDb,
        brandDb,
        orgDb,
        workos: fakeWorkos,
        invalidateMemberContextCache: () => {},
      }),
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM organization_domains WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM registry_audit_log WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await closeDatabase();
  });

  async function seedOrg(
    orgId: string,
    overrides: Partial<{ name: string; company_type: string | null; revenue_tier: string | null; membership_tier: string | null; role: string }> = {},
  ) {
    const name = overrides.name ?? 'Acme Media';
    const role = overrides.role ?? 'owner';
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, company_type, revenue_tier, membership_tier, created_at, updated_at)
       VALUES ($1, $2, false, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET
         name = EXCLUDED.name,
         company_type = EXCLUDED.company_type,
         revenue_tier = EXCLUDED.revenue_tier,
         membership_tier = EXCLUDED.membership_tier`,
      [orgId, name, overrides.company_type ?? null, overrides.revenue_tier ?? null, overrides.membership_tier ?? null],
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = EXCLUDED.role`,
      [currentUserId, orgId, role, currentUserEmail],
    );
  }

  beforeEach(async () => {
    currentUserEmail = 'owner@acme.example';
    currentUserId = 'user_boot_owner';
    await pool.query(`DELETE FROM registry_audit_log WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organization_domains WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
  });

  it.each(['owner', 'member'])('denies bootstrap for existing %s without writing domain proof', async (role) => {
    const orgId = `${TEST_PREFIX}_contained`;
    await seedOrg(orgId);
    await pool.query('UPDATE organization_memberships SET role = $2 WHERE workos_organization_id = $1', [orgId, role]);
    const before = (await pool.query('SELECT * FROM organization_domains WHERE workos_organization_id = $1', [orgId])).rows;
    const res = await request(app).post('/api/me/member-profile').send({
      organization_name: 'Acme', company_type: 'adtech', corporate_domain: 'acme.example',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('organization_onboarding_disabled');
    expect((await pool.query('SELECT * FROM organization_domains WHERE workos_organization_id = $1', [orgId])).rows).toEqual(before);
    expect(await memberDb.getProfileByOrgId(orgId)).toBeNull();
  });

  it('still routes legacy display_name + slug bodies to the original handler', async () => {
    const orgId = `${TEST_PREFIX}_legacy`;
    await seedOrg(orgId);

    const res = await request(app)
      .post('/api/me/member-profile')
      .send({
        display_name: 'Legacy Profile',
        slug: 'legacy-profile-boot',
      });

    // Legacy handler returns 201 + the raw DB profile shape (display_name,
    // slug). We don't assert the full body — only that the bootstrap branch
    // didn't intercept (no organization_id at top level of profile).
    expect(res.status).toBe(201);
    expect(res.body.profile.display_name).toBe('Legacy Profile');
    expect(res.body.profile.slug).toBe('legacy-profile-boot');
    expect(res.body.profile.organization_id).toBeUndefined();
  });
});
