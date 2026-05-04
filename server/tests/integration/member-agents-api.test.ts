/**
 * Integration tests for the per-agent REST surface mounted at /api/me/agents.
 *
 * Same harness pattern as agent-visibility-e2e.test.ts: stubbed `requireAuth`
 * threading a synthetic `req.user`, real Postgres via initializeDatabase.
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
import { OrganizationDatabase, type MembershipTier } from '../../src/db/organization-db.js';
import { createMemberAgentsRouter } from '../../src/routes/member-agents.js';

const TEST_PREFIX = 'org_member_agents_api';

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
    ],
  );
}

describe('Per-agent REST API (/api/me/agents)', () => {
  let pool: Pool;
  let app: express.Application;
  let memberDb: MemberDatabase;
  let orgDb: OrganizationDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_registry',
      max: 5,
    });
    await runMigrations();

    memberDb = new MemberDatabase();
    orgDb = new OrganizationDatabase();

    app = express();
    app.use(express.json());

    let currentUserId = 'user_e2e';
    (app as any).setCurrentUser = (id: string) => {
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

    app.use(
      '/api/me/agents',
      createMemberAgentsRouter({
        memberDb,
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
    await pool.query(`DELETE FROM users WHERE primary_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
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
      is_public: false,
      agents: [{ url: 'https://existing.example/mcp', visibility: 'private' }],
    });
  }

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(`DELETE FROM users WHERE primary_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
  });

  it('GET returns 400 when user has no org', async () => {
    (app as any).setCurrentUser('unprovisioned_user');
    const res = await request(app).get('/api/me/agents');
    expect(res.status).toBe(400);
  });

  it('GET returns 404 when no profile exists', async () => {
    const orgId = `${TEST_PREFIX}_no_profile`;
    const userId = `${TEST_PREFIX}_no_profile_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);

    (app as any).setCurrentUser(userId);
    const res = await request(app).get('/api/me/agents');
    expect(res.status).toBe(404);
  });

  it('GET returns the org agents array', async () => {
    const orgId = `${TEST_PREFIX}_get`;
    const userId = `${TEST_PREFIX}_get_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'get');

    (app as any).setCurrentUser(userId);
    const res = await request(app).get('/api/me/agents');
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].url).toBe('https://existing.example/mcp');
  });

  it('POST creates a new agent (201) and is idempotent on url (200 update)', async () => {
    const orgId = `${TEST_PREFIX}_post`;
    const userId = `${TEST_PREFIX}_post_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'post');

    (app as any).setCurrentUser(userId);
    const created = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://new.example/mcp', name: 'New', visibility: 'private' });
    expect(created.status).toBe(201);
    expect(created.body.agent.url).toBe('https://new.example/mcp');
    expect(created.body.agent.name).toBe('New');

    const updated = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://new.example/mcp', name: 'Renamed', visibility: 'private' });
    expect(updated.status).toBe(200);
    expect(updated.body.agent.name).toBe('Renamed');

    const profile = await memberDb.getProfileByOrgId(orgId);
    const matching = profile!.agents.filter((a) => a.url === 'https://new.example/mcp');
    expect(matching).toHaveLength(1);
  });

  it('POST returns 400 when url is missing or invalid', async () => {
    const orgId = `${TEST_PREFIX}_post_invalid`;
    const userId = `${TEST_PREFIX}_post_invalid_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'postinv');

    (app as any).setCurrentUser(userId);
    const noUrl = await request(app).post('/api/me/agents').send({ name: 'No URL' });
    expect(noUrl.status).toBe(400);

    const badUrl = await request(app).post('/api/me/agents').send({ url: 'not a url' });
    expect(badUrl.status).toBe(400);
  });

  it('POST downgrades visibility=public for non-API-tier callers and returns warnings', async () => {
    const orgId = `${TEST_PREFIX}_downgrade`;
    const userId = `${TEST_PREFIX}_downgrade_user`;
    await seedOrg(pool, orgId, 'individual_academic');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'downgrade');

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://upgrade.example/mcp', visibility: 'public' });
    expect(res.status).toBe(201);
    expect(res.body.agent.visibility).toBe('members_only');
    expect(res.body.warnings).toBeDefined();
    expect(res.body.warnings[0].code).toBe('visibility_downgraded');
  });

  it('PATCH updates a single entry by url-encoded URL when body.url matches path', async () => {
    const orgId = `${TEST_PREFIX}_patch`;
    const userId = `${TEST_PREFIX}_patch_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'patch');

    (app as any).setCurrentUser(userId);
    const target = encodeURIComponent('https://existing.example/mcp');
    const res = await request(app)
      .patch(`/api/me/agents/${target}`)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe('Renamed');
    expect(res.body.agent.url).toBe('https://existing.example/mcp');
  });

  it('PATCH returns 400 url_immutable when body.url disagrees with the path', async () => {
    const orgId = `${TEST_PREFIX}_patch_url_immutable`;
    const userId = `${TEST_PREFIX}_patch_url_immutable_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'patchurlimm');

    (app as any).setCurrentUser(userId);
    const target = encodeURIComponent('https://existing.example/mcp');
    const res = await request(app)
      .patch(`/api/me/agents/${target}`)
      .send({ name: 'Renamed', url: 'https://attempt-rename.example/mcp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('url_immutable');
  });

  it('PATCH returns 404 when the URL is not registered', async () => {
    const orgId = `${TEST_PREFIX}_patch_404`;
    const userId = `${TEST_PREFIX}_patch_404_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'patch404');

    (app as any).setCurrentUser(userId);
    const target = encodeURIComponent('https://missing.example/mcp');
    const res = await request(app).patch(`/api/me/agents/${target}`).send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE removes the entry and returns 204', async () => {
    const orgId = `${TEST_PREFIX}_delete`;
    const userId = `${TEST_PREFIX}_delete_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'delete');

    (app as any).setCurrentUser(userId);
    const target = encodeURIComponent('https://existing.example/mcp');
    const res = await request(app).delete(`/api/me/agents/${target}`);
    expect(res.status).toBe(204);

    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile!.agents).toHaveLength(0);
  });

  it('DELETE returns 404 for an unknown URL', async () => {
    const orgId = `${TEST_PREFIX}_delete_404`;
    const userId = `${TEST_PREFIX}_delete_404_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'delete404');

    (app as any).setCurrentUser(userId);
    const target = encodeURIComponent('https://missing.example/mcp');
    const res = await request(app).delete(`/api/me/agents/${target}`);
    expect(res.status).toBe(404);
  });

  it('DELETE returns 409 unpublish_first when the agent is currently public', async () => {
    const orgId = `${TEST_PREFIX}_delete_public`;
    const userId = `${TEST_PREFIX}_delete_public_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Test deletepublic',
      slug: 'deletepublic',
      primary_brand_domain: 'deletepublic.example',
      is_public: false,
      agents: [{ url: 'https://pub.example/mcp', visibility: 'public' }],
    });

    (app as any).setCurrentUser(userId);
    const target = encodeURIComponent('https://pub.example/mcp');
    const res = await request(app).delete(`/api/me/agents/${target}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('unpublish_first');

    // Profile JSONB must not have changed — refusing the delete is the
    // whole point.
    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile!.agents).toHaveLength(1);
    expect(profile!.agents[0].url).toBe('https://pub.example/mcp');
  });
});
