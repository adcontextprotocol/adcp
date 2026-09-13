import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import type { AuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), memberships: vi.fn(), previousSnapshot: undefined as AuthorizationSnapshot | undefined,
}));
vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    userManagement = { listOrganizationMemberships: mocks.memberships };
  },
}));
// Only the authentication and external WorkOS transport are mocked. The route,
// exact-credential resolver, and grant validity queries run against PostgreSQL.
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
    req.user = {
      id: 'user_api_key_boundary_primary',
      authWorkosUserId: req.get('x-authenticated-user') ?? 'user_api_key_boundary_primary',
      email: 'sam@pinnacle.example',
      emailVerified: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    if (mocks.previousSnapshot) {
      Object.defineProperty(req.user, 'authorizationSnapshot', { value: mocks.previousSnapshot, enumerable: false });
    }
    next();
  },
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createApiKeysRouter } from '../../src/routes/api-keys.js';
import { loadAuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';
import { bumpAuthorizationEpochs } from '../../src/db/authorization-epoch-db.js';

const PRIMARY = 'user_api_key_boundary_primary';
const LINKED = 'user_api_key_boundary_linked';
const PINNACLE = 'org_api_key_boundary_pinnacle';
const STREAMHAUS = 'org_api_key_boundary_streamhaus';

describe('API key exact credential grants in PostgreSQL', () => {
  let pool: Pool;
  let identities: string[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/me/api-keys', createApiKeysRouter());

  async function cleanup() {
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [[PRIMARY, LINKED]]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [[PINNACLE, STREAMHAUS]]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[PRIMARY, LINKED]]);
    if (identities.length) {
      await pool.query('DELETE FROM identities WHERE id = ANY($1::uuid[])', [identities]);
      identities = [];
    }
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    vi.stubGlobal('fetch', mocks.fetch);
  }, 60000);

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      vi.unstubAllGlobals();
      await closeDatabase();
    }
  });

  beforeEach(async () => {
    await cleanup();
    mocks.previousSnapshot = undefined;
    mocks.memberships.mockReset().mockResolvedValue({ data: [] });
    mocks.fetch.mockReset().mockImplementation(async (_url, options: RequestInit) => ({
      ok: true,
      status: options.method === 'DELETE' ? 204 : 200,
      json: async () => ({ data: [] }),
    }));
    await pool.query(
      'INSERT INTO organizations (workos_organization_id, name) VALUES ($1, $2), ($3, $4)',
      [PINNACLE, 'Pinnacle Agency', STREAMHAUS, 'StreamHaus'],
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id)
       VALUES ($1, $2, $3), ($4, $5, $3)`,
      [PRIMARY, 'sam@pinnacle.example', PINNACLE, LINKED, 'sam@streamhaus.example'],
    );
    const bindings = await pool.query(
      'SELECT workos_user_id, identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)',
      [[PRIMARY, LINKED]],
    );
    identities = bindings.rows.map((row) => row.identity_id);
    const primaryIdentity = bindings.rows.find((row) => row.workos_user_id === PRIMARY).identity_id;
    await pool.query(
      'UPDATE identity_workos_users SET identity_id = $1, is_primary = FALSE WHERE workos_user_id = $2',
      [primaryIdentity, LINKED],
    );
  });

  function list(credential: string, organizationId?: string) {
    const query = organizationId ? `?org=${organizationId}` : '';
    return request(app).get(`/api/me/api-keys${query}`).set('x-authenticated-user', credential);
  }

  function lifecycle(credential: string, organizationId: string) {
    return Promise.all([
      list(credential, organizationId),
      request(app).post(`/api/me/api-keys?org=${organizationId}`)
        .set('x-authenticated-user', credential).send({ name: 'Scoped key' }),
      request(app).delete(`/api/me/api-keys/key_scoped?org=${organizationId}`)
        .set('x-authenticated-user', credential),
    ]);
  }

  async function grant(credential: string, organization: string, role = 'admin') {
    const result = await pool.query(
      `INSERT INTO organization_credential_grants
       (workos_user_id, workos_organization_id, role, granted_by_workos_user_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [credential, organization, role, PRIMARY],
    );
    return result.rows[0].id as string;
  }

  it('does not share either credential\'s exact organization grant through their common identity', async () => {
    await grant(PRIMARY, PINNACLE, 'owner');
    await grant(LINKED, STREAMHAUS);

    const results = await Promise.all([
      list(PRIMARY, PINNACLE), list(LINKED, STREAMHAUS),
      list(PRIMARY, STREAMHAUS), list(LINKED, PINNACLE), list(LINKED),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200, 403, 403, 400]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect((await pool.query(
      'SELECT * FROM organization_memberships WHERE workos_user_id = ANY($1)', [[PRIMARY, LINKED]],
    )).rows).toHaveLength(0);
  });

  it.each(['revoked', 'expired', 'future'] as const)('rejects every next key operation after an active exact grant becomes %s without changing source membership', async (state) => {
    await pool.query(
      `INSERT INTO organization_memberships
       (workos_user_id, workos_organization_id, workos_membership_id, email, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [PRIMARY, STREAMHAUS, 'mem_api_key_boundary_source', 'sam@pinnacle.example'],
    );
    const sourceMemberships = async () => (await pool.query(
      'SELECT * FROM organization_memberships WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [[PRIMARY, LINKED]],
    )).rows;
    const before = await sourceMemberships();
    const id = await grant(LINKED, STREAMHAUS);
    const active = await lifecycle(LINKED, STREAMHAUS);
    expect(active.map((result) => result.status)).toEqual([200, 201, 204]);
    expect(await sourceMemberships()).toEqual(before);
    mocks.fetch.mockClear();

    if (state === 'revoked') {
      await pool.query(
        'UPDATE organization_credential_grants SET revoked_at = NOW(), revoked_by_workos_user_id = $2 WHERE id = $1',
        [id, PRIMARY],
      );
    } else {
      await pool.query(
        `UPDATE organization_credential_grants
         SET effective_from = NOW() + $2::interval,
             effective_until = NOW() + $3::interval WHERE id = $1`,
        [id, state === 'expired' ? '-2 days' : '1 day', state === 'expired' ? '-1 day' : '2 days'],
      );
    }
    const results = await lifecycle(LINKED, STREAMHAUS);
    expect(results.map((result) => result.status)).toEqual([403, 403, 403]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await sourceMemberships()).toEqual(before);
  });

  it('reads committed grant revocation and replacement without trusting stale membership or primary org', async () => {
    await pool.query(
      `INSERT INTO organization_memberships
       (workos_user_id, workos_organization_id, workos_membership_id, email, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [LINKED, PINNACLE, 'mem_api_key_boundary_stale', 'sam@streamhaus.example'],
    );
    const id = await grant(LINKED, STREAMHAUS);
    expect((await list(LINKED, STREAMHAUS)).status).toBe(200);
    await pool.query(
      'UPDATE organization_credential_grants SET revoked_at = NOW(), revoked_by_workos_user_id = $2 WHERE id = $1',
      [id, PRIMARY],
    );
    mocks.fetch.mockClear();

    expect((await list(LINKED, STREAMHAUS)).status).toBe(403);
    expect((await list(LINKED, PINNACLE)).status).toBe(403);
    expect((await list(LINKED)).status).toBe(400);
    await grant(LINKED, STREAMHAUS, 'member');
    expect((await list(LINKED, STREAMHAUS)).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await pool.query(
      'SELECT workos_organization_id, role FROM organization_memberships WHERE workos_user_id = $1', [LINKED],
    )).rows).toEqual([{ workos_organization_id: PINNACLE, role: 'owner' }]);
    expect((await pool.query(
      'SELECT primary_organization_id FROM users WHERE workos_user_id = $1', [LINKED],
    )).rows[0].primary_organization_id).toBe(PINNACLE);
  });

  it.each(['epoch changed', 'grant expired', 'grant revoked'] as const)('denies replayed selected context after %s even when fresh WorkOS membership could authorize', async (change) => {
    const id = await grant(LINKED, STREAMHAUS);
    mocks.previousSnapshot = (await loadAuthorizationSnapshot(LINKED, STREAMHAUS))!;
    mocks.memberships.mockImplementation(async ({ userId, organizationId }) => ({
      data: [{ userId, organizationId, status: 'active', role: { slug: 'owner' } }],
    }));
    expect((await lifecycle(LINKED, STREAMHAUS)).map((result) => result.status)).toEqual([200, 201, 204]);

    if (change === 'epoch changed') {
      await bumpAuthorizationEpochs(pool, [LINKED]);
    } else if (change === 'grant revoked') {
      await pool.query(
        'UPDATE organization_credential_grants SET revoked_at = NOW(), revoked_by_workos_user_id = $2 WHERE id = $1',
        [id, PRIMARY],
      );
    } else {
      await pool.query(
        `UPDATE organization_credential_grants SET effective_from = NOW() - INTERVAL '2 days',
          effective_until = NOW() - INTERVAL '1 day' WHERE id = $1`, [id],
      );
    }
    mocks.memberships.mockClear();
    mocks.fetch.mockClear();

    expect((await lifecycle(LINKED, STREAMHAUS)).map((result) => result.status)).toEqual([403, 403, 403]);
    expect(mocks.memberships).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await pool.query(
      'SELECT * FROM organization_memberships WHERE workos_user_id = ANY($1)', [[PRIMARY, LINKED]],
    )).rows).toHaveLength(0);
  });
});
