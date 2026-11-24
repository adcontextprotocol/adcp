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

import { flushDirtySessions, runWithSessionContext, stopSessionCleanup } from '../../src/training-agent/state.js';
import { setSandboxWallClockForTesting } from '../../src/training-agent/account-sandbox.js';
import { resetReportingSubscriptionProbe } from '../../src/training-agent/subscription-probe.js';
import { getAgentUrl } from '../../src/training-agent/config.js';
import { ENGINE_VERSION } from '../../src/training-agent/inventory-sim/engine/index.js';
import { seasonFingerprint } from '../../src/training-agent/inventory-sim/season-file.js';
import { INVENTORY_TENANT_PROFILES } from '../../src/training-agent/tenants/inventory.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Where an unpinned sandbox clock starts, so the seeds' scripted 2027
 * events stay ahead of it whenever the suite runs. */
const WALL_CLOCK = '2026-11-20T09:00:00Z';
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

  /** A storefront's first call: provision the buyer's account, so get_products
   * can price for it. */
  const provision = async (token: string) => {
    const synced = await call('inventory-adserver', 'sync_accounts', {
      idempotency_key: `inventory-tenants-provision-${token}`,
      accounts: [{ ...ACCOUNT, billing: 'operator' }],
    }, token);
    if (synced.adcp_error || synced.__envelope) throw new Error(`sync_accounts failed: ${JSON.stringify(synced).slice(0, 500)}`);
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
    setSandboxWallClockForTesting();
    stopSessionCleanup();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  describe('/inventory-adserver', () => {
    const tenant = 'inventory-adserver';
    beforeAll(() => provision(TOKEN));
    const start = new Date(Date.parse(WALL_CLOCK.slice(0, 10)) + 2 * DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const day = (date: Date) => date.toISOString().slice(0, 10);

    it('declares a media-buy seller with guaranteed and non-guaranteed specialisms', async () => {
      const capabilities = await call(tenant, 'get_adcp_capabilities', {});
      expect(capabilities.supported_protocols).toContain('media_buy');
      expect(capabilities.specialisms).toEqual(expect.arrayContaining(['sales-guaranteed', 'sales-non-guaranteed']));
      // A storefront reads an inventory agent as a wholesale catalogue, with
      // its own credential rather than a per-buyer operator.
      expect(capabilities.media_buy.buying_modes).toEqual(expect.arrayContaining(['brief', 'wholesale']));
      // false is the schema default, so the SDK may omit it.
      expect(capabilities.account.require_operator_auth ?? false).toBe(false);
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
      // No package has a creative yet, so none can begin delivery.
      expect(guaranteed.media_buy_status).toBe('pending_creatives');
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

    it('echoes each package context unchanged on create, read-back and update', async () => {
      const context = { buyer_ref: 'sf_pkg_0001', nested: { trace: ['a', 1, null], flag: false } };
      const created = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-tenants-pkg-context-01',
        account: ACCOUNT,
        brand: BRAND,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        packages: [{ product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 1000, impressions: 40_000, context }],
      });
      expectCanonical('create_media_buy', created);
      expect(created.packages[0].context).toEqual(context);

      const listed = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [created.media_buy_id] });
      expectCanonical('get_media_buys', listed);
      expect(listed.media_buys[0].packages[0].context).toEqual(context);

      const replaced = { buyer_ref: 'sf_pkg_0001_v2' };
      const updated = await call(tenant, 'update_media_buy', {
        idempotency_key: 'inventory-tenants-pkg-context-02',
        account: ACCOUNT,
        media_buy_id: created.media_buy_id,
        packages: [{ package_id: created.packages[0].package_id, context: replaced }],
      });
      expectCanonical('update_media_buy', updated);
      expect(updated.affected_packages[0].context).toEqual(replaced);
      const reread = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [created.media_buy_id] });
      expect(reread.media_buys[0].packages[0].context).toEqual(replaced);
    });

    it('echoes the media buy context unchanged on create and every read-back', async () => {
      const context = { storefront_media_buy_id: 'sf_mb_0001', nested: { trace: ['a', 1, null], flag: false } };
      const created = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-tenants-buy-context-01',
        account: ACCOUNT,
        brand: BRAND,
        context,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        packages: [{ product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 1000, impressions: 40_000 }],
      });
      expectCanonical('create_media_buy', created);
      expect(created.context).toEqual(context);

      const listed = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [created.media_buy_id] });
      expectCanonical('get_media_buys', listed);
      expect(listed.media_buys[0].context).toEqual(context);

      // An update's context is its own operation's, echoed on its response;
      // it never replaces the buy's.
      const operation = { request_ref: 'update-0001' };
      const updated = await call(tenant, 'update_media_buy', {
        idempotency_key: 'inventory-tenants-buy-context-02',
        account: ACCOUNT,
        media_buy_id: created.media_buy_id,
        context: operation,
        paused: true,
      });
      expectCanonical('update_media_buy', updated);
      expect(updated.context).toEqual(operation);
      const reread = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [created.media_buy_id] });
      expect(reread.media_buys[0].context).toEqual(context);

      const plain = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-tenants-buy-context-03',
        account: ACCOUNT,
        brand: BRAND,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        packages: [{ product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 1000, impressions: 40_000 }],
      });
      const plainRead = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [plain.media_buy_id] });
      expect(plainRead.media_buys[0]).not.toHaveProperty('context');
    });

    it('answers an account-less wholesale read with the public card', async () => {
      const filters = { start_date: day(start), end_date: day(new Date(end.getTime() - DAY_MS)), delivery_type: 'guaranteed' };
      const hero = (result: Structured) => result.products.find((product: Structured) => product.product_id === 'sports_hero_guaranteed')
        .forecast.points[0].metrics.impressions.mid as number;
      const open = await call(tenant, 'get_products', { buying_mode: 'wholesale', filters });
      expectCanonical('get_products', open);
      expect(open.cache_scope).toBe('public');
      const scoped = await call(tenant, 'get_products', { buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND, filters });
      expect(scoped.cache_scope).toBe('account');
      // The earlier test booked 100,000 hero impressions in this caller's
      // market; only the account-scoped forecast nets them out.
      expect(hero(open) - hero(scoped)).toBeGreaterThan(95_000);
    });

    it('answers ACCOUNT_NOT_FOUND for an account it never provisioned, and prices it once synced', async () => {
      // The public token is one caller; its own flow (sync, then discover)
      // is the one a storefront runs.
      const token = process.env.PUBLIC_TEST_AGENT_TOKEN!;
      const account = { brand: { domain: 'never-synced-inventory.example' }, operator: 'unprovisioned-agency.example', sandbox: true };
      const filters = { start_date: day(start), end_date: day(new Date(end.getTime() - DAY_MS)) };
      const rejected = await call(tenant, 'get_products', { buying_mode: 'wholesale', account, filters }, token);
      expect(rejected.adcp_error?.code).toBe('ACCOUNT_NOT_FOUND');
      expect(rejected).not.toHaveProperty('products');

      // The read did not provision it.
      const again = await call(tenant, 'get_products', { buying_mode: 'wholesale', account, filters }, token);
      expect(again.adcp_error?.code).toBe('ACCOUNT_NOT_FOUND');

      const synced = await call(tenant, 'sync_accounts', {
        idempotency_key: 'inventory-tenants-unprovisioned-sync-01', accounts: [{ ...account, billing: 'operator' }],
      }, token);
      expect(synced.adcp_error).toBeUndefined();
      const priced = await call(tenant, 'get_products', { buying_mode: 'wholesale', account, filters }, token);
      expectCanonical('get_products', priced);
      expect(priced.cache_scope).toBe('account');

      // Without an account, discovery still answers with the public card.
      const open = await call(tenant, 'get_products', { buying_mode: 'wholesale', filters }, token);
      expectCanonical('get_products', open);
      expect(open.cache_scope).toBe('public');
    });

    it('filters by format_option_refs and pages with max_results and a cursor', async () => {
      const filters = { format_option_refs: [{ scope: 'product', format_option_id: 'display_300x250_image' }] };
      const all = await call(tenant, 'get_products', { buying_mode: 'wholesale', filters });
      expectCanonical('get_products', all);
      const serving = all.products.map((product: Structured) => product.product_id);
      expect(serving).toEqual(['ros_display_guaranteed', 'sports_fans_display_guaranteed', 'ros_display_auction']);
      // Without pagination the response is unchanged: every match, no pagination block.
      expect(all).not.toHaveProperty('pagination');

      const first = await call(tenant, 'get_products', { buying_mode: 'wholesale', filters, pagination: { max_results: 2 } });
      expectCanonical('get_products', first);
      expect(first.products.map((product: Structured) => product.product_id)).toEqual(serving.slice(0, 2));
      expect(first.pagination).toMatchObject({ has_more: true, total_count: 3 });
      const second = await call(tenant, 'get_products', {
        buying_mode: 'wholesale', filters, pagination: { max_results: 2, cursor: first.pagination.cursor },
      });
      expect(second.products.map((product: Structured) => product.product_id)).toEqual(serving.slice(2));
      expect(second.pagination).toEqual({ has_more: false, total_count: 3 });

      const malformed = await call(tenant, 'get_products', { buying_mode: 'wholesale', filters, pagination: { cursor: 'not-a-cursor' } });
      expect(malformed.adcp_error?.code ?? malformed.errors?.[0]?.code).toBe('INVALID_REQUEST');
    });

    it('answers NOT_CANCELLABLE to a second cancel, and INVALID_STATE to any other change after one', async () => {
      const create = (key: string) => call(tenant, 'create_media_buy', {
        idempotency_key: key, account: ACCOUNT, brand: BRAND, start_time: start.toISOString(), end_time: end.toISOString(),
        packages: [
          { product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 100 },
          { product_id: 'ros_display_auction', pricing_option_id: 'ros_display_auction_cpm', budget: 100 },
        ],
      });
      const update = (key: string, patch: Record<string, unknown>) => call(tenant, 'update_media_buy', {
        idempotency_key: key, account: ACCOUNT, ...patch,
      });

      const buy = await create('inventory-tenants-recancel-buy-01');
      expect((await update('inventory-tenants-recancel-first-01', { media_buy_id: buy.media_buy_id, canceled: true })).media_buy_status).toBe('canceled');
      const again = await update('inventory-tenants-recancel-again-01', { media_buy_id: buy.media_buy_id, canceled: true });
      expect(again.adcp_error ?? again.errors?.[0]).toMatchObject({ code: 'NOT_CANCELLABLE' });
      const paused = await update('inventory-tenants-recancel-pause-01', { media_buy_id: buy.media_buy_id, paused: true });
      expect((paused.adcp_error ?? paused.errors?.[0])?.code).toBe('INVALID_STATE');

      const other = await create('inventory-tenants-recancel-buy-02');
      const pkg = other.packages[0].package_id;
      await update('inventory-tenants-recancel-pkg-first', { media_buy_id: other.media_buy_id, packages: [{ package_id: pkg, canceled: true }] });
      const pkgAgain = await update('inventory-tenants-recancel-pkg-again', { media_buy_id: other.media_buy_id, packages: [{ package_id: pkg, canceled: true }] });
      expect(pkgAgain.adcp_error ?? pkgAgain.errors?.[0]).toMatchObject({ code: 'NOT_CANCELLABLE', field: 'packages[0].canceled' });
      const pkgBudget = await update('inventory-tenants-recancel-pkg-budget', { media_buy_id: other.media_buy_id, packages: [{ package_id: pkg, budget: 200 }] });
      expect((pkgBudget.adcp_error ?? pkgBudget.errors?.[0])?.code).toBe('INVALID_STATE');
    });

    it('filters by required_metrics, keeping only products that report every one', async () => {
      const ids = async (required: string[]) => (await call(tenant, 'get_products', {
        buying_mode: 'wholesale', filters: { required_metrics: required },
      })).products.map((product: Structured) => product.product_id);
      expect(await ids(['completed_views'])).toEqual(['preroll_guaranteed', 'preroll_auction']);
      // The season declares the viewable_impressions leaf, not the viewability
      // container, so it cannot satisfy the sibling viewable_rate leaf.
      expect(await ids(['viewable_rate'])).toEqual([]);
      expect((await ids([])).length).toBeGreaterThan(2);
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

    it('reports a negative budget as invalid before looking the product up', async () => {
      const negative = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-tenants-negative-00001',
        account: ACCOUNT, brand: BRAND, start_time: start.toISOString(), end_time: end.toISOString(),
        packages: [{ product_id: 'nope', pricing_option_id: 'nope_cpm', budget: -500 }],
      });
      expect(negative.errors?.[0]).toMatchObject({ code: 'INVALID_REQUEST', field: 'packages[0].budget' });
    });
  });

  describe('sandbox_clock on the inventory tenants', () => {
    const tenant = 'inventory-adserver';
    const CLOCK_TOKEN = 'demo-inventory-clock-v1';
    beforeAll(() => provision(CLOCK_TOKEN));
    const controller = (params: Record<string, unknown>, scenario = 'sandbox_clock') =>
      call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, CLOCK_TOKEN);
    const flight = { start_time: '2027-01-01T00:00:00Z', end_time: '2027-01-31T00:00:00Z' };

    it('is listed and discoverable', async () => {
      const listed = await call(tenant, 'comply_test_controller', { scenario: 'list_scenarios', account: ACCOUNT }, CLOCK_TOKEN);
      expect(listed.scenarios).toEqual(expect.arrayContaining(['sandbox_clock', 'reset_state']));
      const capabilities = await call(tenant, 'get_adcp_capabilities', {}, CLOCK_TOKEN);
      expect(capabilities.compliance_testing.scenarios).toEqual(expect.arrayContaining(['sandbox_clock', 'reset_state']));
    });

    it('delivers a month of buys over simulated time', async () => {
      const initial = await controller({ operation: 'get' });
      expect(initial.success).toBe(true);
      expect(initial.simulated.simulated_now.slice(0, 10)).toBe(WALL_CLOCK.slice(0, 10));
      expect(initial.simulated.pinned).toBe(false);
      expect(initial.simulated.seed_id).toBe(INVENTORY_TENANT_PROFILES[tenant].seed.seed_id);
      expect(initial.simulated.season_fingerprint).toBe(seasonFingerprint(INVENTORY_TENANT_PROFILES[tenant].seed));
      expect(initial.simulated.engine_version).toBe(ENGINE_VERSION);

      const pinned = await controller({ operation: 'advance_time', to: '2026-12-31T12:00:00Z' });
      expect(pinned.simulated.simulated_now).toBe('2026-12-31T12:00:00.000Z');

      const guaranteed = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-clock-guaranteed-00001', account: ACCOUNT, brand: BRAND, ...flight,
        packages: [{ product_id: 'sports_hero_guaranteed', pricing_option_id: 'sports_hero_guaranteed_cpm', budget: 3000, impressions: 180_000 }],
      }, CLOCK_TOKEN);
      expectCanonical('create_media_buy', guaranteed);
      const forecast = await call(tenant, 'get_products', {
        buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND,
        filters: { start_date: '2027-01-01', end_date: '2027-01-30', delivery_type: 'non_guaranteed' },
      }, CLOCK_TOKEN);
      const forecastMid = forecast.products.find((product: Structured) => product.product_id === 'preroll_auction')
        .forecast.points[0].metrics.impressions.mid as number;
      // A budget no day can spend: the bid takes every pre-roll impression
      // that arrives, so its delivery is the actual traffic.
      const auction = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-clock-auction-0000001', account: ACCOUNT, brand: BRAND, ...flight,
        packages: [{ product_id: 'preroll_auction', pricing_option_id: 'preroll_auction_cpm', budget: 1_000_000, bid_price: 10 }],
      }, CLOCK_TOKEN);
      expectCanonical('create_media_buy', auction);

      const advanced = await controller({ operation: 'advance_time', by: 'P31D' });
      expect(advanced.success).toBe(true);
      expect(advanced.simulated.simulated_now).toBe('2027-01-31T12:00:00.000Z');
      expect(advanced.simulated.days_crossed).toBe(31);
      expect(advanced.simulated).toMatchObject({ seed_id: initial.simulated.seed_id, season_fingerprint: initial.simulated.season_fingerprint, engine_version: ENGINE_VERSION });

      const delivery = await call(tenant, 'get_media_buy_delivery', {
        account: ACCOUNT, media_buy_ids: [guaranteed.media_buy_id, auction.media_buy_id],
      }, CLOCK_TOKEN);
      expectCanonical('get_media_buy_delivery', delivery);
      const [g, a] = delivery.media_buy_deliveries;
      expect(g.status).toBe('completed');

      // The hero unit loses three quarters of its traffic 2027-01-08..12 and
      // the guarantee falls behind, then catches up on the days after.
      const daily = new Map<string, number>(g.daily_breakdown.map((row: Structured) => [row.date, row.impressions]));
      expect(daily.get('2027-01-09')!).toBeLessThan(daily.get('2027-01-06')! / 2);
      const average = (from: number, to: number) => {
        let total = 0;
        for (let d = from; d <= to; d++) total += daily.get(`2027-01-${String(d).padStart(2, '0')}`)!;
        return total / (to - from + 1);
      };
      expect(average(13, 30)).toBeGreaterThan(average(1, 7) * 1.1);
      expect(g.totals.impressions).toBeGreaterThan(180_000 * 0.97);
      expect(g.totals.impressions).toBeLessThanOrEqual(180_000);

      // Actual traffic differs from the forecast, within the model's error. The
      // forecast is read on 2026-12-31 (day 60 of the season) for 30 January
      // days, so lead times run 1 to 30 days. ln(actual / forecast) over the
      // flight is:
      //  - the publisher bias, -0.02 on both publishers;
      //  - the election spike, a scripted truth-only event: 1.8x on Pinnacle
      //    News for 3 of 30 days, and Pinnacle carries about 0.64 of the
      //    pre-roll forecast (Summit Sports has traffic_multiplier 0.6), so
      //    ln(1 + 0.8 * 0.064) = +0.049;
      //  - the second-order mean of a log of a sum, 1/2 (sum w v - V) = +0.006,
      //    with weights w = F / W and v the unknown variance of a cell-day;
      //  - the error nobody can see yet, zero-mean with variance V = 0.00123
      //    (sd 0.035): per publisher, the same-day AR(1) shock beyond what the
      //    closed days reveal, with variance a^2 (1 - phi^(2(h+1))), plus the
      //    revision shocks, a^2 min(h, 60) / 14, at a = 0.06 and phi = 0.85,
      //    averaged over 30 days and over two independent publishers; the cell
      //    shock (cell_kappa 3.08) and the daily wobble add about 0.00003 to V.
      // The centre is -0.02 + 0.049 + 0.006 = +0.035 and the bound is three sd
      // either side. The ln 2 log clip is far outside it, so it does not bind.
      const logError = Math.log(a.totals.impressions / forecastMid);
      expect(a.totals.impressions).not.toBe(forecastMid);
      expect(logError).toBeGreaterThan(0.035 - 3 * 0.035);
      expect(logError).toBeLessThan(0.035 + 3 * 0.035);
      expect(a.totals.spend).toBeCloseTo((a.totals.impressions * 10) / 1000, 0);
    });

    it('only moves forward, and reset_state unpins it', async () => {
      const backwards = await controller({ operation: 'advance_time', to: '2027-01-01T00:00:00Z' });
      expect(backwards.success).toBe(false);
      expect(backwards.error).toBe('INVALID_TRANSITION');
      const badDuration = await controller({ operation: 'advance_time', by: 'P1M' });
      expect(badDuration.error).toBe('INVALID_PARAMS');

      const reset = await call(tenant, 'comply_test_controller', { scenario: 'reset_state', account: ACCOUNT }, CLOCK_TOKEN);
      expect(reset.success, JSON.stringify(reset).slice(0, 500)).toBe(true);
      const after = await controller({ operation: 'get' });
      expect(after.simulated.pinned).toBe(false);
      const buys = await call(tenant, 'get_media_buys', { account: ACCOUNT }, CLOCK_TOKEN);
      expect(buys.media_buys).toHaveLength(0);
    });

    it('starts a market fresh when another tenant unpins the shared clock', async () => {
      await controller({ operation: 'advance_time', to: '2026-12-31T12:00:00Z' });
      await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-clock-fresh-market-001', account: ACCOUNT, brand: BRAND, ...flight,
        packages: [{ product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 1000, impressions: 50_000 }],
      }, CLOCK_TOKEN);
      await controller({ operation: 'advance_time', by: 'P5D' });
      expect((await call(tenant, 'get_media_buys', { account: ACCOUNT }, CLOCK_TOKEN)).media_buys).toHaveLength(1);

      // The reset /sales reset_state runs unpins the same clock; this market
      // had run days the wall clock has not reached, so it belongs to a
      // discarded timeline.
      await runWithSessionContext(async () => {
        await resetReportingSubscriptionProbe({ mode: 'open', principal: `static:demo:${CLOCK_TOKEN}` });
        await flushDirtySessions();
      });
      expect((await controller({ operation: 'get' })).simulated.pinned).toBe(false);
      expect((await call(tenant, 'get_media_buys', { account: ACCOUNT }, CLOCK_TOKEN)).media_buys).toHaveLength(0);
    });
  });

  describe('creatives on /inventory-adserver', () => {
    const tenant = 'inventory-adserver';
    const CREATIVE_TOKEN = 'demo-inventory-creatives-v1';
    beforeAll(() => provision(CREATIVE_TOKEN));
    // The format ids a buyer copies from this tenant's products.
    const formatId = (id: string) => ({ agent_url: getAgentUrl(), id });
    const banner = (id: string, format = 'display_300x250') => ({
      creative_id: id, name: `Banner ${id}`, format_id: formatId(format),
      assets: {
        image: { asset_type: 'image', url: `https://cdn.inventory-buyer.example/${id}.png`, width: 300, height: 250 },
        click_url: { asset_type: 'url', url: 'https://inventory-buyer.example/landing' },
      },
    });
    let key = 0;
    const sync = (args: Record<string, unknown>) =>
      call(tenant, 'sync_creatives', { idempotency_key: `inventory-creatives-sync-${String(++key).padStart(6, '0')}`, account: ACCOUNT, ...args }, CREATIVE_TOKEN);
    let mediaBuyId: string;
    let displayPackage: string;

    beforeAll(async () => {
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-creatives-buy-000001', account: ACCOUNT, brand: BRAND,
        start_time: '2027-04-01T00:00:00Z', end_time: '2027-05-01T00:00:00Z',
        packages: [
          { product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 1000, impressions: 50_000 },
          { product_id: 'preroll_guaranteed', pricing_option_id: 'preroll_guaranteed_cpm', budget: 1000, impressions: 20_000 },
        ],
      }, CREATIVE_TOKEN);
      expectCanonical('create_media_buy', buy);
      mediaBuyId = buy.media_buy_id;
      displayPackage = buy.packages[0].package_id;
    });

    it('lists the creative tools and declares a creative library', async () => {
      rpcId += 1;
      const response = await fetch(`${baseUrl}/${tenant}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${CREATIVE_TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/list' }),
      });
      const tools = ((await response.json()) as Structured).result.tools.map((tool: Structured) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['sync_creatives', 'list_creatives', 'list_creative_formats']));
      const capabilities = await call(tenant, 'get_adcp_capabilities', {}, CREATIVE_TOKEN);
      expect(capabilities.creative?.has_creative_library).toBe(true);
    });

    it('lists only the formats its placements serve', async () => {
      const formats = await call(tenant, 'list_creative_formats', {}, CREATIVE_TOKEN);
      expectCanonical('list_creative_formats', formats);
      expect(formats.formats.map((format: Structured) => format.format_id.id).sort())
        .toEqual(['display_300x250', 'display_728x90', 'display_image', 'video_30s', 'video_preroll']);
      const none = await call(tenant, 'list_creative_formats', { format_ids: [formatId('audio_spot')] }, CREATIVE_TOKEN);
      expect(none.formats).toEqual([]);
    });

    it('syncs a creative and assigns it to a booked package', async () => {
      const status = async () => (await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] }, CREATIVE_TOKEN)).media_buys[0].status;
      expect(await status()).toBe('pending_creatives');
      const result = await sync({
        creatives: [banner('banner_a')],
        assignment_operations: [{ operation: 'assign', creative_id: 'banner_a', package_id: displayPackage, weight: 60 }],
      });
      expectCanonical('sync_creatives', result);
      expect(result.creatives).toEqual([expect.objectContaining({ creative_id: 'banner_a', action: 'created', status: 'approved', assigned_to: [displayPackage] })]);

      const listed = await call(tenant, 'list_creatives', { account: ACCOUNT }, CREATIVE_TOKEN);
      expectCanonical('list_creatives', listed);
      expect(listed.creatives[0].assignments).toEqual({
        assignment_count: 1,
        assigned_packages: [expect.objectContaining({ package_id: displayPackage, media_buy_id: mediaBuyId, approval_status: 'approved' })],
      });
      const buys = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] }, CREATIVE_TOKEN);
      expectCanonical('get_media_buys', buys);
      expect(buys.media_buys[0].packages[0].creative_approvals).toEqual([{ creative_id: 'banner_a', approval_status: 'approved' }]);
      expect(buys.media_buys[0].packages[1].creative_approvals).toBeUndefined();
      // One package can now begin delivery, so the buy waits only on its start.
      expect(await status()).toBe('pending_start');

      const again = await sync({ creatives: [banner('banner_a')] });
      expect(again.creatives[0].action).toBe('unchanged');
    });

    it('applies assignment operations all or nothing, and checks the package serves the format', async () => {
      const rejected = await sync({
        creatives: [banner('banner_b')],
        assignment_operations: [
          { operation: 'assign', creative_id: 'banner_b', package_id: displayPackage },
          { operation: 'assign', creative_id: 'banner_b', package_id: 'pkg_missing' },
        ],
      });
      expect(rejected.errors[0]).toMatchObject({ code: 'PACKAGE_NOT_FOUND', field: 'assignment_operations[1]' });
      const listed = await call(tenant, 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['banner_b'] } }, CREATIVE_TOKEN);
      expect(listed.creatives).toEqual([]);

      const video = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] }, CREATIVE_TOKEN);
      const prerollPackage = video.media_buys[0].packages[1].package_id;
      const mismatch = await sync({ assignment_operations: [{ operation: 'assign', creative_id: 'banner_a', package_id: prerollPackage }] });
      expect(mismatch.errors[0]).toMatchObject({ code: 'FORMAT_NOT_SUPPORTED' });

      const merge = await sync({ assignment_operations: [{ operation: 'merge', creative_id: 'banner_a', package_id: displayPackage, merged_creative_id: 'x' }] });
      expect(merge.errors[0].code).toBe('UNSUPPORTED_FEATURE');
    });

    it('replaces and unassigns, reports deprecated assignment errors per package, and honors dry_run', async () => {
      await sync({ creatives: [banner('banner_c', 'display_728x90')] });
      const replaced = await sync({
        assignment_operations: [{ operation: 'replace', creative_id: 'banner_c', replaces_creative_id: 'banner_a', package_id: displayPackage }],
      });
      expectCanonical('sync_creatives', replaced);
      const rows = Object.fromEntries(replaced.creatives.map((row: Structured) => [row.creative_id, row]));
      expect(rows.banner_c.assigned_to).toEqual([displayPackage]);
      expect(rows.banner_a.assigned_to).toEqual([]);

      const legacy = await sync({ assignments: [{ creative_id: 'banner_a', package_id: 'pkg_missing' }] });
      expectCanonical('sync_creatives', legacy);
      expect(legacy.creatives[0].assignment_errors).toEqual({ pkg_missing: 'Unknown package pkg_missing' });

      const dry = await sync({ dry_run: true, assignment_operations: [{ operation: 'unassign', creative_id: 'banner_c', package_id: displayPackage }] });
      expect(dry.dry_run).toBe(true);
      expect(dry.creatives[0].assigned_to).toEqual([]);
      const still = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] }, CREATIVE_TOKEN);
      expect(still.media_buys[0].packages[0].creative_approvals).toEqual([{ creative_id: 'banner_c', approval_status: 'approved' }]);
    });

    it('resolves canonical image creatives by format_kind and params alone, without a format_id', async () => {
      const canonical = (id: string, width: number, height: number, params?: Record<string, unknown>) => ({
        creative_id: id, name: `Canonical ${id}`, format_kind: 'image', ...(params && { params }),
        assets: {
          image: { asset_type: 'image', url: `https://cdn.inventory-buyer.example/${id}.png`, width, height },
          click_url: { asset_type: 'url', url: 'https://inventory-buyer.example/landing' },
        },
      });
      const leaderboard = await sync({
        creatives: [canonical('leaderboard', 728, 90, { width: 728, height: 90 })],
        assignment_operations: [{ operation: 'assign', creative_id: 'leaderboard', package_id: displayPackage }],
      });
      expectCanonical('sync_creatives', leaderboard);
      expect(leaderboard.creatives[0]).toMatchObject({ creative_id: 'leaderboard', action: 'created', assigned_to: [displayPackage] });
      // Without params, the image asset's size picks the format.
      const rectangle = await sync({ creatives: [canonical('rectangle', 300, 250)] });
      expect(rectangle.creatives[0].action).toBe('created');
      const listed = await call(tenant, 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['leaderboard', 'rectangle'] } }, CREATIVE_TOKEN);
      expect(Object.fromEntries(listed.creatives.map((creative: Structured) => [creative.creative_id, creative.format_id.id])))
        .toEqual({ leaderboard: 'display_728x90', rectangle: 'display_300x250' });

      // Still ambiguous: refused, naming the candidates.
      const ambiguous = await sync({ creatives: [canonical('unsized', 300, 250, {})] });
      expect(ambiguous.errors[0].code).toBe('INVALID_REQUEST');
      expect(ambiguous.errors[0].message).toContain('display_728x90');
      expect(ambiguous.errors[0].message).toContain('display_300x250');
      // The takeover image is unsized, so it takes a size no sized format has.
      const skyscraper = await sync({ creatives: [canonical('skyscraper', 160, 600, { width: 160, height: 600 })] });
      expect(skyscraper.creatives[0].action).toBe('created');
      const onRos = await sync({ assignment_operations: [{ operation: 'assign', creative_id: 'skyscraper', package_id: displayPackage }] });
      expect(onRos.errors[0].code).toBe('FORMAT_NOT_SUPPORTED');
      const unserved = await sync({ creatives: [{ ...canonical('html_ad', 300, 250), format_kind: 'html' }] });
      expect(unserved.errors[0].code).toBe('FORMAT_NOT_SUPPORTED');

      // Inline on create_media_buy, the same params pick the 728x90 of a ROS
      // display product that also serves 300x250.
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-creatives-canonical-01', account: ACCOUNT, brand: BRAND,
        start_time: '2027-04-01T00:00:00Z', end_time: '2027-05-01T00:00:00Z',
        packages: [{
          product_id: 'ros_display_auction', pricing_option_id: 'ros_display_auction_cpm', budget: 500, bid_price: 3,
          creatives: [canonical('inline_leaderboard', 728, 90, { width: 728, height: 90 })],
        }],
      }, CREATIVE_TOKEN);
      expectCanonical('create_media_buy', buy);
      const inline = await call(tenant, 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['inline_leaderboard'] } }, CREATIVE_TOKEN);
      expect(inline.creatives[0].format_id.id).toBe('display_728x90');
    });

    it('validates leniently on request and rejects formats the seller does not serve', async () => {
      const strict = await sync({ creatives: [banner('banner_d'), banner('podcast_ad', 'audio_spot')] });
      expect(strict.errors[0]).toMatchObject({ code: 'FORMAT_NOT_SUPPORTED', field: 'creatives[1].format_id' });
      const lenient = await sync({ validation_mode: 'lenient', creatives: [banner('banner_d'), banner('podcast_ad', 'audio_spot')] });
      expectCanonical('sync_creatives', lenient);
      expect(lenient.creatives.map((row: Structured) => [row.creative_id, row.action])).toEqual([['banner_d', 'created'], ['podcast_ad', 'failed']]);

      // delete_missing keeps a resent creative that fails lenient validation.
      await sync({ creatives: [banner('banner_keep')] });
      const resent = await sync({
        validation_mode: 'lenient', delete_missing: true, dry_run: true,
        creatives: [banner('banner_d'), { ...banner('banner_keep'), format_id: formatId('audio_spot') }],
      });
      const actions = Object.fromEntries(resent.creatives.map((row: Structured) => [row.creative_id, row.action]));
      expect(actions.banner_keep).toBe('failed');
      expect(actions.banner_a).toBe('deleted');
    });

    it('takes inline creatives and replacement assignments on create_media_buy and update_media_buy', async () => {
      const created = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-creatives-inline-0001', account: ACCOUNT, brand: BRAND,
        start_time: '2027-04-01T00:00:00Z', end_time: '2027-05-01T00:00:00Z',
        packages: [{
          product_id: 'ros_display_auction', pricing_option_id: 'ros_display_auction_cpm', budget: 500, bid_price: 3,
          creatives: [banner('banner_inline')],
          creative_assignments: [{ creative_id: 'banner_d', weight: 40 }],
        }],
      }, CREATIVE_TOKEN);
      expectCanonical('create_media_buy', created);
      const packageId = created.packages[0].package_id;
      const read = async () => (await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [created.media_buy_id] }, CREATIVE_TOKEN))
        .media_buys[0].packages[0].creative_approvals.map((approval: Structured) => approval.creative_id);
      expect(await read()).toEqual(['banner_inline', 'banner_d']);

      const updated = await call(tenant, 'update_media_buy', {
        idempotency_key: 'inventory-creatives-update-0001', account: ACCOUNT, media_buy_id: created.media_buy_id,
        packages: [{ package_id: packageId, creative_assignments: [{ creative_id: 'banner_c' }] }],
      }, CREATIVE_TOKEN);
      expectCanonical('update_media_buy', updated);
      expect(await read()).toEqual(['banner_c']);

      const wrongFormat = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-creatives-inline-0002', account: ACCOUNT, brand: BRAND,
        start_time: '2027-04-01T00:00:00Z', end_time: '2027-05-01T00:00:00Z',
        packages: [{ product_id: 'preroll_auction', pricing_option_id: 'preroll_auction_cpm', budget: 500, bid_price: 8, creatives: [banner('banner_on_video')] }],
      }, CREATIVE_TOKEN);
      expect(JSON.stringify(wrongFormat)).toContain('FORMAT_NOT_SUPPORTED');
    });
  });

  describe('/inventory-content', () => {
    const tenant = 'inventory-content';
    const CONTENT_TOKEN = 'demo-inventory-content-v1';
    beforeAll(() => provision(CONTENT_TOKEN));
    const clock = (params: Record<string, unknown>) =>
      call(tenant, 'comply_test_controller', { scenario: 'sandbox_clock', account: ACCOUNT, params }, CONTENT_TOKEN);
    const products = (startDate: string, endDate: string) => call(tenant, 'get_products', {
      buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND, filters: { start_date: startDate, end_date: endDate },
    }, CONTENT_TOKEN);
    const episode = (result: Structured, id: string) => result.products
      .find((product: Structured) => product.product_id === 'morning_brief_midroll')
      .installments.find((installment: Structured) => installment.installment_id === id);

    it('declares only the guaranteed specialism it sells', async () => {
      const capabilities = await call(tenant, 'get_adcp_capabilities', {}, CONTENT_TOKEN);
      expect(capabilities.specialisms).toEqual(['sales-guaranteed']);
    });

    it('sells episode sponsorships, cancels a seeded episode, and delivers listens as they build', async () => {
      await clock({ operation: 'advance_time', to: '2026-12-31T12:00:00Z' });
      const offer = await products('2027-01-01', '2027-01-31');
      expectCanonical('get_products', offer);
      const podcast = offer.products.find((product: Structured) => product.product_id === 'morning_brief_midroll');
      expect(podcast.channels).toEqual(['podcast']);
      expect(podcast.collections).toEqual([{ publisher_domain: 'morning-brief.example', collection_ids: ['morning_brief'] }]);
      expect(podcast.installments.map((installment: Structured) => installment.installment_id))
        .toEqual(['morning_brief_010', 'morning_brief_011', 'morning_brief_012', 'morning_brief_013']);
      expect(episode(offer, 'morning_brief_012').status).toBe('scheduled');
      const forecastMid = podcast.forecast.points[0].metrics.impressions.mid as number;
      expect(forecastMid).toBeGreaterThan(150_000);

      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-content-podcast-00001', account: ACCOUNT, brand: BRAND,
        start_time: '2027-01-01T00:00:00Z', end_time: '2027-02-01T00:00:00Z',
        packages: [{ product_id: 'morning_brief_midroll', pricing_option_id: 'morning_brief_midroll_cpm', budget: 5000 }],
      }, CONTENT_TOKEN);
      expectCanonical('create_media_buy', buy);
      const soldOut = await products('2027-01-01', '2027-01-31');
      expect(soldOut.products.find((product: Structured) => product.product_id === 'morning_brief_midroll')
        .forecast.points[0].metrics.impressions.mid).toBe(0);

      await clock({ operation: 'advance_time', to: '2027-01-19T06:00:00Z' });
      const after = await products('2027-01-01', '2027-01-31');
      expect(episode(after, 'morning_brief_012').status).toBe('cancelled');
      expect(episode(after, 'morning_brief_011').status).toBe('published');

      // Listens for the last January episode build over 30 days.
      await clock({ operation: 'advance_time', to: '2027-03-15T00:00:00Z' });
      const delivery = await call(tenant, 'get_media_buy_delivery', { account: ACCOUNT, media_buy_ids: [buy.media_buy_id] }, CONTENT_TOKEN);
      expectCanonical('get_media_buy_delivery', delivery);
      const delivered = delivery.media_buy_deliveries[0].totals.impressions as number;
      // Forecasts never know a cancellation, so delivery is the three episodes
      // that ran over the four forecast: 3 / 4 = 0.75, times the mean of three
      // audience shocks A_i (audience_sigma 0.12, so sd 0.12 / sqrt(3) = 0.07).
      // channel_sigma is 0, and per-cell noise (cell_kappa 0.4, about 0.04 per
      // cell-day) and the daily truth variation average out or cancel. Three sd
      // is 0.75 x (1 +/- 0.21) = 0.59 to 0.91; the bounds below, 0.6 and 0.9, sit just inside that.
      expect(delivered / forecastMid).toBeGreaterThan(0.6);
      expect(delivered / forecastMid).toBeLessThan(0.9);
      const daily = (delivery.media_buy_deliveries[0].daily_breakdown as Structured[]).filter(row => row.impressions > 0);
      expect(daily[0].date).toBe('2027-01-04');
      expect(daily.at(-1)!.date > '2027-02-15').toBe(true);
    });

    it('discards the caller\'s markets on both inventory tenants on reset_state', async () => {
      await call('inventory-adserver', 'create_media_buy', {
        idempotency_key: 'inventory-content-cross-reset01', account: ACCOUNT, brand: BRAND,
        start_time: '2027-03-20T00:00:00Z', end_time: '2027-04-20T00:00:00Z',
        packages: [{ product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 1000, impressions: 50_000 }],
      }, CONTENT_TOKEN);
      expect((await call('inventory-adserver', 'get_media_buys', { account: ACCOUNT }, CONTENT_TOKEN)).media_buys).toHaveLength(1);
      const reset = await call(tenant, 'comply_test_controller', { scenario: 'reset_state', account: ACCOUNT }, CONTENT_TOKEN);
      expect(reset.success, JSON.stringify(reset).slice(0, 500)).toBe(true);
      expect((await call('inventory-adserver', 'get_media_buys', { account: ACCOUNT }, CONTENT_TOKEN)).media_buys).toHaveLength(0);
      expect((await call(tenant, 'get_media_buys', { account: ACCOUNT }, CONTENT_TOKEN)).media_buys).toHaveLength(0);
    });

    it('takes a sponsorship creative inline on create_media_buy, in the format the product serves', async () => {
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-content-inline-crv01', account: ACCOUNT, brand: BRAND,
        start_time: '2027-02-01T00:00:00Z', end_time: '2027-03-01T00:00:00Z',
        packages: [{
          product_id: 'weekly_dispatch_sponsor', pricing_option_id: 'weekly_dispatch_sponsor_cpm', budget: 3000,
          creatives: [{ creative_id: 'dispatch_read', name: 'Dispatch sponsor read', format_id: { agent_url: getAgentUrl(), id: 'email_sponsored' }, assets: { headline: { asset_type: 'text', content: 'Brought to you by an example brand' } } }],
        }],
      }, CONTENT_TOKEN);
      expectCanonical('create_media_buy', buy);
      const listed = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [buy.media_buy_id] }, CONTENT_TOKEN);
      expect(listed.media_buys[0].packages[0].creative_approvals).toEqual([{ creative_id: 'dispatch_read', approval_status: 'approved' }]);
    });

    it('reports a postponed installment at its new date', async () => {
      await clock({ operation: 'advance_time', to: '2027-01-24T00:00:00Z' });
      const offer = await products('2027-01-15', '2027-01-20');
      const video = offer.products.find((product: Structured) => product.product_id === 'maker_studio_integration');
      const moved = video.installments.find((installment: Structured) => installment.installment_id === 'maker_studio_006');
      expect(moved.status).toBe('published');
      expect(moved.scheduled_at).toBe('2027-01-23T00:00:00Z');
    });
  });

  describe('test controller seeds', () => {
    const SEED_TOKEN = 'demo-inventory-seeds-v1';
    const UNSEEDED_TOKEN = 'demo-inventory-unseeded-v1';
    const flight = { start_date: '2027-02-01', end_date: '2027-02-28' };
    const controller = (tenant: string, scenario: string, params: Record<string, unknown>, token = SEED_TOKEN) =>
      call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, token);
    const displayFixture = {
      delivery_type: 'non_guaranteed',
      channels: ['display'],
      name: 'Seeded rectangle',
      format_options: [{ format_option_id: 'display_300x250', format_kind: 'image', params: { width: 300, height: 250 } }],
    };
    const products = (tenant: string, token: string) =>
      call(tenant, 'get_products', { buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND, filters: flight }, token);
    // Forecast timestamps follow the moving wall clock; everything else must
    // not change.
    const stable = (value: Structured): Structured => JSON.parse(JSON.stringify(value, (key, field) =>
      key === 'generated_at' || key === 'valid_until' ? undefined : field));

    // A storefront provisions the account before naming it on get_products.
    beforeAll(async () => {
      for (const token of [SEED_TOKEN, UNSEEDED_TOKEN]) {
        const synced = await call('inventory-adserver', 'sync_accounts', {
          idempotency_key: `inventory-seeds-provision-${token}`, accounts: [{ ...ACCOUNT, billing: 'operator' }],
        }, token);
        expect(synced.adcp_error).toBeUndefined();
      }
    });

    it('lists the seed scenarios', async () => {
      const listed = await controller('inventory-adserver', 'list_scenarios', {});
      expect(listed.scenarios).toEqual(expect.arrayContaining(['seed_account', 'seed_product', 'seed_pricing_option']));
    });

    it('sells a seeded product at its seeded price, only to the caller that seeded it', async () => {
      const tenant = 'inventory-adserver';
      const before = stable(await products(tenant, UNSEEDED_TOKEN));

      expect((await controller(tenant, 'seed_product', { product_id: 'seeded_rectangle', fixture: displayFixture })).success).toBe(true);
      expect((await controller(tenant, 'seed_pricing_option', {
        product_id: 'seeded_rectangle', pricing_option_id: 'cpm_seeded', fixture: { pricing_model: 'cpm', currency: 'USD', floor_price: 8 },
      })).success).toBe(true);
      // A replay with the same fixture succeeds; a divergent one is refused.
      expect((await controller(tenant, 'seed_product', { product_id: 'seeded_rectangle', fixture: displayFixture })).success).toBe(true);
      expect((await controller(tenant, 'seed_product', { product_id: 'seeded_rectangle', fixture: { ...displayFixture, name: 'Other' } })).success).toBe(false);

      const offer = await products(tenant, SEED_TOKEN);
      expectCanonical('get_products', offer);
      const seeded = offer.products.find((product: Structured) => product.product_id === 'seeded_rectangle');
      expect(seeded.name).toBe('Seeded rectangle');
      expect(seeded.format_options).toEqual(displayFixture.format_options);
      expect(seeded.pricing_options).toEqual([{ pricing_option_id: 'cpm_seeded', pricing_model: 'cpm', currency: 'USD', floor_price: 8 }]);
      expect(seeded.forecast.points[0].metrics.impressions.mid).toBeGreaterThan(0);

      // A caller that never seeded sees exactly what it saw before.
      expect(stable(await products(tenant, UNSEEDED_TOKEN))).toEqual(before);
      // The public card never carries a caller's seeds, even the seeder's own.
      const publicCard = await call(tenant, 'get_products', { buying_mode: 'wholesale', filters: flight }, SEED_TOKEN);
      expect(publicCard.cache_scope).toBe('public');
      expect(publicCard.products.map((product: Structured) => product.product_id)).not.toContain('seeded_rectangle');

      const wrongPrice = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-seeds-wrong-price-01', account: ACCOUNT, brand: BRAND,
        start_time: '2027-02-01T00:00:00Z', end_time: '2027-02-28T00:00:00Z',
        packages: [{ product_id: 'seeded_rectangle', pricing_option_id: 'seeded_rectangle_cpm', budget: 1000 }],
      }, SEED_TOKEN);
      expect(wrongPrice.adcp_error?.code).toBe('INVALID_PRICING_OPTION');
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-seeds-buy-0001', account: ACCOUNT, brand: BRAND,
        start_time: '2027-02-01T00:00:00Z', end_time: '2027-02-28T00:00:00Z',
        packages: [{ product_id: 'seeded_rectangle', pricing_option_id: 'cpm_seeded', budget: 1000, bid_price: 9 }],
      }, SEED_TOKEN);
      expectCanonical('create_media_buy', buy);
      expect(buy.packages[0].pricing_option_id).toBe('cpm_seeded');

      // The other caller cannot buy it.
      const foreign = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-seeds-foreign-01', account: ACCOUNT, brand: BRAND,
        start_time: '2027-02-01T00:00:00Z', end_time: '2027-02-28T00:00:00Z',
        packages: [{ product_id: 'seeded_rectangle', pricing_option_id: 'cpm_seeded', budget: 1000 }],
      }, UNSEEDED_TOKEN);
      expect(foreign.adcp_error?.code).toBe('PRODUCT_NOT_FOUND');

      // reset_state discards the seeds with the rest of the market.
      await controller(tenant, 'reset_state', {});
      const reset = await products(tenant, SEED_TOKEN);
      expect(reset.products.map((product: Structured) => product.product_id)).not.toContain('seeded_rectangle');
    });

    it('sells a seeded product on the content platform\'s nearest placement', async () => {
      const tenant = 'inventory-content';
      expect((await controller(tenant, 'seed_product', { product_id: 'seeded_content_display', fixture: displayFixture })).success).toBe(true);
      const offer = await products(tenant, SEED_TOKEN);
      expectCanonical('get_products', offer);
      const seeded = offer.products.find((product: Structured) => product.product_id === 'seeded_content_display');
      expect(seeded.channels).toEqual(['display']);
      expect(seeded.pricing_options[0].pricing_option_id).toBe('seeded_content_display_cpm');
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-seeds-content-01', account: ACCOUNT, brand: BRAND,
        start_time: '2027-02-01T00:00:00Z', end_time: '2027-02-28T00:00:00Z',
        packages: [{ product_id: 'seeded_content_display', pricing_option_id: 'seeded_content_display_cpm', budget: 1000 }],
      }, SEED_TOKEN);
      expectCanonical('create_media_buy', buy);
    });

    it('sells a seeded product whose channel the season lacks entirely', async () => {
      // The ad server has no audio or installment placements at all.
      const tenant = 'inventory-adserver';
      const audioFixture = {
        delivery_type: 'non_guaranteed',
        channels: ['streaming_audio'],
        format_options: [{ format_option_id: 'seeded_audio_spot', format_kind: 'audio_hosted', params: {} }],
      };
      expect((await controller(tenant, 'seed_product', { product_id: 'seeded_audio', fixture: audioFixture })).success).toBe(true);
      const offer = await products(tenant, SEED_TOKEN);
      expectCanonical('get_products', offer);
      const seeded = offer.products.find((product: Structured) => product.product_id === 'seeded_audio');
      expect(seeded.channels).toEqual(['streaming_audio']);
      expect(seeded.forecast.points[0].metrics.impressions.mid).toBeGreaterThan(0);
    });

    it('provisions a seeded account for the caller, so get_products prices for it without a sync', async () => {
      const token = 'demo-inventory-seed-account-v1';
      const account = { brand: { domain: 'seeded-account.example' }, operator: 'seed-agency.example', operator_unit: { id: 'seeded-unit' }, sandbox: true };
      const before = await call('inventory-adserver', 'get_products', { buying_mode: 'wholesale', account, filters: flight }, token);
      expect(before.adcp_error?.code).toBe('ACCOUNT_NOT_FOUND');
      const seeded = await call('inventory-adserver', 'comply_test_controller', {
        scenario: 'seed_account', account, params: { account_id: 'acct_seeded_account_example', fixture: { ...account, billing: 'operator', status: 'active' } },
      }, token);
      expect(seeded.success, JSON.stringify(seeded)).toBe(true);
      const after = await call('inventory-adserver', 'get_products', { buying_mode: 'wholesale', account, filters: flight }, token);
      expectCanonical('get_products', after);
      expect(after.cache_scope).toBe('account');
    });

    it('reports the reporting_capabilities a seeded product declares, over the tenant defaults', async () => {
      const tenant = 'inventory-adserver';
      const declared = ['impressions', 'spend', 'clicks', 'viewability'];
      expect((await controller(tenant, 'seed_product', {
        product_id: 'seeded_reporting', fixture: { ...displayFixture, reporting_capabilities: { available_metrics: declared } },
      })).success).toBe(true);
      const offer = await products(tenant, SEED_TOKEN);
      expectCanonical('get_products', offer);
      const seeded = offer.products.find((product: Structured) => product.product_id === 'seeded_reporting');
      expect(seeded.reporting_capabilities.available_metrics).toEqual(declared);
      expect(seeded.reporting_capabilities.available_reporting_frequencies).toEqual(['daily']);
    });

    it('lets a declared viewability container satisfy its leaves under required_metrics, but not a sibling leaf', async () => {
      const tenant = 'inventory-adserver';
      const seed = (id: string, metrics: string[]) => controller(tenant, 'seed_product', {
        product_id: id, fixture: { ...displayFixture, reporting_capabilities: { available_metrics: ['impressions', 'spend', ...metrics] } },
      });
      expect((await seed('seeded_container', ['viewability'])).success).toBe(true);
      expect((await seed('seeded_leaf', ['viewable_rate'])).success).toBe(true);
      const matching = async (required: string[]) => (await call(tenant, 'get_products', {
        buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND, filters: { ...flight, required_metrics: required },
      }, SEED_TOKEN)).products.map((product: Structured) => product.product_id).filter((id: string) => id.startsWith('seeded_container') || id.startsWith('seeded_leaf'));
      expect(await matching(['viewable_rate'])).toEqual(['seeded_container', 'seeded_leaf']);
      expect(await matching(['viewable_rate', 'viewed_seconds'])).toEqual(['seeded_container']);
    });

    it('rejects a seeded product that reuses one of the tenant\'s own ids', async () => {
      const refused = await controller('inventory-adserver', 'seed_product', { product_id: 'ros_display_guaranteed', fixture: displayFixture });
      expect(refused.success).toBe(false);
    });
  });

  // A goal the forecast cannot cover is refused, not capped (#9198).
  describe('goals over the forecast', () => {
    const flight = { start_date: '2027-02-01', end_date: '2027-02-28' };
    const times = { start_time: '2027-02-01T00:00:00Z', end_time: '2027-03-01T00:00:00Z' };
    const errorOf = (result: Structured): Structured => (result.adcp_error ?? result.errors?.[0] ?? {}) as Structured;

    const prepare = async (tenant: string, token: string) => {
      await provision(token);
      const clock = await call(tenant, 'comply_test_controller', {
        scenario: 'sandbox_clock', account: ACCOUNT, params: { operation: 'advance_time', to: '2026-12-31T12:00:00Z' },
      }, token);
      expect(clock.success, JSON.stringify(clock).slice(0, 500)).toBe(true);
    };
    const available = async (tenant: string, token: string, productId: string) => {
      const offer = await call(tenant, 'get_products', { buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND, filters: flight }, token);
      return offer.products.find((product: Structured) => product.product_id === productId).forecast.points[0].metrics.impressions.mid as number;
    };
    const book = (tenant: string, token: string, key: string, productId: string, pricingOptionId: string, impressions: number) =>
      call(tenant, 'create_media_buy', {
        idempotency_key: key, account: ACCOUNT, brand: BRAND, ...times,
        packages: [{ product_id: productId, pricing_option_id: pricingOptionId, budget: 1_000_000, impressions }],
      }, token);

    describe('/inventory-adserver', () => {
      const tenant = 'inventory-adserver';
      const TOKEN_GOAL = 'demo-inventory-goal-adserver-v1';
      const product = 'ros_display_guaranteed';
      const option = 'ros_display_guaranteed_cpm';
      beforeAll(() => prepare(tenant, TOKEN_GOAL));

      it('refuses a second 75% goal and a raise past what is left, and accepts a decrease', async () => {
        const open = await available(tenant, TOKEN_GOAL, product);
        const share = Math.floor(open * 0.75);
        const first = await book(tenant, TOKEN_GOAL, 'inventory-goal-adserver-a-0001', product, option, share);
        expectCanonical('create_media_buy', first);
        const left = await available(tenant, TOKEN_GOAL, product);
        expect(left).toBe(open - share);

        const second = await book(tenant, TOKEN_GOAL, 'inventory-goal-adserver-b-0001', product, option, share);
        expect(errorOf(second)).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', field: 'packages[0].impressions', recovery: 'correctable' });
        expect(errorOf(second).message).toContain(String(share));
        expect(errorOf(second).message).toContain(String(left));
        // The refusal books nothing.
        expect(await available(tenant, TOKEN_GOAL, product)).toBe(left);

        const update = (key: string, impressions: number) => call(tenant, 'update_media_buy', {
          idempotency_key: key, account: ACCOUNT, media_buy_id: first.media_buy_id,
          packages: [{ package_id: first.packages[0].package_id, impressions }],
        }, TOKEN_GOAL);
        const raised = await update('inventory-goal-adserver-raise-01', open + 1);
        expect(errorOf(raised)).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', field: 'packages[0].impressions' });
        expect(await available(tenant, TOKEN_GOAL, product)).toBe(left);

        const lowered = await update('inventory-goal-adserver-lower-01', Math.floor(share / 2));
        expectCanonical('update_media_buy', lowered);
        expect(await available(tenant, TOKEN_GOAL, product)).toBeGreaterThan(left);
      });

      it('names the budget when the goal came from it', async () => {
        const open = await available(tenant, TOKEN_GOAL, product);
        // The rate is $9 CPM, so a budget this size buys more than is open.
        const budget = Math.ceil(((open + 1_000_000) * 9) / 1000);
        const result = await call(tenant, 'create_media_buy', {
          idempotency_key: 'inventory-goal-adserver-budget-1', account: ACCOUNT, brand: BRAND, ...times,
          packages: [{ product_id: product, pricing_option_id: option, budget }],
        }, TOKEN_GOAL);
        expect(errorOf(result)).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', field: 'packages[0].budget' });
      });
    });

    // A guaranteed product with several fixed prices books at the one chosen (#9208).
    describe('/inventory-adserver selected pricing option', () => {
      const tenant = 'inventory-adserver';
      const TOKEN_PRICE = 'demo-inventory-goal-price-v1';
      const controller = (scenario: string, params: Record<string, unknown>) =>
        call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, TOKEN_PRICE);
      beforeAll(async () => {
        await prepare(tenant, TOKEN_PRICE);
        expect((await controller('seed_product', {
          product_id: 'seeded_two_rates',
          fixture: {
            delivery_type: 'guaranteed',
            channels: ['display'],
            name: 'Seeded two rates',
            format_options: [{ format_option_id: 'display_300x250', format_kind: 'image', params: { width: 300, height: 250 } }],
          },
        })).success).toBe(true);
        for (const [id, fixed_price] of [['cpm_one', 1], ['cpm_ten', 10]] as const) {
          expect((await controller('seed_pricing_option', {
            product_id: 'seeded_two_rates', pricing_option_id: id, fixture: { pricing_model: 'cpm', currency: 'USD', fixed_price },
          })).success).toBe(true);
        }
      });

      const seedOne = async (productId: string, delivery_type: string, options: Record<string, unknown>) => {
        expect((await controller('seed_product', {
          product_id: productId,
          fixture: {
            delivery_type,
            channels: ['display'],
            name: productId,
            format_options: [{ format_option_id: 'display_300x250', format_kind: 'image', params: { width: 300, height: 250 } }],
          },
        })).success).toBe(true);
        for (const [id, price] of Object.entries(options)) {
          expect((await controller('seed_pricing_option', {
            product_id: productId, pricing_option_id: id, fixture: { pricing_model: 'cpm', currency: 'USD', ...(delivery_type === 'guaranteed' ? { fixed_price: price } : { floor_price: price }) },
          })).success).toBe(true);
        }
      };
      const forecastOf = async (productId: string, budget: number) => {
        const offer = await call(tenant, 'get_products', {
          buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND, filters: { ...flight, budget_range: { max: budget } },
        }, TOKEN_PRICE);
        expectCanonical('get_products', offer);
        return offer.products.find((product: Structured) => product.product_id === productId).forecast as Structured;
      };
      const bookAt = async (key: string, pricingOptionId: string, budget: number, productId = 'seeded_two_rates') => {
        const buy = await call(tenant, 'create_media_buy', {
          idempotency_key: key, account: ACCOUNT, brand: BRAND, ...times,
          packages: [{ product_id: productId, pricing_option_id: pricingOptionId, budget }],
        }, TOKEN_PRICE);
        expectCanonical('create_media_buy', buy);
        return buy;
      };

      it('prices a single-rate forecast without a label, and booking matches it', async () => {
        await seedOne('seeded_one_rate', 'guaranteed', { cpm_only: 10 });
        const forecast = await forecastOf('seeded_one_rate', 1000);
        expect(forecast.forecast_range_unit).toBe('spend');
        expect(forecast.points[0].budget).toBe(1000);
        expect(forecast.points[0].label).toBeUndefined();
        expect(forecast.points[0].metrics.impressions.mid).toBe(100_000);
        expect(forecast.points[0].metrics.spend.mid).toBe(1000);
        const buy = await bookAt('inventory-forecast-one-rate-001', 'cpm_only', 1000, 'seeded_one_rate');
        expect(buy.packages[0].impressions).toBe(forecast.points[0].metrics.impressions.mid);
      });

      it('prices the forecast without a label when several options share one rate', async () => {
        await seedOne('seeded_equal_rates', 'guaranteed', { cpm_a: 10, cpm_b: 10 });
        const forecast = await forecastOf('seeded_equal_rates', 1000);
        expect(forecast.forecast_range_unit).toBe('spend');
        expect(forecast.points[0].budget).toBe(1000);
        expect(forecast.points[0].label).toBeUndefined();
        expect(forecast.points[0].metrics.spend.mid).toBe(1000);
        const buy = await bookAt('inventory-forecast-equal-rates-1', 'cpm_b', 1000, 'seeded_equal_rates');
        expect(buy.packages[0].impressions).toBe(forecast.points[0].metrics.impressions.mid);
      });

      it('labels an auction forecast with the first floor it is priced at', async () => {
        await seedOne('seeded_two_floors', 'non_guaranteed', { floor_one: 1, floor_ten: 10 });
        const forecast = await forecastOf('seeded_two_floors', 1000);
        expect(forecast.forecast_range_unit).toBe('spend');
        expect(forecast.points[0].budget).toBe(1000);
        expect(forecast.points[0].label).toBe('Priced at pricing option floor_one');
        expect(forecast.points[0].metrics.spend).toBeDefined();
      });

      it('labels the forecast with the full sentence when it is exactly 128 characters', async () => {
        const firstId = 'p'.repeat(103);
        await seedOne('seeded_label_103', 'guaranteed', { [firstId]: 1, cpm_ten_label: 10 });
        const forecast = await forecastOf('seeded_label_103', 1000);
        expect(forecast.points[0].label).toBe(`Priced at pricing option ${firstId}`);
        expect(forecast.points[0].label).toHaveLength(128);
        expect(forecast.points[0].metrics.impressions.mid).toBe(1_000_000);
      });

      it('falls back to the bare id when the sentence would pass 128 characters', async () => {
        const firstId = 'q'.repeat(104);
        await seedOne('seeded_label_104', 'guaranteed', { [firstId]: 1, cpm_ten_label: 10 });
        const forecast = await forecastOf('seeded_label_104', 1000);
        expect(forecast.points[0].label).toBe(firstId);
        expect(forecast.points[0].metrics.impressions.mid).toBe(1_000_000);
      });

      it('labels the forecast by position when the first option\'s id is too long to name', async () => {
        await seedOne('seeded_label_129', 'guaranteed', { ['r'.repeat(129)]: 1, ['s'.repeat(129)]: 10 });
        const forecast = await forecastOf('seeded_label_129', 100);
        expect(forecast.points[0].label).toBe('Priced at the first pricing option listed');
        expect(forecast.points[0].metrics.impressions.mid).toBe(100_000);
        expect(forecast.points[0].metrics.spend.mid).toBe(100);
        const buy = await bookAt('inventory-forecast-long-id-0001', 'r'.repeat(129), 100, 'seeded_label_129');
        expect(buy.packages[0].impressions).toBe(forecast.points[0].metrics.impressions.mid);
      });

      it('prices an auction forecast at the placements\' lowest floor when the first option has none', async () => {
        expect((await controller('seed_product', {
          product_id: 'seeded_no_floor',
          fixture: {
            delivery_type: 'non_guaranteed',
            channels: ['display'],
            name: 'seeded_no_floor',
            format_options: [{ format_option_id: 'display_300x250', format_kind: 'image', params: { width: 300, height: 250 } }],
          },
        })).success).toBe(true);
        for (const [id, fixture] of [
          ['floor_none', { pricing_model: 'cpm', currency: 'USD' }],
          ['floor_ten', { pricing_model: 'cpm', currency: 'USD', floor_price: 10 }],
        ] as const) {
          const seeded = await controller('seed_pricing_option', { product_id: 'seeded_no_floor', pricing_option_id: id, fixture });
          expect(seeded.success, JSON.stringify(seeded).slice(0, 300)).toBe(true);
        }
        const forecast = await forecastOf('seeded_no_floor', 1000);
        expect(forecast.points[0].label).toBe('Priced at pricing option floor_none');
        expect(forecast.points[0].metrics.spend.mid).toBe(1000);
        // A $10 floor would buy exactly 100,000 at most.
        expect(forecast.points[0].metrics.impressions.mid).toBeGreaterThan(100_000);
      });

      const delivered = async (mediaBuyId: string) => {
        const delivery = await call(tenant, 'get_media_buy_delivery', { account: ACCOUNT, media_buy_ids: [mediaBuyId] }, TOKEN_PRICE);
        expectCanonical('get_media_buy_delivery', delivery);
        return delivery.media_buy_deliveries[0].totals as Structured;
      };

      it('derives the goal and spend from the selected option, not the first', async () => {
        const budget = 1000;
        // Discovery prices the forecast at the first option and names it.
        const forecast = await forecastOf('seeded_two_rates', budget);
        expect(forecast.forecast_range_unit).toBe('spend');
        expect(forecast.points[0].budget).toBe(budget);
        expect(forecast.points[0].label).toBe('Priced at pricing option cpm_one');
        expect(forecast.points[0].metrics.spend.mid).toBe(budget);
        expect(forecast.points[0].metrics.impressions.mid).toBe(1_000_000);
        const second = await bookAt('inventory-goal-price-second-1', 'cpm_ten', budget);
        expect(second.packages[0].impressions).toBe(Math.floor((budget * 1000) / 10));
        const first = await bookAt('inventory-goal-price-first-01', 'cpm_one', budget);
        expect(first.packages[0].impressions).toBe(Math.floor((budget * 1000) / 1));
        expect(first.packages[0].impressions).toBe(forecast.points[0].metrics.impressions.mid);

        const clock = await controller('sandbox_clock', { operation: 'advance_time', by: 'P40D' });
        expect(clock.success, JSON.stringify(clock).slice(0, 500)).toBe(true);
        const priced = await delivered(second.media_buy_id);
        expect(priced.impressions).toBeGreaterThan(0);
        expect(priced.spend).toBeCloseTo((priced.impressions * 10) / 1000, 0);
        const cheap = await delivered(first.media_buy_id);
        expect(cheap.spend).toBeCloseTo((cheap.impressions * 1) / 1000, 0);
      });
    });

    describe('/inventory-adserver multi-package updates', () => {
      const tenant = 'inventory-adserver';
      const TOKEN_GOAL = 'demo-inventory-goal-update-v1';
      const product = 'ros_display_guaranteed';
      const option = 'ros_display_guaranteed_cpm';
      beforeAll(() => prepare(tenant, TOKEN_GOAL));
      const update = (key: string, patch: Record<string, unknown>) =>
        call(tenant, 'update_media_buy', { idempotency_key: key, account: ACCOUNT, ...patch }, TOKEN_GOAL);
      const reread = async (id: string) =>
        (await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [id] }, TOKEN_GOAL)).media_buys[0] as Structured;
      const pair = async (key: string, goals: number[]) => {
        const created = await call(tenant, 'create_media_buy', {
          idempotency_key: key, account: ACCOUNT, brand: BRAND, ...times,
          packages: goals.map(impressions => ({ product_id: product, pricing_option_id: option, budget: 1_000_000, impressions })),
        }, TOKEN_GOAL);
        expectCanonical('create_media_buy', created);
        return created;
      };

      it('applies raises after the decreases of the same request, in either package order', async () => {
        const open = await available(tenant, TOKEN_GOAL, product);
        const a = Math.floor(open / 2);
        const b = open - a;
        const created = await pair('inventory-goal-update-pair-001', [a, b]);
        const [idA, idB] = created.packages.map((pkg: Structured) => pkg.package_id);
        expect(await available(tenant, TOKEN_GOAL, product)).toBe(0);

        const swap = await update('inventory-goal-update-swap-001', {
          media_buy_id: created.media_buy_id,
          packages: [{ package_id: idA, impressions: a + 100 }, { package_id: idB, impressions: b - 100 }],
        });
        expectCanonical('update_media_buy', swap);
        const back = await update('inventory-goal-update-swap-002', {
          media_buy_id: created.media_buy_id,
          packages: [{ package_id: idB, impressions: b }, { package_id: idA, impressions: a }],
        });
        expectCanonical('update_media_buy', back);
        expect((await reread(created.media_buy_id)).packages.map((pkg: Structured) => pkg.impressions)).toEqual([a, b]);

        const both = await update('inventory-goal-update-both-0001', {
          media_buy_id: created.media_buy_id,
          packages: [{ package_id: idA, impressions: a + 100 }, { package_id: idB, impressions: b + 100 }],
        });
        expect(errorOf(both)).toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
        expect((await reread(created.media_buy_id)).packages.map((pkg: Structured) => pkg.impressions)).toEqual([a, b]);
        expect(await available(tenant, TOKEN_GOAL, product)).toBe(0);
        // Free the market for the next test.
        expectCanonical('update_media_buy', await update('inventory-goal-update-free-0001', { media_buy_id: created.media_buy_id, canceled: true }));
      });

      it('lets a cancellation take precedence over the other fields of its level', async () => {
        const open = await available(tenant, TOKEN_GOAL, product);
        const rootBuy = await pair('inventory-goal-update-root-0001', [1000]);
        const root = await update('inventory-goal-update-root-0002', {
          media_buy_id: rootBuy.media_buy_id, canceled: true,
          packages: [{ package_id: rootBuy.packages[0].package_id, impressions: open * 10 }],
        });
        expectCanonical('update_media_buy', root);
        expect((await reread(rootBuy.media_buy_id)).status).toBe('canceled');

        const pkgBuy = await pair('inventory-goal-update-pkg-00001', [1000, 1000]);
        const [x, y] = pkgBuy.packages.map((pkg: Structured) => pkg.package_id);
        const pkgCancel = await update('inventory-goal-update-pkg-00002', {
          media_buy_id: pkgBuy.media_buy_id, packages: [{ package_id: x, canceled: true, impressions: open * 10 }],
        });
        expectCanonical('update_media_buy', pkgCancel);
        const packages = (await reread(pkgBuy.media_buy_id)).packages as Structured[];
        expect(packages.find(pkg => pkg.package_id === x)).toMatchObject({ canceled: true });
        expect(packages.find(pkg => pkg.package_id === y)?.canceled).not.toBe(true);
      });
    });

    describe('/inventory-adserver mid-flight window', () => {
      const tenant = 'inventory-adserver';
      const TOKEN_GOAL = 'demo-inventory-goal-window-v1';
      const product = 'ros_display_guaranteed';
      beforeAll(() => prepare(tenant, TOKEN_GOAL));

      it('holds only the in-window part of a booking when the forecast opens mid-flight', async () => {
        const mid = async (window: Record<string, string>) => {
          const offer = await call(tenant, 'get_products', { buying_mode: 'wholesale', account: ACCOUNT, brand: BRAND, filters: window }, TOKEN_GOAL);
          return offer.products.find((p: Structured) => p.product_id === product).forecast.points[0].metrics.impressions.mid as number;
        };
        const late = { start_date: '2027-02-15', end_date: '2027-02-28' };
        const open = await available(tenant, TOKEN_GOAL, product);
        const lateBefore = await mid(late);
        const share = Math.floor(open * 0.75);
        expectCanonical('create_media_buy', await book(tenant, TOKEN_GOAL, 'inventory-goal-window-a-00001', product, 'ros_display_guaranteed_cpm', share));

        const lateAfter = await mid(late);
        // The whole goal used to land in the late window, leaving nothing.
        expect(lateAfter).toBeGreaterThan(0);
        expect(lateAfter).toBeGreaterThan(lateBefore - share);
        expect(lateAfter).toBeLessThan(lateBefore);
      });
    });

    describe('/inventory-content', () => {
      const tenant = 'inventory-content';
      const TOKEN_GOAL = 'demo-inventory-goal-content-v1';
      const product = 'seeded_goal_display';
      const option = 'seeded_goal_display_cpm';
      beforeAll(async () => {
        await prepare(tenant, TOKEN_GOAL);
        // Every built-in product here is an exclusive sponsorship; a seeded
        // guaranteed product is the one that books against an impression goal.
        const seeded = await call(tenant, 'comply_test_controller', {
          scenario: 'seed_product', account: ACCOUNT,
          params: {
            product_id: product,
            fixture: {
              delivery_type: 'guaranteed',
              channels: ['display'],
              name: 'Seeded goal display',
              format_options: [{ format_option_id: 'display_300x250', format_kind: 'image', params: { width: 300, height: 250 } }],
            },
          },
        }, TOKEN_GOAL);
        expect(seeded.success, JSON.stringify(seeded).slice(0, 500)).toBe(true);
      });

      it('refuses a goal over the forecast and a second 75% goal', async () => {
        const open = await available(tenant, TOKEN_GOAL, product);
        expect(open).toBeGreaterThan(0);
        const over = await book(tenant, TOKEN_GOAL, 'inventory-goal-content-over-0001', product, option, open + 1);
        expect(errorOf(over)).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', field: 'packages[0].impressions' });

        const share = Math.floor(open * 0.75);
        expectCanonical('create_media_buy', await book(tenant, TOKEN_GOAL, 'inventory-goal-content-a-00001', product, option, share));
        const second = await book(tenant, TOKEN_GOAL, 'inventory-goal-content-b-00001', product, option, share);
        expect(errorOf(second)).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', field: 'packages[0].impressions' });
      });
    });
  });
});
