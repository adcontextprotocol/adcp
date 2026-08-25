/**
 * Integration tests for explicit-organization agent registration.
 *
 * The route now self-heals two prior 4xx cliffs that forced storefront-style
 * integrations to chain extra round trips:
 *
 * - **No org**: requests fail closed with `organization_selection_required`.
 *
 * - **No profile**: any POST against an org without a member profile used
 *   to get a `404 Create a member profile via POST /api/me/member-profile first`.
 *   The route now creates a private profile on first call and surfaces
 *   `profile_auto_created: true`.
 *
 * Organization creation is a separate explicit workflow.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const userOverride: { email?: string; firstName?: string; lastName?: string } = {};

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/auth.js')>(
    '../../src/middleware/auth.js',
  );
  return {
    ...actual,
    requireAuth: (_req: any, _res: any, next: any) => next(),
  };
});

// brandCreationRateLimiter wraps a Postgres-backed rate-limit store; replace
// with a no-op so the test suite isn't dependent on rate-limit state across
// runs.
vi.mock('../../src/middleware/rate-limit.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/rate-limit.js')>(
    '../../src/middleware/rate-limit.js',
  );
  return {
    ...actual,
    brandCreationRateLimiter: (_req: any, _res: any, next: any) => next(),
  };
});

import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MemberDatabase } from '../../src/db/member-db.js';
import { OrganizationDatabase } from '../../src/db/organization-db.js';
import { createMemberAgentsRouter } from '../../src/routes/member-agents.js';

const TEST_PREFIX = 'org_member_agents_boot';
const USER_ID = 'user_boot_agents_owner';

describe('POST /api/me/agents (auto-bootstrap)', () => {
  let pool: Pool;
  let app: express.Application;
  let memberDb: MemberDatabase;
  let orgDb: OrganizationDatabase;
  let selectedOrgId: string | null = null;

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
    app.use((req, _res, next) => {
      (req as any).user = {
        id: USER_ID,
        email: userOverride.email ?? `${USER_ID}@example.com`,
        firstName: userOverride.firstName ?? 'Test',
        lastName: userOverride.lastName ?? 'User',
      };
      if (selectedOrgId && !req.url.includes('?org=')) {
        req.url += `${req.url.includes('?') ? '&' : '?'}org=${encodeURIComponent(selectedOrgId)}`;
      }
      next();
    });

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
          const rows = await pool.query<{ workos_organization_id: string; role: string }>(
            `SELECT workos_organization_id, role FROM organization_memberships WHERE ${where}`,
            args,
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
        createOrganizationMembership: vi.fn().mockImplementation(async ({ userId, organizationId, roleSlug }: any) => ({
          id: `om_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          userId,
          organizationId,
          role: { slug: roleSlug },
          status: 'active',
        })),
        updateOrganizationMembership: vi.fn(),
      },
      organizations: {
        createOrganization: vi.fn().mockImplementation(async ({ name }: { name: string }) => ({
          id: `${TEST_PREFIX}_workos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
        })),
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
    await pool.query(`DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM users WHERE primary_organization_id LIKE $1`, [
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

  async function seedOrgWithoutProfile(orgId: string, name = 'Acme Bootstrap Co') {
    selectedOrgId = orgId;
    // The hostname verification gate (#4499 MVP) requires a row in
    // `organization_domains` with `verified = true` — `email_domain`
    // is NOT a trustworthy claim and is no longer trusted by the gate
    // (security review on #4648). Seed a verified parent so the test
    // agent URLs (`*.example.com/mcp`) match as subdomains. RFC 2606
    // reserves example.com so safe in tests.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = EXCLUDED.name`,
      [orgId, name],
    );
    await pool.query(
      `INSERT INTO organization_domains
         (workos_organization_id, domain, verified, source, created_at, updated_at)
       VALUES ($1, 'example.com', true, 'test', NOW(), NOW())
       ON CONFLICT (domain) DO NOTHING`,
      [orgId],
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET primary_organization_id = EXCLUDED.primary_organization_id`,
      [USER_ID, `${USER_ID}@example.com`, orgId],
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, 'owner', $3, NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = 'owner'`,
      [USER_ID, orgId, `${USER_ID}@example.com`],
    );
  }

  beforeEach(async () => {
    selectedOrgId = null;
    userOverride.email = undefined;
    userOverride.firstName = undefined;
    userOverride.lastName = undefined;
    await pool.query(`DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id = $1`, [USER_ID]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [USER_ID]);
    await pool.query(`DELETE FROM organization_domains WHERE domain LIKE $1`, ['%boot-corp.test']);
    // Clean up shared verified-domain rows seeded by helpers /
    // individual tests so tests in this file (and others) don't race
    // on the unique-domain constraint.
    await pool.query(
      `DELETE FROM organization_domains WHERE domain IN ('example.com', 'no-fork.test')`,
    );
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
  });

  it('auto-creates a private profile on first agent registration and surfaces profile_auto_created', async () => {
    const orgId = `${TEST_PREFIX}_first_agent`;
    await seedOrgWithoutProfile(orgId, 'Acme First-Agent Co');

    const res = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://agent.example.com/mcp', type: 'sales', visibility: 'private' });

    expect(res.status).toBe(201);
    expect(res.body.profile_auto_created).toBe(true);
    expect(res.body.agent).toMatchObject({
      url: 'https://agent.example.com/mcp',
      visibility: 'private',
    });

    const profile = await memberDb.getProfileByOrgId(orgId);
    expect(profile).not.toBeNull();
    expect(profile!.display_name).toBe('Acme First-Agent Co');
    expect(profile!.is_public).toBe(false);
    expect(Array.isArray(profile!.agents)).toBe(true);
    expect(profile!.agents).toHaveLength(1);
    expect(profile!.agents![0].url).toBe('https://agent.example.com/mcp');
  });

  it('does not surface profile_auto_created on subsequent calls', async () => {
    const orgId = `${TEST_PREFIX}_subsequent`;
    await seedOrgWithoutProfile(orgId);

    const first = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://agent-1.example.com/mcp', type: 'sales', visibility: 'private' });
    expect(first.status).toBe(201);
    expect(first.body.profile_auto_created).toBe(true);

    const second = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://agent-2.example.com/mcp', type: 'sales', visibility: 'private' });
    expect(second.status).toBe(201);
    expect(second.body.profile_auto_created).toBeUndefined();
  });

  it('returns 200 + no profile_auto_created when re-posting an existing url (idempotent update)', async () => {
    const orgId = `${TEST_PREFIX}_idempotent`;
    await seedOrgWithoutProfile(orgId);

    const first = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://agent.example.com/mcp', type: 'sales', visibility: 'private', name: 'v1' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://agent.example.com/mcp', type: 'sales', visibility: 'private', name: 'v2' });

    expect(second.status).toBe(200);
    expect(second.body.profile_auto_created).toBeUndefined();
    expect(second.body.agent.name).toBe('v2');
  });

  it('does not auto-bootstrap on PATCH — caller must register first or create the profile explicitly', async () => {
    const orgId = `${TEST_PREFIX}_patch`;
    await seedOrgWithoutProfile(orgId);

    const res = await request(app)
      .patch('/api/me/agents/' + encodeURIComponent('https://agent.example.com/mcp'))
      .send({ name: 'renamed' });

    // PATCH should still 404 — auto-bootstrap is intentionally limited to
    // POST. Updating a nonexistent agent on a nonexistent profile is a
    // genuine error, not a "first time" case.
    expect(res.status).toBe(404);
  });

  describe('organization selection', () => {
    it('fails closed for a fresh corporate-email user when no org is selected', async () => {
      userOverride.email = `fresh@boot-corp.test`;
      userOverride.firstName = 'Fresh';
      userOverride.lastName = 'User';

      const res = await request(app)
        .post('/api/me/agents')
        .send({ url: 'https://agent.boot-corp.test/mcp', type: 'sales', visibility: 'private' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('organization_selection_required');
      const memberships = await pool.query(
        `SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`,
        [USER_ID],
      );
      expect(memberships.rowCount).toBe(0);
    });

    it('fails closed for a fresh free-email user without creating a workspace', async () => {
      userOverride.email = `solo+${Date.now()}@gmail.com`;
      userOverride.firstName = 'Solo';
      userOverride.lastName = 'Founder';

      const res = await request(app)
        .post('/api/me/agents')
        .send({ url: 'https://agent.solo.test/mcp', type: 'sales', visibility: 'private' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('organization_selection_required');
      const memberships = await pool.query(
        `SELECT 1 FROM organization_memberships WHERE workos_user_id = $1`,
        [USER_ID],
      );
      expect(memberships.rowCount).toBe(0);
    });

    it('registers against an explicitly selected existing membership without forking', async () => {
      const existingOrgId = `${TEST_PREFIX}_existing`;
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
         VALUES ($1, $2, false, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO NOTHING`,
        [existingOrgId, 'Already Owned'],
      );
      // Verified domain matching the agent URL — required by the
      // hostname gate. email_domain is no longer trusted (see #4648).
      await pool.query(
        `INSERT INTO organization_domains
           (workos_organization_id, domain, verified, source, created_at, updated_at)
         VALUES ($1, 'no-fork.test', true, 'test', NOW(), NOW())
         ON CONFLICT (domain) DO NOTHING`,
        [existingOrgId],
      );
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
         VALUES ($1, $2, 'owner', $3, NOW(), NOW())
         ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
        [USER_ID, existingOrgId, `${USER_ID}@example.com`],
      );
      selectedOrgId = existingOrgId;

      const res = await request(app)
        .post('/api/me/agents')
        .send({ url: 'https://agent.no-fork.test/mcp', type: 'sales', visibility: 'private' });

      expect(res.status).toBe(201);
      // Profile creation remains safe after explicit organization selection.
      expect(res.body.profile_auto_created).toBe(true);

      const orgRow = await pool.query<{ workos_organization_id: string }>(
        `SELECT workos_organization_id FROM member_profiles WHERE workos_organization_id = $1`,
        [existingOrgId],
      );
      expect(orgRow.rowCount).toBe(1);
    });
  });
});
