/**
 * Integration tests for the auto-bootstrap path on `POST /api/me/agents`.
 *
 * The pre-bootstrap behavior was: any POST against an org without a member
 * profile returned `404 "Create a member profile via POST /api/me/member-profile first"`,
 * forcing third-party integrations (e.g. the Scope3 storefront) to chain
 * a manual profile-create round trip. This suite exercises the new path:
 * the endpoint auto-creates a private profile on first call and surfaces
 * `profile_auto_created: true` so the caller can render a "we set up your
 * profile" hint.
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

// brandCreationRateLimiter wraps a Postgres-backed rate-limit store; replace
// with a no-op middleware so the test suite isn't dependent on rate-limit
// state across runs.
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
        email: `${USER_ID}@example.com`,
        firstName: 'Test',
        lastName: 'User',
      };
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
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET name = EXCLUDED.name`,
      [orgId, name],
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
    await pool.query(`DELETE FROM member_profiles WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM users WHERE primary_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id LIKE $1`, [
      `${TEST_PREFIX}%`,
    ]);
  });

  it('auto-creates a private profile on first agent registration and surfaces profile_auto_created', async () => {
    const orgId = `${TEST_PREFIX}_first_agent`;
    await seedOrgWithoutProfile(orgId, 'Acme First-Agent Co');

    const res = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://agent.example.com/mcp', visibility: 'private' });

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
      .send({ url: 'https://agent-1.example.com/mcp', visibility: 'private' });
    expect(first.status).toBe(201);
    expect(first.body.profile_auto_created).toBe(true);

    const second = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://agent-2.example.com/mcp', visibility: 'private' });
    expect(second.status).toBe(201);
    expect(second.body.profile_auto_created).toBeUndefined();
  });

  it('returns 200 + no profile_auto_created when re-posting an existing url (idempotent update)', async () => {
    const orgId = `${TEST_PREFIX}_idempotent`;
    await seedOrgWithoutProfile(orgId);

    const first = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://agent.example.com/mcp', visibility: 'private', name: 'v1' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/me/agents')
      .send({ url: 'https://agent.example.com/mcp', visibility: 'private', name: 'v2' });

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
});
