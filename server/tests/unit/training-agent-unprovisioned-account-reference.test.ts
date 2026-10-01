/**
 * Account references before provisioning (docs/accounts/overview.mdx).
 *
 * The training agent exposes sync_accounts, so a buyer-declared natural key
 * on a discovery task resolves only after it is provisioned. An unprovisioned
 * key is ACCOUNT_NOT_FOUND, never a silent public fallback, and the read does
 * not create the account.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import { clearSessions, stopSessionCleanup } from '../../src/training-agent/state.js';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token';

type ToolResult = {
  result?: {
    isError?: boolean;
    structuredContent?: {
      adcp_error?: { code?: string; recovery?: string; field?: string };
      products?: unknown[];
      signals?: unknown[];
      accounts?: Array<{ action?: string; account_id?: string }>;
      cache_scope?: string;
    };
  };
};

async function bootServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
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
  const port = (srv.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/training-agent`,
    close: () => new Promise(r => srv.close(() => r())),
  };
}

let rpcId = 1;

async function rpc(url: string, method: string, params: Record<string, unknown>): Promise<ToolResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  return response.json() as Promise<ToolResult>;
}

async function initialize(url: string): Promise<void> {
  await rpc(url, 'initialize', {
    protocolVersion: '2025-03-26',
    clientInfo: { name: 'unprovisioned-account-test', version: '1' },
    capabilities: {},
  });
}

const callTool = (url: string, name: string, args: Record<string, unknown>) =>
  rpc(url, 'tools/call', { name, arguments: args });

const unprovisioned = {
  brand: { domain: 'never-synced-unit.example' },
  operator: 'unprovisioned-unit-agency.example',
};

const productsRequest = (account?: Record<string, unknown>) => ({
  buying_mode: 'brief',
  brief: 'Outdoor lifestyle video inventory for adults 25-54 in the US.',
  ...(account && { account }),
});

describe('training agent: account references before provisioning', () => {
  let server: Awaited<ReturnType<typeof bootServer>>;

  beforeEach(async () => {
    clearSessions();
    clearAccountStore();
    server = await bootServer();
  });

  afterEach(async () => {
    await server.close();
    clearSessions();
    clearAccountStore();
    stopSessionCleanup();
  });

  it('rejects an unsynced natural key on get_products and does not create the account', async () => {
    const url = `${server.baseUrl}/sales/mcp`;
    await initialize(url);

    const rejected = await callTool(url, 'get_products', productsRequest(unprovisioned));
    expect(rejected.result?.structuredContent?.adcp_error).toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
      recovery: 'terminal',
      field: 'account',
    });
    expect(rejected.result?.structuredContent?.products).toBeUndefined();

    // list_accounts treats account as a filter: an unknown key matches nothing.
    const listed = await callTool(url, 'list_accounts', { account: unprovisioned });
    expect(listed.result?.structuredContent?.adcp_error).toBeUndefined();
    expect(listed.result?.structuredContent?.accounts).toEqual([]);
  });

  it('resolves the same natural key after sync_accounts provisions it', async () => {
    const url = `${server.baseUrl}/sales/mcp`;
    await initialize(url);

    const synced = await callTool(url, 'sync_accounts', {
      accounts: [{ ...unprovisioned, billing: 'operator', payment_terms: 'net_30' }],
      idempotency_key: 'unprovisioned-unit-sync-0001',
    });
    const row = synced.result?.structuredContent?.accounts?.[0];
    expect(row?.action).not.toBe('failed');

    const answered = await callTool(url, 'get_products', productsRequest(unprovisioned));
    expect(answered.result?.structuredContent?.adcp_error).toBeUndefined();
    expect(Array.isArray(answered.result?.structuredContent?.products)).toBe(true);

    // Sandbox is part of the natural key: the sandbox twin is still unprovisioned.
    const sandboxTwin = await callTool(url, 'get_products', productsRequest({ ...unprovisioned, sandbox: true }));
    expect(sandboxTwin.result?.structuredContent?.adcp_error?.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('keeps public discovery when account is omitted', async () => {
    const url = `${server.baseUrl}/sales/mcp`;
    await initialize(url);

    const answered = await callTool(url, 'get_products', productsRequest());
    expect(answered.result?.structuredContent?.adcp_error).toBeUndefined();
    expect(Array.isArray(answered.result?.structuredContent?.products)).toBe(true);
  });

  it('rejects an unsynced natural key on get_signals', async () => {
    const url = `${server.baseUrl}/signals/mcp`;
    await initialize(url);

    const rejected = await callTool(url, 'get_signals', {
      signal_spec: 'In-market auto intenders',
      account: unprovisioned,
    });
    expect(rejected.result?.structuredContent?.adcp_error).toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
      field: 'account',
    });
  });

  // Temporary exemption for adcontextprotocol/adcp-client#3095: the storyboard
  // runner synthesizes this exact key on account-less discovery probes.
  it('exempts only the runner-synthesized acme-outdoor probe key', async () => {
    const url = `${server.baseUrl}/signals/mcp`;
    await initialize(url);

    const probeKey = { brand: { domain: 'acmeoutdoor.example' }, operator: 'acmeoutdoor.example', sandbox: true };
    const answered = await callTool(url, 'get_signals', {
      signal_spec: 'In-market auto intenders',
      account: probeKey,
    });
    expect(answered.result?.structuredContent?.adcp_error).toBeUndefined();

    const otherOperator = await callTool(url, 'get_signals', {
      signal_spec: 'In-market auto intenders',
      account: { ...probeKey, operator: 'unprovisioned-agency.example' },
    });
    expect(otherOperator.result?.structuredContent?.adcp_error?.code).toBe('ACCOUNT_NOT_FOUND');

    const withCurrency = await callTool(url, 'get_signals', {
      signal_spec: 'In-market auto intenders',
      account: { ...probeKey, currency: 'EUR' },
    });
    expect(withCurrency.result?.structuredContent?.adcp_error?.code).toBe('ACCOUNT_NOT_FOUND');

    // The exemption creates nothing: no account without brand_id appears.
    const listed = await callTool(url, 'list_accounts', { account: probeKey });
    const created = (listed.result?.structuredContent?.accounts ?? [])
      .filter(account => (account as { brand?: { brand_id?: string } }).brand?.brand_id === undefined);
    expect(created).toEqual([]);
  });
});
