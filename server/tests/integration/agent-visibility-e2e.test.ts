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
    (app as any).setCurrentUser = (id: string, orgId?: string | null) => {
      currentUserId = id;
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

    // Minimal WorkOS stub so routes resolve the test user's real seeded org
    // memberships instead of trusting the org declared by setCurrentUser().
    const fakeWorkos = {
      userManagement: {
        listOrganizationMemberships: async ({
          userId = currentUserId,
          organizationId,
        }: {
          userId?: string;
          organizationId?: string;
        } = {}) => {
          const rows = await pool.query<{ workos_organization_id: string; role: string | null }>(
            `SELECT workos_organization_id, role
               FROM organization_memberships
              WHERE workos_user_id = $1
                AND ($2::text IS NULL OR workos_organization_id = $2)`,
            [userId, organizationId ?? null],
          );
          return {
            data: rows.rows.map((row) => ({
              organizationId: row.workos_organization_id,
              userId,
              status: 'active',
              role: { slug: row.role ?? 'member' },
            })),
          };
        },
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
      `DELETE FROM organization_domains WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM organization_memberships WHERE workos_organization_id LIKE $1`,
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

  async function seedBrandPrimaryUnverified(orgId: string, domain: string) {
    await pool.query(
      `INSERT INTO organization_domains
         (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, false, true, 'workos', NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET
         workos_organization_id = EXCLUDED.workos_organization_id,
         verified = false, is_primary = true, source = 'workos'`,
      [orgId, domain],
    );
  }

  async function seedBrandPrimary(orgId: string, domain: string) {
    await pool.query(
      `INSERT INTO organization_domains
         (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET
         workos_organization_id = EXCLUDED.workos_organization_id,
         verified = true, is_primary = true, source = 'workos'`,
      [orgId, domain],
    );
  }

  async function provisionUser(userId: string, orgId: string) {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET primary_organization_id = EXCLUDED.primary_organization_id`,
      [userId, `${userId}@example.com`, orgId],
    );
    // resolvePrimaryOrganization requires both an organizations row and a
    // current organization_memberships row to trust the cached pointer.
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, 'admin', $3, NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
      [userId, orgId, `${userId}@example.com`],
    );
  }

  async function addMembership(userId: string, orgId: string, role = 'admin') {
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = EXCLUDED.role`,
      [userId, orgId, role, `${userId}@example.com`],
    );
  }

  async function createProfile(orgId: string, slug: string) {
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: `Test ${slug}`,
      slug,
      is_public: true,
      agents: [
        { url: `https://a1.${slug}.example`, visibility: 'private' },
        { url: `https://a2.${slug}.example`, visibility: 'members_only' },
      ],
    });
    await seedBrandPrimary(orgId, `${slug}.example`);
  }

  async function createProfileWithAgent(
    orgId: string,
    slug: string,
    domain: string,
    agentUrl: string,
    visibility: 'private' | 'members_only' | 'public' = 'private',
  ) {
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: `Test ${slug}`,
      slug,
      is_public: true,
      agents: [{ url: agentUrl, visibility }],
    });
    await seedBrandPrimary(orgId, domain);
  }

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM organization_domains WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM organization_memberships WHERE workos_organization_id LIKE $1`,
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

  it('agent visibility and check endpoints honor URL-selected org', async () => {
    const primaryOrgId = `${TEST_PREFIX}_agent_scope_primary`;
    const selectedOrgId = `${TEST_PREFIX}_agent_scope_selected`;
    const userId = `${TEST_PREFIX}_agent_scope_user`;
    await seedOrg(pool, primaryOrgId, 'individual_academic');
    await seedOrg(pool, selectedOrgId, 'individual_academic');
    await provisionUser(userId, primaryOrgId);
    await addMembership(userId, selectedOrgId);
    await createProfileWithAgent(
      primaryOrgId,
      'agentscopeprimary',
      'example.net',
      'https://agent.example.net/mcp',
    );
    await createProfileWithAgent(
      selectedOrgId,
      'agentscopeselected',
      'example.org',
      'https://agent.example.org/mcp',
    );

    (app as any).setCurrentUser(userId, selectedOrgId);
    const visibilityRes = await request(app)
      .patch(`/api/me/member-profile/agents/0/visibility?org=${selectedOrgId}`)
      .send({ visibility: 'members_only' });

    expect(visibilityRes.status).toBe(200);
    expect(visibilityRes.body.visibility).toBe('members_only');

    const selectedProfile = await memberDb.getProfileByOrgId(selectedOrgId);
    const primaryProfile = await memberDb.getProfileByOrgId(primaryOrgId);
    expect(selectedProfile!.agents[0].visibility).toBe('members_only');
    expect(primaryProfile!.agents[0].visibility).toBe('private');

    const checkRes = await request(app)
      .post(`/api/me/member-profile/agents/0/check?org=${selectedOrgId}`);

    expect(checkRes.status).toBe(200);
    expect(checkRes.body.agent_url).toBe('https://agent.example.org/mcp');
  });

  it('agent visibility and check endpoints reject URL-selected org outsiders', async () => {
    const primaryOrgId = `${TEST_PREFIX}_agent_scope_outsider_primary`;
    const selectedOrgId = `${TEST_PREFIX}_agent_scope_outsider_selected`;
    const userId = `${TEST_PREFIX}_agent_scope_outsider_user`;
    await seedOrg(pool, primaryOrgId, 'individual_academic');
    await seedOrg(pool, selectedOrgId, 'individual_academic');
    await provisionUser(userId, primaryOrgId);
    await createProfileWithAgent(
      selectedOrgId,
      'agentscopeoutsider',
      'outsider.example.org',
      'https://agent.outsider.example.org/mcp',
    );

    (app as any).setCurrentUser(userId, selectedOrgId);
    const visibilityRes = await request(app)
      .patch(`/api/me/member-profile/agents/0/visibility?org=${selectedOrgId}`)
      .send({ visibility: 'members_only' });

    expect(visibilityRes.status).toBe(403);
    expect(visibilityRes.body.error).toBe('Not authorized');

    const checkRes = await request(app)
      .post(`/api/me/member-profile/agents/0/check?org=${selectedOrgId}`);

    expect(checkRes.status).toBe(403);
    expect(checkRes.body.error).toBe('Not authorized');
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
      is_public: true,
      agents: [
        { url: 'https://pub.listing.example', visibility: 'public' },
        { url: 'https://mem.listing.example', visibility: 'members_only' },
        { url: 'https://priv.listing.example', visibility: 'private' },
      ],
    });
    await seedBrandPrimary(orgId, 'listing.example');

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
      is_public: true,
      agents: [
        { url: 'https://p1.downgrade.example', visibility: 'public' },
        { url: 'https://p2.downgrade.example', visibility: 'public' },
        { url: 'https://m.downgrade.example', visibility: 'members_only' },
      ],
    });
    await seedBrandPrimary(orgId, 'downgrade.example');

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
      is_public: true,
      agents: [{ url: 'https://p.cancel.example', visibility: 'public' }],
    });
    await seedBrandPrimary(orgId, 'cancel.example');

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
          { url: 'https://smuggled.putbypass.example', visibility: 'public' },
          { url: 'https://also.putbypass.example', visibility: 'public', name: 'Evil' },
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
          { url: 'https://pro-pub.putpro.example', visibility: 'public' },
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
      is_public: false, // Profile is not in public directory
      agents: [
        { url: 'https://members.privp.example', visibility: 'members_only' },
      ],
    });
    await seedBrandPrimary(orgId, 'privp.example');

    const service = new AgentService();
    const publicOnly = await service.listAgents();
    expect(publicOnly.map((a) => a.url)).not.toContain('https://members.privp.example');

    const withApi = await service.listAgents({ viewerHasApiAccess: true });
    expect(withApi.map((a) => a.url)).toContain('https://members.privp.example');
  });

  it('public agent on private-profile member appears in listAgents (regression guard for #4194)', async () => {
    // Pins the fix in #4194: before this PR, the early-continue
    //   `if (visibility==='public' && !profile.is_public && !viewerHasApiAccess) continue`
    // silently hid public agents on profiles that opted out of the member
    // directory. Per-agent visibility is the only gate; is_public gates only
    // the /Members directory listing.
    const orgId = `${TEST_PREFIX}_pub_private`;
    await seedOrg(pool, orgId, 'individual_professional');
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Pub On Private Org',
      slug: 'pub-on-private',
      is_public: false,
      agents: [
        { url: 'https://agent.pubprivate.example', visibility: 'public' },
      ],
    });
    await seedBrandPrimary(orgId, 'pubprivate.example');

    const service = new AgentService();
    const agents = await service.listAgents();
    expect(agents.map((a) => a.url)).toContain('https://agent.pubprivate.example');
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

    // Re-run migration 419 explicitly to simulate the transform on legacy rows.
    // Resolve relative to this file so the path works regardless of vitest cwd
    // (root invocation vs. server/ invocation both stable).
    const fs = await import('fs/promises');
    const path = await import('path');
    const url = await import('url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sqlPath = path.resolve(here, '../../src/db/migrations/419_agent_visibility.sql');
    const sql = await fs.readFile(sqlPath, 'utf-8');
    await pool.query(sql);

    const profile = await memberDb.getProfileByOrgId(orgId);
    const byUrl = Object.fromEntries(profile!.agents.map((a) => [a.url, a.visibility]));
    expect(byUrl['https://old-pub.example']).toBe('public');
    expect(byUrl['https://old-priv.example']).toBe('private');
    // is_public key should be gone after migration transform
    expect((profile!.agents[0] as any).is_public).toBeUndefined();
  });

  it('POST /publish on a community brand: profile JSONB commits even when brand.json manifest write fails (#2825)', async () => {
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
      is_public: true,
      agents: [
        { url: `https://agent.${domain}`, visibility: 'private' },
      ],
    });
    await seedBrandPrimary(orgId, domain);
    // Seed a community-hosted brand row so the publish hits the
    // intended code path (`target==='public' && !isSelfHosted`). Without
    // this, `discovered` is null and the test passes via the missing-
    // discovery fallthrough — a future refactor that short-circuits
    // null discovery would silently collapse the test.
    await brandDb.upsertDiscoveredBrand({
      domain,
      source_type: 'community',
      brand_manifest: { agents: [] },
    });

    // Spy on the real brandDb instance. `applyAgentVisibility` calls
    // `brandDb.updateManifestAgents` — forcing it to throw simulates a
    // failed community-manifest write.
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
    }
  });

  it('POST /publish on a self-hosted brand: does NOT call updateManifestAgents (proves the spy in the sibling test is real)', async () => {
    // The manifest-write drift scenario applies only to community-
    // hosted brands. Self-hosted brands (`source_type==='brand_json'`)
    // skip the manifest write entirely and instead return a `snippet`
    // for the owner to paste into their own brand.json. This test is
    // the specificity check for the failing-manifest test above: if
    // someone refactors `applyAgentVisibility` to always call
    // `updateManifestAgents` (including on self-hosted), this test
    // flips red.
    const orgId = `${TEST_PREFIX}_self_hosted`;
    const userId = `${TEST_PREFIX}_self_hosted_user`;
    const domain = 'selfhosted.example';
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Self Hosted Org',
      slug: 'selfhosted',
      is_public: true,
      agents: [
        { url: `https://agent.${domain}`, visibility: 'private' },
      ],
    });
    await seedBrandPrimary(orgId, domain);
    await brandDb.upsertDiscoveredBrand({
      domain,
      source_type: 'brand_json',
      brand_manifest: { agents: [] },
    });

    const updateSpy = vi.spyOn(brandDb, 'updateManifestAgents');
    try {
      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app).post('/api/me/member-profile/agents/0/publish');

      expect(res.status).toBe(200);
      expect(res.body.visibility).toBe('public');
      // Self-hosted → snippet returned for the owner to paste; no
      // manifest write from our side.
      expect(res.body.action).toBe('snippet');
      expect(res.body.snippet).toMatchObject({ url: `https://agent.${domain}` });
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
    }
  });

  // Pins the contract the dashboard reads to enable/disable the "Public"
  // visibility toggle. Stage 2 of #4159 dropped the column the dashboard
  // was inferring from; without this surface, the toggle silently greyed
  // out for every Builder/Member with a verified primary domain.
  describe('GET /api/me/member-profile: agent_visibility_gate', () => {
    it('Builder with primary brand domain: can_publish_publicly=true', async () => {
      const orgId = `${TEST_PREFIX}_gate_ok`;
      const userId = `${TEST_PREFIX}_gate_ok_user`;
      await seedOrg(pool, orgId, 'company_standard');
      await provisionUser(userId, orgId);
      await createProfile(orgId, 'gateok');

      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app).get('/api/me/member-profile');

      expect(res.status).toBe(200);
      expect(res.body.has_api_access).toBe(true);
      expect(res.body.agent_visibility_gate).toEqual({
        can_publish_publicly: true,
        reasons: [],
      });
      // Re-derived from organization_domains.is_primary so legacy callers
      // (member-profile.html, dashboard-agents.html) keep working post-#4313.
      expect(res.body.profile.primary_brand_domain).toBe('gateok.example');
    });

    it('Explorer with primary brand domain: tier_required', async () => {
      const orgId = `${TEST_PREFIX}_gate_tier`;
      const userId = `${TEST_PREFIX}_gate_tier_user`;
      await seedOrg(pool, orgId, 'individual_academic');
      await provisionUser(userId, orgId);
      await createProfile(orgId, 'gatetier');

      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app).get('/api/me/member-profile');

      expect(res.status).toBe(200);
      expect(res.body.agent_visibility_gate.can_publish_publicly).toBe(false);
      expect(res.body.agent_visibility_gate.reasons).toEqual(['tier_required']);
    });

    it('Builder without primary brand domain: brand_domain_required', async () => {
      const orgId = `${TEST_PREFIX}_gate_brand`;
      const userId = `${TEST_PREFIX}_gate_brand_user`;
      await seedOrg(pool, orgId, 'company_standard');
      await provisionUser(userId, orgId);
      await memberDb.createProfile({
        workos_organization_id: orgId,
        display_name: 'No Brand Org',
        slug: 'gatebrand',
        is_public: true,
        agents: [{ url: 'https://a.gatebrand.example', visibility: 'private' }],
      });
      // Deliberately no seedBrandPrimary — the org has no is_primary row.

      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app).get('/api/me/member-profile');

      expect(res.status).toBe(200);
      expect(res.body.agent_visibility_gate.can_publish_publicly).toBe(false);
      expect(res.body.agent_visibility_gate.reasons).toEqual(['brand_domain_required']);
      expect(res.body.profile.primary_brand_domain).toBeUndefined();
    });

    it('unpaid tier with no brand domain: both reasons surface', async () => {
      const orgId = `${TEST_PREFIX}_gate_both`;
      const userId = `${TEST_PREFIX}_gate_both_user`;
      await seedOrg(pool, orgId, null);
      await provisionUser(userId, orgId);
      await memberDb.createProfile({
        workos_organization_id: orgId,
        display_name: 'Bare Org',
        slug: 'gateboth',
        is_public: true,
        agents: [{ url: 'https://a.gateboth.example', visibility: 'private' }],
      });

      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app).get('/api/me/member-profile');

      expect(res.status).toBe(200);
      expect(res.body.agent_visibility_gate.can_publish_publicly).toBe(false);
      // Order is deterministic: tier first, then brand. Pinned in the
      // unit test for computeAgentVisibilityGate too.
      expect(res.body.agent_visibility_gate.reasons).toEqual([
        'tier_required',
        'brand_domain_required',
      ]);
    });

    it('Builder with unverified primary domain: brand_domain_unverified', async () => {
      const orgId = `${TEST_PREFIX}_gate_unverified`;
      const userId = `${TEST_PREFIX}_gate_unverified_user`;
      await seedOrg(pool, orgId, 'company_standard');
      await provisionUser(userId, orgId);
      await memberDb.createProfile({
        workos_organization_id: orgId,
        display_name: 'Unverified Domain Org',
        slug: 'gateunverified',
        is_public: true,
        agents: [],
      });
      await seedBrandPrimaryUnverified(orgId, 'gateunverified.example');

      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app).get('/api/me/member-profile');

      expect(res.status).toBe(200);
      expect(res.body.agent_visibility_gate.can_publish_publicly).toBe(false);
      expect(res.body.agent_visibility_gate.reasons).toContain('brand_domain_unverified');
    });
  });

  // Unverified domain write-side enforcement (#4511).
  // An org can have is_primary=true but verified=false (admin import, legacy
  // seeding). All three write paths that can set visibility='public' must
  // reject with brand_domain_unverified until the org completes DNS verification.
  describe('Unverified domain write-side enforcement', () => {
    async function setupUnverifiedOrg(suffix: string) {
      const orgId = `${TEST_PREFIX}_unv_${suffix}`;
      const userId = `${TEST_PREFIX}_unv_${suffix}_user`;
      const domain = `unv${suffix}.example`;
      await seedOrg(pool, orgId, 'individual_professional');
      await provisionUser(userId, orgId);
      await memberDb.createProfile({
        workos_organization_id: orgId,
        display_name: `Unverified ${suffix}`,
        slug: `unv${suffix}`,
        is_public: true,
        agents: [{ url: `https://agent.${domain}`, visibility: 'private' }],
      });
      await seedBrandPrimaryUnverified(orgId, domain);
      return { orgId, userId, domain };
    }

    it('POST /publish returns 400 brand_domain_unverified when primary domain is not DNS-verified', async () => {
      const { userId, orgId } = await setupUnverifiedOrg('pub');
      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app).post('/api/me/member-profile/agents/0/publish');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('brand_domain_unverified');
    });

    it('PATCH /visibility=public returns 400 brand_domain_unverified when primary domain is not DNS-verified', async () => {
      const { userId, orgId } = await setupUnverifiedOrg('patch');
      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app)
        .patch('/api/me/member-profile/agents/0/visibility')
        .send({ visibility: 'public' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('brand_domain_unverified');
    });

    it('PUT /member-profile: rejects visibility=public when primary domain is not DNS-verified', async () => {
      const { userId, orgId, domain } = await setupUnverifiedOrg('put');
      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app)
        .put('/api/me/member-profile')
        .send({ agents: [{ url: `https://agent.${domain}`, visibility: 'public' }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('brand_domain_unverified');
    });
  });

  // Hostname verification (#4499 MVP) wired into the bulk PUT and
  // visibility-flip paths in addition to the per-agent POST. Closes the
  // smuggle paths the security review on PR #4648 flagged:
  // bulk PUT was rewriting the JSONB without hostname checks, and
  // visibility-flip could promote a grandfathered (un-verified) row to
  // public — the exact escalation #340 shape.
  describe('Hostname verification on bulk PUT + visibility flip', () => {
    it('PUT /api/me/member-profile: rejects NEW agent on an unverified hostname', async () => {
      const orgId = `${TEST_PREFIX}_put_rogue`;
      const userId = `${TEST_PREFIX}_put_rogue_user`;
      await seedOrg(pool, orgId, 'individual_professional');
      await provisionUser(userId, orgId);
      await createProfile(orgId, 'putrogue');

      (app as any).setCurrentUser(userId, orgId);
      const res = await request(app)
        .put('/api/me/member-profile')
        .send({
          agents: [
            { url: 'https://existing.putrogue.example', visibility: 'private' },
            { url: 'https://adcp-mcp.celtra.com/mcp', visibility: 'private' },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unverified_hostname');
      expect(res.body.agent_index).toBe(1);
      expect(res.body.agent_hostname).toBe('adcp-mcp.celtra.com');
    });

    it('PUT /api/me/member-profile: grandfathers entries already in the JSONB', async () => {
      const orgId = `${TEST_PREFIX}_put_grandfather`;
      const userId = `${TEST_PREFIX}_put_grandfather_user`;
      await seedOrg(pool, orgId, 'individual_professional');
      await provisionUser(userId, orgId);
      // Seed a profile with an agent on a hostname that does NOT match
      // the verified domain. Real production case: an entry that
      // pre-dates the hostname gate.
      await memberDb.createProfile({
        workos_organization_id: orgId,
        display_name: 'Grandfathered',
        slug: 'putgrandfather',
        is_public: false,
        agents: [{ url: 'https://legacy.unrelated.example', visibility: 'private' }],
      });
      await seedBrandPrimary(orgId, 'putgrandfather.example');

      (app as any).setCurrentUser(userId, orgId);
      // Same legacy URL — should pass the gate as a grandfather.
      const res = await request(app)
        .put('/api/me/member-profile')
        .send({
          agents: [{ url: 'https://legacy.unrelated.example', visibility: 'private', name: 'updated' }],
        });

      expect(res.status).toBe(200);
    });

    it('PUT /api/me/member-profile: grandfathers non-canonical legacy URLs after canonicalization', async () => {
      // A pre-#3573 row could be stored in non-canonical form (mixed case,
      // trailing slash, etc.). When a legitimate caller re-PUTs the same
      // entry, the incoming URL gets canonicalized and the grandfather
      // set must also be built from canonical URLs — otherwise the gate
      // rejects an unchanged entry with no escape hatch. Pins
      // member-profiles.ts:1219-1230 canonicalization of `existingUrls`.
      const orgId = `${TEST_PREFIX}_put_grandfather_noncanonical`;
      const userId = `${TEST_PREFIX}_put_grandfather_noncanonical_user`;
      await seedOrg(pool, orgId, 'individual_professional');
      await provisionUser(userId, orgId);
      // Seed in non-canonical form by writing directly to JSONB.
      await pool.query(
        `INSERT INTO member_profiles
           (workos_organization_id, display_name, slug, is_public, agents, created_at, updated_at)
         VALUES ($1, $2, $3, false, $4::jsonb, NOW(), NOW())`,
        [
          orgId,
          'Grandfathered noncanonical',
          'putgfnoncanonical',
          JSON.stringify([
            { url: 'https://Legacy.Unrelated.Example/', visibility: 'private' },
          ]),
        ],
      );
      await seedBrandPrimary(orgId, 'putgfnoncanonical.example');

      (app as any).setCurrentUser(userId, orgId);
      // Caller sends the same URL — canonicalization will lowercase + strip
      // trailing slash. The grandfather check has to compare canonicalized
      // values on both sides.
      const res = await request(app)
        .put('/api/me/member-profile')
        .send({
          agents: [
            { url: 'https://Legacy.Unrelated.Example/', visibility: 'private', name: 'still here' },
          ],
        });

      expect(res.status).toBe(200);
    });

    it('PATCH /agents/:index/visibility: rejects flipping a grandfathered row to members_only or public', async () => {
      const orgId = `${TEST_PREFIX}_flip_gf`;
      const userId = `${TEST_PREFIX}_flip_gf_user`;
      await seedOrg(pool, orgId, 'individual_professional');
      await provisionUser(userId, orgId);
      // Grandfathered agent — hostname doesn't match the verified domain.
      await memberDb.createProfile({
        workos_organization_id: orgId,
        display_name: 'Flip GF',
        slug: 'flipgf',
        is_public: false,
        agents: [{ url: 'https://legacy.unrelated.example', visibility: 'private' }],
      });
      await seedBrandPrimary(orgId, 'flipgf.example');

      (app as any).setCurrentUser(userId, orgId);

      // members_only flip — should reject.
      const membersRes = await request(app)
        .patch('/api/me/member-profile/agents/0/visibility')
        .send({ visibility: 'members_only' });
      expect(membersRes.status).toBe(400);
      expect(membersRes.body.error).toBe('unverified_hostname');

      // public flip — should also reject.
      const publicRes = await request(app)
        .patch('/api/me/member-profile/agents/0/visibility')
        .send({ visibility: 'public' });
      expect(publicRes.status).toBe(400);
      expect(publicRes.body.error).toBe('unverified_hostname');

      // private (demotion) — always allowed.
      const privateRes = await request(app)
        .patch('/api/me/member-profile/agents/0/visibility')
        .send({ visibility: 'private' });
      expect(privateRes.status).toBe(200);
    });
  });
});
