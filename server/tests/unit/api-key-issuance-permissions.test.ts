import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { AuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';

const mocks = vi.hoisted(() => ({
  listOrganizationMemberships: vi.fn(),
  queryWithTimeout: vi.fn(),
  fetch: vi.fn(),
  info: vi.fn(),
  request: null as express.Request | null,
  previousSnapshot: undefined as AuthorizationSnapshot | undefined,
}));

vi.hoisted(() => {
  vi.stubEnv('WORKOS_API_KEY', 'sk_test_api_key_issuance');
  vi.stubEnv('WORKOS_CLIENT_ID', 'client_test_api_key_issuance');
  vi.stubEnv('WORKOS_COOKIE_PASSWORD', 'test-cookie-password-at-least-32-characters');
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    userManagement = {
      listOrganizationMemberships: mocks.listOrganizationMemberships,
    };
  },
}));

vi.mock('../../src/db/client.js', () => ({
  queryWithTimeout: mocks.queryWithTimeout, isTransientConnectionError: () => false,
}));
vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({ info: mocks.info, warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  DEV_USERS: {},
  isDevModeEnabled: () => false,
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: req.get('x-canonical-user') ?? 'user_caller',
      authWorkosUserId: req.get('x-authenticated-user'),
      identityId: req.get('x-identity-id'),
      email: 'caller@example.test',
      emailVerified: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    if (mocks.previousSnapshot) {
      Object.defineProperty(req.user, 'authorizationSnapshot', { value: mocks.previousSnapshot, enumerable: false });
    }
    mocks.request = req;
    next();
  },
}));

const { createApiKeysRouter } = await import('../../src/routes/api-keys.js');
const { loadAuthorizationSnapshot } = await import('../../src/db/user-authorization-snapshot-db.js');

function snapshotRow(userId: string, organizationId?: string, role?: 'owner' | 'admin' | 'member') {
  return {
    in_recovery: false, authenticated_user_id: userId,
    canonical_user_id: userId === 'user_linked' ? 'user_primary' : userId,
    identity_id: 'identity_original', authorization_epoch: '1',
    email: 'caller@example.test', email_verified: true, first_name: null, last_name: null,
    grant_id: role ? 'grant_scoped' : null, grant_organization_id: role ? organizationId : null,
    grant_role: role ?? null, grant_effective_from: role ? '2026-01-01T00:00:00.000000Z' : null,
    grant_effective_until: null,
  };
}

function setSnapshotWithoutGrant() {
  mocks.queryWithTimeout.mockImplementation(async (_sql, [userId]) => ({ rows: [snapshotRow(userId)] }));
}

beforeEach(() => {
  mocks.queryWithTimeout.mockReset();
  setSnapshotWithoutGrant();
  mocks.request = null;
  mocks.previousSnapshot = undefined;
});

// Own the process-global transport for the lifetime of this file. Installing
// and restoring it independently in sibling suites lets one suite's teardown
// expose native fetch while another suite is still issuing a request under a
// loaded full-suite worker, leaking the request to WorkOS. Individual tests
// only reset/configure the mock implementation below.
beforeAll(() => {
  vi.stubGlobal('fetch', mocks.fetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function setMembership(
  role: 'owner' | 'admin' | 'member',
  status: 'active' | 'pending' | 'inactive' = 'active',
) {
  mocks.listOrganizationMemberships.mockResolvedValue({
    data: [
      {
        userId: 'user_caller',
        organizationId: 'org_target',
        role: { slug: role },
        status,
      },
    ],
  });
}

function setUnboundMembership(organizationId?: string) {
  mocks.listOrganizationMemberships.mockResolvedValue({
    data: [
      {
        userId: 'user_caller',
        ...(organizationId ? { organizationId } : {}),
        role: { slug: 'owner' },
        status: 'active',
      },
    ],
  });
}

function setNoMembership() {
  mocks.listOrganizationMemberships.mockResolvedValue({ data: [] });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/me/api-keys', createApiKeysRouter());
  return app;
}

describe('tenant API key issuance permissions', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: vi.fn().mockResolvedValue({ id: 'key_created', value: 'secret' }),
    });
  });

  it.each([[], ['admin:*']] as const)(
    'refuses an active ordinary member creating a key with permissions %j',
    async (permissions) => {
      setMembership('member');

      const response = await request(app)
        .post('/api/me/api-keys?org=org_target')
        .send({ name: 'Member key', permissions });

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('owners and admins');
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['owner', 'admin:*'],
    ['admin', 'admin:read'],
  ] as const)(
    'allows an organization %s to create a key with server-approved permission %s',
    async (role, permission) => {
      setMembership(role);

      const response = await request(app)
        .post('/api/me/api-keys?org=org_target')
        .send({ name: 'Automation key', permissions: [permission] });

      expect(response.status).toBe(201);
      const [url, options] = mocks.fetch.mock.calls[0] as [string, RequestInit];
      expect(new URL(url).pathname).toBe('/organizations/org_target/api_keys');
      expect(JSON.parse(options.body as string)).toEqual({
        name: 'Automation key',
        permissions: [permission],
      });
    },
  );

  it('allows an active owner to create an unprivileged key', async () => {
    setMembership('owner');

    const response = await request(app)
      .post('/api/me/api-keys?org=org_target')
      .send({ name: 'Registry key', permissions: [] });

    expect(response.status).toBe(201);
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledWith({
      userId: 'user_caller',
      organizationId: 'org_target',
    });
    const [, options] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Registry key' });
  });

  it('deduplicates server-approved permissions before sending them to WorkOS', async () => {
    setMembership('owner');

    const response = await request(app)
      .post('/api/me/api-keys?org=org_target')
      .send({
        name: 'Deduplicated key',
        permissions: ['admin:read', 'admin:read'],
      });

    expect(response.status).toBe(201);
    const [, options] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({
      name: 'Deduplicated key',
      permissions: ['admin:read'],
    });
  });

  it.each([
    { label: 'a scalar', permissions: 'admin:*' },
    { label: 'a non-string array item', permissions: ['admin:*', 7] },
  ])('rejects malformed permissions supplied as $label', async ({ permissions }) => {
    setMembership('owner');

    const response = await request(app)
      .post('/api/me/api-keys?org=org_target')
      .send({ name: 'Malformed key', permissions });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid permissions');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects caller-invented permissions even for an organization owner', async () => {
    setMembership('owner');

    const response = await request(app)
      .post('/api/me/api-keys?org=org_target')
      .send({ name: 'Unknown scope', permissions: ['admin:billing'] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid permissions');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('organization-wide API key management permissions', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    });
  });

  async function rawDelete(path: string) {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      return await new Promise<number | undefined>((resolve, reject) => {
        // Passing a raw HTTP path avoids the client's URL dot normalization.
        const req = httpRequest({
          hostname: '127.0.0.1', port: (server.address() as AddressInfo).port,
          method: 'DELETE', path: `${path}?org=org_target`,
          headers: { 'x-canonical-user': 'user_primary', 'x-authenticated-user': 'user_linked' },
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  function exactLinkedMembership(role: 'admin' | 'member') {
    mocks.listOrganizationMemberships.mockResolvedValue({ data: [{
      userId: 'user_linked', organizationId: 'org_target', status: 'active', role: { slug: role },
    }] });
  }

  function expectExactAuthorizationWithoutDelete() {
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledExactlyOnceWith({
      userId: 'user_linked', organizationId: 'org_target',
    });
    expect(mocks.queryWithTimeout).toHaveBeenCalledWith(
      expect.any(String), ['user_linked', 'org_target'], expect.any(Number),
      { retryTransientCheckout: false },
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  }

  it.each([
    '.', '..', '%2e', '%2E', '.%2e', '.%2E', '%2e.', '%2E.',
    '%2e%2e', '%2e%2E', '%2E%2e', '%2E%2E', './', '../', '%2E/', '%2e%2E/',
  ])('authorizes the exact credential before rejecting raw dot-segment path %s without a provider DELETE', async (keyPath) => {
    exactLinkedMembership('admin');
    expect(await rawDelete(`/api/me/api-keys/${keyPath}`)).toBe(400);
    expectExactAuthorizationWithoutDelete();
  });

  it('authorizes before rejecting dot segments on a case-insensitive route', async () => {
    exactLinkedMembership('admin');
    expect(await rawDelete('/API/ME/API-KEYS/%2E%2E/')).toBe(400);
    expectExactAuthorizationWithoutDelete();
  });

  it.each(['.', '..', '%2E', '%2e%2E'])('preserves forbidden and unavailable exact authorization for raw path %s', async (keyPath) => {
    exactLinkedMembership('member');
    expect(await rawDelete(`/api/me/api-keys/${keyPath}`)).toBe(403);
    expectExactAuthorizationWithoutDelete();

    vi.clearAllMocks();
    mocks.listOrganizationMemberships.mockRejectedValue(new Error('Authorization provider unavailable'));
    expect(await rawDelete(`/api/me/api-keys/${keyPath}`)).toBe(503);
    expectExactAuthorizationWithoutDelete();
  });

  it('refuses an ordinary member listing organization API keys before WorkOS is called', async () => {
    setMembership('member');

    const response = await request(app).get('/api/me/api-keys?org=org_target');

    expect(response.status).toBe(403);
    expect(response.body.message).toContain('owners and admins');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses an ordinary member revoking an organization API key before WorkOS is called', async () => {
    setMembership('member');

    const response = await request(app).delete(
      '/api/me/api-keys/key_owner_automation?org=org_target',
    );

    expect(response.status).toBe(403);
    expect(response.body.message).toContain('owners and admins');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('allows an active owner to list organization API keys', async () => {
    setMembership('owner');

    const response = await request(app).get('/api/me/api-keys?org=org_target');

    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, options] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/organizations/org_target/api_keys');
    expect(options.method).toBe('GET');
  });

  it('allows an active admin to revoke an organization API key', async () => {
    setMembership('admin');
    mocks.fetch.mockResolvedValue({ ok: true, status: 204 });

    const response = await request(app).delete(
      '/api/me/api-keys/key_owner_automation?org=org_target',
    );

    expect(response.status).toBe(204);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, options] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      '/organizations/org_target/api_keys/key_owner_automation',
    );
    expect(options.method).toBe('DELETE');
  });

  it.each([
    ['another organization', 'org_attacker'],
    ['no organization ID', undefined],
  ] as const)(
    'refuses all key operations when WorkOS returns an owner membership for %s',
    async (_label, returnedOrganizationId) => {
      for (const operation of ['create', 'list', 'revoke'] as const) {
        vi.clearAllMocks();
        setUnboundMembership(returnedOrganizationId);

        const response = operation === 'create'
          ? await request(app)
            .post('/api/me/api-keys?org=org_target')
            .send({ name: 'Cross-org key', permissions: [] })
          : operation === 'list'
          ? await request(app).get('/api/me/api-keys?org=org_target')
          : await request(app).delete(
            '/api/me/api-keys/key_cross_org?org=org_target',
          );

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Access denied');
        expect(mocks.fetch).not.toHaveBeenCalled();
      }
    },
  );
});

describe('inactive API key lifecycle principals', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    });
  });

  const cases = [
    ['pending', 'create'],
    ['pending', 'list'],
    ['pending', 'revoke'],
    ['inactive', 'create'],
    ['inactive', 'list'],
    ['inactive', 'revoke'],
    ['none', 'create'],
    ['none', 'list'],
    ['none', 'revoke'],
  ] as const;

  it.each(cases)(
    'refuses a %s owner attempting to %s organization API keys',
    async (membershipState, operation) => {
      if (membershipState === 'none') {
        setNoMembership();
      } else {
        setMembership('owner', membershipState);
      }

      const response = operation === 'create'
        ? await request(app)
          .post('/api/me/api-keys?org=org_target')
          .send({ name: 'Lifecycle key', permissions: [] })
        : operation === 'list'
          ? await request(app).get('/api/me/api-keys?org=org_target')
          : await request(app).delete(
            '/api/me/api-keys/key_lifecycle?org=org_target',
          );

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Access denied');
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
});

describe('exact credential API key authorization', () => {
  const app = createApp();
  const operations = ['create', 'list', 'revoke'] as const;

  function perform(operation: typeof operations[number], org?: string) {
    const query = org === undefined ? '' : `?org=${encodeURIComponent(org)}`;
    return operation === 'create'
      ? request(app).post(`/api/me/api-keys${query}`).send({ name: 'Scoped automation' })
      : operation === 'list'
        ? request(app).get(`/api/me/api-keys${query}`)
        : request(app).delete(`/api/me/api-keys/key_scoped${query}`);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOrganizationMemberships.mockReset().mockResolvedValue({ data: [] });
    mocks.fetch.mockReset().mockImplementation(async (_url, options: RequestInit) => ({
      ok: true,
      status: options.method === 'DELETE' ? 204 : 200,
      json: async () => ({ data: [] }),
    }));
  });

  it.each(operations)('isolates linked credentials in both directions when they %s keys', async (operation) => {
    const organizations: Record<string, string> = {
      user_primary: 'org_pinnacle',
      user_linked: 'org_streamhaus',
    };
    mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => ({
      data: organizations[userId] === organizationId
        ? [{ userId, organizationId, status: 'active', role: { slug: 'owner' } }]
        : [],
    }));

    for (const [credential, ownOrg] of Object.entries(organizations)) {
      const otherOrg = ownOrg === 'org_pinnacle' ? 'org_streamhaus' : 'org_pinnacle';
      const denied = await perform(operation, otherOrg)
        .set('x-canonical-user', 'user_primary')
        .set('x-authenticated-user', credential);
      expect(denied.status).toBe(403);
      expect(mocks.fetch).not.toHaveBeenCalled();

      const allowed = await perform(operation, ownOrg)
        .set('x-canonical-user', 'user_primary')
        .set('x-authenticated-user', credential);
      expect(allowed.status).toBe(operation === 'create' ? 201 : operation === 'revoke' ? 204 : 200);
      expect(mocks.listOrganizationMemberships).toHaveBeenLastCalledWith({
        userId: credential, organizationId: ownOrg,
      });
      expect(mocks.queryWithTimeout).toHaveBeenLastCalledWith(
        expect.any(String), [credential, ownOrg], expect.any(Number),
        { retryTransientCheckout: false },
      );
      expect(new URL(mocks.fetch.mock.calls[0][0]).pathname)
        .toContain(`/organizations/${ownOrg}/api_keys`);
      mocks.fetch.mockClear();
    }
  });

  it.each(operations)('requires an explicit organization to %s even for an owner', async (operation) => {
    setMembership('owner');

    expect((await perform(operation)).status).toBe(400);
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.queryWithTimeout).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    '/api/me/api-keys?org=org_target&org=org_other',
    '/api/me/api-keys?org=%20',
  ])('rejects an ambiguous or malformed selected organization: %s', async (url) => {
    setMembership('owner');
    expect((await request(app).get(url)).status).toBe(400);
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('cannot use a path-like selected organization to target another organization', async () => {
    setMembership('owner');
    const response = await request(app).get('/api/me/api-keys?org=org_target%2F..%2Forg_other');
    expect(response.status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects conflicting query and body organization selections', async () => {
    setMembership('owner');
    const response = await request(app).post('/api/me/api-keys?org=org_target')
      .send({ organizationId: 'org_other', name: 'Ambiguous key' });
    expect(response.status).toBe(400);
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['api_key_key_tenant', 'admin_api_key'])('refuses synthetic principal %s for all key management', async (principal) => {
    setMembership('owner');
    for (const operation of operations) {
      expect((await perform(operation, 'org_target').set('x-canonical-user', principal)).status).toBe(403);
    }
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.queryWithTimeout).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(operations)('returns unavailable separately from forbidden when authority cannot establish permission to %s', async (operation) => {
    mocks.listOrganizationMemberships.mockRejectedValue(new Error('WorkOS unavailable'));
    expect((await perform(operation, 'org_target')).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();

    setMembership('member');
    mocks.queryWithTimeout.mockRejectedValue(new Error('Grant database unavailable'));
    expect((await perform(operation, 'org_target')).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();

    setSnapshotWithoutGrant();
    expect((await perform(operation, 'org_target')).status).toBe(403);
  });

  it('does not cache organization authority between operations', async () => {
    setMembership('owner');
    expect((await perform('list', 'org_target')).status).toBe(200);
    mocks.fetch.mockClear();
    setMembership('member');

    expect((await perform('create', 'org_target')).status).toBe(403);
    expect((await perform('revoke', 'org_target')).status).toBe(403);
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(3);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not inherit a linked credential grant or a higher canonical role', async () => {
    mocks.listOrganizationMemberships.mockImplementation(async ({ userId }) => ({
      data: userId === 'user_primary'
        ? [{ userId, organizationId: 'org_target', status: 'active', role: { slug: 'owner' } }]
        : [],
    }));
    mocks.queryWithTimeout.mockImplementation(async (_sql, [userId, orgId]) => ({
      rows: [snapshotRow(userId, orgId, orgId === 'org_target' ? userId === 'user_primary' ? 'owner' : 'member' : undefined)],
    }));

    for (const operation of operations) {
      expect((await perform(operation, 'org_target')
        .set('x-canonical-user', 'user_primary')
        .set('x-authenticated-user', 'user_linked')).status).toBe(403);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('authorizes only the exact credential and organization named by an explicit admin grant', async () => {
    mocks.queryWithTimeout.mockImplementation(async (_sql, [userId, orgId]) => ({
      rows: [snapshotRow(userId, orgId, userId === 'user_linked' && orgId === 'org_target' ? 'admin' : undefined)],
    }));

    expect((await perform('list', 'org_target')
      .set('x-canonical-user', 'user_primary').set('x-authenticated-user', 'user_linked')).status).toBe(200);
    mocks.fetch.mockClear();
    expect((await perform('list', 'org_target').set('x-canonical-user', 'user_primary')).status).toBe(403);
    expect((await perform('list', 'org_other')
      .set('x-canonical-user', 'user_primary').set('x-authenticated-user', 'user_linked')).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['epoch changed', 'grant expired', 'grant replaced', 'organization changed'])('preserves the non-enumerable snapshot and rejects replay after %s', async (change) => {
    const original = snapshotRow('user_linked', 'org_target', 'admin');
    mocks.queryWithTimeout.mockResolvedValue({ rows: [original] });
    mocks.previousSnapshot = (await loadAuthorizationSnapshot(
      'user_linked', change === 'organization changed' ? 'org_other' : 'org_target',
    ))!;
    const current = change === 'epoch changed' ? { ...original, authorization_epoch: '2' }
      : change === 'grant expired' ? snapshotRow('user_linked')
        : change === 'grant replaced' ? { ...original, grant_id: 'grant_replacement' } : original;
    mocks.queryWithTimeout.mockResolvedValue({ rows: [current] });
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [{ userId: 'user_linked', organizationId: 'org_target', status: 'active', role: { slug: 'owner' } }],
    });

    for (const operation of operations) {
      expect((await perform(operation, 'org_target')
        .set('x-canonical-user', 'user_primary').set('x-authenticated-user', 'user_linked')).status).toBe(403);
    }
    expect(Object.keys(mocks.request!.user!)).not.toContain('authorizationSnapshot');
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('keeps concurrent requests isolated when the linked credential lookup completes first', async () => {
    const primaryStarted = Promise.withResolvers<void>();
    const releasePrimary = Promise.withResolvers<void>();
    mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => {
      if (userId === 'user_primary') {
        primaryStarted.resolve();
        await releasePrimary.promise;
        return { data: [{ userId, organizationId, status: 'active', role: { slug: 'owner' } }] };
      }
      return { data: [] };
    });
    const primary = perform('list', 'org_target')
      .set('x-canonical-user', 'user_primary').then((response) => response);
    await primaryStarted.promise;
    try {
      const linked = await perform('list', 'org_target')
        .set('x-canonical-user', 'user_primary').set('x-authenticated-user', 'user_linked');
      expect(linked.status).toBe(403);
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      releasePrimary.resolve();
    }
    expect((await primary).status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});

describe('API key selector agreement and immutable audit actor', () => {
  const app = createApp();
  const methods = ['GET', 'POST', 'DELETE'] as const;
  const locations = [
    ['query', 'org'], ['query', 'organization_id'], ['query', 'organizationId'],
    ['body', 'organizationId'], ['body', 'organization_id'],
    ['header', 'x-organization-id'],
  ] as const;
  type Selection = { query?: Record<string, unknown>; body?: Record<string, unknown>; header?: string | string[] };

  function select(entries: Array<readonly [typeof locations[number], unknown]>): Selection {
    const selection: Selection = {};
    for (const [[source, field], value] of entries) {
      if (source === 'header') selection.header = value as string | string[];
      else (selection[source] ??= {})[field] = value;
    }
    return selection;
  }

  function perform(method: typeof methods[number], selection: Selection) {
    const route = '/api/me/api-keys';
    const call = method === 'GET' ? request(app).get(route)
      : method === 'POST' ? request(app).post(route)
        : request(app).delete(`${route}/key_scoped`);
    if (selection.query) call.query(selection.query);
    if (selection.header !== undefined) call.set('X-Organization-ID', selection.header);
    return call.send({ ...(method === 'POST' ? { name: 'Scoped automation' } : {}), ...selection.body });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOrganizationMemberships.mockReset();
    setMembership('owner');
    mocks.fetch.mockReset().mockImplementation(async (_url, options: RequestInit) => ({
      ok: true,
      status: options.method === 'DELETE' ? 204 : 200,
      json: async () => ({ data: [] }),
    }));
  });

  it.each(methods)('accepts each explicit selector alone and all agreeing selectors on %s', async (method) => {
    const selections = [
      ...locations.map((location) => select([[location, 'org_target']])),
      select(locations.map((location) => [location, 'org_target'])),
    ];
    for (const selection of selections) {
      const response = await perform(method, selection);
      expect(response.status, JSON.stringify(selection)).toBe(method === 'GET' ? 200 : method === 'POST' ? 201 : 204);
      expect(mocks.listOrganizationMemberships).toHaveBeenLastCalledWith({ userId: 'user_caller', organizationId: 'org_target' });
      expect(new URL(mocks.fetch.mock.lastCall![0]).pathname).toContain('/organizations/org_target/api_keys');
    }
  });

  it.each(methods)('rejects every conflicting selector pair before authorization on %s', async (method) => {
    for (const [index, left] of locations.entries()) {
      for (const right of locations.slice(index + 1)) {
        const selection = select([[left, 'org_target'], [right, 'org_other']]);
        expect((await perform(method, selection)).status, JSON.stringify(selection)).toBe(400);
      }
    }
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.queryWithTimeout).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(methods)('rejects malformed and repeated selectors even alongside a valid selection on %s', async (method) => {
    for (const location of locations) {
      const invalidValues: unknown[] = location[0] === 'header'
        ? ['', ' ', 'org_target,org_other', 'org_target, org_target', ['org_target', 'org_target'], ['org_target', 'org_other']]
        : location[0] === 'query'
          ? ['', ' ', ' org_target', 'org_target ', ['org_target', 'org_target']]
          : ['', ' ', ' org_target', 'org_target ', null, 7, [], ['org_target'], { id: 'org_target' }];
      for (const value of invalidValues) {
        const fallback = location[0] === 'query' ? locations[2] : locations[0];
        const selection = select([[fallback, 'org_target'], [location, value]]);
        expect((await perform(method, selection)).status, JSON.stringify(selection)).toBe(400);
      }
    }
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.queryWithTimeout).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', 201, 'API key created'],
    ['DELETE', 204, 'API key revoked'],
    ['DELETE', 404, 'API key revoke: already absent in WorkOS'],
  ] as const)('keeps the original actor for %s provider status %s across both asynchronous boundaries', async (method, providerStatus, message) => {
    const lookupStarted = Promise.withResolvers<void>();
    const releaseLookup = Promise.withResolvers<void>();
    const providerStarted = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    mocks.listOrganizationMemberships.mockImplementation(async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return { data: [{ userId: 'user_linked', organizationId: 'org_target', status: 'active', role: { slug: 'owner' } }] };
    });
    mocks.fetch.mockImplementation(async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return {
        ok: providerStatus !== 404,
        status: providerStatus,
        json: async () => ({ id: 'key_scoped' }),
        text: async () => 'Already absent',
      };
    });

    const pending = perform(method, { query: { org: 'org_target' } })
      .set('x-canonical-user', 'user_primary').set('x-authenticated-user', 'user_linked')
      .set('x-identity-id', 'identity_original').then((response) => response);
    try {
      await lookupStarted.promise;
      Object.assign(mocks.request!.user!, {
        id: 'user_changed_during_lookup', authWorkosUserId: 'user_wrong_lookup', identityId: 'identity_wrong_lookup',
      });
      releaseLookup.resolve();
      await providerStarted.promise;
      Object.assign(mocks.request!.user!, {
        id: 'user_changed_during_provider', authWorkosUserId: 'user_wrong_provider', identityId: 'identity_wrong_provider',
      });
    } finally {
      releaseLookup.resolve();
      releaseProvider.resolve();
    }

    expect((await pending).status).toBe(method === 'POST' ? 201 : 204);
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledWith({ userId: 'user_linked', organizationId: 'org_target' });
    expect(mocks.queryWithTimeout).toHaveBeenCalledWith(
      expect.any(String), ['user_linked', 'org_target'], expect.any(Number),
      { retryTransientCheckout: false },
    );
    expect(mocks.info).toHaveBeenCalledWith({
      userId: 'user_primary', authWorkosUserId: 'user_linked', identityId: 'identity_original',
      organizationId: 'org_target', ...(method === 'POST' ? { keyName: 'Scoped automation' } : { apiKeyId: 'key_scoped' }),
    }, message);
  });
});
