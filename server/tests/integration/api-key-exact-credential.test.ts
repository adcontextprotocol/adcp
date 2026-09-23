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
// exact-credential lifecycle fence runs against PostgreSQL. Grants are fixture
// data that must never authorize, elevate, or impede key management.
vi.mock('../../src/middleware/auth.js', () => ({
  requireApiKeyManagementAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
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

describe('API key direct exact credential membership in PostgreSQL', () => {
  let pool: Pool;
  let identities: string[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/me/api-keys', createApiKeysRouter());

  async function cleanup() {
    await pool.query('DELETE FROM registry_audit_log WHERE workos_user_id = ANY($1)', [[PRIMARY, LINKED]]);
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

  function operation(action: 'list' | 'create' | 'revoke', credential: string, organizationId: string) {
    if (action === 'list') return list(credential, organizationId);
    if (action === 'create') {
      return request(app).post(`/api/me/api-keys?org=${organizationId}`)
        .set('x-authenticated-user', credential).send({ name: 'Scoped key' });
    }
    return request(app).delete(`/api/me/api-keys/key_scoped?org=${organizationId}`)
      .set('x-authenticated-user', credential);
  }

  function lifecycle(credential: string, organizationId: string) {
    return Promise.all((['list', 'create', 'revoke'] as const).map((action) => operation(action, credential, organizationId)));
  }

  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  async function waitForBlockedBy(blockerPid: number, minimum = 1) {
    const deadline = Date.now() + 1_500;
    do {
      const result = await pool.query<{ pid: number; blockers: number[] }>(
        `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
         WHERE cardinality(pg_blocking_pids(pid)) > 0`,
      );
      // A second waiter may queue behind the first tuple-lock waiter rather
      // than reporting the original transaction directly as its blocker.
      const chain = new Set([blockerPid]);
      for (let pass = 0; pass < result.rows.length; pass++) {
        for (const row of result.rows) {
          if (row.blockers.some((pid) => chain.has(pid))) chain.add(row.pid);
        }
      }
      if (chain.size - 1 >= minimum) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error('Expected a lifecycle operation to wait on the exact credential fence');
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

  function allowDirectMembership(role = 'owner') {
    mocks.memberships.mockImplementation(async ({ userId, organizationId }) => ({
      data: [{ id: `mem_${userId}`, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), userId, organizationId, status: 'active', role: { slug: role } }],
    }));
  }

  it.each([
    [PRIMARY, 'identity_credential_deleted'], [LINKED, 'identity_credential_deleted'],
    [PRIMARY, 'identity_primary_deletion_quarantined'], [LINKED, 'identity_primary_deletion_quarantined'],
  ])('withholds buffered inventory when %s gains a durable %s marker during the read', async (credential, action) => {
    allowDirectMembership();
    mocks.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => {
        await pool.query(
          `INSERT INTO registry_audit_log (workos_organization_id, workos_user_id, action, resource_type, resource_id)
           VALUES ($1, $2::text, $3, 'user', $2::text)`, [PINNACLE, credential, action],
        );
        return { data: [{ id: 'key_withheld_lifecycle_marker', secret: 'withheld-lifecycle-secret' }] };
      },
    });
    const response = await operation('list', credential, PINNACLE);
    expect(response.status).toBe(403);
    expect(response.text).not.toContain('key_withheld_lifecycle_marker');
    expect(response.text).not.toContain('withheld-lifecycle-secret');
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][1].method).toBe('GET');
  });

  async function persistedMemberships() {
    return (await pool.query(
      'SELECT * FROM organization_memberships WHERE workos_user_id = ANY($1) ORDER BY workos_user_id',
      [[PRIMARY, LINKED]],
    )).rows;
  }

  async function changeGrant(id: string, state: 'revoked' | 'expired' | 'future') {
    if (state === 'revoked') {
      await pool.query(
        'UPDATE organization_credential_grants SET revoked_at = NOW(), revoked_by_workos_user_id = $2 WHERE id = $1',
        [id, PRIMARY],
      );
      return;
    }
    await pool.query(
      `UPDATE organization_credential_grants
       SET effective_from = NOW() + $2::interval,
           effective_until = NOW() + $3::interval WHERE id = $1`,
      [id, state === 'expired' ? '-2 days' : '1 day', state === 'expired' ? '-1 day' : '2 days'],
    );
  }

  it.each([
    [PRIMARY, PINNACLE, LINKED, STREAMHAUS],
    [LINKED, STREAMHAUS, PRIMARY, PINNACLE],
  ])('never lets %s manage keys through its own or its sibling credential grant', async (credential, organization, sibling, siblingOrganization) => {
    await grant(credential, organization, 'owner');
    await grant(sibling, siblingOrganization);
    const before = await persistedMemberships();

    expect((await lifecycle(credential, organization)).map((result) => result.status)).toEqual([403, 403, 403]);
    expect((await lifecycle(credential, siblingOrganization)).map((result) => result.status)).toEqual([403, 403, 403]);
    expect((await list(credential)).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await persistedMemberships()).toEqual(before);
  });

  it.each(['admin', 'owner'])('does not elevate a direct member through an exact %s grant', async (grantRole) => {
    await grant(LINKED, STREAMHAUS, grantRole);
    allowDirectMembership('member');

    expect((await lifecycle(LINKED, STREAMHAUS)).map((result) => result.status)).toEqual([403, 403, 403]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await persistedMemberships()).toEqual([]);
  });

  it.each(['absent', 'admin', 'owner', 'member', 'revoked', 'expired', 'future'] as const)(
    'permits direct admin reads and contains mutations independently of %s grants', async (state) => {
      if (state !== 'absent') {
        const id = await grant(LINKED, STREAMHAUS, ['member', 'owner'].includes(state) ? state : 'admin');
        // Authentication may have captured an active grant. Changing that grant
        // must not revoke the credential's independent direct WorkOS membership.
        mocks.previousSnapshot = (await loadAuthorizationSnapshot(LINKED, STREAMHAUS))!;
        if (state === 'revoked' || state === 'expired' || state === 'future') await changeGrant(id, state);
      }
      allowDirectMembership('admin');
      const before = await persistedMemberships();

      expect((await lifecycle(LINKED, STREAMHAUS)).map((result) => result.status)).toEqual([200, 503, 503]);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(await persistedMemberships()).toEqual(before);
    },
  );

  it('does not query unavailable grant storage for direct active membership', async () => {
    await grant(LINKED, STREAMHAUS);
    mocks.previousSnapshot = (await loadAuthorizationSnapshot(LINKED, STREAMHAUS))!;
    allowDirectMembership();
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      // Any grant-table read would block until the route's authorization query
      // times out. The route must complete while this lock remains held.
      await blocker.query('LOCK TABLE organization_credential_grants IN ACCESS EXCLUSIVE MODE');
      expect((await lifecycle(LINKED, STREAMHAUS)).map((result) => result.status)).toEqual([200, 503, 503]);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(await persistedMemberships()).toEqual([]);
  });

  it('returns unavailable without secret effects when WorkOS fails despite an active exact owner grant', async () => {
    await grant(LINKED, STREAMHAUS, 'owner');
    mocks.memberships.mockRejectedValue(new Error('WorkOS temporarily unavailable'));
    const before = await persistedMemberships();

    expect((await lifecycle(LINKED, STREAMHAUS)).map((result) => result.status)).toEqual([503, 503, 503]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await persistedMemberships()).toEqual(before);
  });

  it.each([
    [PRIMARY, PINNACLE, LINKED],
    [LINKED, STREAMHAUS, PRIMARY],
  ])('does not reuse %s canonical sibling, cached membership, or primary organization', async (credential, organization, sibling) => {
    await pool.query(
      `INSERT INTO organization_memberships
       (workos_user_id, workos_organization_id, workos_membership_id, email, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [credential, organization, 'mem_api_key_boundary_stale', 'sam@streamhaus.example'],
    );
    await grant(credential, organization, 'owner');
    mocks.memberships.mockResolvedValue({
      data: [{ userId: sibling, organizationId: organization, status: 'active', role: { slug: 'owner' } }],
    });
    const before = await persistedMemberships();

    expect((await lifecycle(credential, organization)).map((result) => result.status)).toEqual([403, 403, 403]);
    expect((await list(credential)).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await persistedMemberships()).toEqual(before);
    expect((await pool.query(
      'SELECT primary_organization_id FROM users WHERE workos_user_id = $1', [credential],
    )).rows[0].primary_organization_id).toBe(PINNACLE);
  });

  it.each([PRIMARY, LINKED])('denies replayed identity epoch for %s even when fresh WorkOS membership could authorize', async (credential) => {
    mocks.previousSnapshot = (await loadAuthorizationSnapshot(credential, STREAMHAUS))!;
    allowDirectMembership();
    expect((await lifecycle(credential, STREAMHAUS)).map((result) => result.status)).toEqual([200, 503, 503]);
    await bumpAuthorizationEpochs(pool, [credential]);
    mocks.memberships.mockClear();
    mocks.fetch.mockClear();

    expect((await lifecycle(credential, STREAMHAUS)).map((result) => result.status)).toEqual([403, 403, 403]);
    expect(mocks.memberships).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await persistedMemberships()).toEqual([]);
  });

  it.each((['list', 'create', 'revoke'] as const).flatMap((action) =>
    [PRIMARY, LINKED].map((credential) => ({ action, credential })),
  ))('rechecks $credential after $action waits behind an authoritative epoch mutation', async ({ action, credential }) => {
    await bumpAuthorizationEpochs(pool, [credential]);
    mocks.previousSnapshot = (await loadAuthorizationSnapshot(credential, STREAMHAUS))!;
    allowDirectMembership();
    const membershipChecked = barrier();
    mocks.memberships.mockImplementation(async ({ userId, organizationId }) => {
      membershipChecked.release();
      return { data: [{ id: `mem_${userId}`, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), userId, organizationId, status: 'active', role: { slug: 'owner' } }] };
    });
    const mutation = await pool.connect();
    let pending: Promise<request.Response> | undefined;
    try {
      await mutation.query('BEGIN');
      await mutation.query('SELECT workos_user_id FROM users WHERE workos_user_id = $1 FOR UPDATE', [credential]);
      const pid = (await mutation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      pending = operation(action, credential, STREAMHAUS).then((response) => response);
      await Promise.race([
        membershipChecked.promise,
        pending.then(() => { throw new Error('Request completed before direct membership validation'); }),
      ]);
      // The initial direct lookup has completed. The provider operation must
      // wait for the authoritative row lock and recheck after its release.
      await waitForBlockedBy(pid);
      expect(mocks.fetch).not.toHaveBeenCalled();
      await bumpAuthorizationEpochs(mutation, [credential]);
      await mutation.query('COMMIT');
      expect((await pending).status).toBe(403);
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      await mutation.query('ROLLBACK');
      mutation.release();
      await pending;
    }
  });

  it.each((['list'] as const).flatMap((action) =>
    [PRIMARY, LINKED].flatMap((credential) =>
      (['existing', 'absent'] as const).map((epochState) => ({ action, credential, epochState }))),
  ))('holds the exact $credential $epochState epoch fence throughout the $action provider effect', async ({ action, credential, epochState }) => {
    if (epochState === 'existing') await bumpAuthorizationEpochs(pool, [credential]);
    allowDirectMembership();
    const providerEntered = barrier();
    const providerReleased = barrier();
    mocks.fetch.mockImplementation(async (_url, options: RequestInit) => {
      providerEntered.release();
      await providerReleased.promise;
      return {
        ok: true,
        status: options.method === 'DELETE' ? 204 : 200,
        json: async () => ({ data: [] }),
      };
    });
    const mutation = await pool.connect();
    let mutationPending: Promise<void> | undefined;
    const pending = operation(action, credential, STREAMHAUS).then((response) => response);
    try {
      await Promise.race([
        providerEntered.promise,
        pending.then(() => { throw new Error('Request completed before the provider effect'); }),
      ]);
      await mutation.query('BEGIN');
      const pid = (await mutation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      mutationPending = bumpAuthorizationEpochs(mutation, [credential]);
      const deadline = Date.now() + 1_500;
      let blockingPids: number[] = [];
      do {
        blockingPids = (await pool.query('SELECT pg_blocking_pids($1) AS pids', [pid])).rows[0].pids;
        if (blockingPids.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      expect(blockingPids.length).toBeGreaterThan(0);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      providerReleased.release();
      expect((await pending).status).toBe(200);
      await mutationPending;
      await mutation.query('COMMIT');
    } finally {
      providerReleased.release();
      await pending;
      await mutationPending;
      await mutation.query('ROLLBACK');
      mutation.release();
    }
  });

  it('serializes linked and primary key management without taking binding locks in opposite order', async () => {
    allowDirectMembership();
    const identity = (await pool.query(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1', [PRIMARY],
    )).rows[0].identity_id;
    const blocker = await pool.connect();
    let linked: Promise<request.Response> | undefined;
    let primary: Promise<request.Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM identities WHERE id = $1 FOR UPDATE', [identity]);
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      linked = list(LINKED, STREAMHAUS).then((response) => response);
      await waitForBlockedBy(pid);
      primary = list(PRIMARY, PINNACLE).then((response) => response);
      await waitForBlockedBy(pid, 2);
      // LINKED is first in the identity-lock queue. PRIMARY must not already
      // own the primary binding that LINKED will need after this lock opens.
      await blocker.query('COMMIT');
      expect((await Promise.all([linked, primary])).map((response) => response.status)).toEqual([200, 200]);
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.all([linked, primary]);
    }
  });

  it.each([PRIMARY, LINKED].flatMap((credential) =>
    (['headers', 'body'] as const).flatMap((phase) =>
      (['revoked', 'member', 'admin', 'outage'] as const).map((change) => ({ credential, phase, change }))),
  ))('withholds $credential inventory after external $change during provider $phase', async ({ credential, phase, change }) => {
    let current: 'owner' | 'revoked' | 'member' | 'admin' | 'outage' = 'owner';
    const entered = barrier();
    const released = barrier();
    mocks.memberships.mockImplementation(async ({ userId, organizationId }) => {
      if (current === 'outage') throw new Error('Membership provider unavailable');
      return { data: current === 'revoked' ? [] : [{
        id: `mem_${userId}`, userId, organizationId, status: 'active', role: { slug: current },
        createdAt: new Date(0).toISOString(), updatedAt: new Date(current === 'owner' ? 0 : 1).toISOString(),
      }] };
    });
    mocks.fetch.mockImplementation(async () => {
      if (phase === 'headers') { entered.release(); await released.promise; }
      return { ok: true, status: 200, json: async () => {
        if (phase === 'body') { entered.release(); await released.promise; }
        return { data: [{ id: 'key_must_not_escape', value: 'secret_must_not_escape' }] };
      } };
    });
    let completed = false;
    const pending = list(credential, STREAMHAUS).then((response) => { completed = true; return response; });
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Read missed barrier'); })]);
      expect(completed).toBe(false);
      current = change;
      released.release();
      const response = await pending;
      expect(response.status).toBe(change === 'outage' ? 503 : 403);
      expect(response.text).not.toContain('key_must_not_escape');
      expect(response.text).not.toContain('secret_must_not_escape');
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(mocks.fetch.mock.calls[0][1].method).toBe('GET');
      expect(mocks.memberships).toHaveBeenCalledTimes(3);
      expect(await persistedMemberships()).toEqual([]);
    } finally {
      released.release();
      await pending;
    }
  });

  it.each([PRIMARY, LINKED].flatMap((credential) =>
    (['create', 'revoke'] as const).flatMap((action) =>
      (['revoked', 'admin'] as const).map((change) => ({ credential, action, change }))),
  ))('contains $credential $action even after the final provider lookup races with $change', async ({ credential, action, change }) => {
    const entered = barrier();
    const released = barrier();
    let changed = false;
    let calls = 0;
    mocks.memberships.mockImplementation(async ({ userId, organizationId }) => {
      // Capture the provider's old response before the external mutation. The
      // second lookup deliberately cannot see the change; containment must
      // still prevent a key mutation without pretending this read is atomic.
      const data = changed && change === 'revoked' ? [] : [{
        id: `mem_${userId}`, userId, organizationId, status: 'active',
        role: { slug: changed ? 'admin' : 'owner' },
        createdAt: new Date(0).toISOString(), updatedAt: new Date(changed ? 1 : 0).toISOString(),
      }];
      if (++calls === 2) { entered.release(); await released.promise; }
      return { data };
    });
    const pending = operation(action, credential, STREAMHAUS).then((response) => response);
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Mutation missed barrier'); })]);
      changed = true;
      released.release();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('API key mutations unavailable');
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(await persistedMemberships()).toEqual([]);
    } finally {
      released.release();
      await pending;
    }
  });

});
