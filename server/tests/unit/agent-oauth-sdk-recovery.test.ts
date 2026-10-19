import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationRequiredError } from '@adcp/sdk';
import { createNonInteractiveOAuthProvider, OAuthError } from '@adcp/sdk/auth';
import { testCapabilityDiscovery } from '@adcp/sdk/testing';
import { adaptAuthForSdk, agentConfigAuthFields, type SdkAuth } from '../../src/services/sdk-auth-adapter.js';
import { buildAgentOAuthAuthorizeUrl, isOAuthRequiredError } from '../../src/routes/helpers/agent-oauth-prompt.js';
import { isOAuthRequiredErrorMessage } from '../../src/routes/helpers/oauth-error-detection.js';
import type { AgentContextDatabase } from '../../src/db/agent-context-db.js';

const agentUrl = 'https://owned-agent.example/mcp';
const issuer = 'https://owned-issuer.example';
const contextId = '63a74099-bc76-4525-b847-8c36909b4e5b';

beforeEach(() => vi.stubEnv('BASE_URL', 'https://owned-app.example'));
afterEach(() => vi.unstubAllEnvs());

async function actualOwnerErrors(): Promise<OAuthError[]> {
  const config = { id: 'owned-fixture', name: 'Owned fixture', agent_uri: agentUrl, protocol: 'mcp' as const };
  const legacy = createNonInteractiveOAuthProvider({ ...config, ...agentConfigAuthFields({
    type: 'oauth', tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
  }) });
  const bound = createNonInteractiveOAuthProvider({ ...config, ...agentConfigAuthFields({
    type: 'oauth', tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', issuer },
  }) });
  const credentialless = createNonInteractiveOAuthProvider(config);
  const operations = [legacy.tokens(), bound.tokens({ issuer: 'https://different-issuer.example' }),
    credentialless.saveCodeVerifier('synthetic-pkce'), credentialless.redirectToAuthorization(new URL(issuer + '/authorize'))];
  const results = await Promise.allSettled(operations);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
  return results.map(result => (result as PromiseRejectedResult).reason as OAuthError);
}

function promptDb() {
  return { getByOrgAndUrl: vi.fn().mockResolvedValue({ id: contextId }), create: vi.fn() };
}

describe('actual SDK15 owner recovery prompts', () => {
  it.each(['refresh grant', 'confidential client'])('validates an unstamped %s before endpoint discovery can mask its error', async (credential) => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.method ?? 'unknown');
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Owned fixture has no port');
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const auth: SdkAuth = {
        type: 'oauth',
        tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', ...(credential === 'confidential client' && { issuer }) },
        ...(credential === 'confidential client' && { client: { client_id: 'synthetic-client', client_secret: 'synthetic-secret' } }),
      };
      let result: unknown;
      try {
        const selected = await adaptAuthForSdk(auth, { ownerDiscoveryUrl: url });
        const discovery = await testCapabilityDiscovery(url, {
          auth: selected,
          transport: { allowPrivateIp: true },
          versionEnvelope: 'major-only',
        });
        result = discovery.steps[0]?.error;
      } catch (error) {
        result = error;
      }
      expect(result).toBeInstanceOf(OAuthError);
      expect((result as OAuthError).code).toBe('oauth_issuer_required');
      const link = await buildAgentOAuthAuthorizeUrl(url, 'org_owned', promptDb() as unknown as AgentContextDatabase, { authorizationError: result });
      expect(new URL(link!).searchParams.get('fresh')).toBe('1');
      expect(requests).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('recognizes actual finite issuer and owner failures, including flattened storyboard messages', async () => {
    const errors = await actualOwnerErrors();
    expect(errors.map(error => error.code)).toEqual(['oauth_issuer_required', 'oauth_issuer_mismatch', 'owner_reauthorization_required', 'interactive_required']);
    for (const error of errors) {
      expect(error).toBeInstanceOf(OAuthError);
      expect(isOAuthRequiredError(error)).toBe(true);
      expect(isOAuthRequiredErrorMessage(error.message)).toBe(true);
    }
  });

  it('offers fresh owner sign-in for actual typed and flattened SDK errors without serializing them', async () => {
    for (const error of await actualOwnerErrors()) {
      for (const authorizationError of [error, error.message]) {
        const db = promptDb();
        const result = await buildAgentOAuthAuthorizeUrl(agentUrl, 'org_owned', db as unknown as AgentContextDatabase, {
          authorizationError,
          returnTo: '/dashboard/agents',
        });
        expect(result).not.toBeNull();
        const url = new URL(result!);
        expect(url.pathname).toBe('/api/oauth/agent/start');
        expect(url.searchParams.get('agent_context_id')).toBe(contextId);
        expect(url.searchParams.get('fresh')).toBe('1');
        expect(url.searchParams.get('return_to')).toBe('/dashboard/agents');
        expect([...url.searchParams.keys()].sort()).toEqual(['agent_context_id', 'fresh', 'return_to']);
        expect(db.getByOrgAndUrl).toHaveBeenCalledWith('org_owned', agentUrl);
        expect(db.create).not.toHaveBeenCalled();
      }
    }
  });

  it('keeps an ordinary typed OAuth401 prompt in ordinary mode', async () => {
    const error = new AuthenticationRequiredError(agentUrl, { authorization_servers: [issuer] }, 'requires auth');
    const db = promptDb();
    expect(isOAuthRequiredError(error)).toBe(true);
    const result = await buildAgentOAuthAuthorizeUrl(agentUrl, 'org_owned', db as unknown as AgentContextDatabase, { authorizationError: error });
    expect(new URL(result!).searchParams.has('fresh')).toBe(false);
  });

  it('refuses unknown codes, generic text, AUTH_INVALID and misleading substring prompts before a database read', async () => {
    for (const authorizationError of [
      new OAuthError('Saved OAuth credentials need a valid issuer. Clear them and sign in again, or set their issuer from trusted configuration.', 'unknown_code'),
      new Error('Unexpected OAuth failure'), 'AUTH_INVALID: Token rejected',
      'schema field oauth_issuer_required_extra invalid',
      'Remote validation: OAuth credentials belong to a different authorization server.',
      'oauth_issuer_required',
    ]) {
      expect(isOAuthRequiredError(authorizationError)).toBe(false);
      const db = promptDb();
      expect(await buildAgentOAuthAuthorizeUrl(agentUrl, 'org_owned', db as unknown as AgentContextDatabase, { authorizationError })).toBeNull();
      expect(db.getByOrgAndUrl).not.toHaveBeenCalled();
      expect(db.create).not.toHaveBeenCalled();
    }
  });
});

describe('dashboard explicit owner-recovery click', () => {
  const html = readFileSync(new URL('../../public/dashboard-agents.html', import.meta.url), 'utf8');
  const handler = html.slice(html.indexOf('    // OAuth "Authorize with agent" button'), html.indexOf('    // Monitoring pause toggle'));
  const renderer = html.slice(html.indexOf('      function renderOAuthChallenge('), html.indexOf('      function parseCapabilityProbeRetrySeconds('));

  it('carries only the true server recovery signal into the click and preserves context and return path', async () => {
    for (const fresh of [true, false]) {
      const render = new Function('escapeHtml', renderer + '\nreturn renderOAuthChallenge;')((s: unknown) => String(s));
      const rendered = render(agentUrl, contextId, 'Owner sign-in needed', fresh);
      const attribute = rendered.match(/data-oauth-fresh="([^"]*)"/)?.[1];
      let click: (event: unknown) => Promise<void> = async () => { throw new Error('click handler absent'); };
      const document = { addEventListener: (_event: string, listener: typeof click) => { click = listener; } };
      const window = { location: { pathname: '/dashboard/agents', search: '?org=owned', hash: '#agent' } };
      const fetch = vi.fn(() => { throw new Error('existing context should not need a request'); });
      new Function('document', 'window', 'fetch', 'alert', 'console', handler)(document, window, fetch, vi.fn(), console);
      const button = { dataset: { agentUrl, agentContextId: contextId, oauthFresh: attribute }, disabled: false, textContent: 'Authorize with agent' };
      await click({ target: { closest: () => button } });
      const target = new URL(String(window.location.href), 'https://app.example');
      expect(target.pathname).toBe('/api/oauth/agent/start');
      expect(target.searchParams.get('agent_context_id')).toBe(contextId);
      expect(target.searchParams.get('return_to')).toBe('/dashboard/agents?org=owned#agent');
      expect(target.searchParams.get('fresh')).toBe(fresh ? '1' : null);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});
