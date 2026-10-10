import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeMCPConnections } from '@adcp/sdk';
import { openBuyerAuthFile, startBuyerLogin, finishBuyerLogin, createBuyerOAuthSession, DEFAULT_BUYER_AGENT } from '../../../scripts/training-buyer-auth.mjs';

let directory: string;
let file: Awaited<ReturnType<typeof openBuyerAuthFile>> | undefined;
const issuer = 'https://auth.example.com';
const resource = `${DEFAULT_BUYER_AGENT}/mcp`;
let requests: { url: string; body?: string; authorization: string | null }[];
let challenge: string;
let tokenExchanges: number;
let tokenLifetime: number;
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
const providerPort: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = init?.body?.toString();
  requests.push({ url, body, authorization: headers.get('Authorization') });
  if (url.includes('oauth-protected-resource')) return response({ resource, authorization_servers: [issuer] });
  if (url.includes('oauth-authorization-server')) return response({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['openid', 'profile', 'email', 'offline_access'] });
  if (url === `${issuer}/register`) return response({ ...JSON.parse(body!), client_id: 'client_buyer' }, 201);
  if (url === `${issuer}/token`) {
    const params = new URLSearchParams(body);
    expect(params.get('resource')).toBe(resource);
    expect(params.get('client_secret')).toBeNull();
    if (params.get('grant_type') === 'authorization_code') {
      expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(challenge);
      expect(params.get('code')).toBe('controlled-code');
    } else {
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe(`refresh-${tokenExchanges}`);
    }
    tokenExchanges++;
    return response({ access_token: `access-${tokenExchanges}`, refresh_token: `refresh-${tokenExchanges}`, token_type: 'Bearer', expires_in: tokenLifetime });
  }
  if (url.includes('/reporting/destinations/')) return response({ grant: { account_id: 'account-a' } });
  if (url === resource) {
    const rpc = JSON.parse(body!);
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') return response({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'controlled-sales', version: '1' } } });
    if (rpc.method === 'tools/call') return response({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"accepted":true}' }], structuredContent: { accepted: true } } });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
  }
  throw new Error(`Unexpected controlled endpoint ${url}`);
};
async function start() {
  file = await openBuyerAuthFile(join(directory, 'oauth.json'), { create: true });
  const result = await startBuyerLogin(file, { issuer, redirectUri: 'http://127.0.0.1:8765/callback', trustedFetchFn: providerPort });
  const url = new URL(result.authorizationUrl);
  challenge = url.searchParams.get('code_challenge')!;
  expect(url.searchParams.get('resource')).toBe(resource); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  return `http://127.0.0.1:8765/callback?code=controlled-code&state=${result.state}`;
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'training-buyer-login-')); requests = []; challenge = ''; tokenExchanges = 0; tokenLifetime = 3600; });
afterEach(async () => { await closeMCPConnections(); await file?.close(); file = undefined; await rm(directory, { recursive: true, force: true }); });

describe('buyer login through official OAuth and MCP clients', () => {
  it('reuses five-minute WorkOS tokens and refreshes when the request budget reaches expiry', async () => {
    tokenLifetime = 300;
    const callback = await start();
    await finishBuyerLogin(file!, callback, { trustedFetchFn: providerPort });
    const session = createBuyerOAuthSession(file!, DEFAULT_BUYER_AGENT, { trustedFetchFn: providerPort });
    await session.fetch(`${DEFAULT_BUYER_AGENT}/reporting/destinations/a/b`);
    await session.call('get_reporting_status', {});
    expect(tokenExchanges).toBe(1);
    expect(requests.filter(r => r.url.includes('/reporting/') || r.url === resource)
      .every(r => r.authorization === 'Bearer access-1')).toBe(true);
    file!.state.agent.oauth_tokens.expires_at = new Date(Date.now() + 20_000).toISOString(); await file!.save();
    await session.fetch(`${DEFAULT_BUYER_AGENT}/reporting/destinations/a/b`);
    await session.fetch(`${DEFAULT_BUYER_AGENT}/reporting/destinations/a/b`);
    expect(tokenExchanges).toBe(2);
    expect(requests.filter(r => r.url.includes('/reporting/')).slice(-2)
      .every(r => r.authorization === 'Bearer access-2')).toBe(true);
  });
  it('completes PKCE once, rotates refresh, and shares the current token with REST and MCP', async () => {
    const callback = await start();
    await finishBuyerLogin(file!, callback, { trustedFetchFn: providerPort });
    await expect(finishBuyerLogin(file!, callback, { trustedFetchFn: providerPort })).rejects.toThrow();
    file!.state.agent.oauth_tokens.expires_at = '2000-01-01T00:00:00Z'; await file!.save();
    const session = createBuyerOAuthSession(file!, DEFAULT_BUYER_AGENT, { trustedFetchFn: providerPort });
    const [rest, mcp] = await Promise.all([session.fetch(`${DEFAULT_BUYER_AGENT}/reporting/destinations/account-a/destination-a`), session.call('get_reporting_status', {})]);
    expect(rest.status).toBe(200); expect(mcp).toEqual({ accepted: true }); expect(tokenExchanges).toBe(2);
    const operations = requests.filter(r => r.url.includes('/reporting/destinations/') || r.url === resource);
    expect(operations.length).toBeGreaterThan(2); expect(operations.every(r => r.authorization === 'Bearer access-2')).toBe(true);
    const saved = JSON.parse(await readFile(join(directory, 'oauth.json'), 'utf8'));
    expect(saved.agent.oauth_tokens.refresh_token).toBe('refresh-2'); expect(saved.pending).toBeUndefined();
    expect((await stat(join(directory, 'oauth.json'))).mode & 0o777).toBe(0o600);
    await expect(session.fetch('https://foreign.example.com/reporting/destinations/a/b')).rejects.toThrow();
  });
  it.each(['state', 'origin', 'duplicate-code', 'error'])('rejects a %s callback before spending the code', async mutation => {
    const callback = new URL(await start());
    if (mutation === 'state') callback.searchParams.set('state', 'foreign');
    if (mutation === 'origin') callback.hostname = 'localhost';
    if (mutation === 'duplicate-code') callback.searchParams.append('code', 'other');
    if (mutation === 'error') callback.searchParams.set('error', 'access_denied');
    await expect(finishBuyerLogin(file!, callback.href, { trustedFetchFn: providerPort })).rejects.toThrow();
    expect(tokenExchanges).toBe(0); expect(file!.state.pending).toBeDefined();
  });
  it.each(['refresh-response-size', 'rest-response-size', 'rest-redirect'])('bounds %s without spending another refresh token', async failure => {
    const callback = await start();
    await finishBuyerLogin(file!, callback, { trustedFetchFn: providerPort });
    if (failure === 'refresh-response-size') { file!.state.agent.oauth_tokens.expires_at = '2000-01-01T00:00:00Z'; await file!.save(); }
    const boundedPort: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if ((failure === 'refresh-response-size' && url.includes('oauth-protected-resource'))
        || (failure === 'rest-response-size' && url.includes('/reporting/'))) return new Response('x'.repeat(1024 * 1024 + 1));
      if (failure === 'rest-redirect' && url.includes('/reporting/')) return new Response(null, { status: 302, headers: { Location: 'https://foreign.example.com' } });
      return providerPort(input, init);
    };
    const session = createBuyerOAuthSession(file!, DEFAULT_BUYER_AGENT, { trustedFetchFn: boundedPort });
    await expect(session.fetch(`${DEFAULT_BUYER_AGENT}/reporting/destinations/a/b`)).rejects.toThrow();
    expect(tokenExchanges).toBe(1);
    const allowedOrigins = new Set([new URL(issuer).origin, new URL(DEFAULT_BUYER_AGENT).origin]);
    expect(requests.every(request => allowedOrigins.has(new URL(request.url).origin))).toBe(true);
  });
  it('consumes expired state and cannot resume it', async () => {
    const callback = await start(); file!.state.pending.expiresAt = new Date(0).toISOString(); await file!.save();
    await expect(finishBuyerLogin(file!, callback, { trustedFetchFn: providerPort })).rejects.toThrow();
    expect(file!.state.pending).toBeUndefined(); expect(tokenExchanges).toBe(0);
  });
  it('rejects another issuer without issuing or spending saved credentials', async () => {
    file = await openBuyerAuthFile(join(directory, 'oauth.json'), { create: true });
    await expect(startBuyerLogin(file, { issuer: 'https://foreign.example.com', redirectUri: 'http://127.0.0.1:8765/callback', clientId: 'client_existing', trustedFetchFn: providerPort })).rejects.toThrow();
    expect(tokenExchanges).toBe(0); expect(file.state.pending).toBeUndefined();
  });
  it('prevents concurrent processes, synced storage, permissive files, and symlink reads', async () => {
    await start(); await expect(openBuyerAuthFile(join(directory, 'oauth.json'))).rejects.toThrow();
    await expect(openBuyerAuthFile(join(process.cwd(), '.context', 'buyer-oauth.json'), { create: true })).rejects.toThrow();
    await file!.close(); file = undefined;
    await chmod(join(directory, 'oauth.json'), 0o644);
    await expect(openBuyerAuthFile(join(directory, 'oauth.json'))).rejects.toThrow();
    await chmod(join(directory, 'oauth.json'), 0o600);
    await symlink(join(directory, 'oauth.json'), join(directory, 'linked.json'));
    await expect(openBuyerAuthFile(join(directory, 'linked.json'))).rejects.toThrow();
  });
});
