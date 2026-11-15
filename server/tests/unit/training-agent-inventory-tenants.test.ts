/**
 * #9025 part B: the training agent's inventory tenants over MCP. Products
 * carry engine forecasts, buys book into the caller's simulated market, and
 * every response matches the canonical AdCP schema for its task.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { getCanonicalToolValidator } from '@adcp/sdk/schemas';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'inventory-tenants-test-public-token';

import { stopSessionCleanup } from '../../src/training-agent/state.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = 'demo-inventory-tenants-v1';
const ACCOUNT = { brand: { domain: 'inventory-buyer.example' }, operator: 'inventory-buyer.example', sandbox: true };
const BRAND = { domain: 'inventory-buyer.example' };

type Structured = Record<string, any>;

function expectCanonical(tool: string, value: Structured): void {
  const validate = getCanonicalToolValidator(tool, 'sync', { adcpVersion: '3.2' }) as
    | (((payload: unknown) => boolean) & { errors?: unknown })
    | undefined;
  expect(validate, `no canonical validator for ${tool}`).toBeDefined();
  if (value.adcp_error || value.__envelope) throw new Error(`${tool} failed: ${JSON.stringify(value).slice(0, 1500)}`);
  const ok = validate!(value);
  expect(ok, `${tool}: ${JSON.stringify(validate!.errors)?.slice(0, 1500)}`).toBe(true);
}

describe('inventory tenants', () => {
  let server: http.Server;
  let baseUrl: string;
  let rpcId = 0;

  const call = async (tenant: string, name: string, args: Record<string, unknown>, token = TOKEN): Promise<Structured> => {
    rpcId += 1;
    const response = await fetch(`${baseUrl}/${tenant}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
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
  }, 90_000);

  afterAll(async () => {
    stopSessionCleanup();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  describe('/inventory-adserver', () => {
    const tenant = 'inventory-adserver';
    const start = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS + 2 * DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const day = (date: Date) => date.toISOString().slice(0, 10);

    it('declares a media-buy seller with guaranteed and non-guaranteed specialisms', async () => {
      const capabilities = await call(tenant, 'get_adcp_capabilities', {});
      expect(capabilities.supported_protocols).toContain('media_buy');
      expect(capabilities.specialisms).toEqual(expect.arrayContaining(['sales-guaranteed', 'sales-non-guaranteed']));
    });

    it('returns products with forecasts for the requested flight', async () => {
      const result = await call(tenant, 'get_products', {
        buying_mode: 'wholesale',
        account: ACCOUNT,
        brand: BRAND,
        filters: { start_date: day(start), end_date: day(new Date(end.getTime() - DAY_MS)) },
      });
      expectCanonical("get_products", result);
      const ids = result.products.map((product: Structured) => product.product_id);
      expect(ids).toEqual(expect.arrayContaining(['homepage_takeover_daily', 'ros_display_guaranteed', 'ros_display_auction']));
      const guaranteed = result.products.find((product: Structured) => product.product_id === 'ros_display_guaranteed');
      expect(guaranteed.delivery_type).toBe('guaranteed');
      expect(guaranteed.forecast.method).toBe('guaranteed');
      expect(guaranteed.forecast.points[0].metrics.impressions.mid).toBeGreaterThan(1_000_000);
      expect(guaranteed.pricing_options[0].fixed_price).toBe(9);
      const auction = result.products.find((product: Structured) => product.product_id === 'ros_display_auction');
      expect(auction.pricing_options[0].floor_price).toBe(2);
    });

    it('books a guaranteed and a non-guaranteed buy, reduces the forecast, and pauses one', async () => {
      const before = await call(tenant, 'get_products', {
        buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND, filters: { start_date: day(start), end_date: day(new Date(end.getTime() - DAY_MS)), delivery_type: 'guaranteed' },
      });
      const available = (products: Structured[]) =>
        products.find(product => product.product_id === 'sports_hero_guaranteed').forecast.points[0].metrics.impressions.mid as number;

      const guaranteed = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-tenants-guaranteed-0001',
        account: ACCOUNT,
        brand: BRAND,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        packages: [{ product_id: 'sports_hero_guaranteed', pricing_option_id: 'sports_hero_guaranteed_cpm', budget: 2000, impressions: 100_000 }],
      });
      expectCanonical('create_media_buy', guaranteed);
      expect(guaranteed.media_buy_status).toBe('pending_start');
      expect(guaranteed.packages[0].impressions).toBe(100_000);

      const after = await call(tenant, 'get_products', {
        buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND, filters: { start_date: day(start), end_date: day(new Date(end.getTime() - DAY_MS)), delivery_type: 'guaranteed' },
      });
      expect(available(before.products) - available(after.products)).toBeGreaterThan(95_000);

      const auction = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-tenants-auction-00001',
        account: ACCOUNT,
        brand: BRAND,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        packages: [{
          product_id: 'ros_display_auction', pricing_option_id: 'ros_display_auction_cpm', budget: 5000, bid_price: 3,
          targeting_overlay: { geo_countries: ['CA'] },
        }],
      });
      expectCanonical('create_media_buy', auction);

      const listed = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [guaranteed.media_buy_id, auction.media_buy_id] });
      expectCanonical('get_media_buys', listed);
      expect(listed.media_buys).toHaveLength(2);

      const paused = await call(tenant, 'update_media_buy', {
        idempotency_key: 'inventory-tenants-pause-0000001',
        account: ACCOUNT,
        media_buy_id: auction.media_buy_id,
        paused: true,
      });
      expectCanonical('update_media_buy', paused);
      expect(paused.media_buy_status).toBe('paused');
      expect(paused.revision).toBe(2);

      const delivery = await call(tenant, 'get_media_buy_delivery', { account: ACCOUNT, media_buy_ids: [guaranteed.media_buy_id] });
      expectCanonical('get_media_buy_delivery', delivery);
      expect(delivery.media_buy_deliveries[0].totals.impressions).toBe(0);
    });

    it('refuses an unknown product and a wrong pricing option', async () => {
      const unknown = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-tenants-unknown-00001',
        account: ACCOUNT, brand: BRAND, start_time: start.toISOString(), end_time: end.toISOString(),
        packages: [{ product_id: 'nope', pricing_option_id: 'nope_cpm', budget: 100 }],
      });
      expect(unknown.errors?.[0]?.code).toBe('PRODUCT_NOT_FOUND');
      const wrongPrice = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-tenants-wrongprice-01',
        account: ACCOUNT, brand: BRAND, start_time: start.toISOString(), end_time: end.toISOString(),
        packages: [{ product_id: 'ros_display_guaranteed', pricing_option_id: 'other', budget: 100 }],
      });
      expect(wrongPrice.errors?.[0]?.code).toBe('INVALID_PRICING_OPTION');
    });
  });

});
