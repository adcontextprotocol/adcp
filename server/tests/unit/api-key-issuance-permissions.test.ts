import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  listOrganizationMemberships: vi.fn(),
  fetch: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_api_key_issuance';
  process.env.WORKOS_CLIENT_ID = 'client_test_api_key_issuance';
  process.env.WORKOS_COOKIE_PASSWORD =
    'test-cookie-password-at-least-32-characters';
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    userManagement = {
      listOrganizationMemberships: mocks.listOrganizationMemberships,
    };
  },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  DEV_USERS: {},
  isDevModeEnabled: () => false,
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 'user_caller',
      email: 'caller@example.test',
      emailVerified: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    next();
  },
}));

const { createApiKeysRouter } = await import('../../src/routes/api-keys.js');

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

function setMembership(
  role: 'owner' | 'admin' | 'member',
  status: 'active' | 'pending' | 'inactive' = 'active',
) {
  mocks.listOrganizationMemberships.mockResolvedValue({
    data: [
      {
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
      const [, options] = mocks.fetch.mock.calls[0] as [string, RequestInit];
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
