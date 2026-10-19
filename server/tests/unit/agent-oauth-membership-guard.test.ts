import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { PendingWebFlow, PendingWebFlowStore } from '@adcp/sdk/auth';

const workosMocks = vi.hoisted(() => ({
  listOrganizationMemberships: vi.fn(),
}));
const sdkMocks = vi.hoisted(() => {
  class OAuthError extends Error {
    constructor(message = 'OAuth error', public code = 'oauth_error', public agentId?: string) {
      super(message);
      this.name = 'OAuthError';
    }
  }
  return {
    startWebOAuthFlow: vi.fn(),
    completeWebOAuthFlow: vi.fn(),
    discoverOAuthMetadata: vi.fn(),
    safeReturnTo: vi.fn((value: string) => (value.startsWith('/') ? value : undefined)),
    OAuthError,
    AgentVanishedDuringFlowError: class AgentVanishedDuringFlowError extends OAuthError {},
    ConfidentialClientNotAllowedError: class ConfidentialClientNotAllowedError extends OAuthError {},
    InvalidOrExpiredFlowError: class InvalidOrExpiredFlowError extends OAuthError {},
    ProtectedResourceMetadataError: class ProtectedResourceMetadataError extends OAuthError {},
    StateMismatchError: class StateMismatchError extends OAuthError {},
    TokenExchangeError: class TokenExchangeError extends OAuthError {
      oauthErrorCode?: string;
    },
  };
});
const mcpAuthMocks = vi.hoisted(() => ({
  discoverAuthorizationServerMetadata: vi.fn(),
  discoverOAuthProtectedResourceMetadata: vi.fn(),
}));
const mcpServerAuthMocks = vi.hoisted(() => {
  class OAuthError extends Error {
    static errorCode = 'server_error';
    get errorCode() {
      return (this.constructor as typeof OAuthError).errorCode;
    }
  }
  return { OAuthError };
});
const agentContextDbMocks = vi.hoisted(() => ({
  instance: {
    getById: vi.fn(),
    getOAuthClient: vi.fn(),
    clearOAuthClient: vi.fn(),
    removeOAuthTokens: vi.fn(),
    hasValidOAuthTokens: vi.fn(),
  },
}));
const adapterMocks = vi.hoisted(() => ({
  pendingFlowStore: {
    put: vi.fn(),
    consume: vi.fn(),
  },
  agentStorage: {
    loadAgent: vi.fn(),
  },
  createWebOAuthAdapters: vi.fn(),
}));

vi.mock('@adcp/sdk/auth', () => ({
  startWebOAuthFlow: sdkMocks.startWebOAuthFlow,
  completeWebOAuthFlow: sdkMocks.completeWebOAuthFlow,
  safeReturnTo: sdkMocks.safeReturnTo,
  discoverOAuthMetadata: sdkMocks.discoverOAuthMetadata,
  OAuthError: sdkMocks.OAuthError,
  AgentVanishedDuringFlowError: sdkMocks.AgentVanishedDuringFlowError,
  ConfidentialClientNotAllowedError: sdkMocks.ConfidentialClientNotAllowedError,
  InvalidOrExpiredFlowError: sdkMocks.InvalidOrExpiredFlowError,
  ProtectedResourceMetadataError: sdkMocks.ProtectedResourceMetadataError,
  StateMismatchError: sdkMocks.StateMismatchError,
  TokenExchangeError: sdkMocks.TokenExchangeError,
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverAuthorizationServerMetadata: mcpAuthMocks.discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata: mcpAuthMocks.discoverOAuthProtectedResourceMetadata,
}));

vi.mock('@modelcontextprotocol/sdk/server/auth/errors.js', () => ({
  OAuthError: mcpServerAuthMocks.OAuthError,
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getWorkos: () => ({
    userManagement: {
      listOrganizationMemberships: workosMocks.listOrganizationMemberships,
    },
  }),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_123', email: 'oauth-unit@test.com' };
    next();
  },
}));

vi.mock('../../src/db/agent-context-db.js', () => ({
  AgentContextDatabase: vi.fn(function AgentContextDatabase() {
    return agentContextDbMocks.instance;
  }),
}));

vi.mock('../../src/routes/helpers/web-oauth-stores.js', () => ({
  AgentOAuthPendingFlowStore: class AgentOAuthPendingFlowStore {
    cleanupExpired() {
      return Promise.resolve(0);
    }
  },
  createWebOAuthAdapters: adapterMocks.createWebOAuthAdapters,
}));

import {
  buildDurableOAuthScopeHint,
  createAgentOAuthRouter,
  createMembershipGuardedPendingFlowStore,
  isAgentSideOAuthError,
} from '../../src/routes/agent-oauth.js';
import { oauthSafeFetch } from '../../src/utils/oauth-safe-fetch.js';

const TEST_USER_ID = 'user_123';
const TEST_ORG_ID = 'org_123';
const AGENT_CONTEXT_ID = '11111111-1111-4111-8111-111111111111';
const TEST_AGENT_URL = 'https://agent.example.com/mcp';

function stateBinding(state: string): string {
  return `v1.${Buffer.from(state, 'utf8').toString('base64url')}`;
}

function makeApp(stateCookie?: string) {
  const app = express();
  if (stateCookie) {
    app.use((req, _res, next) => {
      req.cookies = { adcp_oauth_state: stateCookie };
      next();
    });
  }
  app.use('/api/oauth/agent', createAgentOAuthRouter());
  return app;
}

beforeEach(() => {
  workosMocks.listOrganizationMemberships.mockReset();
  sdkMocks.startWebOAuthFlow.mockReset();
  sdkMocks.completeWebOAuthFlow.mockReset();
  sdkMocks.discoverOAuthMetadata.mockReset();
  sdkMocks.safeReturnTo.mockClear();
  mcpAuthMocks.discoverAuthorizationServerMetadata.mockReset();
  mcpAuthMocks.discoverOAuthProtectedResourceMetadata.mockReset();
  agentContextDbMocks.instance.getById.mockReset();
  agentContextDbMocks.instance.getOAuthClient.mockReset();
  agentContextDbMocks.instance.clearOAuthClient.mockReset();
  agentContextDbMocks.instance.removeOAuthTokens.mockReset();
  agentContextDbMocks.instance.hasValidOAuthTokens.mockReset();
  adapterMocks.pendingFlowStore.put.mockReset();
  adapterMocks.pendingFlowStore.consume.mockReset();
  adapterMocks.agentStorage.loadAgent.mockReset();
  adapterMocks.createWebOAuthAdapters.mockReset();

  workosMocks.listOrganizationMemberships.mockResolvedValue({
    data: [{ userId: TEST_USER_ID, organizationId: TEST_ORG_ID, status: 'active' }],
  });
  agentContextDbMocks.instance.getById.mockResolvedValue({
    id: AGENT_CONTEXT_ID,
    organization_id: TEST_ORG_ID,
    agent_url: TEST_AGENT_URL,
  });
  agentContextDbMocks.instance.getOAuthClient.mockResolvedValue(null);
  agentContextDbMocks.instance.hasValidOAuthTokens.mockReturnValue(false);
  adapterMocks.createWebOAuthAdapters.mockReturnValue({
    pendingFlowStore: adapterMocks.pendingFlowStore,
    agentStorage: adapterMocks.agentStorage,
  });
  adapterMocks.agentStorage.loadAgent.mockResolvedValue({
    id: AGENT_CONTEXT_ID,
    name: 'Test Agent',
    agent_uri: TEST_AGENT_URL,
    protocol: 'mcp',
  });
  sdkMocks.startWebOAuthFlow.mockResolvedValue({
    authorizationUrl: 'https://auth.example.com/authorize',
    state: 'state_123',
  });
  mcpAuthMocks.discoverOAuthProtectedResourceMetadata.mockResolvedValue({
    resource: TEST_AGENT_URL,
    scopes_supported: ['openid', 'profile'],
    authorization_servers: ['https://auth.example.com'],
  });
  mcpAuthMocks.discoverAuthorizationServerMetadata.mockResolvedValue({
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    scopes_supported: ['openid', 'profile', 'offline_access'],
  });
});

function makeFlow(overrides: Partial<PendingWebFlow> = {}): PendingWebFlow {
  return {
    state: 'state_123',
    agentId: 'agent_ctx_123',
    agentUrl: 'https://agent.example.com/mcp',
    codeVerifier: 'verifier',
    redirectUri: 'https://app.example.com/api/oauth/agent/callback',
    authorizationServerUrl: 'https://auth.example.com',
    clientInformation: { client_id: 'client_123' } as any,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-01T00:10:00Z'),
    carry: { organization_id: 'org_123' },
    ...overrides,
  };
}

function makeStore(flow: PendingWebFlow | null): PendingWebFlowStore {
  return {
    put: vi.fn(),
    consume: vi.fn().mockResolvedValue(flow),
  };
}

describe('createMembershipGuardedPendingFlowStore', () => {
  beforeEach(() => {
    workosMocks.listOrganizationMemberships.mockReset();
  });

  it('returns the consumed flow when the callback user is still active in the flow org', async () => {
    const flow = makeFlow();
    const store = makeStore(flow);
    workosMocks.listOrganizationMemberships.mockResolvedValueOnce({
      data: [{ userId: 'user_123', organizationId: 'org_123', status: 'active' }],
    });

    const guarded = createMembershipGuardedPendingFlowStore(store, 'user_123');

    await expect(guarded.consume('state_123')).resolves.toBe(flow);
    expect(workosMocks.listOrganizationMemberships).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_123',
      organizationId: 'org_123',
      statuses: ['active'],
    }));
  });

  it('returns null before token exchange when the callback user is not active in the flow org', async () => {
    const store = makeStore(makeFlow());
    workosMocks.listOrganizationMemberships.mockResolvedValueOnce({ data: [] });

    const guarded = createMembershipGuardedPendingFlowStore(store, 'user_123');

    await expect(guarded.consume('state_123')).resolves.toBeNull();
  });

  it('rejects before token exchange when WorkOS membership verification fails', async () => {
    const store = makeStore(makeFlow());
    workosMocks.listOrganizationMemberships.mockRejectedValueOnce(new Error('workos unavailable'));

    const guarded = createMembershipGuardedPendingFlowStore(store, 'user_123');

    await expect(guarded.consume('state_123')).rejects.toThrow('workos unavailable');
  });
});

describe('GET /api/oauth/agent/start durable scope hint', () => {
  it('passes PRM scopes plus offline_access as authorization and registration scope', async () => {
    const res = await request(makeApp())
      .get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://auth.example.com/authorize');
    const stateCookie = res.headers['set-cookie']?.find((cookie: string) =>
      cookie.startsWith('adcp_oauth_state='),
    );
    expect(stateCookie).toContain(`adcp_oauth_state=${stateBinding('state_123')}`);
    expect(stateCookie).not.toContain('adcp_oauth_state=state_123');
    expect(mcpAuthMocks.discoverOAuthProtectedResourceMetadata).toHaveBeenCalledWith(
      TEST_AGENT_URL,
      undefined,
      oauthSafeFetch,
    );
    expect(mcpAuthMocks.discoverAuthorizationServerMetadata).toHaveBeenCalledWith(
      'https://auth.example.com',
      { fetchFn: oauthSafeFetch },
    );
    expect(sdkMocks.startWebOAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ id: AGENT_CONTEXT_ID, agent_uri: TEST_AGENT_URL }),
      fetch: oauthSafeFetch,
      scopeHint: 'openid profile offline_access',
      clientMetadata: { scope: 'openid profile offline_access' },
      carry: expect.objectContaining({
        organization_id: TEST_ORG_ID,
        user_id: TEST_USER_ID,
      }),
    }));
  });

  it('does not request offline_access when the authorization server explicitly omits it', async () => {
    mcpAuthMocks.discoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
      resource: TEST_AGENT_URL,
      scopes_supported: ['openid'],
      authorization_servers: ['https://auth.example.com'],
    });
    mcpAuthMocks.discoverAuthorizationServerMetadata.mockResolvedValueOnce({
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      scopes_supported: ['openid', 'profile'],
    });

    await request(makeApp())
      .get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID })
      .expect(302);

    expect(sdkMocks.startWebOAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
      scopeHint: 'openid',
      clientMetadata: { scope: 'openid' },
    }));
  });

  it('requests offline_access when PRM is absent and AS metadata does not reject it', async () => {
    mcpAuthMocks.discoverOAuthProtectedResourceMetadata.mockRejectedValueOnce(
      new Error('Resource server does not implement OAuth 2.0 Protected Resource Metadata.'),
    );
    mcpAuthMocks.discoverAuthorizationServerMetadata.mockResolvedValueOnce(undefined);

    await request(makeApp())
      .get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID })
      .expect(302);

    expect(mcpAuthMocks.discoverAuthorizationServerMetadata).toHaveBeenCalledWith(
      TEST_AGENT_URL,
      { fetchFn: oauthSafeFetch },
    );
    expect(sdkMocks.startWebOAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
      scopeHint: 'offline_access',
      clientMetadata: { scope: 'offline_access' },
    }));
  });

  it('does not follow PRM authorization_servers when the PRM resource is not allowed', async () => {
    mcpAuthMocks.discoverOAuthProtectedResourceMetadata.mockResolvedValueOnce({
      resource: 'https://evil.example.com/mcp',
      scopes_supported: ['openid'],
      authorization_servers: ['https://auth.example.com'],
    });

    await request(makeApp())
      .get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID })
      .expect(302);

    expect(mcpAuthMocks.discoverAuthorizationServerMetadata).not.toHaveBeenCalled();
    const opts = sdkMocks.startWebOAuthFlow.mock.calls[0][0];
    expect(opts).not.toHaveProperty('scopeHint');
    expect(opts).not.toHaveProperty('clientMetadata');
  });
});

describe('fresh owner OAuth recovery identity', () => {
  it.each(['inactive-membership', 'missing-context'] as const)('refuses fresh recovery for %s before SDK or adapter work', async denial => {
    if (denial === 'inactive-membership') {
      workosMocks.listOrganizationMemberships.mockResolvedValueOnce({ data: [] });
    } else {
      agentContextDbMocks.instance.getById.mockResolvedValueOnce(null);
    }
    await request(makeApp()).get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID, fresh: '1' })
      .expect(denial === 'inactive-membership' ? 403 : 404);
    expect(adapterMocks.createWebOAuthAdapters).not.toHaveBeenCalled();
    expect(adapterMocks.agentStorage.loadAgent).not.toHaveBeenCalled();
    expect(sdkMocks.startWebOAuthFlow).not.toHaveBeenCalled();
    expect(mcpAuthMocks.discoverOAuthProtectedResourceMetadata).not.toHaveBeenCalled();
    expect(agentContextDbMocks.instance.clearOAuthClient).not.toHaveBeenCalled();
    expect(agentContextDbMocks.instance.removeOAuthTokens).not.toHaveBeenCalled();
  });

  it('captures the authorized context/org/URL without clearing the old grant for a stale redirect', async () => {
    agentContextDbMocks.instance.getOAuthClient.mockResolvedValueOnce({
      client_id: 'legacy-client', registered_redirect_uri: 'https://old.example.test/callback',
    });
    await request(makeApp()).get('/api/oauth/agent/start').query({ agent_context_id: AGENT_CONTEXT_ID, fresh: '1' }).expect(302);
    expect(agentContextDbMocks.instance.clearOAuthClient).not.toHaveBeenCalled();
    expect(agentContextDbMocks.instance.removeOAuthTokens).not.toHaveBeenCalled();
    expect(adapterMocks.createWebOAuthAdapters).toHaveBeenCalledWith(expect.objectContaining({
      userId: TEST_USER_ID,
      ownerStart: { id: AGENT_CONTEXT_ID, organizationId: TEST_ORG_ID, agentUrl: TEST_AGENT_URL, fresh: true },
      authorize: expect.any(Function),
    }));
  });
});

describe('controlled owner reauthorization recovery', () => {
  it('offers explicit fresh recovery only for a context already authorized by the start handler', async () => {
    sdkMocks.startWebOAuthFlow.mockRejectedValueOnce(Object.assign(new sdkMocks.OAuthError(), {
      code: 'oauth_issuer_binding_required', message: 'Owner sign-in needed',
    }));
    const result = await request(makeApp()).get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID, return_to: '/dashboard?tab=agents' }).expect(302);
    const target = new URL(result.headers.location, 'https://buyer.example.test');
    expect(target.pathname).toBe('/oauth-complete.html');
    expect(target.searchParams.get('agent_context_id')).toBe(AGENT_CONTEXT_ID);
    expect(target.searchParams.get('return_to')).toBe('/dashboard?tab=agents');
    expect(agentContextDbMocks.instance.clearOAuthClient).not.toHaveBeenCalled();
    expect(agentContextDbMocks.instance.removeOAuthTokens).not.toHaveBeenCalled();
  });
});

describe('OAuth public failure redaction', () => {
  const privateDetails = 'synthetic-client-secret=hidden; SELECT oauth_refresh_token FROM tenant_customer; ECONNRESET 10.0.0.23:5432';

  it.each(['unexpected', 'sdk-agent', 'mcp-agent'] as const)('keeps %s start diagnostics out of the public redirect', async kind => {
    const failure = kind === 'sdk-agent' ? new sdkMocks.OAuthError(privateDetails)
      : kind === 'mcp-agent' ? new mcpServerAuthMocks.OAuthError(privateDetails) : new Error(privateDetails);
    sdkMocks.startWebOAuthFlow.mockRejectedValueOnce(failure);
    const result = await request(makeApp()).get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID }).expect(302);
    const target = new URL(result.headers.location, 'https://buyer.example.test');
    expect(target.searchParams.get('error')).toBe(kind === 'unexpected'
      ? 'Unable to start sign-in. Please try again.' : 'The agent authorization server could not start sign-in.');
    expect(target.searchParams.get('code')).toBe('oauth_start_failed');
    expect(decodeURIComponent(result.headers.location)).not.toContain(privateDetails);
    expect(target.searchParams.has('agent_context_id')).toBe(false);
  });

  it.each(['owner_reauthorization_required', 'oauth_issuer_binding_required', 'oauth_issuer_required', 'oauth_issuer_mismatch'])('uses app-owned %s recovery copy without upstream details', async code => {
    sdkMocks.startWebOAuthFlow.mockRejectedValueOnce(new sdkMocks.OAuthError(privateDetails, code));
    const result = await request(makeApp()).get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID, return_to: '/dashboard?tab=agents' }).expect(302);
    const target = new URL(result.headers.location, 'https://buyer.example.test');
    expect(target.searchParams.get('code')).toBe(code);
    expect(target.searchParams.get('error')).toBe('Start a new sign-in to authorize this agent.');
    expect(target.searchParams.get('agent_context_id')).toBe(AGENT_CONTEXT_ID);
    expect(target.searchParams.get('return_to')).toBe('/dashboard?tab=agents');
    expect(decodeURIComponent(result.headers.location)).not.toContain(privateDetails);
  });

  it.each(['owner_reauthorization_required', 'oauth_issuer_binding_required', 'oauth_issuer_required', 'oauth_issuer_mismatch'])('does not offer another fresh retry after a fresh %s failure', async code => {
    sdkMocks.startWebOAuthFlow.mockRejectedValueOnce(new sdkMocks.OAuthError(privateDetails, code));
    const result = await request(makeApp()).get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID, fresh: '1', return_to: '/dashboard' }).expect(302);
    const target = new URL(result.headers.location, 'https://buyer.example.test');
    expect(target.searchParams.get('code')).toBe(code);
    expect(target.searchParams.get('error')).toBe('Check the agent authorization server and client configuration before starting a new sign-in.');
    expect(target.searchParams.has('agent_context_id')).toBe(false);
    expect(target.searchParams.has('return_to')).toBe(false);
    expect(agentContextDbMocks.instance.clearOAuthClient).not.toHaveBeenCalled();
    expect(agentContextDbMocks.instance.removeOAuthTokens).not.toHaveBeenCalled();
  });

  it.each(['unrecognized_oauth_error', 'oauth_issuer_required?synthetic-client-secret=hidden', 'oauth_issuer_mismatch&synthetic-client-secret=hidden'])('refuses recovery and upstream projection for an unknown start code %s', async code => {
    sdkMocks.startWebOAuthFlow.mockRejectedValueOnce(new sdkMocks.OAuthError(privateDetails, code));
    const result = await request(makeApp()).get('/api/oauth/agent/start')
      .query({ agent_context_id: AGENT_CONTEXT_ID, return_to: '/dashboard?tab=agents' }).expect(302);
    const target = new URL(result.headers.location, 'https://buyer.example.test');
    expect(target.searchParams.get('code')).toBe('oauth_start_failed');
    expect(target.searchParams.get('error')).toBe('The agent authorization server could not start sign-in.');
    expect(target.searchParams.has('agent_context_id')).toBe(false);
    expect(target.searchParams.has('return_to')).toBe(false);
    expect(decodeURIComponent(result.headers.location)).not.toContain(privateDetails);
    expect(result.headers.location).not.toContain('hidden');
    expect(agentContextDbMocks.instance.clearOAuthClient).not.toHaveBeenCalled();
    expect(agentContextDbMocks.instance.removeOAuthTokens).not.toHaveBeenCalled();
  });

  it('keeps unexpected callback diagnostics out of the public redirect', async () => {
    sdkMocks.completeWebOAuthFlow.mockRejectedValueOnce(new Error(privateDetails));
    const result = await request(makeApp(stateBinding('state_123'))).get('/api/oauth/agent/callback')
      .query({ code: 'synthetic-code', state: 'state_123' }).expect(302);
    const target = new URL(result.headers.location, 'https://buyer.example.test');
    expect(target.searchParams.get('code')).toBe('oauth_error');
    expect(target.searchParams.get('error')).toBe('Unable to complete sign-in. Please start again.');
    expect(decodeURIComponent(result.headers.location)).not.toContain(privateDetails);
  });

  it.each(['invalid_grant', 'synthetic-client-secret=hidden'])('restricts public token-exchange codes for %s', async code => {
    const failure = new sdkMocks.TokenExchangeError(privateDetails);
    failure.oauthErrorCode = code;
    sdkMocks.completeWebOAuthFlow.mockRejectedValueOnce(failure);
    const result = await request(makeApp(stateBinding('state_123'))).get('/api/oauth/agent/callback')
      .query({ code: 'synthetic-code', state: 'state_123' }).expect(302);
    const target = new URL(result.headers.location, 'https://buyer.example.test');
    expect(target.searchParams.get('code')).toBe(code === 'invalid_grant' ? code : 'token_exchange_failed');
    expect(target.searchParams.get('error')).toBe('Token exchange failed');
    expect(result.headers.location).not.toContain('hidden');
  });

  it('does not reflect authorization-server rejection descriptions or unknown codes', async () => {
    const result = await request(makeApp(stateBinding('state_123'))).get('/api/oauth/agent/callback')
      .query({ error: 'synthetic-client-secret=hidden', error_description: privateDetails, state: 'state_123' }).expect(302);
    const target = new URL(result.headers.location, 'https://buyer.example.test');
    expect(target.searchParams.get('code')).toBe('authorization_failed');
    expect(target.searchParams.get('error')).toBe('Authorization server rejected the sign-in.');
    expect(result.headers.location).not.toContain('hidden');
    expect(sdkMocks.completeWebOAuthFlow).not.toHaveBeenCalled();
  });
});

describe('agent OAuth safe fetch injection', () => {
  it.each([
    { error: 'access_denied', expectedCode: 'access_denied', expectedMessage: 'Authorization was denied.' },
    { error: ['access_denied', 'server_error'], expectedCode: 'authorization_failed', expectedMessage: 'Authorization server rejected the sign-in.' },
  ])('refuses token exchange when a bound callback contains both code and $expectedCode provider error', async ({ error, expectedCode, expectedMessage }) => {
    const response = await request(makeApp(stateBinding('state_123')))
      .get('/api/oauth/agent/callback')
      .query({ code: 'synthetic-code', error, error_description: 'synthetic-private-detail', state: 'state_123' })
      .expect(302);
    const target = new URL(response.headers.location, 'https://buyer.example.test');
    expect(target.searchParams.get('success')).toBe('false');
    expect(target.searchParams.get('code')).toBe(expectedCode);
    expect(target.searchParams.get('error')).toBe(expectedMessage);
    expect(response.headers.location).not.toContain('synthetic-private-detail');
    expect(response.headers['set-cookie']?.[0]).toContain('adcp_oauth_state=;');
    expect(sdkMocks.completeWebOAuthFlow).not.toHaveBeenCalled();
    expect(adapterMocks.createWebOAuthAdapters).not.toHaveBeenCalled();
    expect(adapterMocks.pendingFlowStore.consume).not.toHaveBeenCalled();
  });

  it('requires browser binding before handling a callback with both code and provider error', async () => {
    const response = await request(makeApp(stateBinding('different_state')))
      .get('/api/oauth/agent/callback')
      .query({ code: 'synthetic-code', error: 'access_denied', state: 'state_123' })
      .expect(302);
    expect(response.headers.location).toContain('code=state_mismatch');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sdkMocks.completeWebOAuthFlow).not.toHaveBeenCalled();
    expect(adapterMocks.createWebOAuthAdapters).not.toHaveBeenCalled();
    expect(adapterMocks.pendingFlowStore.consume).not.toHaveBeenCalled();
  });

  it('passes the scoped fetcher to callback token exchange', async () => {
    sdkMocks.completeWebOAuthFlow.mockResolvedValueOnce({
      agentId: AGENT_CONTEXT_ID,
      agentUrl: TEST_AGENT_URL,
      tokens: { access_token: 'token', token_type: 'bearer' },
      carry: { organization_id: TEST_ORG_ID },
      persisted: true,
    });

    await request(makeApp(stateBinding('state_123')))
      .get('/api/oauth/agent/callback')
      .query({ code: 'code_123', state: 'state_123' })
      .expect(302);

    expect(sdkMocks.completeWebOAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
      state: 'state_123',
      code: 'code_123',
      expectedState: 'state_123',
      fetch: oauthSafeFetch,
    }));
  });

  it('rejects a callback whose state does not match the browser binding', async () => {
    const response = await request(makeApp(stateBinding('different_state')))
      .get('/api/oauth/agent/callback')
      .query({ code: 'code_123', state: 'state_123' })
      .expect(302);

    expect(response.headers.location).toContain('code=state_mismatch');
    expect(sdkMocks.completeWebOAuthFlow).not.toHaveBeenCalled();
  });

  it('rejects the legacy clear-text state cookie even when it matches the callback', async () => {
    const response = await request(makeApp('state_123'))
      .get('/api/oauth/agent/callback')
      .query({ code: 'code_123', state: 'state_123' })
      .expect(302);

    expect(response.headers.location).toContain('code=state_mismatch');
    expect(sdkMocks.completeWebOAuthFlow).not.toHaveBeenCalled();
  });

  it('requires browser-bound state on provider error callbacks', async () => {
    const response = await request(makeApp(stateBinding('different_state')))
      .get('/api/oauth/agent/callback')
      .query({ error: 'access_denied', state: 'state_123' })
      .expect(302);

    expect(response.headers.location).toContain('code=state_mismatch');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sdkMocks.completeWebOAuthFlow).not.toHaveBeenCalled();
  });

  it('accepts a provider error callback with browser-bound state', async () => {
    const response = await request(makeApp(stateBinding('state_123')))
      .get('/api/oauth/agent/callback')
      .query({ error: 'access_denied', error_description: 'User denied access', state: 'state_123' })
      .expect(302);

    expect(response.headers.location).toContain('success=false');
    const target = new URL(response.headers.location, 'https://buyer.example.test');
    expect(target.searchParams.get('error')).toBe('Authorization was denied.');
    expect(target.searchParams.get('code')).toBe('access_denied');
    expect(response.headers.location).not.toContain('User');
    expect(response.headers['set-cookie']?.[0]).toContain('adcp_oauth_state=;');
    expect(sdkMocks.completeWebOAuthFlow).not.toHaveBeenCalled();
  });

  it('passes the scoped fetcher to status discovery', async () => {
    sdkMocks.discoverOAuthMetadata.mockResolvedValueOnce({
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
    });

    await request(makeApp())
      .get(`/api/oauth/agent/${AGENT_CONTEXT_ID}/status`)
      .expect(200);

    expect(sdkMocks.discoverOAuthMetadata).toHaveBeenCalledWith(TEST_AGENT_URL, {
      fetch: oauthSafeFetch,
    });
  });
});

describe('buildDurableOAuthScopeHint', () => {
  it('recognizes OAuth failures from both SDK error families as agent-side', () => {
    expect(isAgentSideOAuthError(new sdkMocks.OAuthError())).toBe(true);
    expect(isAgentSideOAuthError(new mcpServerAuthMocks.OAuthError('registration failed'))).toBe(true);
    expect(isAgentSideOAuthError(new Error('database unavailable'))).toBe(false);
  });

  it('preserves advertised scopes and appends offline_access', () => {
    expect(buildDurableOAuthScopeHint(['openid', 'profile', 'email'])).toBe('openid profile email offline_access');
  });

  it('deduplicates offline_access when the agent already advertises it', () => {
    expect(buildDurableOAuthScopeHint(['openid', 'offline_access', 'email', 'offline_access'])).toBe('openid offline_access email');
  });

  it('requests offline_access even when no scopes are advertised', () => {
    expect(buildDurableOAuthScopeHint(undefined)).toBe('offline_access');
  });

  it('preserves advertised scopes without offline_access when the auth server does not allow it', () => {
    expect(buildDurableOAuthScopeHint(['adcp.read'], false)).toBe('adcp.read');
    expect(buildDurableOAuthScopeHint(undefined, false)).toBeUndefined();
  });
});
