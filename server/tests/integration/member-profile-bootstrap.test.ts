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
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await closeDatabase();
  });

  async function seedOrg(orgId: string) {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = EXCLUDED.name`,
      [orgId, 'Placeholder Co'],
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, 'owner', $3, NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = 'owner'`,
      [currentUserId, orgId, currentUserEmail],
    );
  }

  beforeEach(async () => {
    currentUserEmail = 'owner@acme.example';
    currentUserId = 'user_boot_owner';
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

  it('creates a profile and persists org metadata + verified domain on first call (201)', async () => {
    const orgId = `${TEST_PREFIX}_create`;
    await seedOrg(orgId);

    const res = await request(app)
      .post('/api/me/member-profile')
      .send({
        organization_name: 'Acme Media',
        company_type: 'publisher',
        revenue_tier: '5m_50m',
        corporate_domain: 'acme.example',
        primary_brand_domain: 'acme.example',
        marketing_opt_in: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.profile).toMatchObject({
      organization_id: orgId,
      organization_name: 'Acme Media',
      company_type: 'publisher',
      revenue_tier: '5m_50m',
      corporate_domain: 'acme.example',
      primary_brand_domain: 'acme.example',
      agents: [],
    });
    expect(typeof res.body.profile.created_at).toBe('string');

    const orgRow = await pool.query<{ name: string; company_type: string; revenue_tier: string }>(
      `SELECT name, company_type, revenue_tier FROM organizations WHERE workos_organization_id = $1`,
      [orgId],
    );
    expect(orgRow.rows[0]).toMatchObject({
      name: 'Acme Media',
      company_type: 'publisher',
      revenue_tier: '5m_50m',
    });

    const domainRow = await pool.query<{ verified: boolean; source: string }>(
      `SELECT verified, source FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
      [orgId, 'acme.example'],
    );
    expect(domainRow.rows[0]).toMatchObject({ verified: true, source: 'email_verification' });
  });

  it('is idempotent — second call returns 200 with profile_already_exists warning', async () => {
    const orgId = `${TEST_PREFIX}_idempotent`;
    await seedOrg(orgId);

    const first = await request(app)
      .post('/api/me/member-profile')
      .send({
        organization_name: 'Acme Idempotent',
        company_type: 'publisher',
        corporate_domain: 'acme.example',
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/me/member-profile')
      .send({
        organization_name: 'Acme Idempotent',
        company_type: 'publisher',
        corporate_domain: 'acme.example',
      });
    expect(second.status).toBe(200);
    expect(second.body.profile.organization_id).toBe(orgId);
    expect(second.body.warnings).toEqual([
      expect.objectContaining({ code: 'profile_already_exists' }),
    ]);
  });

  it('rejects personal email domains with 403', async () => {
    currentUserEmail = 'user@gmail.com';
    currentUserId = 'user_boot_personal';
    const orgId = `${TEST_PREFIX}_personal`;
    await seedOrg(orgId);

    const res = await request(app)
      .post('/api/me/member-profile')
      .send({
        organization_name: 'Acme',
        company_type: 'publisher',
        corporate_domain: 'acme.example',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Personal email domain');
  });

  it('rejects domain mismatch with 403', async () => {
    currentUserEmail = 'owner@acme.example';
    const orgId = `${TEST_PREFIX}_mismatch`;
    await seedOrg(orgId);

    const res = await request(app)
      .post('/api/me/member-profile')
      .send({
        organization_name: 'Other Co',
        company_type: 'publisher',
        corporate_domain: 'other.example',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Domain mismatch');
  });

  it('rejects unknown company_type with 400', async () => {
    const orgId = `${TEST_PREFIX}_badtype`;
    await seedOrg(orgId);

    const res = await request(app)
      .post('/api/me/member-profile')
      .send({
        organization_name: 'Acme',
        company_type: 'not_a_real_type',
        corporate_domain: 'acme.example',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid company_type');
  });

  it('returns 404 when caller has no organization', async () => {
    currentUserId = 'user_boot_orphan';
    currentUserEmail = 'orphan@acme.example';

    const res = await request(app)
      .post('/api/me/member-profile')
      .send({
        organization_name: 'Acme',
        company_type: 'publisher',
        corporate_domain: 'acme.example',
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No organization');
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
