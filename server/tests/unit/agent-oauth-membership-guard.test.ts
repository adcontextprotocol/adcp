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
} from '../../src/routes/agent-oauth.js';
import { oauthSafeFetch } from '../../src/routes/helpers/oauth-safe-fetch.js';

const TEST_USER_ID = 'user_123';
const TEST_ORG_ID = 'org_123';
const AGENT_CONTEXT_ID = '11111111-1111-4111-8111-111111111111';
const TEST_AGENT_URL = 'https://agent.example.com/mcp';

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

describe('agent OAuth safe fetch injection', () => {
  it('passes the scoped fetcher to callback token exchange', async () => {
    sdkMocks.completeWebOAuthFlow.mockResolvedValueOnce({
      agentId: AGENT_CONTEXT_ID,
      agentUrl: TEST_AGENT_URL,
      tokens: { access_token: 'token', token_type: 'bearer' },
      carry: { organization_id: TEST_ORG_ID },
      persisted: true,
    });

    await request(makeApp('state_123'))
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
