/**
 * End-to-end: Web Bot Auth signed MCP requests against the sandbox identity
 * route. Boots the real training-agent router; every request is signed as
 * a fixture agent with the SDK signer, verified, bound through open sandbox
 * onboarding, and authorized against the brand house's trust.json grants.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { signWebBotAuth } from '@adcp/sdk/identity-3.3';
import { FIXTURE_AGENTS, FIXTURE_DOMAINS, fixtureSigningKey, type FixtureAgentName } from './fixture-world.js';

const ROUTE = '/api/training-agent/sales/identity/mcp';

async function bootServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const { createTrainingAgentRouter } = await import('../index.js');
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter());
  const srv = http.createServer(app);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  return {
    port: (srv.address() as { port: number }).port,
    close: () => new Promise(r => srv.close(() => r())),
  };
}

interface RpcResponse {
  status: number;
  body: {
    error?: { code: number; message: string };
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
}

describe('sandbox identity route: Web Bot Auth and demand-side grants', () => {
  let server: { port: number; close: () => Promise<void> };
  let rpcId = 0;

  beforeAll(async () => {
    server = await bootServer();
  }, 120_000);
  afterAll(async () => {
    await server?.close();
  });

  async function rpc(method: string, params: Record<string, unknown>, signer?: FixtureAgentName): Promise<RpcResponse> {
    const host = `127.0.0.1:${server.port}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      host,
      // The verifier reconstructs the signed https URL behind the proxy.
      'x-forwarded-proto': 'https',
    };
    if (signer) {
      Object.assign(headers, await signWebBotAuth(
        { method: 'POST', url: `https://${host}${ROUTE}`, headers: { ...headers }, body },
        fixtureSigningKey(signer),
        { origin: FIXTURE_AGENTS[signer].origin },
      ));
    }
    const response = await fetch(`http://${host}${ROUTE}`, { method: 'POST', headers, body });
    return { status: response.status, body: JSON.parse(await response.text()) };
  }

  const tool = (name: string, args: Record<string, unknown>, signer?: FixtureAgentName) =>
    rpc('tools/call', { name, arguments: { adcp_version: '3.3', ...args } }, signer);

  const syncAccount = (signer: FixtureAgentName, account: Record<string, unknown>) =>
    tool('sync_accounts', {
      idempotency_key: `identity33-${randomUUID()}`,
      accounts: [{ billing: 'operator', sandbox: true, ...account }],
    }, signer);

  const onboard = (signer: FixtureAgentName) =>
    tool('sync_principal', {
      idempotency_key: `identity33-${randomUUID()}`,
      configuration: { notification_configs: [] },
    }, signer);

  const errorCode = (response: RpcResponse) =>
    (response.body.result?.structuredContent?.adcp_error as { code?: string } | undefined)?.code;
  const errorReason = (response: RpcResponse) =>
    ((response.body.result?.structuredContent?.adcp_error as { details?: { reason?: string } } | undefined)?.details)?.reason;

  const novaMotors = { domain: FIXTURE_DOMAINS.child, brand_id: 'nova_motors', countries: ['US'] };

  it('lets an unsigned caller discover the agent but nothing else', async () => {
    const capabilities = await tool('get_adcp_capabilities', {});
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.result?.isError).not.toBe(true);
    const caps = capabilities.body.result?.structuredContent as Record<string, unknown>;
    expect(caps.request_signing).toMatchObject({ supported: true, profiles: ['web-bot-auth'] });
    expect((caps.account as Record<string, unknown>).agent_onboarding).toEqual({ sandbox: { mode: 'open' } });
    expect(caps.experimental_features).toEqual(expect.arrayContaining(['signing.web_bot_auth', 'account.agent_onboarding']));

    const unsigned = await tool('sync_accounts', { idempotency_key: `identity33-${randomUUID()}`, accounts: [] });
    expect(unsigned.status).toBe(401);
  });

  it('accepts the granted agency for the child brand its parent protects', async () => {
    expect((await onboard('agency')).body.result?.isError).not.toBe(true);
    const result = await syncAccount('agency', { brand: novaMotors, operator: FIXTURE_DOMAINS.agency });
    expect(result.body.result?.isError, JSON.stringify(result.body)).not.toBe(true);
    const accounts = result.body.result?.structuredContent?.accounts as Array<{ status?: string; errors?: unknown }>;
    expect(accounts[0]?.status, JSON.stringify(accounts[0])).toBe('active');
  });

  it('refuses an impostor claiming the brand, whatever operator it names', async () => {
    expect((await onboard('impostor')).body.result?.isError).not.toBe(true);
    for (const operator of [FIXTURE_DOMAINS.impostor, FIXTURE_DOMAINS.agency]) {
      const result = await syncAccount('impostor', { brand: novaMotors, operator });
      expect(errorCode(result), JSON.stringify(result.body)).toBe('PERMISSION_DENIED');
      expect(errorReason(result)).toBe('grant_absent');
    }
  });

  // Spec: implicit authority extends to the brand's house (L2, Grants in
  // trust records). Fixed in adcontextprotocol/adcp-client#3388 (SDK 16.5);
  // @adcp/sdk 16.3.0 checked the brand's domain only and returned grant_absent.
  it("lets the house's own agent act for its child brand without a grant", async () => {
    expect((await onboard('house')).body.result?.isError).not.toBe(true);
    const result = await syncAccount('house', { brand: novaMotors, operator: FIXTURE_DOMAINS.house });
    const accounts = result.body.result?.structuredContent?.accounts as Array<{ status?: string }> | undefined;
    expect(accounts?.[0]?.status, JSON.stringify(result.body)).toBe('active');
  });

  it('applies the grant limits: a market the grant does not cover is refused', async () => {
    await onboard('agency');
    const result = await syncAccount('agency', {
      brand: { ...novaMotors, countries: ['FR'] },
      operator: FIXTURE_DOMAINS.agency,
    });
    expect(errorCode(result), JSON.stringify(result.body)).toBe('PERMISSION_DENIED');
    expect(errorReason(result)).toBe('grant_absent');
  });

  it('fails spend closed when the brand authority record is unavailable', async () => {
    await onboard('agency');
    const result = await syncAccount('agency', {
      brand: { domain: FIXTURE_DOMAINS.offline, countries: ['US'] },
      operator: FIXTURE_DOMAINS.agency,
    });
    expect(errorCode(result), JSON.stringify(result.body)).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects a request whose signature does not match its body', async () => {
    const host = `127.0.0.1:${server.port}`;
    const signedBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_products', arguments: {} } });
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', host, 'x-forwarded-proto': 'https' };
    Object.assign(headers, await signWebBotAuth(
      { method: 'POST', url: `https://${host}/api/training-agent/sales/other/mcp`, headers: { ...headers }, body: signedBody },
      fixtureSigningKey('impostor'),
      { origin: FIXTURE_AGENTS.impostor.origin },
    ));
    const response = await fetch(`http://${host}${ROUTE}`, { method: 'POST', headers, body: signedBody });
    expect([401, 403]).toContain(response.status);
  });
});
