import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';

const authority = vi.hoisted(() => ({ snapshot: vi.fn(), ban: vi.fn(), memberships: vi.fn(), errorLog: vi.fn() }));
vi.mock('../../src/db/user-authorization-snapshot-db.js', async importOriginal => ({
  ...await importOriginal<object>(), loadAuthorizationSnapshot: authority.snapshot,
}));
vi.mock('../../src/db/bans-db.js', () => ({ bansDb: { checkPlatformBanForUserAndOrg: authority.ban } }));
vi.mock('../../src/auth/workos-client.js', () => ({ getPipesWorkos: () => ({ userManagement: { listOrganizationMemberships: authority.memberships } }) }));
vi.mock('../../src/logger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/logger.js')>();
  return { ...actual, createLogger: (name: string) => name === 'training-buyer-oauth'
    ? { error: authority.errorLog } : actual.createLogger(name) };
});
import { createTrainingBuyerOAuthMiddleware, trainingBuyerOAuthConfig, trainingBuyerMetadata, trainingBuyerDocumentation, TRAINING_BUYER_RESOURCE } from '../../src/training-agent/buyer-oauth.js';
import { trainingBuyerAgentRegistry } from '../../src/training-agent/buyer-agent-registry.js';

const config = { issuer: 'https://auth.example.com', resource: TRAINING_BUYER_RESOURCE,
  organizationId: 'org_canary', metadataUrl: 'https://test-agent.adcontextprotocol.org/.well-known/oauth-protected-resource/sales/mcp' };
const snapshot = { authenticatedUserId: 'user_buyer', canonicalUserId: 'user_alias', identityId: 'identity1', bindingVersion: '11',
  selectedOrganizationId: 'org_canary', authorizationEpoch: '9007199254740993', credential: { email: 'buyer@example.com', emailVerified: true },
  credentialGrant: { id: 'grant1', organizationId: 'org_canary', role: 'admin', effectiveFrom: '2026-01-01T00:00:00Z', effectiveUntil: null } };
const member = { userId: 'user_buyer', organizationId: 'org_canary', status: 'active', role: { slug: 'admin' } };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let app: express.Express;
const fallback = vi.fn((_req, res, next) => { res.locals.trainingPrincipal = 'static:public'; next(); });
async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: config.issuer, aud: config.resource, sub: 'user_buyer', org_id: config.organizationId,
    client_id: 'client_buyer', sid: 'app_consent_buyer', scope: 'openid offline_access', iat: now, exp: now + 3600, ...overrides };
  for (const key of Object.keys(claims)) if ((claims as Record<string, unknown>)[key] === undefined) delete (claims as Record<string, unknown>)[key];
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'buyer' }).sign(keys.privateKey);
}
function buildApp(resolver: JWTVerifyGetKey = async () => keys.publicKey, access: 'sandbox' | 'private-reporting' = 'private-reporting') {
  const result = express(); result.use(express.json());
  result.use(createTrainingBuyerOAuthMiddleware(config, fallback, resolver, access));
  result.all('/operation', (req, res) => res.json({ principal: res.locals.trainingPrincipal, auth: (req as unknown as { auth: unknown }).auth }));
  return result;
}
beforeAll(async () => { keys = await generateKeyPair('RS256'); });
beforeEach(() => {
  vi.clearAllMocks(); authority.snapshot.mockResolvedValue(structuredClone(snapshot)); authority.ban.mockResolvedValue({ banned: false });
  authority.memberships.mockResolvedValue({ data: [structuredClone(member)] }); app = buildApp();
});

describe('private training buyer Connect authorization', () => {
  it('binds an authorized person to the organization and keeps the OAuth actor without a raw token', async () => {
    const signed = await token(); const result = await request(app).post('/operation').set('Authorization', `Bearer ${signed}`).send({});
    expect(result.status).toBe(200); expect(result.body.principal).toBe('workos:org_canary');
    expect(result.body.auth.extra.credential).toMatchObject({ kind: 'oauth', client_id: 'client_buyer' });
    expect(result.body.auth.extra.training_oauth_actor).toMatchObject({ user_id: 'user_buyer', organization_id: 'org_canary', authorization_epoch: snapshot.authorizationEpoch });
    expect(JSON.stringify(result.body)).not.toContain(signed);
    expect(authority.memberships).toHaveBeenCalledWith({ userId: 'user_buyer', organizationId: 'org_canary' });
    expect(authority.snapshot).toHaveBeenCalledTimes(2); expect(fallback).not.toHaveBeenCalled();
  });
  it.each([
    { aud: 'https://agenticadvertising.org/mcp' }, { iss: 'https://foreign.example.com' }, { exp: 1 }, { exp: undefined },
    { iat: undefined }, { sid: undefined }, { sub: 'client_machine' }, { grant_type: 'client_credentials' },
    { org_id: undefined }, { client_id: undefined }, { client_id: '' }, { exp: Math.floor(Date.now() / 1000) + 7200 },
  ])('rejects invalid identity or claims terminally: %j', async claims => {
    const result = await request(app).post('/operation').set('Authorization', `Bearer ${await token(claims)}`).send({});
    expect(result.status).toBe(401); expect(result.headers['www-authenticate']).toContain(config.metadataUrl);
    expect(authority.snapshot).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });
  it('requires sign-in and advertises the sales resource', async () => {
    const result = await request(app).get('/operation'); expect(result.status).toBe(401);
    expect(result.headers['www-authenticate']).toContain('resource_metadata='); expect(result.headers['cache-control']).toBe('no-store');
  });
  it('rejects a modified signature before any organization authority lookup', async () => {
    const parts = (await token()).split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    expect((await request(app).get('/operation').set('Authorization', `Bearer ${parts.join('.')}`)).status).toBe(401);
    expect(authority.snapshot).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });
  it('keeps sandbox bearer credentials on their existing path', async () => {
    expect((await request(app).get('/operation').set('Authorization', 'Bearer demo-kit-v1')).status).toBe(200);
    expect(fallback).toHaveBeenCalledOnce(); expect(authority.snapshot).not.toHaveBeenCalled();
  });
  it.each(['wrong-organization', 'conflicting-selection', 'inactive', 'foreign-user', 'member-role', 'local-member', 'missing-grant', 'banned', 'local-revocation'])('denies %s', async denial => {
    if (denial === 'inactive') authority.memberships.mockResolvedValue({ data: [{ ...member, status: 'inactive' }] });
    if (denial === 'foreign-user') authority.memberships.mockResolvedValue({ data: [{ ...member, userId: 'user_alias' }] });
    if (denial === 'member-role') authority.memberships.mockResolvedValue({ data: [{ ...member, role: { slug: 'member' } }] });
    if (denial === 'local-member') authority.snapshot.mockResolvedValue({ ...snapshot, credentialGrant: { ...snapshot.credentialGrant, role: 'member' } });
    if (denial === 'missing-grant') authority.snapshot.mockResolvedValue({ ...snapshot, credentialGrant: null });
    if (denial === 'banned') authority.ban.mockResolvedValue({ banned: true });
    if (denial === 'local-revocation') authority.snapshot.mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, authorizationEpoch: '2' });
    const result = await request(app).post('/operation').set('Authorization', `Bearer ${await token(denial === 'wrong-organization' ? { org_id: 'org_foreign' } : {})}`)
      .send(denial === 'conflicting-selection' ? { organization_id: 'org_foreign' } : {});
    expect(result.status).toBe(403); expect(fallback).not.toHaveBeenCalled();
    expect(result.headers['www-authenticate']).toContain('Bearer error="insufficient_scope"');
    expect(result.body).toEqual({ error: 'BUYER_ACCESS_DENIED',
      error_description: 'Private training buyer reporting requires an owner or admin of the configured canary organization. Use /sales/mcp for the OAuth sandbox.' });
    expect(result.headers['www-authenticate']).toContain(result.body.error_description);
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('denies deleted credentials without recreating local identity', async () => {
    authority.snapshot.mockResolvedValue(null);
    expect((await request(app).get('/operation').set('Authorization', `Bearer ${await token()}`)).status).toBe(401);
    expect(authority.memberships).not.toHaveBeenCalled();
  });
  it.each(['snapshot', 'ban', 'memberships', 'jwks'])('fails closed on %s outage without exposing credentials', async dependency => {
    const outage = Object.assign(new Error('secret=not-for-response'), { name: 'secret-error-name', code: 'secret-error-code' });
    if (dependency === 'jwks') app = buildApp(async () => { throw outage; });
    else authority[dependency as 'snapshot' | 'ban' | 'memberships'].mockRejectedValue(outage);
    const signed = await token();
    const result = await request(app).get('/operation').set('Authorization', `Bearer ${signed}`);
    expect(result.status).toBe(503); expect(JSON.stringify(result.body)).not.toContain('not-for-response'); expect(fallback).not.toHaveBeenCalled();
    const dependencyLabels = { snapshot: 'primary_authorization', ban: 'platform_ban', memberships: 'workos_membership', jwks: 'jwt_key_service' };
    expect(authority.errorLog).toHaveBeenCalledExactlyOnceWith({ dependency: dependencyLabels[dependency as keyof typeof dependencyLabels],
      code: 'BUYER_AUTHORIZATION_UNAVAILABLE' }, 'Training buyer authorization unavailable');
    expect(JSON.stringify(authority.errorLog.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(authority.errorLog.mock.calls)).not.toContain(signed);
  });
  it('rechecks membership after a token has already been accepted', async () => {
    const signed = await token(); expect((await request(app).get('/operation').set('Authorization', `Bearer ${signed}`)).status).toBe(200);
    authority.memberships.mockResolvedValue({ data: [] });
    expect((await request(app).get('/operation').set('Authorization', `Bearer ${signed}`)).status).toBe(403);
  });
  it('limits OAuth requests before primary/provider authority reads', async () => {
    const signed = await token();
    for (let i = 0; i < 60; i++) expect((await request(app).get('/operation').set('Authorization', `Bearer ${signed}`)).status).toBe(200);
    expect((await request(app).get('/operation').set('Authorization', `Bearer ${signed}`)).status).toBe(429);
    expect(authority.memberships).toHaveBeenCalledTimes(60); expect(authority.snapshot).toHaveBeenCalledTimes(120);
  });
});

describe('organization OAuth sales sandbox', () => {
  function membership(organizationId: string, localRole = 'member', providerRole = localRole) {
    authority.snapshot.mockResolvedValue({ ...snapshot, selectedOrganizationId: organizationId,
      credentialGrant: { ...snapshot.credentialGrant, organizationId, role: localRole } });
    authority.memberships.mockResolvedValue({ data: [{ ...member, organizationId, role: { slug: providerRole } }] });
    app = buildApp(undefined, 'sandbox');
  }
  async function authenticate(organizationId: string) {
    return request(app).get('/operation').set('Authorization', `Bearer ${await token({ org_id: organizationId })}`);
  }
  it.each(['owner', 'admin', 'member'])('admits a non-canary %s to an organization sandbox', async role => {
    membership('org_integrator', role);
    const result = await authenticate('org_integrator');
    expect(result.status).toBe(200);
    expect(result.body.principal).toBe('training-oauth:org_integrator');
    expect(result.body.auth.clientId).toBe(result.body.principal);
    expect(result.body.auth.extra.training_oauth_actor).toMatchObject({ organization_id: 'org_integrator', principal_id: result.body.principal });
    expect(authority.snapshot).toHaveBeenCalledTimes(2);
    expect(authority.snapshot).toHaveBeenCalledWith('user_buyer', 'org_integrator');
    expect(fallback).not.toHaveBeenCalled();
  });
  it.each([['member', 'member'], ['admin', 'member'], ['member', 'admin']])('isolates canary roles %s/%s from the private buyer', async (localRole, providerRole) => {
    membership(config.organizationId, localRole, providerRole);
    const result = await authenticate(config.organizationId);
    expect(result.status).toBe(200);
    expect(result.body.principal).toBe('training-oauth:org_canary');
  });
  it('preserves the private buyer for canary admins', async () => {
    membership(config.organizationId, 'admin');
    expect((await authenticate(config.organizationId)).body.principal).toBe('workos:org_canary');
  });
  it('admits ordinary organization members without a manually provisioned local grant', async () => {
    membership('org_integrator');
    authority.snapshot.mockResolvedValue({ ...snapshot, selectedOrganizationId: 'org_integrator', credentialGrant: null });
    const result = await authenticate('org_integrator');
    expect(result.status).toBe(200);
    expect(result.body.principal).toBe('training-oauth:org_integrator');
    expect(authority.memberships).toHaveBeenCalledWith({ userId: 'user_buyer', organizationId: 'org_integrator' });
  });
  it('demotes a revoked canary grant to the sandbox without retaining private authority', async () => {
    membership(config.organizationId, 'admin');
    const signed = await token();
    expect((await request(app).get('/operation').set('Authorization', `Bearer ${signed}`)).body.principal).toBe('workos:org_canary');
    authority.snapshot.mockResolvedValue({ ...snapshot, credentialGrant: null, authorizationEpoch: '2' });
    const sandbox = await request(app).get('/operation').set('Authorization', `Bearer ${signed}`);
    expect(sandbox.status).toBe(200);
    expect(sandbox.body.principal).toBe('training-oauth:org_canary');
    app = buildApp();
    expect((await request(app).get('/operation').set('Authorization', `Bearer ${signed}`)).status).toBe(403);
  });
  it.each(['inactive', 'unknown-role', 'banned', 'revoked', 'conflicting-selection'])('denies sandbox access when %s', async denial => {
    membership('org_integrator');
    if (denial === 'inactive') authority.memberships.mockResolvedValue({ data: [] });
    if (denial === 'unknown-role') authority.memberships.mockResolvedValue({ data: [{ ...member, organizationId: 'org_integrator', role: { slug: 'unknown' } }] });
    if (denial === 'banned') authority.ban.mockResolvedValue({ banned: true });
    if (denial === 'revoked') {
      const before = await authority.snapshot();
      authority.snapshot.mockResolvedValueOnce(before).mockResolvedValue({ ...before, authorizationEpoch: '2' });
    }
    const result = await request(app).post('/operation').set('Authorization', `Bearer ${await token({ org_id: 'org_integrator' })}`)
      .send(denial === 'conflicting-selection' ? { organization_id: config.organizationId } : {});
    expect(result.status).toBe(403);
    expect(result.headers['www-authenticate']).toContain('error="insufficient_scope"');
    expect(result.body.error_description).toContain('active membership');
    expect(fallback).not.toHaveBeenCalled();
  });
  it('partitions buyer-agent state by organization and private authority with the same OAuth client', async () => {
    async function agentFor(organizationId: string, role: string) {
      membership(organizationId, role);
      const result = await authenticate(organizationId);
      expect(result.status).toBe(200);
      const { extra } = result.body.auth;
      return trainingBuyerAgentRegistry.resolve({ credential: extra.credential, extra, input: {} });
    }
    const integrator = await agentFor('org_integrator', 'member');
    expect(integrator).not.toBeNull();
    expect(await agentFor('org_integrator', 'admin')).toEqual(integrator);
    expect((await agentFor('org_other', 'member'))?.agent_url).not.toBe(integrator?.agent_url);
    const privateBuyer = await agentFor(config.organizationId, 'admin');
    expect((await agentFor(config.organizationId, 'member'))?.agent_url).not.toBe(privateBuyer?.agent_url);
  });
});

describe('buyer OAuth configuration and metadata', () => {
  const env = { TRAINING_BUYER_OAUTH_ENABLED: 'true', TRAINING_BUYER_OAUTH_ISSUER: config.issuer, TRAINING_BUYER_OAUTH_ORGANIZATION_ID: config.organizationId };
  it('is disabled by default and pins the sales resource when enabled', () => {
    expect(trainingBuyerOAuthConfig({})).toBeUndefined();
    expect(trainingBuyerOAuthConfig({ ...env, TRAINING_BUYER_OAUTH_ENABLED: 'false' })).toBeUndefined();
    const configured = trainingBuyerOAuthConfig(env)!;
    expect(trainingBuyerMetadata(configured)).toMatchObject({ resource: config.resource, authorization_servers: [config.issuer],
      resource_name: 'AdCP sales training sandbox', resource_documentation: 'https://test-agent.adcontextprotocol.org/sales/oauth' });
  });
  it('serves connection instructions that describe the public and private access boundaries', () => {
    const instructions = trainingBuyerDocumentation(config);
    expect(instructions).toContain(config.resource);
    expect(instructions).toContain(config.issuer);
    expect(instructions).toContain(config.metadataUrl);
    expect(instructions).toContain('PKCE');
    expect(instructions).toContain('active owner, admin, or member role');
    expect(instructions).toContain('403 BUYER_ACCESS_DENIED');
  });
  it.each([
    { TRAINING_BUYER_OAUTH_ENABLED: '1' }, { TRAINING_BUYER_OAUTH_ISSUER: '' }, { TRAINING_BUYER_OAUTH_ISSUER: 'http://auth.example.com' },
    { TRAINING_BUYER_OAUTH_ISSUER: 'https://auth.example.com/path' }, { TRAINING_BUYER_OAUTH_ORGANIZATION_ID: '' },
    { TRAINING_BUYER_OAUTH_RESOURCE: 'https://agenticadvertising.org/mcp' }, { TRAINING_REPORTING_GCS_CANARY_PRINCIPAL: 'workos:org_other' },
  ])('rejects partial or inconsistent configuration: %j', override => { expect(() => trainingBuyerOAuthConfig({ ...env, ...override })).toThrow(); });
});
