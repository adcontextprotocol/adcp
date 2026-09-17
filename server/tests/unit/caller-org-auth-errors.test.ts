import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(), jwtVerify: vi.fn(), decodeJwt: vi.fn(), query: vi.fn(), listAllAgents: vi.fn(),
  getProfileByDomain: vi.fn(), issueDomainClaim: vi.fn(),
  listProposals: vi.fn(), getProposalById: vi.fn(), submitProposal: vi.fn(),
}));
vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test';
  process.env.WORKOS_CLIENT_ID = 'client_test';
});
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/middleware/auth.js')>(),
  validateWorkOSApiKey: mocks.validateApiKey,
}));
vi.mock('jose', async (importOriginal) => ({
  ...await importOriginal<typeof import('jose')>(),
  createRemoteJWKSet: () => vi.fn(),
  decodeJwt: mocks.decodeJwt,
  jwtVerify: mocks.jwtVerify,
}));
vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/db/client.js')>(),
  query: mocks.query,
}));
vi.mock('../../src/db/member-db.js', () => ({
  MemberDatabase: class { getProfileByDomain = mocks.getProfileByDomain; },
}));
vi.mock('../../src/db/community-mirror-db.js', () => ({
  CommunityMirrorDatabase: class {
    listProposals = mocks.listProposals;
    getProposalById = mocks.getProposalById;
    submitProposal = mocks.submitProposal;
  },
}));
vi.mock('../../src/services/brand-logo-auth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/brand-logo-auth.js')>(),
  isRegistryModerator: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/addie/admin-status-lookup.js', () => ({
  isWebUserAAOAdmin: vi.fn().mockResolvedValue(false),
  isAuthenticatedUserAAOAdmin: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/middleware/rate-limit.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  return Object.fromEntries(Object.entries(original).map(([name, value]) => [name, name.endsWith('RateLimiter') ? pass : value]));
});

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';
import { createCommunityMirrorRouter } from '../../src/routes/community-mirrors.js';
import { stopAuthTimers } from '../../src/middleware/auth.js';

const attachedCookieUser: express.RequestHandler = (req, _res, next) => {
  // Exercise the resolver boundary after another middleware attached a user.
  req.user = { id: 'cookie_user', email: 'cookie@example.test' } as typeof req.user;
  next();
};
function app() {
  const application = express();
  application.use(express.json());
  const config = {
    brandManager: {}, brandDb: {}, propertyDb: { issueDomainClaim: mocks.issueDomainClaim },
    adagentsManager: {}, healthChecker: {}, capabilityDiscovery: {},
    crawler: { getFederatedIndex: () => ({ listAllAgents: mocks.listAllAgents }) },
    registryRequestsDb: { trackRequest: async () => {}, markResolved: async () => true },
    requireAuth: attachedCookieUser, optionalAuth: attachedCookieUser,
  } as unknown as RegistryApiConfig;
  application.use('/api', createRegistryApiRouter(config));
  application.use('/api/registry', createCommunityMirrorRouter({ requireAuth: attachedCookieUser }));
  return application;
}
const application = app();
afterAll(stopAuthTimers);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateApiKey.mockResolvedValue(null);
  mocks.decodeJwt.mockImplementation((token: string) => {
    if (token === 'eyJmalformed') {
      throw Object.assign(new Error('Malformed JWT'), { code: 'ERR_JWT_INVALID' });
    }
    return { iss: 'https://auth.example.test/user_management/client_test' };
  });
  mocks.jwtVerify.mockRejectedValue(Object.assign(new Error('Expired token'), { code: 'ERR_JWT_EXPIRED' }));
  mocks.query.mockResolvedValue({ rows: [{ primary_organization_id: 'org_cookie', joins_valid: true }] });
  mocks.getProfileByDomain.mockResolvedValue(null);
  mocks.listAllAgents.mockResolvedValue([]);
  mocks.getProposalById.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', proposed_by_user_id: 'cookie_user' });
});

describe.each([
  ['agent listing', 'get', '/api/registry/agents'],
  ['operator listing', 'get', '/api/registry/operator?domain=example.test'],
  ['domain claim', 'post', '/api/properties/hosted/example.test/claim'],
  ['proposal listing', 'get', '/api/registry/mirror-proposals'],
  ['proposal detail', 'get', '/api/registry/mirror-proposals/11111111-1111-4111-8111-111111111111'],
  ['proposal submission', 'put', '/api/registry/mirrors/test-platform'],
] as const)('%s preserves bearer authorization failures', (_name, method, path) => {
  it.each([
    ['Authorization', 'Bearer sk_revoked'],
    ['authorization', 'bearer wrong-static-token'],
    ['AUTHORIZATION', 'BEARER eyJexpired.payload.sig'],
    ['aUtHoRiZaTiOn', 'bEaReR\t sk_revoked'],
    ['Authorization', 'Bearer'],
    ['Authorization', 'Bearer malformed opaque token'],
    ['Authorization', 'Bearer eyJmalformed'],
    ['Authorization', 'Bearer sk_revoked, Bearer sk_other'],
  ])(
    'returns 401 for %s: %s instead of anonymous or cookie authority', async (header, authorization) => {
      const response = await request(application)[method](path)
        .set(header, authorization)
        .set('Cookie', 'wos-session=verified-cookie')
        .send({});
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'invalid_bearer_token' });
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.listAllAgents).not.toHaveBeenCalled();
      expect(mocks.listProposals).not.toHaveBeenCalled();
      expect(mocks.submitProposal).not.toHaveBeenCalled();
      expect(mocks.issueDomainClaim).not.toHaveBeenCalled();
    },
  );
  it.each(['Bearer sk_unavailable', 'Bearer eyJunavailable.payload.sig'])(
    'returns 503 for unavailable %s instead of 500 or anonymous access', async (authorization) => {
      mocks.validateApiKey.mockRejectedValue(new Error('Provider unavailable'));
      mocks.jwtVerify.mockRejectedValue(new Error('JWKS unavailable'));
      const response = await request(application)[method](path)
        .set('Authorization', authorization)
        .set('Cookie', 'wos-session=verified-cookie')
        .send({});
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'authorization_unavailable' });
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.listAllAgents).not.toHaveBeenCalled();
      expect(mocks.listProposals).not.toHaveBeenCalled();
      expect(mocks.submitProposal).not.toHaveBeenCalled();
      expect(mocks.issueDomainClaim).not.toHaveBeenCalled();
    },
  );
});

it('preserves an API-key provider/request organization conflict as 403', async () => {
  mocks.validateApiKey.mockResolvedValue({ organizationId: 'org_provider' });

  const response = await request(application)
    .get('/api/registry/agents?organizationId=org_request')
    .set('Authorization', 'bEaReR\tsk_live');

  expect(response.status).toBe(403);
  expect(response.body).toEqual({ error: 'organization_selection_conflict' });
  expect(mocks.listAllAgents).not.toHaveBeenCalled();
});

it('does not let spoofed authorization headers replace an invalid selected bearer', async () => {
  mocks.validateApiKey.mockImplementation(async (req: express.Request) => (
    req.headers.authorization === 'Bearer sk_other' ? { organizationId: 'org_other' } : null
  ));

  const response = await request(application)
    .get('/api/registry/agents')
    .set('Authorization', 'Bearer invalid-selected-token')
    .set('X-Authorization', 'Bearer sk_other')
    .set('X-Forwarded-Authorization', 'Bearer sk_other')
    .set('Cookie', 'wos-session=verified-cookie');

  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: 'invalid_bearer_token' });
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.listAllAgents).not.toHaveBeenCalled();
});

it.each([undefined, 'Basic dXNlcjpwYXNz'])('preserves cookie-only resolution when no Bearer is selected: %s', async (authorization) => {
  mocks.issueDomainClaim.mockResolvedValue({ token: 'claim_cookie', lockedToOrgId: null });
  const claim = request(application)
    .post('/api/properties/hosted/example.test/claim')
    .set('Cookie', 'wos-session=verified-cookie');
  if (authorization !== undefined) claim.set('Authorization', authorization);

  const response = await claim.send({});

  expect(response.status).toBe(200);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('primary_organization_id'), ['cookie_user']);
  expect(mocks.issueDomainClaim).toHaveBeenCalledWith('example.test', 'org_cookie');
  expect(mocks.jwtVerify).not.toHaveBeenCalled();
  expect(mocks.validateApiKey).not.toHaveBeenCalled();
});
