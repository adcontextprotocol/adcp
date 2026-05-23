/**
 * Authz coverage for POST /api/me/member-profile/verify-brand.
 *
 * The endpoint is a mutating brand-ownership verification path, not a
 * read-only status check. Plain org members must not be able to finalize
 * verification for either their primary org or a URL-selected org.
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

vi.mock('../../src/services/brand-logo-service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/brand-logo-service.js')>(
    '../../src/services/brand-logo-service.js',
  );
  return {
    ...actual,
    checkLogoUrlIsImage: vi.fn().mockResolvedValue({ ok: true, contentType: 'image/png' }),
    rehostExternalLogo: vi.fn().mockImplementation(async (url: string) => url),
  };
});

import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MemberDatabase } from '../../src/db/member-db.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import { OrganizationDatabase } from '../../src/db/organization-db.js';
import { createMemberProfileRouter } from '../../src/routes/member-profiles.js';

const TEST_PREFIX = 'org_verify_brand_auth';
const TEST_ORG = `${TEST_PREFIX}_main`;
const OTHER_ORG = `${TEST_PREFIX}_other`;
const MEMBER_USER = `${TEST_PREFIX}_member`;
const OUTSIDER_USER = `${TEST_PREFIX}_outsider`;

describe('POST /api/me/member-profile/verify-brand authz', () => {
  let pool: Pool;
  let app: express.Application;
  let memberDb: MemberDatabase;
  let currentUserId = MEMBER_USER;
  let createdOrganizationDomains: Array<{ organizationId: string; domain: string }> = [];
  const workosDomainsByOrg = new Map<string, any[]>();

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
      max: 5,
    });
    await runMigrations();

    memberDb = new MemberDatabase();
    const brandDb = new BrandDatabase();
    const orgDb = new OrganizationDatabase();

    const fakeWorkos = {
      userManagement: {
        listOrganizationMemberships: async ({
          userId,
          organizationId,
        }: {
          userId: string;
          organizationId?: string;
        }) => {
          const rows = await pool.query<{ workos_organization_id: string; role: string }>(
            `SELECT workos_organization_id, role
               FROM organization_memberships
              WHERE workos_user_id = $1
                AND ($2::text IS NULL OR workos_organization_id = $2)`,
            [userId, organizationId ?? null],
          );
          return {
            data: rows.rows.map((r) => ({
              userId,
              organizationId: r.workos_organization_id,
              status: 'active' as const,
              role: { slug: r.role || 'member' },
            })),
          };
        },
      },
      organizations: {
        getOrganization: async (orgId: string) => ({
          id: orgId,
          name: `Org ${orgId}`,
          domains: workosDomainsByOrg.get(orgId) ?? [],
        }),
      },
      organizationDomains: {
        createOrganizationDomain: async ({
          organizationId,
          domain,
        }: {
          organizationId: string;
          domain: string;
        }) => {
          createdOrganizationDomains.push({ organizationId, domain });
          const created = {
            id: `org_domain_${domain.replace(/[^a-z0-9]/gi, '_')}`,
            domain,
            organizationId,
            state: 'pending',
            verificationToken: 'test-token',
            verificationPrefix: '_workos',
            verificationStrategy: 'dns',
          };
          const domains = workosDomainsByOrg.get(organizationId) ?? [];
          domains.push(created);
          workosDomainsByOrg.set(organizationId, domains);
          return created;
        },
        verifyOrganizationDomain: async (domainId: string) => {
          for (const domains of workosDomainsByOrg.values()) {
            const domain = domains.find((d) => d.id === domainId);
            if (domain) {
              domain.state = 'verified';
              return domain;
            }
          }
          throw new Error(`Unknown organization domain ${domainId}`);
        },
      },
    } as any;

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = {
        id: currentUserId,
        email: `${currentUserId}@example.com`,
        firstName: 'Test',
        lastName: 'User',
      };
      next();
    });
    app.use(
      '/api/me/member-profile',
      createMemberProfileRouter({
        workos: fakeWorkos,
        memberDb,
        brandDb,
        orgDb,
        invalidateMemberContextCache: () => {},
      }),
    );
  });

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    currentUserId = MEMBER_USER;
    createdOrganizationDomains = [];
    workosDomainsByOrg.clear();
  });

  async function cleanup() {
    await pool.query(
      `DELETE FROM brands
        WHERE workos_organization_id LIKE $1
           OR domain IN ('selected-verify-brand-auth.example')`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(`DELETE FROM organization_domains WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${TEST_PREFIX}%`]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
  }

  async function seedOrg(orgId: string) {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())`,
      [orgId, `Verify Brand Auth ${orgId}`],
    );
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: `Profile ${orgId}`,
      slug: orgId.replace(/_/g, '-'),
      is_public: false,
      agents: [],
    });
    await pool.query(
      `INSERT INTO organization_domains
         (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'workos', NOW(), NOW())`,
      [orgId, `${orgId}.example`],
    );
  }

  async function seedUser(userId: string, orgId: string | null, role: 'owner' | 'admin' | 'member') {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [userId, `${userId}@example.com`, orgId],
    );
    if (orgId) {
      await pool.query(
        `INSERT INTO organization_memberships
           (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [userId, orgId, role, `${userId}@example.com`],
      );
    }
  }

  it('rejects a plain member verifying their primary org brand domain', async () => {
    await seedOrg(TEST_ORG);
    await seedUser(MEMBER_USER, TEST_ORG, 'member');

    const res = await request(app).post('/api/me/member-profile/verify-brand');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not authorized');
  });

  it('rejects a plain member verifying a URL-selected org brand domain', async () => {
    await seedOrg(TEST_ORG);
    await seedOrg(OTHER_ORG);
    await seedUser(MEMBER_USER, TEST_ORG, 'owner');
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, 'member', $3, NOW(), NOW())`,
      [MEMBER_USER, OTHER_ORG, `${MEMBER_USER}@example.com`],
    );

    const res = await request(app)
      .post(`/api/me/member-profile/verify-brand?org=${OTHER_ORG}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not authorized');
  });

  it('rejects a user outside the URL-selected org', async () => {
    await seedOrg(TEST_ORG);
    await seedOrg(OTHER_ORG);
    await seedUser(OUTSIDER_USER, TEST_ORG, 'owner');
    currentUserId = OUTSIDER_USER;

    const res = await request(app)
      .post(`/api/me/member-profile/verify-brand?org=${OTHER_ORG}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not authorized');
  });

  it('issues and verifies brand claims against the URL-selected org', async () => {
    const selectedDomain = 'other-verify-brand-auth.example';
    await seedOrg(TEST_ORG);
    await seedOrg(OTHER_ORG);
    await seedUser(MEMBER_USER, TEST_ORG, 'owner');
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, 'owner', $3, NOW(), NOW())`,
      [MEMBER_USER, OTHER_ORG, `${MEMBER_USER}@example.com`],
    );

    const res = await request(app)
      .post(`/api/me/member-profile/brand-claim/issue?org=${OTHER_ORG}`)
      .send({ domain: selectedDomain });

    expect(res.status).toBe(200);
    expect(createdOrganizationDomains).toContainEqual({
      organizationId: OTHER_ORG,
      domain: selectedDomain,
    });
    expect(res.body.instructions).toContain(
      `/api/me/member-profile/brand-claim/verify?org=${encodeURIComponent(OTHER_ORG)}`,
    );

    const verifyRes = await request(app)
      .post(`/api/me/member-profile/brand-claim/verify?org=${OTHER_ORG}`)
      .send({ domain: selectedDomain });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.domain).toBe(selectedDomain);

    const brand = await pool.query<{ workos_organization_id: string }>(
      `SELECT workos_organization_id FROM brands WHERE domain = $1`,
      [selectedDomain],
    );
    expect(brand.rows[0]?.workos_organization_id).toBe(OTHER_ORG);
  });

  it('keeps selected org context in cross-org ownership self-service guidance', async () => {
    const selectedDomain = 'selected-verify-brand-auth.example';
    await seedOrg(TEST_ORG);
    await seedOrg(OTHER_ORG);
    await seedUser(MEMBER_USER, TEST_ORG, 'owner');
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, 'owner', $3, NOW(), NOW())`,
      [MEMBER_USER, OTHER_ORG, `${MEMBER_USER}@example.com`],
    );
    await pool.query(
      `UPDATE organization_domains
          SET domain = $2
        WHERE workos_organization_id = $1
          AND is_primary = TRUE`,
      [OTHER_ORG, selectedDomain],
    );
    await pool.query(
      `INSERT INTO brands (
         domain, workos_organization_id, brand_manifest, brand_name,
         source_type, review_status, is_public, has_brand_manifest, domain_verified
       ) VALUES ($1, $2, $3, 'Existing owner', 'community', 'approved', TRUE, TRUE, TRUE)`,
      [
        selectedDomain,
        TEST_ORG,
        JSON.stringify({
          brands: [{ id: 'existing-owner', names: [{ en: 'Existing owner' }] }],
        }),
      ],
    );

    const res = await request(app)
      .put(`/api/me/member-profile/brand-identity?org=${OTHER_ORG}`)
      .send({ brand_color: '#336699' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('cross_org_ownership');
    expect(res.body.self_service_path).toBe(
      `/api/me/member-profile/brand-claim/issue?org=${encodeURIComponent(OTHER_ORG)}`,
    );
    expect(res.body.message).toContain(
      `/api/me/member-profile/brand-claim/issue?org=${encodeURIComponent(OTHER_ORG)}`,
    );
  });
});
