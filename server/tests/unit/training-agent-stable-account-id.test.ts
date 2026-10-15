/**
 * account.stable_account_id (get_adcp_capabilities).
 *
 * The current v6 tenant routes declare the capability, so they must return
 * account_id on each non-failed sync_accounts provisioning row, accept
 * { account_id } wherever an AccountRef is accepted, key it to the same state
 * as the natural key, and never change the id for the life of the account.
 * The v5 /mcp and /mcp-strict* routes and the frozen 3.0 surface do not
 * declare it and keep the opaque `a:<account_id>` partition.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { clearAccountStore, clearProcessLocalAccountStore } from '../../src/training-agent/account-handlers.js';
import { clearReportingAccountBindingCacheForTesting } from '../../src/training-agent/reporting-reliability.js';
import {
  clearSessions,
  runWithAccountIdAliasScope,
  sessionKeyFromArgs,
  stopSessionCleanup,
} from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token';

const OTHER_PRINCIPAL_TOKEN = 'demo-stable-account-other-v1';

type Structured = Record<string, any> | undefined;

async function bootServer(
  options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {},
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter(options));
  const srv = http.createServer(app);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/training-agent`,
    close: () => new Promise(r => srv.close(() => r())),
  };
}

let rpcId = 1;

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
  token = 'test-token',
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  return response.json() as Promise<Record<string, any>>;
}

async function initialize(url: string, token = 'test-token'): Promise<void> {
  await rpc(url, 'initialize', {
    protocolVersion: '2025-03-26',
    clientInfo: { name: 'stable-account-id-test', version: '1' },
    capabilities: {},
  }, token);
}

async function callTool(
  url: string,
  name: string,
  args: Record<string, unknown>,
  token = 'test-token',
): Promise<Structured> {
  return (await rpc(url, 'tools/call', { name, arguments: args }, token)).result?.structuredContent;
}

const naturalKey = {
  brand: { domain: 'acmeoutdoor.example' },
  operator: 'pinnacle-agency.example',
  operator_unit: { id: 'stable-account-id-unit' },
  sandbox: true,
};

const ALL_STATUSES = ['pending_creatives', 'pending_start', 'active', 'paused', 'completed', 'rejected', 'canceled'];

async function provision(url: string, idempotencyKey: string, token = 'test-token'): Promise<string> {
  const synced = await callTool(url, 'sync_accounts', {
    accounts: [{ ...naturalKey, billing: 'operator' }],
    idempotency_key: idempotencyKey,
  }, token);
  const accountId = synced?.accounts?.[0]?.account_id;
  expect(accountId, JSON.stringify(synced)).toEqual(expect.any(String));
  return accountId as string;
}

async function createBuy(
  url: string,
  account: Record<string, unknown>,
  idempotencyKey: string,
): Promise<string> {
  const products = await callTool(url, 'get_products', {
    buying_mode: 'brief',
    brief: 'Outdoor lifestyle video inventory for adults 25-54 in the US.',
    account,
  });
  expect(products?.adcp_error).toBeUndefined();
  const product = (products?.products as Array<Record<string, any>>)
    .find(candidate => candidate.pricing_options?.[0]?.pricing_option_id);
  expect(product).toBeDefined();
  const pricing = product!.pricing_options[0];
  const created = await callTool(url, 'create_media_buy', {
    account,
    total_budget: { amount: 6000, currency: 'USD' },
    start_time: '2027-06-01T00:00:00Z',
    end_time: '2027-06-30T23:59:59Z',
    packages: [{
      product_id: product!.product_id,
      pricing_option_id: pricing.pricing_option_id,
      budget: 6000,
      bid_price: Math.max(pricing.floor_price ?? pricing.fixed_price ?? 1, 1),
    }],
    idempotency_key: idempotencyKey,
  });
  expect(created?.adcp_error).toBeUndefined();
  expect(created?.media_buy_id).toEqual(expect.any(String));
  return created!.media_buy_id as string;
}

async function listBuyIds(
  url: string,
  account: Record<string, unknown>,
  token = 'test-token',
): Promise<string[]> {
  const buys = await callTool(url, 'get_media_buys', { account, status_filter: ALL_STATUSES }, token);
  expect(buys?.adcp_error).toBeUndefined();
  return (buys?.media_buys as Array<{ media_buy_id: string }>).map(buy => buy.media_buy_id).sort();
}

describe('training agent: account.stable_account_id', () => {
  let server: Awaited<ReturnType<typeof bootServer>>;

  beforeEach(async () => {
    clearSessions();
    clearAccountStore();
    // The first boot imports the whole training agent; allow for a loaded host.
    server = await bootServer();
  }, 60_000);

  afterEach(async () => {
    await server.close();
    clearSessions();
    clearAccountStore();
    stopSessionCleanup();
  });

  it('declares the capability only on the current v6 tenant routes', async () => {
    for (const path of ['sales/mcp', 'signals/mcp', 'creative/mcp']) {
      const url = `${server.baseUrl}/${path}`;
      await initialize(url);
      const caps = await callTool(url, 'get_adcp_capabilities', { adcp_version: '3.2' });
      expect(caps?.account?.stable_account_id, path).toBe(true);
    }
    // The v5 monolith neither aliases nor rehydrates, so it must not declare.
    for (const path of ['mcp', 'sales/mcp-strict']) {
      const url = `${server.baseUrl}/${path}`;
      await initialize(url);
      const caps = await callTool(url, 'get_adcp_capabilities', { adcp_version: '3.2' });
      expect(caps?.account, path).toBeDefined();
      expect(caps?.account, path).not.toHaveProperty('stable_account_id');
    }
  });

  it('keeps one account_id across provisioning, re-sync, settings updates, and routes', async () => {
    const salesUrl = `${server.baseUrl}/sales/mcp`;
    await initialize(salesUrl);

    const created = await callTool(salesUrl, 'sync_accounts', {
      accounts: [{ ...naturalKey, billing: 'operator' }],
      idempotency_key: 'stable-account-id-sync-0001',
    });
    expect(created?.accounts?.[0]?.action).toBe('created');
    const accountId = created?.accounts?.[0]?.account_id as string;
    expect(accountId).toEqual(expect.any(String));

    const resynced = await callTool(salesUrl, 'sync_accounts', {
      accounts: [{ ...naturalKey, billing: 'agent' }],
      idempotency_key: 'stable-account-id-sync-0002',
    });
    expect(resynced?.accounts?.[0]).toMatchObject({ action: 'updated', account_id: accountId });

    const updated = await callTool(salesUrl, 'sync_accounts', {
      accounts: [{ account: { account_id: accountId }, payment_terms: 'net_60' }],
      idempotency_key: 'stable-account-id-sync-0003',
    });
    expect(updated?.accounts?.[0]).toMatchObject({ action: 'updated', account_id: accountId });

    // Accounts are shared across tenants: another route reports the same id.
    const signalsUrl = `${server.baseUrl}/signals/mcp`;
    await initialize(signalsUrl);
    const crossRoute = await callTool(signalsUrl, 'sync_accounts', {
      accounts: [{ ...naturalKey, billing: 'operator' }],
      idempotency_key: 'stable-account-id-sync-0004',
    });
    expect(crossRoute?.accounts?.[0]).toMatchObject({ action: 'updated', account_id: accountId });

    const byNaturalKey = await callTool(salesUrl, 'list_accounts', { account: naturalKey });
    expect(byNaturalKey?.accounts?.map((account: { account_id?: string }) => account.account_id)).toEqual([accountId]);
  });

  it('resolves { account_id } for a buyer-declared account on account-scoped tasks', async () => {
    const url = `${server.baseUrl}/sales/mcp`;
    await initialize(url);
    const accountId = await provision(url, 'stable-account-id-sync-0010');
    const byId = { account_id: accountId };

    const listed = await callTool(url, 'list_accounts', { account: byId });
    expect(listed?.accounts).toHaveLength(1);
    expect(listed?.accounts?.[0]).toMatchObject({
      account_id: accountId,
      brand: { domain: naturalKey.brand.domain },
      operator: naturalKey.operator,
      operator_unit: { id: naturalKey.operator_unit.id },
    });

    const mediaBuyId = await createBuy(url, byId, 'stable-account-id-create-0001');
    const delivery = await callTool(url, 'get_media_buy_delivery', { account: byId, media_buy_ids: [mediaBuyId] });
    expect(delivery?.adcp_error).toBeUndefined();
    expect(delivery?.media_buy_deliveries).toHaveLength(1);
  });

  it('keys { account_id } and the natural key to one account state, including after rehydration', async () => {
    const url = `${server.baseUrl}/sales/mcp`;
    await initialize(url);
    const byId = { account_id: await provision(url, 'stable-account-id-sync-0020') };

    // Writes under both references land in one partition, so each reference
    // lists both. With separate partitions neither read falls back, because
    // each partition is non-empty.
    const naturalBuy = await createBuy(url, naturalKey, 'stable-account-id-create-0020');
    const idBuy = await createBuy(url, byId, 'stable-account-id-create-0021');
    const both = [naturalBuy, idBuy].sort();
    expect(await listBuyIds(url, naturalKey)).toEqual(both);
    expect(await listBuyIds(url, byId)).toEqual(both);

    // Simulate a different machine: drop the process-local account store and
    // the binding cache, keeping only the durable ledger. The id must still
    // reach the same state through the ledger scan.
    clearProcessLocalAccountStore();
    clearReportingAccountBindingCacheForTesting();
    const thirdBuy = await createBuy(url, byId, 'stable-account-id-create-0022');
    const all = [...both, thirdBuy].sort();
    expect(await listBuyIds(url, byId)).toEqual(all);
    expect(await listBuyIds(url, naturalKey)).toEqual(all);
  });

  it('does not alias another principal\'s account_id into that principal\'s account', async () => {
    const url = `${server.baseUrl}/sales/mcp`;
    await initialize(url);
    const ownerId = await provision(url, 'stable-account-id-sync-0030');
    const ownerBuy = await createBuy(url, naturalKey, 'stable-account-id-create-0030');

    // A second principal writes under the owner's id. Its alias lookup is
    // scoped to its own accounts, so the write stays in the opaque partition
    // instead of landing in the owner's natural partition.
    await initialize(url, OTHER_PRINCIPAL_TOKEN);
    const products = await callTool(url, 'get_products', {
      buying_mode: 'brief',
      brief: 'Outdoor lifestyle video inventory for adults 25-54 in the US.',
      account: { account_id: ownerId },
    }, OTHER_PRINCIPAL_TOKEN);
    const product = (products?.products as Array<Record<string, any>>)
      .find(candidate => candidate.pricing_options?.[0]?.pricing_option_id);
    const pricing = product!.pricing_options[0];
    const intruderBuy = await callTool(url, 'create_media_buy', {
      account: { account_id: ownerId },
      total_budget: { amount: 6000, currency: 'USD' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-06-30T23:59:59Z',
      packages: [{
        product_id: product!.product_id,
        pricing_option_id: pricing.pricing_option_id,
        budget: 6000,
        bid_price: Math.max(pricing.floor_price ?? pricing.fixed_price ?? 1, 1),
      }],
      idempotency_key: 'stable-account-id-create-0031',
    }, OTHER_PRINCIPAL_TOKEN);
    expect(intruderBuy?.media_buy_id).toEqual(expect.any(String));

    expect(await listBuyIds(url, naturalKey)).toEqual([ownerBuy]);
    expect(await listBuyIds(url, { account_id: ownerId })).toEqual([ownerBuy]);
  });

  it('refuses to seed a built-in compliance fixture account_id', async () => {
    const url = `${server.baseUrl}/sales/mcp`;
    await initialize(url);
    const seeded = await callTool(url, 'comply_test_controller', {
      account: { brand: { domain: 'victim.example' }, operator: 'victim.example', sandbox: true },
      scenario: 'seed_account',
      params: {
        account_id: 'acc_luma_shared',
        fixture: {
          brand: { domain: 'victim.example' },
          operator: 'victim.example',
          billing: 'operator',
          sandbox: true,
        },
      },
    });
    expect(seeded?.success, JSON.stringify(seeded)).toBe(false);
    expect(JSON.stringify(seeded)).toContain('acc_luma_shared');
  });

  it('lands a controller seed by account_id in the buyer partition for static credentials', async () => {
    const url = `${server.baseUrl}/sales/mcp`;
    await initialize(url);
    const accountId = await provision(url, 'stable-account-id-sync-0040');
    const byId = { account_id: accountId };
    // Make the natural partition non-empty so a split cannot be masked by
    // the empty-session read fallback.
    const naturalBuy = await createBuy(url, naturalKey, 'stable-account-id-create-0040');

    const seeded = await callTool(url, 'comply_test_controller', {
      account: { ...byId, sandbox: true },
      scenario: 'seed_media_buy',
      params: {
        media_buy_id: 'stable_account_id_seeded_buy',
        fixture: { status: 'active', currency: 'USD' },
      },
    });
    expect(seeded?.success, JSON.stringify(seeded)).toBe(true);

    const expected = [naturalBuy, 'stable_account_id_seeded_buy'].sort();
    expect(await listBuyIds(url, byId)).toEqual(expected);
    expect(await listBuyIds(url, naturalKey)).toEqual(expected);
  });

  it('omits the capability from the frozen 3.0 compatibility surface', async () => {
    const compat = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const url = `${compat.baseUrl}/sales/mcp`;
      await initialize(url);
      const caps = await callTool(url, 'get_adcp_capabilities', {});
      expect(caps?.account).toBeDefined();
      expect(caps?.account).not.toHaveProperty('stable_account_id');
    } finally {
      await compat.close();
    }
  });

  it('aliases session keys only inside the principal-scoped alias context', async () => {
    const url = `${server.baseUrl}/sales/mcp`;
    await initialize(url);
    const accountId = await provision(url, 'stable-account-id-sync-0050');
    const byIdArgs = { account: { account_id: accountId } };

    // Outside a scope (v5 routes, frozen 3.0 surface) the id keeps `a:<id>`.
    expect(sessionKeyFromArgs(byIdArgs, 'open')).toBe(`open:a:${accountId}`);
    // Another principal's scope does not resolve this principal's id.
    expect(runWithAccountIdAliasScope('static:demo:someone-else', () => sessionKeyFromArgs(byIdArgs, 'open')))
      .toBe(`open:a:${accountId}`);
    // The owner's scope keys the id exactly as its natural key.
    expect(runWithAccountIdAliasScope('static:public', () => sessionKeyFromArgs(byIdArgs, 'open')))
      .toBe(sessionKeyFromArgs({ account: naturalKey }, 'open'));
  });
});
