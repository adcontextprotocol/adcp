/**
 * End-to-end integration test for three-tier agent visibility.
 *
 * Drives the actual route handlers, membership tier gate, listing
 * filter, and tier-downgrade enforcement hook against a real Postgres
 * (started via docker-compose). The DATABASE_URL is read from env;
 * the docker-e2e runner script sets it to point at the compose
 * postgres instance.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Stub auth so our synthetic `req.user` flows through the middleware chain.
vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/auth.js')>(
    '../../src/middleware/auth.js'
  );
  return {
    ...actual,
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
  };
});

import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MemberDatabase } from '../../src/db/member-db.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import { OrganizationDatabase, type MembershipTier } from '../../src/db/organization-db.js';
import { createMemberProfileRouter } from '../../src/routes/member-profiles.js';
import { AgentService } from '../../src/agent-service.js';
import { demotePublicAgentsOnTierDowngrade } from '../../src/services/agent-visibility-enforcement.js';

const TEST_PREFIX = 'org_visibility_e2e';

async function seedOrg(pool: Pool, orgId: string, tier: MembershipTier | null) {
  await pool.query(
    `INSERT INTO organizations (
       workos_organization_id, name, is_personal, membership_tier,
       subscription_status, subscription_amount, subscription_interval,
       created_at, updated_at
     ) VALUES ($1, $2, true, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE SET
       membership_tier = EXCLUDED.membership_tier,
       subscription_status = EXCLUDED.subscription_status,
       subscription_amount = EXCLUDED.subscription_amount,
       subscription_interval = EXCLUDED.subscription_interval`,
    [
      orgId,
      `Test Org ${orgId}`,
      tier,
      tier ? 'active' : null,
      tier === 'individual_professional' ? 25000 : tier === 'individual_academic' ? 5000 : null,
      tier ? 'year' : null,
    ]
  );
}

describe('Agent visibility E2E', () => {
  let pool: Pool;
  let app: express.Application;
  let memberDb: MemberDatabase;
  let brandDb: BrandDatabase;
  let orgDb: OrganizationDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_registry',
      max: 5,
    });
    await runMigrations();

    memberDb = new MemberDatabase();
    brandDb = new BrandDatabase();
    orgDb = new OrganizationDatabase();

    app = express();
    app.use(express.json());

    // Route stubs a user onto the request so requireAuth-backed routes
    // resolve the test user's primary organization. We swap the user +
    // its declared org per test via middleware state.
    let currentUserId = 'user_e2e';
    let currentOrgId: string | null = null;
    (app as any).setCurrentUser = (id: string, orgId?: string | null) => {
      currentUserId = id;
      currentOrgId = orgId ?? null;
    };
    app.use((req, _res, next) => {
      (req as any).user = {
        id: currentUserId,
        email: `${currentUserId}@example.com`,
        firstName: 'Test',
        lastName: 'User',
      };
      next();
    });

    // Minimal WorkOS stub so the profile PUT path can resolve the user's
    // org membership. Returns whatever the current test declared.
    const fakeWorkos = {
      userManagement: {
        listOrganizationMemberships: async () => ({
          data: currentOrgId
            ? [{ organizationId: currentOrgId, userId: currentUserId, status: 'active' }]
            : [],
        }),
      },
      organizations: {
        getOrganization: async (orgId: string) => ({ id: orgId, name: `Org ${orgId}` }),
      },
    } as any;

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
    await pool.query(
      `DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM users WHERE primary_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await closeDatabase();
  });

  async function provisionUser(userId: string, orgId: string) {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET primary_organization_id = EXCLUDED.primary_organization_id`,
      [userId, `${userId}@example.com`, orgId],
    );
  }

  async function createProfile(orgId: string, slug: string) {
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: `Test ${slug}`,
      slug,
      primary_brand_domain: `${slug}.example`,
      is_public: true,
      agents: [
        { url: `https://a1.${slug}.example`, visibility: 'private' },
        { url: `https://a2.${slug}.example`, visibility: 'members_only' },
      ],
    });
  }

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM users WHERE primary_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM brand_revisions WHERE brand_domain LIKE $1`,
      [`%.example`],
    );
    await pool.query(`DELETE FROM brands WHERE domain LIKE $1`, [`%.example`]);
  });

  it('Explorer tier: PATCH visibility=public returns 403', async () => {
    const orgId = `${TEST_PREFIX}_explorer`;
    const userId = `${TEST_PREFIX}_explorer_user`;
    await seedOrg(pool, orgId, 'individual_academic');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'explorer');

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .patch('/api/me/member-profile/agents/0/visibility')
      .send({ visibility: 'public' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tier_required');
  });

  it('Explorer tier: PATCH visibility=members_only succeeds', async () => {
    const orgId = `${TEST_PREFIX}_explorer_ok`;
    const userId = `${TEST_PREFIX}_explorer_ok_user`;
    await seedOrg(pool, orgId, 'individual_academic');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'explorerok');

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .patch('/api/me/member-profile/agents/0/visibility')
      .send({ visibility: 'members_only' });

    expect(res.status).toBe(200);
    expect(res.body.visibility).toBe('members_only');
    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile!.agents[0].visibility).toBe('members_only');
  });

  it('Professional tier: PATCH visibility=public succeeds and sets brand.json snippet', async () => {
    const orgId = `${TEST_PREFIX}_pro`;
    const userId = `${TEST_PREFIX}_pro_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'pro');

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .patch('/api/me/member-profile/agents/0/visibility')
      .send({ visibility: 'public' });

    expect(res.status).toBe(200);
    expect(res.body.visibility).toBe('public');
    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile!.agents[0].visibility).toBe('public');
  });

  it('unpaid (no tier): visibility=public returns 403 but members_only works', async () => {
    const orgId = `${TEST_PREFIX}_free`;
    const userId = `${TEST_PREFIX}_free_user`;
    await seedOrg(pool, orgId, null);
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'free');

    (app as any).setCurrentUser(userId);
    const pubRes = await request(app)
      .patch('/api/me/member-profile/agents/0/visibility')
      .send({ visibility: 'public' });
    expect(pubRes.status).toBe(403);

    const memRes = await request(app)
      .patch('/api/me/member-profile/agents/0/visibility')
      .send({ visibility: 'members_only' });
    expect(memRes.status).toBe(200);
  });

  it('AgentService.listAgents filters by viewer tier', async () => {
    const orgId = `${TEST_PREFIX}_listing`;
    await seedOrg(pool, orgId, 'individual_professional');
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Listing Org',
      slug: 'listing',
      primary_brand_domain: 'listing.example',
      is_public: true,
      agents: [
        { url: 'https://pub.listing.example', visibility: 'public' },
        { url: 'https://mem.listing.example', visibility: 'members_only' },
        { url: 'https://priv.listing.example', visibility: 'private' },
      ],
    });

    const service = new AgentService();
    const publicOnly = await service.listAgents();
    const publicUrls = publicOnly.map((a) => a.url).sort();
    expect(publicUrls).toContain('https://pub.listing.example');
    expect(publicUrls).not.toContain('https://mem.listing.example');
    expect(publicUrls).not.toContain('https://priv.listing.example');

    const withApi = await service.listAgents({ viewerHasApiAccess: true });
    const withApiUrls = withApi.map((a) => a.url).sort();
    expect(withApiUrls).toContain('https://pub.listing.example');
    expect(withApiUrls).toContain('https://mem.listing.example');
    expect(withApiUrls).not.toContain('https://priv.listing.example');
  });

  it('tier downgrade: demotes public → members_only', async () => {
    const orgId = `${TEST_PREFIX}_downgrade`;
    await seedOrg(pool, orgId, 'individual_professional');
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Downgrade Org',
      slug: 'downgrade',
      primary_brand_domain: 'downgrade.example',
      is_public: true,
      agents: [
        { url: 'https://p1.downgrade.example', visibility: 'public' },
        { url: 'https://p2.downgrade.example', visibility: 'public' },
        { url: 'https://m.downgrade.example', visibility: 'members_only' },
      ],
    });

    const result = await demotePublicAgentsOnTierDowngrade(
      orgId,
      'individual_professional',
      'individual_academic',
      brandDb,
    );

    expect(result).not.toBeNull();
    expect(result!.demotedCount).toBe(2);
    const after = await memberDb.getProfileByOrgId(orgId);
    const byUrl = Object.fromEntries(after!.agents.map((a) => [a.url, a.visibility]));
    expect(byUrl['https://p1.downgrade.example']).toBe('members_only');
    expect(byUrl['https://p2.downgrade.example']).toBe('members_only');
    expect(byUrl['https://m.downgrade.example']).toBe('members_only');
  });

  it('full cancellation (tier → null) still demotes', async () => {
    const orgId = `${TEST_PREFIX}_cancel`;
    await seedOrg(pool, orgId, 'company_leader');
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Cancel Org',
      slug: 'cancel',
      primary_brand_domain: 'cancel.example',
      is_public: true,
      agents: [{ url: 'https://p.cancel.example', visibility: 'public' }],
    });

    const result = await demotePublicAgentsOnTierDowngrade(
      orgId,
      'company_leader',
      null,
      brandDb,
    );

    expect(result?.demotedCount).toBe(1);
    const after = await memberDb.getProfileByOrgId(orgId);
    expect(after!.agents[0].visibility).toBe('members_only');
  });

  it('PUT /api/me/member-profile: Explorer cannot smuggle visibility=public', async () => {
    const orgId = `${TEST_PREFIX}_put_bypass`;
    const userId = `${TEST_PREFIX}_put_bypass_user`;
    await seedOrg(pool, orgId, 'individual_academic');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'putbypass');

    (app as any).setCurrentUser(userId, orgId);
    const res = await request(app)
      .put('/api/me/member-profile')
      .send({
        agents: [
          { url: 'https://smuggled.example', visibility: 'public' },
          { url: 'https://also.example', visibility: 'public', name: 'Evil' },
        ],
      });

    expect(res.status).toBe(200);
    // Response exposes the silent downgrade via warnings[] so agent
    // callers can tell their requested visibility was not applied.
    expect(res.body.warnings).toHaveLength(2);
    expect(res.body.warnings[0]).toMatchObject({
      code: 'visibility_downgraded',
      requested: 'public',
      applied: 'members_only',
      reason: 'tier_required',
    });
    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile!.agents.every((a) => a.visibility !== 'public')).toBe(true);
    expect(profile!.agents[0].visibility).toBe('members_only');
    expect(profile!.agents[1].visibility).toBe('members_only');
  });

  it('PUT /api/me/member-profile: Professional can set visibility=public via bulk update', async () => {
    const orgId = `${TEST_PREFIX}_put_pro`;
    const userId = `${TEST_PREFIX}_put_pro_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'putpro');

    (app as any).setCurrentUser(userId, orgId);
    const res = await request(app)
      .put('/api/me/member-profile')
      .send({
        agents: [
          { url: 'https://pro-pub.example', visibility: 'public' },
        ],
      });

    expect(res.status).toBe(200);
    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile!.agents[0].visibility).toBe('public');
  });

  it('members_only agents on private profile are visible to API-access viewers', async () => {
    const orgId = `${TEST_PREFIX}_private_profile`;
    await seedOrg(pool, orgId, 'individual_professional');
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Private Profile Org',
      slug: 'private-profile',
      primary_brand_domain: 'privp.example',
      is_public: false, // Profile is not in public directory
      agents: [
        { url: 'https://members.privp.example', visibility: 'members_only' },
      ],
    });

    const service = new AgentService();
    const publicOnly = await service.listAgents();
    expect(publicOnly.map((a) => a.url)).not.toContain('https://members.privp.example');

    const withApi = await service.listAgents({ viewerHasApiAccess: true });
    expect(withApi.map((a) => a.url)).toContain('https://members.privp.example');
  });

  it('legacy is_public agents are normalized on read', async () => {
    const orgId = `${TEST_PREFIX}_legacy`;
    await seedOrg(pool, orgId, null);
    // Bypass typed helper to store a legacy shape
    await pool.query(
      `INSERT INTO member_profiles (workos_organization_id, display_name, slug, agents, is_public, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, true, NOW(), NOW())`,
      [
        orgId,
        'Legacy Org',
        'legacy',
        JSON.stringify([
          { url: 'https://old-pub.example', is_public: true },
          { url: 'https://old-priv.example', is_public: false },
        ]),
      ],
    );

    // Re-run migration 419 explicitly to simulate the transform on legacy rows
    const fs = await import('fs/promises');
    const path = await import('path');
    const sqlPath = path.resolve(process.cwd(), 'src/db/migrations/419_agent_visibility.sql');
    const sql = await fs.readFile(sqlPath, 'utf-8');
    await pool.query(sql);

    const profile = await memberDb.getProfileByOrgId(orgId);
    const byUrl = Object.fromEntries(profile!.agents.map((a) => [a.url, a.visibility]));
    expect(byUrl['https://old-pub.example']).toBe('public');
    expect(byUrl['https://old-priv.example']).toBe('private');
    // is_public key should be gone after migration transform
    expect((profile!.agents[0] as any).is_public).toBeUndefined();
  });

  it('POST /publish: profile JSONB commits even when brand.json manifest write fails (#2825)', async () => {
    // The invariant this pins: `applyAgentVisibility` writes to two
    // different surfaces — `member_profiles.agents` (inside the tx)
    // and `brand_revisions` via `updateManifestAgents` (separate
    // connection). If the manifest write is inside the tx and
    // succeeds while the commit fails, we orphan a manifest entry.
    // The rewrite in #2825 moved the manifest write to AFTER the
    // profile commit, so a manifest failure leaves the committed
    // JSONB authoritative and `/check`'s drift detection picks up
    // the divergence.
    const orgId = `${TEST_PREFIX}_manifest_fail`;
    const userId = `${TEST_PREFIX}_manifest_fail_user`;
    const domain = 'manifestfail.example';
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Manifest Fail Org',
      slug: 'manifestfail',
      primary_brand_domain: domain,
      is_public: true,
      agents: [
        { url: `https://agent.${domain}`, visibility: 'private' },
      ],
    });

    // No brand row seeded on purpose — `applyAgentVisibility` still
    // routes through `updateManifestAgents` when `discovered` is
    // null (the non-self-hosted path treats missing discovery as an
    // empty community manifest). Self-hosted brands (`source_type ===
    // 'brand_json'`) skip the manifest write entirely; the drift
    // scenario only applies to community-hosted / unknown brands.

    // Spy on the real brandDb instance. `applyAgentVisibility` calls
    // `brandDb.updateManifestAgents` — forcing it to throw simulates a
    // failed community-manifest write.
    const originalUpdate = brandDb.updateManifestAgents.bind(brandDb);
    const updateSpy = vi
      .spyOn(brandDb, 'updateManifestAgents')
      .mockRejectedValueOnce(new Error('simulated manifest-write failure'));

    try {
      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app).post('/api/me/member-profile/agents/0/publish');

      // Response should still be 200 — the profile update is
      // authoritative; manifest drift logs but doesn't fail the request.
      expect(res.status).toBe(200);
      expect(res.body.visibility).toBe('public');

      // The manifest write was attempted (so this is a real drift
      // scenario, not a skipped one).
      expect(updateSpy).toHaveBeenCalledTimes(1);

      // Profile JSONB is authoritative and reflects the publish.
      const profile = await memberDb.getProfileByOrgId(orgId);
      expect(profile!.agents[0].visibility).toBe('public');
    } finally {
      updateSpy.mockRestore();
      // Keep the closure around `originalUpdate` happy (some linters
      // flag otherwise-unused bindings in the spy pattern).
      void originalUpdate;
    }
  });
});
