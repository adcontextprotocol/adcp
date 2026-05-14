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
import { ComplianceDatabase } from '../../src/db/compliance-db.js';
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

    // Minimal WorkOS stub: only `listOrganizationMemberships` is called by
    // `resolveUserOrgMembership` on the prod path, and only when `?org=`
    // is supplied. The stub serves whatever membership rows the current
    // test seeded in the local `organization_memberships` table — so the
    // `?org=` path mirrors what real WorkOS would have answered for a
    // legitimately-multi-org user.
    const fakeWorkos = {
      userManagement: {
        listOrganizationMemberships: async ({
          userId,
          organizationId,
        }: {
          userId: string;
          organizationId?: string;
        }) => {
          const args: unknown[] = [userId];
          let where = `workos_user_id = $1`;
          if (organizationId) {
            args.push(organizationId);
            where += ` AND workos_organization_id = $2`;
          }
          const rows = await pool.query<{
            workos_organization_id: string;
            role: string;
          }>(
            `SELECT workos_organization_id, role FROM organization_memberships WHERE ${where}`,
            args,
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
    } as any;

    app.use(
      '/api/me/agents',
      createMemberAgentsRouter({
        memberDb,
        orgDb,
        workos: fakeWorkos,
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
    // resolvePrimaryOrganization requires both the organizations row AND a
    // current organization_memberships row to trust the cached pointer; seed
    // the membership too so tests don't accidentally exercise the dangling-
    // pointer self-heal path.
    await provisionMembership(userId, orgId);
  }

  async function provisionMembership(userId: string, orgId: string, role = 'member') {
    // organization_memberships has no `status` column — `status: 'active'` is
    // synthesized by the fakeWorkos stub when it reconstructs the WorkOS-shaped
    // response. `email` is NOT NULL on the real schema.
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id)
         DO UPDATE SET role = EXCLUDED.role`,
      [userId, orgId, role, `${userId}@example.com`],
    );
  }

  async function createProfile(orgId: string, slug: string) {
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: `Test ${slug}`,
      slug,
      is_public: false,
      agents: [{ url: 'https://existing.example/mcp', visibility: 'private' }],
    });
    await pool.query(
      `INSERT INTO organization_domains
         (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET
         workos_organization_id = EXCLUDED.workos_organization_id,
         verified = true, is_primary = true, source = 'workos'`,
      [orgId, `${slug}.example`],
    );
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
      .send({ url: 'https://new.example/mcp', name: 'New', type: 'sales', visibility: 'private' });
    expect(created.status).toBe(201);
    expect(created.body.agent.url).toBe('https://new.example/mcp');
    expect(created.body.agent.name).toBe('New');

    const updated = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://new.example/mcp', name: 'Renamed', type: 'sales', visibility: 'private' });
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
    // Both cases include `type: 'sales'` so the 400 is unambiguously from
    // the URL validator and not the new type-required gate (covered
    // separately below).
    const noUrl = await request(app)
      .post('/api/me/agents')
      .send({ name: 'No URL', type: 'sales' });
    expect(noUrl.status).toBe(400);

    const badUrl = await request(app)
      .post('/api/me/agents')
      .send({ url: 'not a url', type: 'sales' });
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
      .send({ url: 'https://upgrade.example/mcp', type: 'sales', visibility: 'public' });
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

  it('?org=… targets a non-primary org when the user is a member', async () => {
    const primaryOrg = `${TEST_PREFIX}_org_primary`;
    const secondaryOrg = `${TEST_PREFIX}_org_secondary`;
    const userId = `${TEST_PREFIX}_multi_org_user`;
    await seedOrg(pool, primaryOrg, 'individual_professional');
    await seedOrg(pool, secondaryOrg, 'individual_professional');
    await provisionUser(userId, primaryOrg);
    await provisionMembership(userId, secondaryOrg);
    await createProfile(secondaryOrg, 'multiorg');

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .post(`/api/me/agents?org=${secondaryOrg}`)
      .send({ url: 'https://multi.example/mcp', type: 'sales', visibility: 'private' });
    expect(res.status).toBe(201);
    expect(res.body.agent.url).toBe('https://multi.example/mcp');

    // Primary org's profile must be untouched — `?org=` is the addressable
    // identifier.
    const primary = await memberDb.getProfileByOrgId(primaryOrg);
    expect(primary).toBeNull();
    const secondary = await memberDb.getProfileByOrgId(secondaryOrg);
    expect(secondary!.agents.some((a) => a.url === 'https://multi.example/mcp')).toBe(true);
  });

  it('?org=… returns 403 when the user is not a member', async () => {
    const ownOrg = `${TEST_PREFIX}_org_own`;
    const strangerOrg = `${TEST_PREFIX}_org_stranger`;
    const userId = `${TEST_PREFIX}_org_403_user`;
    await seedOrg(pool, ownOrg, 'individual_professional');
    await seedOrg(pool, strangerOrg, 'individual_professional');
    await provisionUser(userId, ownOrg);
    await provisionMembership(userId, ownOrg);

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .get(`/api/me/agents?org=${strangerOrg}`);
    expect(res.status).toBe(403);
  });

  it('POST resolves type server-side from capability snapshot, ignoring smuggled client value', async () => {
    const orgId = `${TEST_PREFIX}_smuggle`;
    const userId = `${TEST_PREFIX}_smuggle_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'smuggle');

    // Seed a capability snapshot that classifies this URL as `sales`.
    // resolveAgentTypes() reads the most recent snapshot per URL via
    // bulkGetCapabilities; even if the client claims `buying`, the
    // snapshot wins.
    const targetUrl = 'https://smuggle.example/mcp';
    await pool.query(
      `INSERT INTO agent_capabilities_snapshot
         (agent_url, protocol, inferred_type, last_discovered)
       VALUES ($1, 'mcp', 'sales', NOW())
       ON CONFLICT (agent_url) DO UPDATE SET inferred_type = EXCLUDED.inferred_type`,
      [targetUrl],
    );

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .post('/api/me/agents')
      .send({ url: targetUrl, type: 'buying', visibility: 'private' });
    expect(res.status).toBe(201);
    // The server-resolved type wins. The smuggle attempt was harmless.
    expect(res.body.agent.type).toBe('sales');
    const profile = await memberDb.getProfileByOrgId(orgId);
    const stored = profile!.agents.find((a) => a.url === targetUrl);
    expect(stored?.type).toBe('sales');
  });

  // ── Type-required contract (PR #4235) ──────────────────────────
  // The owner declares `type` at registration; the server never infers.
  // 'unknown' is reserved for the server-side smuggle-protection outcome
  // (covered by the snapshot-override test above) and is not accepted on
  // input.

  it('POST returns 400 when type is missing', async () => {
    const orgId = `${TEST_PREFIX}_type_missing`;
    const userId = `${TEST_PREFIX}_type_missing_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'typemissing');

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://no-type.example/mcp', visibility: 'private' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('type is required');
  });

  it('POST returns 400 when type is "unknown" (reserved for server-side outcome)', async () => {
    const orgId = `${TEST_PREFIX}_type_unknown`;
    const userId = `${TEST_PREFIX}_type_unknown_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'typeunknown');

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://unknown.example/mcp', type: 'unknown', visibility: 'private' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('type is required');
  });

  it('POST returns 400 when type is not in the AgentType enum', async () => {
    const orgId = `${TEST_PREFIX}_type_garbage`;
    const userId = `${TEST_PREFIX}_type_garbage_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'typegarbage');

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://garbage.example/mcp', type: 'seller', visibility: 'private' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('type is required');
  });

  it('PATCH returns 400 invalid_type when patch.type is invalid; preserves existing type when omitted', async () => {
    const orgId = `${TEST_PREFIX}_patch_type`;
    const userId = `${TEST_PREFIX}_patch_type_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    // Seed a profile with one agent that already has a declared type so
    // we can verify omission preserves it.
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Test patchtype',
      slug: 'patchtype',
      is_public: false,
      agents: [
        { url: 'https://existing.example/mcp', type: 'sales', visibility: 'private' },
      ],
    });

    (app as any).setCurrentUser(userId);
    const target = encodeURIComponent('https://existing.example/mcp');

    // Invalid type → 400 invalid_type (caller-supplied 'unknown' rejected,
    // out-of-enum strings rejected).
    const badEnum = await request(app)
      .patch(`/api/me/agents/${target}`)
      .send({ type: 'seller' });
    expect(badEnum.status).toBe(400);
    expect(badEnum.body.error).toBe('invalid_type');

    const unknown = await request(app)
      .patch(`/api/me/agents/${target}`)
      .send({ type: 'unknown' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('invalid_type');

    // Omitting type → existing 'sales' preserved on the row.
    const renamed = await request(app)
      .patch(`/api/me/agents/${target}`)
      .send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.agent.type).toBe('sales');

    // Valid type → updated.
    const swapped = await request(app)
      .patch(`/api/me/agents/${target}`)
      .send({ type: 'buying' });
    expect(swapped.status).toBe(200);
    expect(swapped.body.agent.type).toBe('buying');
  });

  // ── agent_registry_metadata seed on register (PR follow-up) ────
  // Without this seed, an agent registered via /api/me/agents lives only
  // in member_profiles.agents JSONB and never enters the heartbeat's
  // known_agents CTE — compliance status stays `unknown` forever. The
  // seed is best-effort; the read-side CTE was widened in the same change
  // as defense-in-depth.

  it('POST seeds an agent_registry_metadata row so the heartbeat can pick it up', async () => {
    const orgId = `${TEST_PREFIX}_meta_seed`;
    const userId = `${TEST_PREFIX}_meta_seed_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'metaseed');

    const targetUrl = 'https://meta-seed.example/mcp';
    // Sanity: no metadata row before the POST.
    const before = await pool.query(
      'SELECT agent_url FROM agent_registry_metadata WHERE agent_url = $1',
      [targetUrl],
    );
    expect(before.rowCount).toBe(0);

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .post('/api/me/agents')
      .send({ url: targetUrl, type: 'sales', visibility: 'private' });
    expect(res.status).toBe(201);

    // Metadata row exists post-write, with default lifecycle_stage so the
    // heartbeat will include it.
    const after = await pool.query<{ agent_url: string; lifecycle_stage: string; compliance_opt_out: boolean }>(
      `SELECT agent_url, lifecycle_stage, compliance_opt_out
       FROM agent_registry_metadata WHERE agent_url = $1`,
      [targetUrl],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].lifecycle_stage).toBe('production');
    expect(after.rows[0].compliance_opt_out).toBe(false);

    // Cleanup the metadata row to avoid leaking state across tests.
    await pool.query('DELETE FROM agent_registry_metadata WHERE agent_url = $1', [targetUrl]);
  });

  it('heartbeat picks up an agent that lives only in member_profiles.agents (read-side CTE widening)', async () => {
    // Defense-in-depth case: a row whose write-side seed never landed
    // (best-effort fallback fired) must still be visible to the
    // compliance heartbeat. We bypass the route deliberately to simulate
    // pre-fix data and to isolate the read-side CTE behavior from the
    // write-side seed.
    const orgId = `${TEST_PREFIX}_cte_only`;
    const userId = `${TEST_PREFIX}_cte_only_user`;
    const targetUrl = 'https://cte-only.example/mcp';
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: 'Test cteonly',
      slug: 'cteonly',
      is_public: false,
      agents: [{ url: targetUrl, type: 'sales', visibility: 'private' }],
    });
    // Sanity: no metadata row, no discovered_agents row.
    await pool.query('DELETE FROM agent_registry_metadata WHERE agent_url = $1', [targetUrl]);
    await pool.query('DELETE FROM discovered_agents WHERE agent_url = $1', [targetUrl]);

    const complianceDb = new ComplianceDatabase();
    const due = await complianceDb.getAgentsDueForCheck(100);
    const matched = due.find((d) => d.agent_url === targetUrl);
    // The read-side CTE's third leg (member_profiles.agents) is what
    // makes this match. With the pre-fix two-leg CTE this assertion
    // would fail.
    expect(matched).toBeDefined();
    expect(matched!.lifecycle_stage).toBe('production');
    expect(matched!.last_checked_at).toBeNull();
  });

  it('POST does NOT overwrite an existing agent_registry_metadata row on re-register', async () => {
    const orgId = `${TEST_PREFIX}_meta_existing`;
    const userId = `${TEST_PREFIX}_meta_existing_user`;
    await seedOrg(pool, orgId, 'individual_professional');
    await provisionUser(userId, orgId);
    await createProfile(orgId, 'metaexisting');

    const targetUrl = 'https://meta-existing.example/mcp';
    // Seed metadata with non-default lifecycle and a custom interval — the
    // re-register MUST preserve these so an owner who tuned cadence /
    // lifecycle from the dashboard doesn't see it reset by the next save.
    await pool.query(
      `INSERT INTO agent_registry_metadata (agent_url, lifecycle_stage, check_interval_hours)
       VALUES ($1, 'testing', 24)`,
      [targetUrl],
    );

    (app as any).setCurrentUser(userId);
    const res = await request(app)
      .post('/api/me/agents')
      .send({ url: targetUrl, type: 'sales', visibility: 'private' });
    expect(res.status).toBe(201);

    const after = await pool.query<{ lifecycle_stage: string; check_interval_hours: number }>(
      `SELECT lifecycle_stage, check_interval_hours
       FROM agent_registry_metadata WHERE agent_url = $1`,
      [targetUrl],
    );
    expect(after.rows[0].lifecycle_stage).toBe('testing');
    expect(after.rows[0].check_interval_hours).toBe(24);

    await pool.query('DELETE FROM agent_registry_metadata WHERE agent_url = $1', [targetUrl]);
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
