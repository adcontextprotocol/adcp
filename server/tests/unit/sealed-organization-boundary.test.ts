/** Mounted conformance route with the real snapshot and organization resolvers. */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkOSUser } from '../../src/types.js';

const mocks = vi.hoisted(() => ({
  principal: undefined as WorkOSUser | undefined,
  boundedQuery: vi.fn(),
  memberships: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = mocks.principal;
    next();
  },
  validateWorkOSApiKey: mocks.validateApiKey,
}));
vi.mock('../../src/db/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/db/client.js')>(),
  queryWithTimeout: mocks.boundedQuery,
}));
vi.mock('../../src/auth/workos-client.js', () => ({
  getAuthorizationEnforcementWorkos: () => ({ userManagement: { listOrganizationMemberships: mocks.memberships } }),
}));

import { buildConformanceTokenRouter } from '../../src/conformance/token-route.js';
import { verifyConformanceToken } from '../../src/conformance/token.js';
import { loadAuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';
import { resolveCallerOrgId } from '../../src/routes/helpers/resolve-caller-org.js';

const ORG = 'org_pinnacle';
const OTHER_ORG = 'org_streamhaus';
const originalSecret = process.env.CONFORMANCE_JWT_SECRET;
let row: Record<string, unknown>;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/conformance', buildConformanceTokenRouter());
  return instance;
}

async function authenticate(authenticatedUserId = 'user_primary', canonicalUserId = 'user_linked', organizationId: string | null = ORG) {
  row.authenticated_user_id = authenticatedUserId;
  row.canonical_user_id = canonicalUserId;
  const snapshot = await loadAuthorizationSnapshot(authenticatedUserId, organizationId);
  mocks.principal = {
    id: canonicalUserId,
    authWorkosUserId: authenticatedUserId,
    email: 'sam@pinnacle.example',
  };
  Object.defineProperty(mocks.principal, 'authorizationSnapshot', { value: snapshot });
  mocks.boundedQuery.mockClear();
}

function post() {
  return request(app()).post('/api/conformance/token').set('Authorization', 'Bearer sealed-session-fixture');
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CONFORMANCE_JWT_SECRET = 'sealed-organization-test-secret';
  mocks.principal = undefined;
  row = {
    in_recovery: false,
    authenticated_user_id: 'user_primary', canonical_user_id: 'user_linked', identity_id: 'identity_linked',
    authorization_epoch: '7', email: 'sam@pinnacle.example', email_verified: true,
    first_name: 'Sam', last_name: 'Adeyemi',
    grant_id: null, grant_organization_id: null, grant_role: null,
    grant_effective_from: null, grant_effective_until: null,
  };
  mocks.boundedQuery.mockImplementation(async () => ({ rows: [{ ...row }], rowCount: 1 }));
  mocks.memberships.mockImplementation(async ({ userId, organizationId }) => ({
    data: [{ id: 'membership_pinnacle', userId, organizationId, status: 'active', role: { slug: 'member' } }],
  }));
  mocks.validateApiKey.mockResolvedValue(null);
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.CONFORMANCE_JWT_SECRET;
  else process.env.CONFORMANCE_JWT_SECRET = originalSecret;
});

describe('sealed-session organization boundary on POST /api/conformance/token', () => {
  it.each([
    ['user_primary', 'user_linked'],
    ['user_linked', 'user_primary'],
  ])('uses the exact authenticated %s credential when person attribution is %s', async (authenticated, canonical) => {
    await authenticate(authenticated, canonical);
    const response = await post();
    expect(response.status).toBe(200);
    expect(verifyConformanceToken(response.body.token).sub).toBe(ORG);
    expect(mocks.memberships).toHaveBeenCalledExactlyOnceWith({ userId: authenticated, organizationId: ORG });
    expect(mocks.boundedQuery.mock.calls.every(([, parameters]) => parameters[0] === authenticated)).toBe(true);
  });

  it.each([
    ['user_primary', 'user_linked'],
    ['user_linked', 'user_primary'],
  ])('does not copy %s authority into authenticated %s', async (canonical, authenticated) => {
    await authenticate(authenticated, canonical);
    mocks.memberships.mockResolvedValue({
      data: [{ userId: canonical, organizationId: ORG, status: 'active', role: { slug: 'owner' } }],
    });
    const response = await post();
    expect(response.status).toBe(403);
    expect(response.body.token).toBeUndefined();
    expect(mocks.memberships).toHaveBeenCalledExactlyOnceWith({ userId: authenticated, organizationId: ORG });
  });

  it('requires explicit organization context even when the credential has a sole membership', async () => {
    await authenticate('user_primary', 'user_linked', null);
    const response = await post();
    expect(response.status).toBe(403);
    expect(response.body.token).toBeUndefined();
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('accepts an explicit request selection when authentication had no selected organization', async () => {
    await authenticate('user_primary', 'user_linked', null);
    const response = await post().send({ organization_id: ORG });
    expect(response.status).toBe(200);
    expect(verifyConformanceToken(response.body.token).sub).toBe(ORG);
  });

  it.each(['absent', 'unavailable'])('preserves an exact credential grant when WorkOS membership is %s', async state => {
    Object.assign(row, {
      grant_id: 'grant_exact', grant_organization_id: ORG, grant_role: 'member',
      grant_effective_from: '2026-01-01T00:00:00.000000Z',
    });
    await authenticate('user_linked', 'user_primary');
    if (state === 'absent') mocks.memberships.mockResolvedValue({ data: [] });
    else mocks.memberships.mockRejectedValue(new Error('provider unavailable'));
    const response = await post();
    expect(response.status).toBe(200);
    expect(verifyConformanceToken(response.body.token).sub).toBe(ORG);
    expect(mocks.boundedQuery.mock.calls.every(([, parameters]) => parameters[0] === 'user_linked')).toBe(true);
  });

  it.each(['id', 'authWorkosUserId'] as const)('rejects a snapshot transplanted to a different principal %s', async field => {
    await authenticate();
    mocks.principal![field] = 'user_other';
    const response = await post();
    expect(response.status).toBe(403);
    expect(response.body.token).toBeUndefined();
    expect(mocks.boundedQuery).not.toHaveBeenCalled();
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('checks path selectors populated after authentication middleware', async () => {
    await authenticate();
    const instance = express();
    // Authentication commonly runs before Express has matched a tenant route.
    instance.use((req, _res, next) => { req.user = mocks.principal; next(); });
    instance.get('/organizations/:orgId/check', async (req, res) => {
      const organizationId = await resolveCallerOrgId(req);
      res.status(organizationId ? 200 : 403).json({ organizationId });
    });
    expect((await request(instance).get(`/organizations/${ORG}/check`)).status).toBe(200);
    mocks.memberships.mockClear();
    const conflict = await request(instance).get(`/organizations/${OTHER_ORG}/check`);
    expect(conflict.status).toBe(403);
    expect(conflict.body.organizationId).toBeNull();
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('rejects a canonical user object without authenticated snapshot provenance', async () => {
    mocks.principal = { id: 'user_linked', email: 'sam@pinnacle.example' };
    const response = await post().send({ organization_id: ORG });
    expect(response.status).toBe(403);
    expect(response.body.token).toBeUndefined();
    expect(mocks.memberships).not.toHaveBeenCalled();
    expect(mocks.boundedQuery).not.toHaveBeenCalled();
  });

  it.each(['header', 'query', 'body', 'org_id alias'])('rejects a conflicting %s selector before provider authorization', async location => {
    await authenticate();
    const pending = post();
    if (location === 'header') pending.set('X-Organization-Id', OTHER_ORG);
    if (location === 'query') pending.query({ organization_id: OTHER_ORG });
    if (location === 'body') pending.send({ organizationId: OTHER_ORG });
    if (location === 'org_id alias') pending.send({ org_id: OTHER_ORG });
    const response = await pending;
    expect(response.status).toBe(403);
    expect(response.body.token).toBeUndefined();
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('accepts matching selectors across header, query, and body', async () => {
    await authenticate();
    const response = await post().set('X-Organization-Id', ORG).query({ org: ORG }).send({ organization_id: ORG });
    expect(response.status).toBe(200);
    expect(verifyConformanceToken(response.body.token).sub).toBe(ORG);
  });

  it.each(['epoch', 'identity', 'credential grant'])('rejects replay of a request snapshot after its %s changes', async changed => {
    if (changed === 'credential grant') {
      Object.assign(row, { grant_id: 'grant_original', grant_organization_id: ORG, grant_role: 'member', grant_effective_from: '2026-01-01T00:00:00.000000Z' });
    }
    await authenticate();
    expect((await post()).status).toBe(200);
    if (changed === 'epoch') row.authorization_epoch = '8';
    if (changed === 'identity') row.canonical_user_id = 'user_rebound';
    if (changed === 'credential grant') row.grant_id = 'grant_replacement';
    mocks.memberships.mockClear();
    const response = await post();
    expect(response.status).toBe(403);
    expect(response.body.token).toBeUndefined();
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('rejects a concurrent epoch change while WorkOS membership is in flight', async () => {
    await authenticate();
    mocks.memberships.mockImplementation(async ({ userId, organizationId }) => {
      row.authorization_epoch = '8';
      return { data: [{ userId, organizationId, status: 'active', role: { slug: 'member' } }] };
    });
    const response = await post();
    expect(response.status).toBe(403);
    expect(response.body.token).toBeUndefined();
  });

  it.each(['database', 'provider'])('fails closed without issuing a token during a %s outage', async source => {
    await authenticate();
    if (source === 'database') mocks.boundedQuery.mockRejectedValue(new Error('private database details'));
    else mocks.memberships.mockRejectedValue(new Error('private provider details'));
    const response = await post();
    expect(response.status).toBe(403);
    expect(response.body.token).toBeUndefined();
    expect(response.text).not.toContain('private');
  });
});
