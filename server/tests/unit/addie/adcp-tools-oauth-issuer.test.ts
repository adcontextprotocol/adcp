import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNonInteractiveOAuthProvider, OAuthError } from '@adcp/sdk/auth';

const db = vi.hoisted(() => ({
  getByOrgAndUrl: vi.fn(),
  getOAuthTokensByOrgAndUrl: vi.fn(),
  getOAuthClient: vi.fn(),
  getOAuthClientCredentialsByOrgAndUrl: vi.fn(),
  getAuthInfoByOrgAndUrl: vi.fn(),
}));
const constructClient = vi.hoisted(() => vi.fn());
const executeTask = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/agent-context-db.js', () => ({
  AgentContextDatabase: class {
    getByOrgAndUrl = db.getByOrgAndUrl;
    getOAuthTokensByOrgAndUrl = db.getOAuthTokensByOrgAndUrl;
    getOAuthClient = db.getOAuthClient;
    getOAuthClientCredentialsByOrgAndUrl = db.getOAuthClientCredentialsByOrgAndUrl;
    getAuthInfoByOrgAndUrl = db.getAuthInfoByOrgAndUrl;
  },
}));
vi.mock('@adcp/sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@adcp/sdk')>(),
  AdCPClient: class {
    constructor(...args: unknown[]) { constructClient(...args); }
    agent() { return { executeCustomTask: executeTask }; }
  },
}));
vi.mock('../../../src/security/gcp-kms-signer.js', () => ({
  getRequestSigningProvider: vi.fn().mockResolvedValue(undefined),
}));
import { createAdcpToolHandlers } from '../../../src/addie/mcp/adcp-tools.js';

const ORG = 'org_synthetic_issuer_reader';
const AGENT = 'https://seller.example.test/mcp';
// The dispatcher reads only the trusted organization facet in this fixture.
const context = {
  organization: { workos_organization_id: ORG },
} as NonNullable<Parameters<typeof createAdcpToolHandlers>[0]>;

describe('Addie independent OAuth-first owner resolver', () => {
  beforeEach(() => {
    vi.stubEnv('BASE_URL', 'https://owned-app.example');
    vi.resetAllMocks();
    db.getByOrgAndUrl.mockResolvedValue({ id: 'synthetic-context', has_oauth_token: true });
    db.getOAuthClient.mockResolvedValue({ client_id: 'synthetic-client' });
    executeTask.mockResolvedValue({ success: true, data: {}, status: 'completed' });
  });
  afterEach(() => vi.unstubAllEnvs());

  async function dispatch(member = context) {
    return createAdcpToolHandlers(member).get('call_adcp_task')!({
      agent_url: AGENT, task: 'list_collection_lists', params: {},
    });
  }

  it('preserves distinct token/client issuer bindings in the actual constructed SDK config', async () => {
    db.getOAuthTokensByOrgAndUrl.mockResolvedValue({
      access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
      issuer: 'https://tokens.example.test/tenant',
    });
    db.getOAuthClient.mockResolvedValue({
      client_id: 'synthetic-client', issuer: 'https://registration.example.test/tenant',
    });
    await dispatch();
    expect(constructClient).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        agent_uri: AGENT,
        oauth_tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
          issuer: 'https://tokens.example.test/tenant' },
        oauth_client: { client_id: 'synthetic-client', issuer: 'https://registration.example.test/tenant' },
      }),
    ], expect.any(Object));
    expect(db.getByOrgAndUrl).toHaveBeenCalledWith(ORG, AGENT);
    expect(db.getOAuthClient).toHaveBeenCalledWith('synthetic-context');
    expect(db.getAuthInfoByOrgAndUrl).not.toHaveBeenCalled();
  });

  it('does not infer issuer metadata for a legacy grant', async () => {
    db.getOAuthTokensByOrgAndUrl.mockResolvedValue({
      access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
    });
    const result = await dispatch() as { telemetry: { error_code: string } };
    expect(result.telemetry.error_code).toBe('OAUTH_AUTHORIZATION_REQUIRED');
    expect(constructClient).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
    await expect(db.getOAuthTokensByOrgAndUrl.mock.results[0].value).resolves.toEqual({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' });
  });

  it('returns an explicit fresh-owner link when actual SDK15 refuses a legacy refresh grant', async () => {
    db.getOAuthTokensByOrgAndUrl.mockResolvedValue({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' });
    const provider = createNonInteractiveOAuthProvider({ id: 'synthetic-context', name: 'Owned fixture', agent_uri: AGENT, protocol: 'mcp',
      oauth_tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } });
    const error = await provider.tokens().catch(error => error);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.code).toBe('oauth_issuer_required');
    executeTask.mockRejectedValueOnce(error);
    const result = await dispatch() as { model_context: string; telemetry: { error_code: string } };
    expect(result.telemetry.error_code).toBe('OAUTH_AUTHORIZATION_REQUIRED');
    const link = result.model_context.match(/https:\/\/owned-app\.example\/api\/oauth\/agent\/start\?[^\s]+/)?.[0];
    expect(link).toBeDefined();
    expect(constructClient).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
    const url = new URL(link!);
    expect(url.searchParams.get('fresh')).toBe('1');
    expect(url.searchParams.get('agent_context_id')).toBe('synthetic-context');
    expect(result.model_context).not.toContain('synthetic-refresh');
    expect(result.model_context).not.toContain('synthetic-access');
  });

  it('does not turn an unknown OAuthError code into an owner sign-in link', async () => {
    executeTask.mockRejectedValueOnce(new OAuthError('Unexpected OAuth failure', 'unknown_code'));
    const result = await dispatch() as { model_context: string; telemetry: { error_code: string } };
    expect(result.telemetry.error_code).toBe('unknown_code');
    expect(result.model_context).not.toContain('/api/oauth/agent/start');
  });
});
