/** Mounted consumers with the real snapshot and organization resolvers. */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkOSUser } from '../../src/types.js';

const mocks = vi.hoisted(() => ({
  principal: undefined as WorkOSUser | undefined,
  boundedQuery: vi.fn(),
  memberships: vi.fn(),
  validateApiKey: vi.fn(),
  listProposals: vi.fn(),
  getProposal: vi.fn(),
  getClient: vi.fn(),
  isAdmin: vi.fn(),
  isModerator: vi.fn(),
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
  getClient: mocks.getClient,
}));
vi.mock('../../src/auth/workos-client.js', () => ({
  getAuthorizationEnforcementWorkos: () => ({ userManagement: { listOrganizationMemberships: mocks.memberships } }),
}));
vi.mock('../../src/db/community-mirror-db.js', () => ({
  CommunityMirrorDatabase: class {
    listProposals = mocks.listProposals;
    getProposalById = mocks.getProposal;
  },
}));
vi.mock('../../src/db/publisher-db.js', () => ({ PublisherDatabase: class {} }));
vi.mock('../../src/addie/admin-status-lookup.js', () => ({ isWebUserAAOAdmin: mocks.isAdmin }));
vi.mock('../../src/services/brand-logo-auth.js', () => ({ isRegistryModerator: mocks.isModerator }));
vi.mock('../../src/notifications/registry.js', () => ({}));
vi.mock('../../src/middleware/rate-limit.js', () => {
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  return { registryReadRateLimiter: pass, brandCreationRateLimiter: pass };
});

import { buildConformanceTokenRouter } from '../../src/conformance/token-route.js';
import { createCommunityMirrorRouter } from '../../src/routes/community-mirrors.js';
import { verifyConformanceToken } from '../../src/conformance/token.js';
import { loadAuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';
import { resolveCallerOrgId } from '../../src/routes/helpers/resolve-caller-org.js';

const ORG = 'org_pinnacle';
const OTHER_ORG = 'org_streamhaus';
const PROPOSAL_ID = '00000000-0000-4000-8000-000000000001';
const originalSecret = process.env.CONFORMANCE_JWT_SECRET;
let row: Record<string, unknown>;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/conformance', buildConformanceTokenRouter());
  return instance;
}

function mirrorApp(attachedOrganizationId?: string) {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/registry', createCommunityMirrorRouter({
    requireAuth: (req, _res, next) => {
      req.user = mocks.principal;
      if (attachedOrganizationId) Object.assign(req, { apiKey: { organizationId: attachedOrganizationId } });
      next();
    },
  }));
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
  mocks.listProposals.mockResolvedValue({ proposals: [{ id: PROPOSAL_ID }], total: 1 });
  mocks.getProposal.mockImplementation(async () => ({
    id: PROPOSAL_ID, proposed_by_user_id: mocks.principal?.id,
    proposed_by_organization_id: ORG, adagents_json: { private_proposal: true },
  }));
  // A canonical admin/moderator result must never rescue denied exact authority.
  mocks.isAdmin.mockResolvedValue(true);
  mocks.isModerator.mockResolvedValue(true);
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.CONFORMANCE_JWT_SECRET;
  else process.env.CONFORMANCE_JWT_SECRET = originalSecret;
});

describe.each([
  ['user_primary', 'user_linked'],
  ['user_linked', 'user_primary'],
])('community mirror proposals with authenticated %s attributed to %s', (authenticated, canonical) => {
  it.each(['no selection', 'no membership', 'canonical membership', 'conflict', 'stale epoch', 'unavailable'])(
    'denies list and detail for %s without canonical-user fallback', async denied => {
      await authenticate(authenticated, canonical, denied === 'no selection' ? null : ORG);
      if (denied === 'no membership') mocks.memberships.mockResolvedValue({ data: [] });
      if (denied === 'canonical membership') mocks.memberships.mockResolvedValue({
        data: [{ userId: canonical, organizationId: ORG, status: 'active', role: { slug: 'owner' } }],
      });
      if (denied === 'stale epoch') row.authorization_epoch = '8';
      if (denied === 'unavailable') mocks.boundedQuery.mockRejectedValue(new Error('database unavailable'));
      for (const path of ['/mirror-proposals', `/mirror-proposals/${PROPOSAL_ID}`]) {
        const pending = request(mirrorApp()).get(`/api/registry${path}`);
        if (denied === 'conflict') pending.set('X-Organization-Id', OTHER_ORG);
        const response = await pending;
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Community mirror proposal not found' });
      }
      expect(mocks.listProposals).not.toHaveBeenCalled();
      expect(mocks.getProposal).not.toHaveBeenCalled();
      expect(mocks.isAdmin).not.toHaveBeenCalled();
      expect(mocks.isModerator).not.toHaveBeenCalled();
    },
  );

  it('scopes authorized list/detail to the selected org and denies other-org or unscoped rows', async () => {
    await authenticate(authenticated, canonical);
    const instance = mirrorApp();
    expect((await request(instance).get('/api/registry/mirror-proposals')).status).toBe(200);
    expect(mocks.listProposals).toHaveBeenCalledWith(expect.objectContaining({ proposedByOrganizationId: ORG }));
    expect(mocks.listProposals.mock.calls[0][0].proposedByUserId).toBeUndefined();
    expect((await request(instance).get(`/api/registry/mirror-proposals/${PROPOSAL_ID}`)).status).toBe(200);
    for (const organizationId of [OTHER_ORG, null]) {
      mocks.getProposal.mockResolvedValue({
        id: PROPOSAL_ID, proposed_by_user_id: canonical, proposed_by_organization_id: organizationId,
      });
      expect((await request(instance).get(`/api/registry/mirror-proposals/${PROPOSAL_ID}`)).status).toBe(404);
    }
    expect(mocks.memberships.mock.calls.every(([input]) => input.userId === authenticated)).toBe(true);
  });

  it('rejects list/detail replay after revocation before reading proposals', async () => {
    await authenticate(authenticated, canonical);
    const instance = mirrorApp();
    for (const path of ['/mirror-proposals', `/mirror-proposals/${PROPOSAL_ID}`]) {
      expect((await request(instance).get(`/api/registry${path}`)).status).toBe(200);
    }
    row.authorization_epoch = '8';
    mocks.listProposals.mockClear();
    mocks.getProposal.mockClear();
    for (const path of ['/mirror-proposals', `/mirror-proposals/${PROPOSAL_ID}`]) {
      expect((await request(instance).get(`/api/registry${path}`)).status).toBe(404);
    }
    expect(mocks.listProposals).not.toHaveBeenCalled();
    expect(mocks.getProposal).not.toHaveBeenCalled();
  });

  it.each(['no selection', 'stale epoch', 'conflict'])('does not rescue %s with an attached API-key organization', async denied => {
    await authenticate(authenticated, canonical, denied === 'no selection' ? null : ORG);
    if (denied === 'stale epoch') row.authorization_epoch = '8';
    for (const path of ['/mirror-proposals', `/mirror-proposals/${PROPOSAL_ID}`]) {
      const pending = request(mirrorApp(ORG)).get(`/api/registry${path}`);
      if (denied === 'conflict') pending.set('X-Organization-Id', OTHER_ORG);
      expect((await pending).status).toBe(404);
    }
    expect(mocks.listProposals).not.toHaveBeenCalled();
    expect(mocks.getProposal).not.toHaveBeenCalled();
  });

  it('denies human manager fallback for queue, approve, reject, publish and retire', async () => {
    await authenticate(authenticated, canonical, null);
    const instance = mirrorApp();
    expect((await request(instance).get('/api/registry/mirror-proposals?review_queue=true')).status).toBe(403);
    for (const action of ['approve', 'reject']) {
      expect((await request(instance).post(`/api/registry/mirror-proposals/${PROPOSAL_ID}/${action}`).send({})).status).toBe(403);
    }
    expect((await request(instance).put('/api/registry/mirrors/example').send({})).status).toBe(403);
    expect((await request(instance).delete('/api/registry/mirrors/example')).status).toBe(403);
    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(mocks.isAdmin).not.toHaveBeenCalled();
    expect(mocks.isModerator).not.toHaveBeenCalled();
  });
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
