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
  transactionQuery: vi.fn(),
  clientQuery: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  connectionError: undefined as ((error: Error) => void) | undefined,
  connect: vi.fn(),
  release: vi.fn(),
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
  getPool: () => ({ connect: mocks.connect }),
}));
vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({ info: mocks.info, warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  DEV_USERS: {},
  isDevModeEnabled: () => false,
  requireApiKeyManagementAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: req.get('x-canonical-user') ?? 'user_caller',
      authWorkosUserId: req.get('x-authenticated-user'),
      identityId: req.get('x-identity-id'),
      email: req.get('x-user-email') ?? 'caller@example.test',
      isAdmin: req.get('x-platform-admin') === 'true',
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
    in_recovery: false, terminal_marker: false, primary_count: '1', authenticated_user_id: userId,
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

function transactionClient() {
  return { query: mocks.clientQuery, release: mocks.release, on: mocks.on, removeListener: mocks.removeListener };
}

beforeEach(() => {
  mocks.queryWithTimeout.mockReset();
  mocks.connectionError = undefined;
  mocks.on.mockReset().mockImplementation((_event, listener) => { mocks.connectionError = listener; });
  mocks.clientQuery.mockReset().mockImplementation(async (statement, parameters) => (
    typeof statement === 'string'
      ? mocks.transactionQuery(statement, parameters)
      : mocks.transactionQuery(statement.text, statement.values)
  ));
  mocks.transactionQuery.mockReset().mockImplementation(async (sql, parameters) => {
    if (sql.includes('AS authenticated_user_id')) {
      return mocks.queryWithTimeout.getMockImplementation()!(sql, parameters);
    }
    return { rows: sql.includes('FROM users WHERE') ? [{ workos_user_id: parameters[0] }] : [] };
  });
  mocks.connect.mockReset().mockResolvedValue(transactionClient());
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
        id: 'membership_caller', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
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
        id: 'membership_caller', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
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
    'contains an organization %s creating a key with server-approved permission %s',
    async (role, permission) => {
      setMembership(role);

      const response = await request(app)
        .post('/api/me/api-keys?org=org_target')
        .send({ name: 'Automation key', permissions: [permission] });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('API key mutations unavailable');
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.info).not.toHaveBeenCalled();
    },
  );

  it('contains an active owner creating an unprivileged key', async () => {
    setMembership('owner');

    const response = await request(app)
      .post('/api/me/api-keys?org=org_target')
      .send({ name: 'Registry key', permissions: [] });

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('API key mutations unavailable');
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledWith({
      userId: 'user_caller',
      organizationId: 'org_target',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('does not send even valid duplicate permissions to WorkOS while mutations are disabled', async () => {
    setMembership('owner');
    const response = await request(app).post('/api/me/api-keys?org=org_target')
      .send({ name: 'Duplicate scopes', permissions: ['admin:read', 'admin:read'] });
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('API key mutations unavailable');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, '', null, false, 0])('completes both exact authorization checks before rejecting missing key name %j', async (name) => {
    setMembership('owner');
    const response = await request(app).post('/api/me/api-keys?org=org_target').send({ name });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('name is required');
    expect(mocks.listOrganizationMemberships.mock.calls).toEqual([
      [{ userId: 'user_caller', organizationId: 'org_target' }],
      [{ userId: 'user_caller', organizationId: 'org_target' }],
    ]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
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
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('rejects caller-invented permissions even for an organization owner', async () => {
    setMembership('owner');

    const response = await request(app)
      .post('/api/me/api-keys?org=org_target')
      .send({ name: 'Unknown scope', permissions: ['admin:billing'] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid permissions');
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
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
      id: 'membership_linked', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      userId: 'user_linked', organizationId: 'org_target', status: 'active', role: { slug: role },
    }] });
  }

  function expectExactAuthorizationWithoutDelete(expectedLookups = 2) {
    expect(mocks.listOrganizationMemberships.mock.calls).toEqual(Array.from({ length: expectedLookups }, () => [{
      userId: 'user_linked', organizationId: 'org_target',
    }]));
    expect(mocks.queryWithTimeout).toHaveBeenCalledWith(
      expect.any(String), ['user_linked'], expect.any(Number), { retryTransientCheckout: false },
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

  it.each([
    '%2E%2E%2Fkey_other', '..%2fkey_other', '%2e%2e%5ckey_other', '..\\key_other',
    'key_%2F..%2Fkey_other', 'key_%5c..%5ckey_other',
    '%252e%252e', '%252E%252E%252Fkey_other', '%255c', '%25',
    '%2Fkey_other', '%2f%2fapi.workos.com', 'https%3A%2F%2Fexample.test',
    'key_value%3Fother=value', 'key_value%23fragment', 'key_value%3Bsegment',
    'key_value%00', 'key_value%09', 'key_value%0A', 'key_value%0D',
    'key_value%20', 'key_value.', 'key_value%EF%BC%8Fother',
  ])('rejects non-opaque decoded key input after exact authorization (case %#)', async (keyPath) => {
    exactLinkedMembership('admin');
    expect(await rawDelete(`/api/me/api-keys/${keyPath}`)).toBe(400);
    expectExactAuthorizationWithoutDelete();
  });

  it.each(['key_01AZaz09_-', 'api_key_01H123ABC', '%6bey_encoded', 'key_valid/'])(
    'accepts an opaque key identifier but keeps revocation contained (case %#)', async (keyPath) => {
      exactLinkedMembership('admin');
      expect(await rawDelete(`/api/me/api-keys/${keyPath}`)).toBe(503);
      expectExactAuthorizationWithoutDelete();
    },
  );

  it.each(['.', '..', '%2E', '%2e%2E'])('preserves forbidden and unavailable exact authorization for raw path %s', async (keyPath) => {
    exactLinkedMembership('member');
    expect(await rawDelete(`/api/me/api-keys/${keyPath}`)).toBe(403);
    expectExactAuthorizationWithoutDelete(1);

    vi.clearAllMocks();
    mocks.listOrganizationMemberships.mockRejectedValue(new Error('Authorization provider unavailable'));
    expect(await rawDelete(`/api/me/api-keys/${keyPath}`)).toBe(503);
    expectExactAuthorizationWithoutDelete(1);
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

  it('contains an active admin revoking an organization API key', async () => {
    setMembership('admin');
    const response = await request(app).delete('/api/me/api-keys/key_owner_automation?org=org_target');
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('API key mutations unavailable');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
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
        ? [{ id: `membership_${userId}_${organizationId}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', userId, organizationId, status: 'active', role: { slug: 'owner' } }]
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
      expect(allowed.status).toBe(operation === 'list' ? 200 : 503);
      expect(mocks.listOrganizationMemberships).toHaveBeenLastCalledWith({
        userId: credential, organizationId: ownOrg,
      });
      expect(mocks.queryWithTimeout).toHaveBeenLastCalledWith(
        expect.any(String), [credential], expect.any(Number), { retryTransientCheckout: false },
      );
      if (operation === 'list') {
        expect(new URL(mocks.fetch.mock.calls[0][0]).pathname).toContain(`/organizations/${ownOrg}/api_keys`);
      } else {
        expect(allowed.body.error).toBe('API key mutations unavailable');
        expect(mocks.fetch).not.toHaveBeenCalled();
      }
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

  it('rejects a path-like selected organization before any membership or key request', async () => {
    setMembership('owner');
    const response = await request(app).get('/api/me/api-keys?org=org_target%2F..%2Forg_other');
    expect(response.status).toBe(400);
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    '.', '..', '../org_other', 'org_target/../org_other', 'org_target\\..\\org_other',
    '%2e%2e', '%252e%252e', '%2F', 'org_target?other=value', 'org_target#fragment',
    'https://example.test', '//example.test', 'org_target\n', 'org_target\r',
    'org_target\t', 'org_target\0', 'org_target ', 'org_\uFF0Fother',
  ])('rejects non-opaque organization selectors in every lifecycle operation (case %#)', async (org) => {
    setMembership('owner');
    for (const operation of operations) {
      expect((await perform(operation, org)).status).toBe(400);
    }
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.queryWithTimeout).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['org_01AZaz09_-', 'org_01H123ABC'])(
    'keeps the outbound inventory URL fixed for an accepted opaque organization (case %#)', async (org) => {
      mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => ({
        data: [{ id: 'membership_opaque', createdAt: '2026-01-01', updatedAt: '2026-01-01',
          userId, organizationId, status: 'active', role: { slug: 'admin' } }],
      }));
      const response = await perform('list', org).query({ after: '../cursor?#', limit: '10' });
      expect(response.status).toBe(200);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = mocks.fetch.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.origin).toBe('https://api.workos.com');
      expect(parsed.pathname).toBe(`/organizations/${org}/api_keys`);
      expect(parsed.hash).toBe('');
      expect([...parsed.searchParams]).toEqual([['after', '../cursor?#'], ['limit', '10']]);
      expect(options.method).toBe('GET');
    },
  );

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

  it.each(operations)('does not let canonical platform-admin or email attribution authorize %s', async (operation) => {
    const response = await perform(operation, 'org_target')
      .set('x-canonical-user', 'user_primary')
      .set('x-authenticated-user', 'user_linked')
      .set('x-platform-admin', 'true')
      .set('x-user-email', 'administrator@example.test');
    expect(response.status).toBe(403);
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledExactlyOnceWith({
      userId: 'user_linked', organizationId: 'org_target',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(['api_key_key_tenant', 'admin_api_key'])('refuses synthetic exact credential %s even with normal canonical user attribution', async (principal) => {
    setMembership('owner');
    for (const operation of operations) {
      expect((await perform(operation, 'org_target')
        .set('x-canonical-user', 'user_caller').set('x-authenticated-user', principal)).status).toBe(403);
    }
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.queryWithTimeout).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(operations)('returns unavailable separately from forbidden when authority cannot establish permission to %s', async (operation) => {
    mocks.listOrganizationMemberships.mockRejectedValue(new Error('WorkOS unavailable'));
    expect((await perform(operation, 'org_target')).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();

    setMembership('member');
    mocks.queryWithTimeout.mockRejectedValue(new Error('Credential lifecycle database unavailable'));
    expect((await perform(operation, 'org_target')).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();

    mocks.queryWithTimeout.mockImplementation(async (sql, [userId]) => {
      if (sql.includes('organization_credential_grants')) throw new Error('Grant storage unavailable');
      return { rows: [snapshotRow(userId)] };
    });
    expect((await perform(operation, 'org_target')).status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('does not cache organization authority between operations', async () => {
    setMembership('owner');
    expect((await perform('list', 'org_target')).status).toBe(200);
    mocks.fetch.mockClear();
    setMembership('member');

    expect((await perform('create', 'org_target')).status).toBe(403);
    expect((await perform('revoke', 'org_target')).status).toBe(403);
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(5);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not inherit a linked credential grant or a higher canonical role', async () => {
    mocks.listOrganizationMemberships.mockImplementation(async ({ userId }) => ({
      data: userId === 'user_primary'
        ? [{ id: `membership_${userId}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', userId, organizationId: 'org_target', status: 'active', role: { slug: 'owner' } }]
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

  it.each(operations)('never authorizes %s through a grant-only exact credential', async (operation) => {
    mocks.queryWithTimeout.mockImplementation(async (_sql, [userId]) => ({
      rows: [snapshotRow(userId, 'org_target', userId === 'user_linked' ? 'admin' : undefined)],
    }));

    expect((await perform(operation, 'org_target')
      .set('x-canonical-user', 'user_primary').set('x-authenticated-user', 'user_linked')).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each(operations)('does not elevate an ordinary direct member with an owner or admin grant to %s keys', async (operation) => {
    setMembership('member');
    for (const grantRole of ['owner', 'admin'] as const) {
      mocks.queryWithTimeout.mockImplementation(async (_sql, [userId]) => ({
        rows: [snapshotRow(userId, 'org_target', grantRole)],
      }));
      expect((await perform(operation, 'org_target')).status).toBe(403);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each(operations)('keeps direct owner/admin %s authorization independent of unavailable grant storage and snapshot grants', async (operation) => {
    const grantRows = [
      snapshotRow('user_caller'),
      snapshotRow('user_caller', 'org_target', 'member'),
      snapshotRow('user_caller', 'org_target', 'admin'),
      snapshotRow('user_caller', 'org_target', 'owner'),
      { ...snapshotRow('user_caller', 'org_target', 'admin'), grant_effective_until: '2020-01-01T00:00:00.000000Z' },
      snapshotRow('user_caller', 'org_other', 'owner'),
    ];
    for (const directRole of ['owner', 'admin'] as const) {
      setMembership(directRole);
      for (const previousRow of grantRows) {
        mocks.queryWithTimeout.mockResolvedValue({ rows: [previousRow] });
        mocks.previousSnapshot = (await loadAuthorizationSnapshot('user_caller', 'org_target'))!;
        mocks.queryWithTimeout.mockClear().mockImplementation(async (sql, [userId]) => {
          if (sql.includes('organization_credential_grants')) {
            throw new Error('Grant storage unavailable');
          }
          return { rows: [snapshotRow(userId)] };
        });
        const response = await perform(operation, 'org_target');
        expect(response.status, `${directRole}; ${JSON.stringify(previousRow)}`).toBe(operation === 'list' ? 200 : 503);
        expect(mocks.queryWithTimeout.mock.calls.every(([sql]) => !sql.includes('organization_credential_grants'))).toBe(true);
      }
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(operation === 'list' ? 12 : 0);
  });

  it.each(['epoch changed', 'organization changed'])('preserves the non-enumerable snapshot and rejects replay after %s', async (change) => {
    const original = snapshotRow('user_linked', 'org_target', 'admin');
    mocks.queryWithTimeout.mockResolvedValue({ rows: [original] });
    mocks.previousSnapshot = (await loadAuthorizationSnapshot(
      'user_linked', change === 'organization changed' ? 'org_other' : 'org_target',
    ))!;
    const current = change === 'epoch changed' ? { ...original, authorization_epoch: '2' } : original;
    mocks.queryWithTimeout.mockResolvedValue({ rows: [current] });
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [{ id: 'membership_linked', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', userId: 'user_linked', organizationId: 'org_target', status: 'active', role: { slug: 'owner' } }],
    });

    for (const operation of operations) {
      expect((await perform(operation, 'org_target')
        .set('x-canonical-user', 'user_primary').set('x-authenticated-user', 'user_linked')).status).toBe(403);
    }
    expect(Object.keys(mocks.request!.user!)).not.toContain('authorizationSnapshot');
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(operations)('rechecks current direct membership inside the lifecycle fence before %s', async (operation) => {
    for (const changedMembership of ['member', 'pending', 'absent', 'unavailable'] as const) {
      vi.clearAllMocks();
      const recheckStarted = Promise.withResolvers<void>();
      const releaseRecheck = Promise.withResolvers<void>();
      let lookups = 0;
      mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => {
        if (++lookups === 1) return { data: [{ id: `membership_${userId}_${organizationId}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', userId, organizationId, status: 'active', role: { slug: 'owner' } }] };
        recheckStarted.resolve();
        await releaseRecheck.promise;
        if (changedMembership === 'unavailable') throw new Error('WorkOS unavailable during final recheck');
        return { data: changedMembership === 'absent' ? [] : [{
          id: `membership_${userId}_${organizationId}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          userId, organizationId, status: changedMembership === 'pending' ? 'pending' : 'active',
          role: { slug: changedMembership === 'member' ? 'member' : 'owner' },
        }] };
      });
      const pending = perform(operation, 'org_target').then((response) => response);
      try {
        await recheckStarted.promise;
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.transactionQuery.mock.calls.some(([sql]) => sql.includes('FROM users WHERE') && sql.includes('FOR UPDATE'))).toBe(true);
      } finally {
        releaseRecheck.resolve();
      }
      expect((await pending).status, changedMembership).toBe(changedMembership === 'unavailable' ? 503 : 403);
      expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.info).not.toHaveBeenCalled();
      expect(mocks.transactionQuery.mock.calls.some(([sql]) => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
      expect(mocks.release).toHaveBeenCalledOnce();
    }
  });

  it.each(operations)('rejects a lifecycle change while %s waits to enter the fence', async (operation) => {
    setMembership('owner');
    const checkoutStarted = Promise.withResolvers<void>();
    const releaseCheckout = Promise.withResolvers<void>();
    mocks.connect.mockImplementation(async () => {
      checkoutStarted.resolve();
      await releaseCheckout.promise;
      return transactionClient();
    });
    const pending = perform(operation, 'org_target').then((response) => response);
    try {
      await checkoutStarted.promise;
      expect(mocks.fetch).not.toHaveBeenCalled();
      mocks.queryWithTimeout.mockImplementation(async (_sql, [userId]) => ({
        rows: [{ ...snapshotRow(userId), authorization_epoch: '2' }],
      }));
    } finally {
      releaseCheckout.resolve();
    }
    expect((await pending).status).toBe(403);
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each(operations)('checks lifecycle state after the last membership await before %s', async (operation) => {
    let lookups = 0;
    mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => {
      if (++lookups === 2) {
        mocks.queryWithTimeout.mockImplementation(async () => ({
          rows: [{ ...snapshotRow(userId), authorization_epoch: '2' }],
        }));
      }
      return { data: [{ id: `membership_${userId}_${organizationId}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', userId, organizationId, status: 'active', role: { slug: 'owner' } }] };
    });
    expect((await perform(operation, 'org_target')).status).toBe(403);
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each(operations)('returns unavailable without an effect when the fenced connection is lost before %s', async (operation) => {
    let lookups = 0;
    mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => {
      if (++lookups === 2) mocks.connectionError!(new Error('Fence connection lost'));
      return { data: [{ id: `membership_${userId}_${organizationId}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', userId, organizationId, status: 'active', role: { slug: 'owner' } }] };
    });
    expect((await perform(operation, 'org_target')).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['connection lost', 'provider budget exhausted'] as const)('refuses a secret operation when %s during the final snapshot query', async (change) => {
    setMembership('owner');
    const finalQueryStarted = Promise.withResolvers<void>();
    const releaseFinalQuery = Promise.withResolvers<void>();
    const query = mocks.transactionQuery.getMockImplementation()!;
    let snapshots = 0;
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.transactionQuery.mockImplementation(async (sql, parameters) => {
      const result = await query(sql, parameters);
      if (sql.includes('AS authenticated_user_id') && ++snapshots === 2) {
        finalQueryStarted.resolve();
        await releaseFinalQuery.promise;
      }
      return result;
    });
    const pending = perform('create', 'org_target').then((response) => response);
    try {
      await finalQueryStarted.promise;
      expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
      expect(mocks.fetch).not.toHaveBeenCalled();
      if (change === 'connection lost') mocks.connectionError!(new Error('Connection lost while final query returns'));
      else now += 11_000;
      releaseFinalQuery.resolve();
      expect((await pending).status).toBe(503);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.info).not.toHaveBeenCalled();
      expect(mocks.connect).toHaveBeenCalledOnce();
    } finally {
      releaseFinalQuery.resolve();
      clock.mockRestore();
    }
  });

  it.each(operations)('bounds a failed lock query and denies %s without retrying authorization or provider effects', async (operation) => {
    setMembership('owner');
    const query = mocks.transactionQuery.getMockImplementation()!;
    mocks.transactionQuery.mockImplementation(async (sql, parameters) => {
      if (sql.includes('FROM users WHERE')) throw Object.assign(new Error('Lock timeout'), { code: '55P03' });
      return query(sql, parameters);
    });
    expect((await perform(operation, 'org_target')).status).toBe(503);
    expect(mocks.clientQuery.mock.calls.length).toBeGreaterThan(1);
    for (const [statement] of mocks.clientQuery.mock.calls) {
      expect(statement.query_timeout).toBeGreaterThan(0);
      expect(statement.query_timeout).toBeLessThanOrEqual(2000);
    }
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(operations)('treats an unusable membership response as unavailable before %s', async (operation) => {
    mocks.listOrganizationMemberships.mockResolvedValue({ data: null });
    expect((await perform(operation, 'org_target')).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(['create', 'revoke'] as const)('does not dispatch %s or claim an unknown outcome while mutations are disabled', async (operation) => {
    setMembership('owner');
    mocks.fetch.mockRejectedValue(new Error('This transport must never be reached'));
    const response = await perform(operation, 'org_target');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'API key mutations unavailable',
      message: 'API key creation and revocation are disabled until membership changes can be fenced.',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each(operations)('does not redispatch or alter the %s response if lock cleanup fails', async (operation) => {
    setMembership('owner');
    const query = mocks.transactionQuery.getMockImplementation()!;
    mocks.transactionQuery.mockImplementation(async (sql, parameters) => {
      if (sql === 'ROLLBACK') throw new Error('Connection lost during lock cleanup');
      return query(sql, parameters);
    });
    expect((await perform(operation, 'org_target')).status).toBe(operation === 'list' ? 200 : 503);
    expect(mocks.fetch).toHaveBeenCalledTimes(operation === 'list' ? 1 : 0);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['create', 'revoke'] as const)('contains %s even when external authority changes after the final local check', async (operation) => {
    for (const change of ['revoked', 'downgraded'] as const) {
      vi.clearAllMocks();
      const finalQueryStarted = Promise.withResolvers<void>();
      const releaseFinalQuery = Promise.withResolvers<void>();
      let revoked = false;
      let snapshots = 0;
      mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => ({ data: revoked
        ? change === 'revoked' ? [] : [{
          id: 'membership_current', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          userId, organizationId, status: 'active', role: { slug: 'member' },
        }]
        : [{ id: 'membership_current', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', userId, organizationId, status: 'active', role: { slug: 'owner' } }],
      }));
      mocks.transactionQuery.mockImplementation(async (sql, parameters) => {
        if (sql.includes('AS authenticated_user_id')) {
          const result = await mocks.queryWithTimeout.getMockImplementation()!(sql, parameters);
          if (++snapshots === 2) {
            finalQueryStarted.resolve();
            await releaseFinalQuery.promise;
          }
          return result;
        }
        return { rows: sql.includes('FROM users WHERE') ? [{ workos_user_id: parameters[0] }] : [] };
      });
      const pending = perform(operation, 'org_target').then((response) => response);
      try {
        await finalQueryStarted.promise;
        expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
        revoked = true;
        expect(mocks.fetch).not.toHaveBeenCalled();
      } finally {
        releaseFinalQuery.resolve();
      }
      const response = await pending;
      expect(response.status, change).toBe(503);
      expect(response.body.error).toBe('API key mutations unavailable');
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.info).not.toHaveBeenCalled();
      expect(mocks.transactionQuery.mock.calls.some(([sql]) => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
    }
  });

  it.each(['response', 'body'] as const)('withholds inventory when external authority changes during the provider %s', async (boundary) => {
    for (const change of ['revoked', 'member', 'admin', 'membership replaced', 'creation changed', 'version changed', 'roles changed', 'unavailable'] as const) {
      vi.clearAllMocks();
      const readStarted = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      let changed = false;
      let settled = false;
      mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => {
        if (changed && change === 'unavailable') throw new Error('Membership read unavailable');
        return { data: changed && change === 'revoked' ? [] : [{
          id: changed && change === 'membership replaced' ? 'membership_replaced' : 'membership_original',
          createdAt: changed && change === 'creation changed' ? '2026-01-02T00:00:00.000Z' : '2026-01-01T00:00:00.000Z',
          updatedAt: changed && change === 'version changed' ? '2026-01-02T00:00:00.000Z' : '2026-01-01T00:00:00.000Z',
          userId, organizationId, status: 'active',
          role: { slug: changed && (change === 'admin' || change === 'member') ? change : 'owner' },
          roles: changed && change === 'roles changed' ? [{ slug: 'owner' }, { slug: 'member' }] : undefined,
        }] };
      });
      mocks.fetch.mockImplementation(async () => {
        if (boundary === 'response') {
          readStarted.resolve();
          await releaseRead.promise;
        }
        return { ok: true, status: 200, json: async () => {
          if (boundary === 'body') {
            readStarted.resolve();
            await releaseRead.promise;
          }
          return { data: [{ id: 'key_inventory_private', value: 'private_inventory_value' }] };
        } };
      });
      const pending = perform('list', 'org_target').then((response) => { settled = true; return response; });
      try {
        await readStarted.promise;
        expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
        expect(settled).toBe(false);
        changed = true;
      } finally {
        releaseRead.resolve();
      }
      const response = await pending;
      expect(response.status, change).toBe(change === 'unavailable' ? 503 : 403);
      expect(JSON.stringify(response.body)).not.toContain('key_inventory_private');
      expect(JSON.stringify(response.body)).not.toContain('private_inventory_value');
      expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(3);
      expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ method: 'GET' }));
      expect(mocks.info).not.toHaveBeenCalled();
    }
  });

  it('withholds inventory when local exact credential state changes during the provider body read', async () => {
    setMembership('owner');
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => {
      readStarted.resolve();
      await releaseRead.promise;
      return { data: [{ id: 'key_inventory_private' }] };
    } });
    const pending = perform('list', 'org_target').then((response) => response);
    try {
      await readStarted.promise;
      mocks.queryWithTimeout.mockImplementation(async (_sql, [userId]) => ({
        rows: [{ ...snapshotRow(userId), authorization_epoch: '2' }],
      }));
    } finally {
      releaseRead.resolve();
    }
    const response = await pending;
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain('key_inventory_private');
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each(['connection lost', 'deadline expired'] as const)('withholds inventory if the local fence is unusable after the final membership lookup: %s', async (failure) => {
    let lookups = 0;
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => {
      if (++lookups === 3) {
        if (failure === 'connection lost') mocks.connectionError!(new Error('Fence lost during final membership lookup'));
        else now += 15_001;
      }
      return { data: [{
        id: 'membership_current', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        userId, organizationId, status: 'active', role: { slug: 'owner' },
      }] };
    });
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ id: 'key_inventory_private' }] }) });
    try {
      const response = await perform('list', 'org_target');
      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).not.toContain('key_inventory_private');
      expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(3);
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(mocks.info).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(failure === 'connection lost');
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['id', 'createdAt', 'updatedAt'] as const)('treats a direct membership missing %s as unavailable', async (field) => {
    const membership: Record<string, unknown> = {
      id: 'membership_current', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', userId: 'user_caller',
      organizationId: 'org_target', status: 'active', role: { slug: 'owner' },
    };
    delete membership[field];
    mocks.listOrganizationMemberships.mockResolvedValue({ data: [membership] });
    for (const operation of operations) expect((await perform(operation, 'org_target')).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { slug: null }, { slug: 7 }, { slug: '' }])('treats unusable direct membership role %j as unavailable', async (role) => {
    mocks.listOrganizationMemberships.mockResolvedValue({ data: [{
      id: 'membership_current', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      userId: 'user_caller', organizationId: 'org_target', status: 'active', role,
    }] });
    for (const operation of operations) expect((await perform(operation, 'org_target')).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('keeps concurrent requests isolated when the linked credential lookup completes first', async () => {
    const primaryStarted = Promise.withResolvers<void>();
    const releasePrimary = Promise.withResolvers<void>();
    mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => {
      if (userId === 'user_primary') {
        primaryStarted.resolve();
        await releasePrimary.promise;
        return { data: [{ id: `membership_${userId}_${organizationId}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', userId, organizationId, status: 'active', role: { slug: 'owner' } }] };
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
      expect(response.status, JSON.stringify(selection)).toBe(method === 'GET' ? 200 : 503);
      expect(mocks.listOrganizationMemberships).toHaveBeenLastCalledWith({ userId: 'user_caller', organizationId: 'org_target' });
      if (method === 'GET') expect(new URL(mocks.fetch.mock.lastCall![0]).pathname).toContain('/organizations/org_target/api_keys');
      else expect(mocks.fetch).not.toHaveBeenCalled();
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

  it('keeps the exact credential immutable across lookup and provider awaits while reading', async () => {
    const lookupStarted = Promise.withResolvers<void>();
    const releaseLookup = Promise.withResolvers<void>();
    const providerStarted = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    mocks.listOrganizationMemberships.mockImplementation(async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return { data: [{
        id: 'membership_linked', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        userId: 'user_linked', organizationId: 'org_target', status: 'active', role: { slug: 'owner' },
      }] };
    });
    mocks.fetch.mockImplementation(async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    const pending = perform('GET', { query: { org: 'org_target' } })
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
    expect((await pending).status).toBe(200);
    expect(mocks.listOrganizationMemberships.mock.calls).toEqual(Array.from({ length: 3 }, () => [{
      userId: 'user_linked', organizationId: 'org_target',
    }]));
    expect(mocks.queryWithTimeout.mock.calls.every(([, [userId]]) => userId === 'user_linked')).toBe(true);
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
