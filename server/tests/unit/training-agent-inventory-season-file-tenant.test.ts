/**
 * An inventory tenant configured with a season file serves that season over
 * MCP. The env var is set before the router module loads, so this file keeps
 * `tenants/inventory.ts` out of its static imports.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/inventory-sim/small-season.yaml',
);
const ENV_VAR = 'TRAINING_AGENT_INVENTORY_ADSERVER_SEASON_FILE';
const previousSeasonFile = process.env[ENV_VAR];
process.env[ENV_VAR] = FIXTURE;
process.env.PUBLIC_TEST_AGENT_TOKEN = 'inventory-season-file-test-public-token';

import { stopSessionCleanup } from '../../src/training-agent/state.js';
import { setSandboxWallClockForTesting } from '../../src/training-agent/account-sandbox.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WALL_CLOCK = '2026-11-20T09:00:00Z';
const TOKEN = 'demo-inventory-season-file-v1';
const ACCOUNT = { brand: { domain: 'inventory-buyer.example' }, operator: 'inventory-buyer.example', sandbox: true };
const BRAND = { domain: 'inventory-buyer.example' };

type Structured = Record<string, any>;

describe('inventory tenant on a season file', () => {
  let server: http.Server;
  let baseUrl: string;
  let rpcId = 0;

  const call = async (tenant: string, name: string, args: Record<string, unknown>): Promise<Structured> => {
    rpcId += 1;
    const response = await fetch(`${baseUrl}/${tenant}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    const envelope = await response.json() as Record<string, any>;
    return (envelope.result?.structuredContent ?? { __envelope: envelope }) as Structured;
  };

  beforeAll(async () => {
    const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    baseUrl = `http://127.0.0.1:${address.port}/api/training-agent`;
    const offset = Date.parse(WALL_CLOCK) - Date.now();
    setSandboxWallClockForTesting(() => Date.now() + offset);
  }, 90_000);

  afterAll(async () => {
    if (previousSeasonFile === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = previousSeasonFile;
    setSandboxWallClockForTesting();
    stopSessionCleanup();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const tenant = 'inventory-adserver';

  it('returns exactly the fixture products with forecasts', async () => {
    const start = new Date(Date.parse(WALL_CLOCK.slice(0, 10)) + 2 * DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS - DAY_MS);
    const result = await call(tenant, 'get_products', {
      buying_mode: 'wholesale',
      account: ACCOUNT,
      brand: BRAND,
      filters: { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) },
    });
    expect(result.__envelope).toBeUndefined();
    const ids = result.products.map((product: Structured) => product.product_id).sort();
    expect(ids).toEqual(['banner_auction', 'banner_guaranteed']);
    for (const product of result.products) expect(product.forecast.points.length).toBeGreaterThan(0);
    const guaranteed = result.products.find((product: Structured) => product.product_id === 'banner_guaranteed');
    expect(guaranteed.pricing_options[0].fixed_price).toBe(8);
  });

  it('sells display only, as the fixture declares', async () => {
    const result = await call(tenant, 'get_products', { buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND });
    expect(result.__envelope).toBeUndefined();
    const channels = new Set(result.products.flatMap((product: Structured) => product.channels));
    expect([...channels]).toEqual(['display']);
    const capabilities = await call(tenant, 'get_adcp_capabilities', {});
    expect(capabilities.specialisms).toEqual(['sales-guaranteed', 'sales-non-guaranteed']);
  });
});
