/**
 * Integration tests for admin cross-org agent removal.
 *
 * Covers the DELETE /api/admin/accounts/:orgId/agents/:url endpoint —
 * the path that resolves rogue / disputed agent entries the owning org
 * cannot or will not self-serve clean up (see escalation #340).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/auth.js')>(
    '../../src/middleware/auth.js',
  );
  let isAdmin = true;
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = {
        id: 'admin_api_key',
        email: 'admin-api-key@internal',
        firstName: 'Admin',
        lastName: 'API Key',
      };
      next();
    },
    // The mocked requireAdmin only toggles admin/not-admin; the real
    // middleware's cross-tenant API-key gate is exercised in the
    // companion unit test (tests/unit/require-admin-cross-tenant.test.ts).
    // Don't duplicate that here — these integration tests focus on the
    // agents.ts route logic.
    requireAdmin: (_req: any, res: any, next: any) => {
      if (!isAdmin) {
        return res.status(403).json({ error: 'forbidden' });
      }
      next();
    },
    __setAdmin: (v: boolean) => {
      isAdmin = v;
    },
  };
});

import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MemberDatabase } from '../../src/db/member-db.js';
import { setupAdminAgentsRoutes } from '../../src/routes/admin/agents.js';

const TEST_PREFIX = 'org_admin_agent_remove';

describe('Admin cross-org agent removal (DELETE /api/admin/accounts/:orgId/agents/:url)', () => {
  let pool: Pool;
  let app: express.Application;
  let memberDb: MemberDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://adcp:localdev@localhost:5432/adcp_registry',
      max: 5,
    });
    await runMigrations();

    memberDb = new MemberDatabase();

    app = express();
    app.use(express.json());
    const apiRouter = express.Router();
    setupAdminAgentsRoutes(apiRouter);
    app.use('/api/admin', apiRouter);
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM registry_audit_log WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await closeDatabase();
  });

  beforeEach(async () => {
    const mod = (await import('../../src/middleware/auth.js')) as unknown as {
      __setAdmin: (v: boolean) => void;
    };
    mod.__setAdmin(true);

    await pool.query(
      `DELETE FROM registry_audit_log WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
  });

  async function seedOrgWithAgents(
    orgId: string,
    slug: string,
    agents: Array<{ url: string; type?: string; visibility?: string; name?: string }>,
  ) {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, true, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [orgId, `Test ${slug}`],
    );
    await memberDb.createProfile({
      workos_organization_id: orgId,
      display_name: `Test ${slug}`,
      slug,
      is_public: false,
      agents: agents as any,
    });
  }

  it('removes the targeted agent from the org JSONB and writes an audit row', async () => {
    const orgId = `${TEST_PREFIX}_basic`;
    const rogueUrl = 'https://adcp-mcp.celtra.com/mcp/';
    await seedOrgWithAgents(orgId, 'adzymic-basic', [
      { url: 'https://apx.sales-agent.adzymic.ai/mcp', type: 'sales', visibility: 'public' },
      { url: rogueUrl, type: 'sales', visibility: 'public', name: 'Celtra Creative Agent' },
    ]);

    const encoded = encodeURIComponent(rogueUrl);
    const res = await request(app)
      .delete(`/api/admin/accounts/${orgId}/agents/${encoded}`)
      .query({ reason: 'escalation 340: rogue Celtra entry under Adzymic', escalation_id: '340' });

    expect(res.status).toBe(200);
    expect(res.body.removed_agent).toMatchObject({
      url: rogueUrl,
      name: 'Celtra Creative Agent',
    });
    expect(res.body.remaining_agent_count).toBe(1);
    expect(res.body.escalation_id).toBe('340');

    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile?.agents).toHaveLength(1);
    expect(profile?.agents?.[0]?.url).toBe('https://apx.sales-agent.adzymic.ai/mcp');

    const audit = await pool.query(
      `SELECT action, resource_type, resource_id, details, workos_user_id
       FROM registry_audit_log
       WHERE workos_organization_id = $1`,
      [orgId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].action).toBe('admin_remove_agent');
    expect(audit.rows[0].resource_type).toBe('agent');
    expect(audit.rows[0].resource_id).toBe(rogueUrl);
    expect(audit.rows[0].workos_user_id).toBe('admin_api_key');
    expect(audit.rows[0].details).toMatchObject({
      reason: 'escalation 340: rogue Celtra entry under Adzymic',
      escalation_id: '340',
      bypassed_public_unpublish_guard: true,
    });
  });

  it('rejects when reason is missing or too short', async () => {
    const orgId = `${TEST_PREFIX}_no_reason`;
    await seedOrgWithAgents(orgId, 'adzymic-noreason', [
      { url: 'https://x.example/mcp', type: 'sales', visibility: 'private' },
    ]);

    const encoded = encodeURIComponent('https://x.example/mcp');

    const noReason = await request(app).delete(`/api/admin/accounts/${orgId}/agents/${encoded}`);
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toBe('reason_required');

    const tooShort = await request(app)
      .delete(`/api/admin/accounts/${orgId}/agents/${encoded}`)
      .query({ reason: 'x' });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error).toBe('reason_required');

    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile?.agents).toHaveLength(1);
  });

  it('returns 404 when the agent url is not on the org profile', async () => {
    const orgId = `${TEST_PREFIX}_missing_agent`;
    await seedOrgWithAgents(orgId, 'adzymic-missing', [
      { url: 'https://only-this.example/mcp', type: 'sales' },
    ]);

    const encoded = encodeURIComponent('https://nope.example/mcp');
    const res = await request(app)
      .delete(`/api/admin/accounts/${orgId}/agents/${encoded}`)
      .query({ reason: 'looking for an entry that does not exist here' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('agent_not_found');
  });

  it('returns 404 when the org has no member profile', async () => {
    const orgId = `${TEST_PREFIX}_no_profile`;
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, true, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [orgId, 'Profile-less org'],
    );

    const encoded = encodeURIComponent('https://anything.example/mcp');
    const res = await request(app)
      .delete(`/api/admin/accounts/${orgId}/agents/${encoded}`)
      .query({ reason: 'profile does not exist' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('profile_not_found');
  });

  it('rejects non-admin callers via requireAdmin', async () => {
    const orgId = `${TEST_PREFIX}_nonadmin`;
    const url = 'https://nonadmin.example/mcp';
    await seedOrgWithAgents(orgId, 'adzymic-nonadmin', [
      { url, type: 'sales', visibility: 'private' },
    ]);

    const mod = (await import('../../src/middleware/auth.js')) as unknown as {
      __setAdmin: (v: boolean) => void;
    };
    mod.__setAdmin(false);

    const encoded = encodeURIComponent(url);
    const res = await request(app)
      .delete(`/api/admin/accounts/${orgId}/agents/${encoded}`)
      .query({ reason: 'should not be permitted to remove' });

    expect(res.status).toBe(403);

    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile?.agents).toHaveLength(1);
  });

  it('pins bypassed_public_unpublish_guard=false when the removed agent was private', async () => {
    const orgId = `${TEST_PREFIX}_private_flag`;
    const url = 'https://private-rogue.example/mcp';
    await seedOrgWithAgents(orgId, 'adzymic-private-flag', [
      { url, type: 'sales', visibility: 'private' },
    ]);

    const res = await request(app)
      .delete(`/api/admin/accounts/${orgId}/agents/${encodeURIComponent(url)}`)
      .query({ reason: 'private rogue cleanup' });

    expect(res.status).toBe(200);

    const audit = await pool.query(
      `SELECT details FROM registry_audit_log
       WHERE workos_organization_id = $1 AND resource_id = $2`,
      [orgId, url],
    );
    expect(audit.rows[0].details.bypassed_public_unpublish_guard).toBe(false);
  });

  // Cross-tenant WorkOS API-key refusal is enforced by `requireAdmin`
  // itself (issue #4501) rather than by per-route checks. See
  // tests/unit/require-admin-cross-tenant.test.ts for coverage.

  it('GET /api/admin/accounts/:orgId/agents lists agents (companion to DELETE)', async () => {
    const orgId = `${TEST_PREFIX}_list`;
    await seedOrgWithAgents(orgId, 'adzymic-list', [
      { url: 'https://a.example/mcp', type: 'sales' },
      { url: 'https://b.example/mcp', type: 'creative' },
    ]);

    const res = await request(app).get(`/api/admin/accounts/${orgId}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.org_id).toBe(orgId);
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.agents.map((a: any) => a.url)).toContain('https://a.example/mcp');
  });

  it('GET returns 404 when the org has no member profile', async () => {
    const orgId = `${TEST_PREFIX}_list_missing`;
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, true, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [orgId, 'no profile'],
    );

    const res = await request(app).get(`/api/admin/accounts/${orgId}/agents`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('profile_not_found');
  });

  it('GET returns an empty agents array when the profile has no agents', async () => {
    const orgId = `${TEST_PREFIX}_list_empty`;
    await seedOrgWithAgents(orgId, 'adzymic-list-empty', []);

    const res = await request(app).get(`/api/admin/accounts/${orgId}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.org_id).toBe(orgId);
    expect(res.body.agents).toEqual([]);
  });

  it('GET rejects non-admin callers via requireAdmin', async () => {
    const orgId = `${TEST_PREFIX}_list_nonadmin`;
    await seedOrgWithAgents(orgId, 'adzymic-list-nonadmin', [
      { url: 'https://x.example/mcp', type: 'sales' },
    ]);

    const mod = (await import('../../src/middleware/auth.js')) as unknown as {
      __setAdmin: (v: boolean) => void;
    };
    mod.__setAdmin(false);

    const res = await request(app).get(`/api/admin/accounts/${orgId}/agents`);
    expect(res.status).toBe(403);
  });

  it('GET surfaces a 500 when member_profiles.agents is corrupt', async () => {
    const orgId = `${TEST_PREFIX}_list_corrupt`;
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, true, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [orgId, 'corrupt agents profile'],
    );
    // Insert directly with a JSONB string that is not an array. The
    // member_profiles.agents column accepts any jsonb value; the row
    // shape is broken by definition, the test pins the route's
    // 500-with-distinct-code response rather than the silent-empty-list
    // failure mode an earlier version produced.
    await pool.query(
      `INSERT INTO member_profiles
         (workos_organization_id, display_name, slug, is_public, agents, created_at, updated_at)
       VALUES ($1, $2, $3, false, $4::jsonb, NOW(), NOW())`,
      [orgId, 'Corrupt', `corrupt-${orgId}`, '"not an array"'],
    );

    const res = await request(app).get(`/api/admin/accounts/${orgId}/agents`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('corrupt_agents_column');
  });


  it('removes a public-visibility agent (bypasses the unpublish-first guard)', async () => {
    const orgId = `${TEST_PREFIX}_public_bypass`;
    const rogueUrl = 'https://rogue-public.example/mcp';
    await seedOrgWithAgents(orgId, 'adzymic-public', [
      { url: rogueUrl, type: 'sales', visibility: 'public', name: 'Rogue Public Agent' },
    ]);

    const encoded = encodeURIComponent(rogueUrl);
    const res = await request(app)
      .delete(`/api/admin/accounts/${orgId}/agents/${encoded}`)
      .query({ reason: 'rogue public entry, owner unreachable' });

    expect(res.status).toBe(200);
    expect(res.body.removed_agent.visibility).toBe('public');

    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile?.agents).toHaveLength(0);

    const audit = await pool.query(
      `SELECT details FROM registry_audit_log
       WHERE workos_organization_id = $1 AND resource_id = $2`,
      [orgId, rogueUrl],
    );
    expect(audit.rows[0].details.bypassed_public_unpublish_guard).toBe(true);
  });
});
