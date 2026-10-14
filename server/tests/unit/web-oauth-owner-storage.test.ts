import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, PendingWebFlow } from '@adcp/sdk/auth';
import type { AgentOAuthState } from '../../src/db/agent-oauth-state-db.js';

vi.mock('../../src/db/agent-oauth-state-db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/db/agent-oauth-state-db.js')>();
  return { ...actual, captureAgentOAuthState: vi.fn(), assertAgentOAuthState: vi.fn(), completeOwnerOAuthIfUnchanged: vi.fn() };
});
import { captureAgentOAuthState, assertAgentOAuthState, completeOwnerOAuthIfUnchanged } from '../../src/db/agent-oauth-state-db.js';
import { AgentContextOAuthStorage } from '../../src/routes/helpers/web-oauth-stores.js';

const ORG = 'org_synthetic_owner';
const USER = 'user_synthetic_owner';
const ID = 'context-synthetic-owner';
const AGENT_URL = 'https://sales.example.test/mcp';
const REDIRECT = 'https://buyer.example.test/callback';
const ISSUER = 'https://issuer.example.test/owner';
const state: AgentOAuthState = {
  id: ID, organization_id: ORG, agent_url: AGENT_URL, protocol: 'mcp', auth_type: 'bearer',
  auth_token_encrypted: null, auth_token_iv: null, auth_token_hint: null,
  oauth_access_token_encrypted: 'unchanged-legacy-access-cipher', oauth_access_token_iv: 'unchanged-access-iv',
  oauth_refresh_token_encrypted: 'unchanged-legacy-refresh-cipher', oauth_refresh_token_iv: 'unchanged-refresh-iv',
  oauth_token_expires_at: null, oauth_token_issuer: null,
  oauth_client_id: 'unchanged-legacy-client', oauth_client_secret_encrypted: 'unchanged-legacy-client-cipher',
  oauth_client_secret_iv: 'unchanged-client-iv', oauth_client_issuer: null,
  oauth_registered_redirect_uri: 'https://old.example.test/callback',
  oauth_cc_token_endpoint: null, oauth_cc_client_id: null, oauth_cc_client_secret_encrypted: null,
  oauth_cc_client_secret_iv: null, oauth_cc_scope: null, oauth_cc_resource: null,
  oauth_cc_audience: null, oauth_cc_auth_method: null, oauth_owner_generation: '0',
};
const client = { client_id: 'new-private-client', client_secret: 'synthetic-new-private-secret', issuer: ISSUER };
const getById = vi.fn();
const authorize = vi.fn();
const getOAuthClient = vi.fn();
const getOAuthTokens = vi.fn();
const db = { getById, getOAuthClient, getOAuthTokens };
const options = { agentContextDb: db, redirectUri: REDIRECT, userId: USER, authorize };

function flow(): PendingWebFlow {
  return { state: 'browser-state', agentId: ID, agentUrl: AGENT_URL, codeVerifier: 'synthetic-verifier',
    redirectUri: REDIRECT, authorizationServerUrl: ISSUER, authorizationServerIssuer: ISSUER,
    clientInformation: client, createdAt: new Date(), expiresAt: new Date(Date.now() + 600000),
    carry: { organization_id: ORG, user_id: USER } };
}
function agent(): AgentConfig {
  return { id: ID, name: 'Synthetic Agent', agent_uri: AGENT_URL, protocol: 'mcp', oauth_client: client };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(captureAgentOAuthState).mockResolvedValue({ ...state });
  vi.mocked(assertAgentOAuthState).mockResolvedValue(undefined);
  vi.mocked(completeOwnerOAuthIfUnchanged).mockResolvedValue({ ...state });
  getById.mockResolvedValue({ id: ID, organization_id: ORG, agent_url: AGENT_URL, protocol: 'mcp' });
  authorize.mockResolvedValue(true);
});

describe('supported fresh owner flow storage', () => {
  it('hides the old unstamped grant, privately stages DCR, and performs one completed atomic replacement', async () => {
    const storage = new AgentContextOAuthStorage({ ...options,
      ownerStart: { id: ID, organizationId: ORG, agentUrl: AGENT_URL, fresh: true } });
    const fresh = await storage.loadAgent(ID);
    expect(fresh).not.toHaveProperty('oauth_tokens');
    expect(fresh).not.toHaveProperty('oauth_client');
    await storage.saveAgent(agent());
    expect(completeOwnerOAuthIfUnchanged).not.toHaveBeenCalled();
    await expect(storage.capture(flow())).resolves.toEqual(state);
    expect((await storage.loadAgent(ID))?.oauth_client).toEqual(client);
    await storage.saveAgent({ ...agent(), oauth_tokens: {
      access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', issuer: ISSUER,
    } });
    expect(completeOwnerOAuthIfUnchanged).toHaveBeenCalledTimes(1);
    expect(completeOwnerOAuthIfUnchanged).toHaveBeenCalledWith(state, client,
      { access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', issuer: ISSUER }, REDIRECT);
    await expect(storage.saveAgent(agent())).rejects.toThrow();
  });

  it('ordinary start retains both stamped records and the preconfigured client without DCR fallback', async () => {
    vi.mocked(captureAgentOAuthState).mockResolvedValue({ ...state, oauth_token_issuer: ISSUER,
      oauth_client_issuer: ISSUER, oauth_registered_redirect_uri: REDIRECT });
    getOAuthClient.mockResolvedValue({ ...client, registered_redirect_uri: REDIRECT });
    getOAuthTokens.mockResolvedValue({ access_token: 'prior-access', refresh_token: 'prior-refresh', issuer: ISSUER });
    const storage = new AgentContextOAuthStorage({ ...options,
      ownerStart: { id: ID, organizationId: ORG, agentUrl: AGENT_URL, fresh: false } });
    const view = await storage.loadAgent(ID);
    expect(view?.oauth_client).toEqual(client);
    expect(view?.oauth_tokens).toEqual({ access_token: 'prior-access', refresh_token: 'prior-refresh', issuer: ISSUER });
    expect(completeOwnerOAuthIfUnchanged).not.toHaveBeenCalled();
  });

  it('explicit fresh omits an unstamped token but retains a stamped exact-redirect client', async () => {
    vi.mocked(captureAgentOAuthState).mockResolvedValue({ ...state,
      oauth_client_issuer: ISSUER, oauth_registered_redirect_uri: REDIRECT });
    getOAuthClient.mockResolvedValue({ ...client, registered_redirect_uri: REDIRECT });
    const storage = new AgentContextOAuthStorage({ ...options,
      ownerStart: { id: ID, organizationId: ORG, agentUrl: AGENT_URL, fresh: true } });
    const view = await storage.loadAgent(ID);
    expect(view?.oauth_client).toEqual(client);
    expect(view).not.toHaveProperty('oauth_tokens');
    expect(getOAuthTokens).not.toHaveBeenCalled();
  });

  it.each(['unstamped-client', 'unstamped-token', 'token-only', 'stale-redirect'] as const)('ordinary %s start refuses before credential reads or DCR staging', async variant => {
    vi.mocked(captureAgentOAuthState).mockResolvedValue({ ...state,
      oauth_token_issuer: ISSUER, oauth_client_issuer: ISSUER, oauth_registered_redirect_uri: REDIRECT,
      ...(variant === 'unstamped-client' && { oauth_client_issuer: null }),
      ...(variant === 'unstamped-token' && { oauth_token_issuer: null }),
      ...(variant === 'token-only' && { oauth_client_id: null, oauth_client_secret_encrypted: null,
        oauth_client_secret_iv: null, oauth_client_issuer: null }),
      ...(variant === 'stale-redirect' && { oauth_registered_redirect_uri: 'https://old.example.test/callback' }),
    });
    const storage = new AgentContextOAuthStorage({ ...options,
      ownerStart: { id: ID, organizationId: ORG, agentUrl: AGENT_URL, fresh: false } });
    await expect(storage.loadAgent(ID)).rejects.toThrow(/owner authorization/);
    expect(getOAuthClient).not.toHaveBeenCalled();
    expect(getOAuthTokens).not.toHaveBeenCalled();
    expect(completeOwnerOAuthIfUnchanged).not.toHaveBeenCalled();
  });

  it('reconstructs only the frozen staged client on a later callback request', async () => {
    const storage = new AgentContextOAuthStorage(options);
    storage.restore(flow(), state);
    const view = await storage.loadAgent(ID);
    expect(view?.oauth_client).toEqual(client);
    expect(view).not.toHaveProperty('oauth_tokens');
    expect(captureAgentOAuthState).not.toHaveBeenCalled();
  });

  it.each(['org', 'url', 'user', 'redirect', 'context'] as const)('refuses callback %s rebinding before a storage read/write', async key => {
    const storage = new AgentContextOAuthStorage(options);
    const wrong = flow();
    if (key === 'org') wrong.carry = { ...wrong.carry, organization_id: 'other-org' };
    if (key === 'user') wrong.carry = { ...wrong.carry, user_id: 'other-user' };
    if (key === 'url') wrong.agentUrl = 'https://other.example.test/mcp';
    if (key === 'redirect') wrong.redirectUri = 'https://other.example.test/callback';
    if (key === 'context') wrong.agentId = 'other-context';
    expect(() => storage.restore(wrong, state)).toThrow();
    expect(getById).not.toHaveBeenCalled();
    expect(completeOwnerOAuthIfUnchanged).not.toHaveBeenCalled();
  });

  it('refuses lost membership before metadata/exchange can obtain the client view', async () => {
    const storage = new AgentContextOAuthStorage(options);
    storage.restore(flow(), state);
    authorize.mockResolvedValue(false);
    await expect(storage.loadAgent(ID)).rejects.toThrow();
    expect(completeOwnerOAuthIfUnchanged).not.toHaveBeenCalled();
  });

  it('refuses owner clear/replacement after metadata and again after token response without persistence', async () => {
    const storage = new AgentContextOAuthStorage(options);
    storage.restore(flow(), state);
    await storage.loadAgent(ID); // Initial SDK load before metadata.
    vi.mocked(assertAgentOAuthState).mockRejectedValueOnce(new Error('concurrent owner clear'));
    await expect(storage.loadAgent(ID)).rejects.toThrow('concurrent owner clear');
    vi.mocked(assertAgentOAuthState).mockRejectedValueOnce(new Error('concurrent owner replacement'));
    await expect(storage.saveAgent({ ...agent(), oauth_tokens: { access_token: 'late', issuer: ISSUER } })).rejects.toThrow();
    expect(completeOwnerOAuthIfUnchanged).not.toHaveBeenCalled();
  });

  it('propagates zero-row final CAS as failure rather than persisted success', async () => {
    const storage = new AgentContextOAuthStorage(options);
    storage.restore(flow(), state);
    vi.mocked(completeOwnerOAuthIfUnchanged).mockRejectedValueOnce(new Error('stale final CAS'));
    await expect(storage.saveAgent({ ...agent(), oauth_tokens: { access_token: 'late', issuer: ISSUER } })).rejects.toThrow();
    expect(completeOwnerOAuthIfUnchanged).toHaveBeenCalledTimes(1);
  });
});
