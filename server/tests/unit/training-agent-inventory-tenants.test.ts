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

      // Actual traffic differs from the forecast, within the seeded error.
      expect(a.totals.impressions).not.toBe(forecastMid);
      expect(Math.abs(a.totals.impressions / forecastMid - 1)).toBeGreaterThan(0.001);
      expect(Math.abs(a.totals.impressions / forecastMid - 1)).toBeLessThan(0.15);
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
      // Three of the four forecast episodes ran.
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

  describe('simulated delivery (#9151)', () => {
    const tenant = 'inventory-adserver';
    const SIM_TOKEN = 'demo-inventory-simulate-v1';
    const flight = { start_time: '2027-01-01T00:00:00Z', end_time: '2027-01-31T00:00:00Z' };
    const controller = (scenario: string, params: Record<string, unknown>, token = SIM_TOKEN) =>
      call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, token);
    const advance = async (params: Record<string, unknown>) => {
      const moved = await controller('sandbox_clock', { operation: 'advance_time', ...params });
      expect(moved.success, JSON.stringify(moved).slice(0, 500)).toBe(true);
    };
    let n = 0;
    const book = async (packages: Array<Record<string, unknown>>) => {
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: `inventory-simulate-buy-${String(++n).padStart(8, '0')}`, account: ACCOUNT, brand: BRAND, ...flight, packages,
      }, SIM_TOKEN);
      expectCanonical('create_media_buy', buy);
      return buy;
    };
    const twoPackages = () => book([
      { product_id: 'sports_hero_guaranteed', pricing_option_id: 'sports_hero_guaranteed_cpm', budget: 3000, impressions: 5000 },
      { product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 1000, impressions: 2500 },
    ]);
    const delivery = async (...ids: string[]) => {
      const result = await call(tenant, 'get_media_buy_delivery', { account: ACCOUNT, media_buy_ids: ids }, SIM_TOKEN);
      expectCanonical('get_media_buy_delivery', result);
      return result.media_buy_deliveries as Structured[];
    };

    beforeAll(async () => {
      await provision(SIM_TOKEN);
      await advance({ to: '2026-12-31T12:00:00Z' });
    });

    it('lists simulate_delivery and simulate_budget_spend in list_scenarios and the capabilities', async () => {
      const listed = await controller('list_scenarios', {});
      expect(listed.scenarios).toEqual(expect.arrayContaining(['simulate_delivery', 'simulate_budget_spend']));
      const capabilities = await call(tenant, 'get_adcp_capabilities', {}, SIM_TOKEN);
      expect(capabilities.compliance_testing.scenarios).toEqual(expect.arrayContaining(['simulate_delivery', 'simulate_budget_spend']));
    });

    it('splits delivery across the live packages by budget, exactly, and reports it at once', async () => {
      const buy = await twoPackages();
      const [hero, ros] = buy.packages.map((pkg: Structured) => pkg.package_id);
      const result = await controller('simulate_delivery', {
        media_buy_id: buy.media_buy_id, impressions: 1001, clicks: 11, conversions: 3, reported_spend: { amount: 100.01, currency: 'USD' },
      });
      expect(result.success, JSON.stringify(result).slice(0, 500)).toBe(true);
      expect(result.simulated).toMatchObject({ impressions: 1001, clicks: 11, conversions: 3, reported_spend: { amount: 100.01, currency: 'USD' } });
      expect(result.cumulative).toMatchObject({ impressions: 1001, reported_spend: { amount: 100.01, currency: 'USD' } });

      const [row] = await delivery(buy.media_buy_id);
      const byPackage = Object.fromEntries(row.by_package.map((entry: Structured) => [entry.package_id, entry]));
      // 3000:1000, so 750.75 and 250.25; the largest remainder takes the odd one.
      expect(byPackage[hero].impressions).toBe(751);
      expect(byPackage[ros].impressions).toBe(250);
      expect(byPackage[hero].spend).toBe(75.01);
      expect(byPackage[ros].spend).toBe(25);
      expect(row.totals.impressions).toBe(1001);
      expect(row.totals.spend).toBe(100.01);
      expect(row.totals.clicks).toBe(11);
      expect(row.totals.conversions).toBe(3);

      // A second call adds to what is there.
      const again = await controller('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 1000, reported_spend: { amount: 20, currency: 'USD' } });
      expect(again.cumulative).toMatchObject({ impressions: 2001, reported_spend: { amount: 120.01, currency: 'USD' } });
      expect((await delivery(buy.media_buy_id))[0].totals.impressions).toBe(2001);
    });

    it('prices impressions at each package rate when no reported_spend is given', async () => {
      const buy = await twoPackages();
      const result = await controller('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 4000 });
      expect(result.success, JSON.stringify(result).slice(0, 500)).toBe(true);
      const [row] = await delivery(buy.media_buy_id);
      for (const entry of row.by_package) {
        expect(entry.spend).toBeCloseTo((entry.impressions * entry.rate) / 1000, 2);
      }
      expect(row.totals.spend).toBeCloseTo(row.by_package.reduce((sum: number, entry: Structured) => sum + entry.spend, 0), 2);
    });

    it('marks delivery final on the row and each package, and leaves provisional rows without finalized_at', async () => {
      const buy = await twoPackages();
      const id = buy.media_buy_id;
      await controller('simulate_delivery', { media_buy_id: id, impressions: 1000 });
      const [untouched] = await delivery(id);
      expect(untouched.is_final).toBeUndefined();
      expect(untouched.by_package[0].is_final).toBeUndefined();

      const provisional = await controller('simulate_delivery', { media_buy_id: id, impressions: 10, is_final: false, measurement_window: 'c7' });
      expect(provisional.success, JSON.stringify(provisional).slice(0, 500)).toBe(true);
      const [open] = await delivery(id);
      expect(open.is_final).toBe(false);
      expect(open.finalized_at).toBeUndefined();
      for (const entry of open.by_package) {
        expect(entry.is_final).toBe(false);
        expect(entry.finalized_at).toBeUndefined();
        expect(entry.measurement_window).toBe('c7');
      }

      const final = await controller('simulate_delivery', { media_buy_id: id, impressions: 10, is_final: true });
      expect(final.success).toBe(true);
      const [closed] = await delivery(id);
      expect(closed.is_final).toBe(true);
      expect(Number.isFinite(Date.parse(closed.finalized_at))).toBe(true);
      for (const entry of closed.by_package) {
        expect(entry).toMatchObject({ is_final: true, finalized_at: closed.finalized_at, measurement_window: 'c7' });
      }
    });

    it('takes finalized_at as final, and refuses it together with is_final false', async () => {
      const buy = await twoPackages();
      const id = buy.media_buy_id;
      const finalizedAt = '2026-12-31T06:00:00Z';
      const result = await controller('simulate_delivery', { media_buy_id: id, impressions: 10, finalized_at: finalizedAt });
      expect(result.success, JSON.stringify(result).slice(0, 500)).toBe(true);
      const [row] = await delivery(id);
      expect(row.is_final).toBe(true);
      expect(Date.parse(row.finalized_at)).toBe(Date.parse(finalizedAt));

      const conflict = await controller('simulate_delivery', { media_buy_id: id, impressions: 10, finalized_at: finalizedAt, is_final: false });
      expect(conflict.success).toBe(false);
      expect(conflict.error).toBe('INVALID_PARAMS');
    });

    it('refuses a currency mismatch, an unknown buy and a canceled buy', async () => {
      const buy = await twoPackages();
      const mismatch = await controller('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 10, reported_spend: { amount: 5, currency: 'EUR' } });
      expect(mismatch.success).toBe(false);
      expect(mismatch.error).toBe('INVALID_PARAMS');
      expect((await delivery(buy.media_buy_id))[0].totals.impressions).toBe(0);

      const unknown = await controller('simulate_delivery', { media_buy_id: 'mb_does_not_exist', impressions: 10 });
      expect(unknown.success).toBe(false);
      expect(unknown.error).toBe('NOT_FOUND');

      const canceled = await call(tenant, 'update_media_buy', {
        idempotency_key: `inventory-simulate-cancel-${String(++n).padStart(8, '0')}`, account: ACCOUNT, media_buy_id: buy.media_buy_id, canceled: true,
      }, SIM_TOKEN);
      expect(canceled.media_buy_status).toBe('canceled');
      const refused = await controller('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 10 });
      expect(refused.success).toBe(false);
      expect(refused.error).toBe('INVALID_STATE');
    });

    it('brings spend to exactly 95 then 100 percent of budget, and never lowers it', async () => {
      const buy = await twoPackages();
      const id = buy.media_buy_id;
      const spent = async () => {
        const [row] = await delivery(id);
        return Object.fromEntries(row.by_package.map((entry: Structured) => [entry.package_id, entry.spend]));
      };
      const [hero, ros] = buy.packages.map((pkg: Structured) => pkg.package_id);

      const at95 = await controller('simulate_budget_spend', { media_buy_id: id, spend_percentage: 95 });
      expect(at95.success, JSON.stringify(at95).slice(0, 500)).toBe(true);
      expect(at95.simulated).toMatchObject({ spend_percentage: 95, computed_spend: { amount: 3800, currency: 'USD' }, budget: { amount: 4000, currency: 'USD' } });
      expect(await spent()).toEqual({ [hero]: 2850, [ros]: 950 });

      const at100 = await controller('simulate_budget_spend', { media_buy_id: id, spend_percentage: 100 });
      expect(at100.success).toBe(true);
      expect(await spent()).toEqual({ [hero]: 3000, [ros]: 1000 });

      const lower = await controller('simulate_budget_spend', { media_buy_id: id, spend_percentage: 50 });
      expect(lower.success).toBe(true);
      expect(await spent()).toEqual({ [hero]: 3000, [ros]: 1000 });
      const [row] = await delivery(id);
      const impressions = row.totals.impressions;
      await controller('simulate_budget_spend', { media_buy_id: id, spend_percentage: 10 });
      expect((await delivery(id))[0].totals.impressions).toBe(impressions);
    });

    it('refuses a spend_percentage outside 0 to 100', async () => {
      const buy = await twoPackages();
      for (const spend_percentage of [-1, 100.5, 101]) {
        const result = await controller('simulate_budget_spend', { media_buy_id: buy.media_buy_id, spend_percentage });
        expect(result.success, String(spend_percentage)).toBe(false);
        expect(result.error).toBe('INVALID_PARAMS');
      }
      expect((await delivery(buy.media_buy_id))[0].totals.spend).toBe(0);
    });

    it('spends every live buy on an account when given account_id', async () => {
      const first = await twoPackages();
      const second = await book([{ product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 500, impressions: 1000 }]);
      // A natural-key account resolves to a synthetic id on the brand domain.
      const result = await controller('simulate_budget_spend', { account_id: `synthetic_${BRAND.domain}`, spend_percentage: 100 });
      expect(result.success, JSON.stringify(result).slice(0, 500)).toBe(true);
      const rows = await delivery(first.media_buy_id, second.media_buy_id);
      expect(rows.map(row => row.totals.spend)).toEqual([4000, 500]);
    });

    it('never pushes an auction package past its budget as the clock advances after an injection', async () => {
      const buy = await book([{ product_id: 'preroll_auction', pricing_option_id: 'preroll_auction_cpm', budget: 1000, bid_price: 10 }]);
      const id = buy.media_buy_id;
      const injected = await controller('simulate_budget_spend', { media_buy_id: id, spend_percentage: 60 });
      expect(injected.success, JSON.stringify(injected).slice(0, 500)).toBe(true);
      await advance({ to: '2027-02-05T12:00:00Z' });
      const [row] = await delivery(id);
      expect(row.totals.spend).toBeGreaterThanOrEqual(600);
      expect(row.totals.spend).toBeLessThanOrEqual(1000);
      for (const entry of row.by_package) expect(entry.spend).toBeLessThanOrEqual(1000);
      // Spend is the change in rounded cumulative spend, so the days add up to the total.
      const days = row.daily_breakdown.reduce((sum: number, day: Structured) => sum + day.spend, 0);
      expect(days).toBeCloseTo(row.totals.spend, 2);
    });

    it('discards simulated delivery with the market on reset_state', async () => {
      const RESET_TOKEN = 'demo-inventory-simulate-reset-v1';
      await provision(RESET_TOKEN);
      const run = (scenario: string, params: Record<string, unknown>) =>
        call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, RESET_TOKEN);
      expect((await run('sandbox_clock', { operation: 'advance_time', to: '2026-12-31T12:00:00Z' })).success).toBe(true);
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-simulate-reset-buy-001', account: ACCOUNT, brand: BRAND, ...flight,
        packages: [{ product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 1000, impressions: 50_000 }],
      }, RESET_TOKEN);
      expect((await run('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 500 })).success).toBe(true);
      const reported = await call(tenant, 'get_media_buy_delivery', { account: ACCOUNT, media_buy_ids: [buy.media_buy_id] }, RESET_TOKEN);
      expect(reported.media_buy_deliveries[0].totals.impressions).toBe(500);

      expect((await run('reset_state', {})).success).toBe(true);
      expect((await call(tenant, 'get_media_buys', { account: ACCOUNT }, RESET_TOKEN)).media_buys).toHaveLength(0);
      expect((await run('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 500 })).error).toBe('NOT_FOUND');
    });
  });

  describe('seeded format options (#9152)', () => {
    const FORMAT_TOKEN = 'demo-inventory-seeded-formats-v1';
    const PLAIN_TOKEN = 'demo-inventory-seeded-formats-plain-v1';
    const formatId = (id: string) => ({ agent_url: getAgentUrl(), id });
    const CTAS = ['SHOP_NOW', 'LEARN_MORE'];
    const fixture = {
      delivery_type: 'non_guaranteed',
      channels: ['display'],
      name: 'Seeded feed and carousel',
      format_options: [
        { format_option_id: 'seeded_carousel', format_kind: 'image_carousel', params: { cta_values: CTAS } },
        { format_option_id: 'seeded_native', format_kind: 'native_in_feed', params: { title_max_chars: 20, cta_values: CTAS } },
        { format_option_id: 'seeded_rect', format_kind: 'image', params: { width: 300, height: 250 } },
        { format_option_id: 'seeded_pub_carousel', format_kind: 'image_carousel', publisher_domain: 'pub.example', params: {} },
      ],
    };
    const controller = (tenant: string, scenario: string, params: Record<string, unknown>, token = FORMAT_TOKEN) =>
      call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, token);
    let key = 0;
    const sync = (tenant: string, creatives: Structured[], token = FORMAT_TOKEN, extra: Record<string, unknown> = {}) =>
      call(tenant, 'sync_creatives', { idempotency_key: `inventory-seeded-formats-${String(++key).padStart(8, '0')}`, account: ACCOUNT, creatives, ...extra }, token);
    const carousel = (id: string, ctas: string[], option = 'seeded_carousel') => ({
      creative_id: id, name: id, format_kind: 'image_carousel', format_option_ref: { scope: 'product', format_option_id: option },
      assets: {
        cards: ctas.map((cta, index) => ({
          asset_type: 'card', headline: `Card ${index + 1}`, cta,
          media: { asset_type: 'image', url: `https://cdn.inventory-buyer.example/${id}-${index}.jpg`, width: 1080, height: 1080 },
        })),
      },
    });
    const native = (id: string, title = 'Short title') => ({
      creative_id: id, name: id, format_kind: 'native_in_feed', format_option_ref: { scope: 'product', format_option_id: 'seeded_native' },
      assets: {
        title: { asset_type: 'text', content: title },
        cta: { asset_type: 'text', content: 'SHOP_NOW' },
        landing_page_url: { asset_type: 'url', url: 'https://inventory-buyer.example/landing' },
      },
    });
    const image300 = (id: string) => ({
      creative_id: id, name: id, format_kind: 'image',
      assets: {
        image: { asset_type: 'image', url: `https://cdn.inventory-buyer.example/${id}.png`, width: 300, height: 250 },
        click_url: { asset_type: 'url', url: 'https://inventory-buyer.example/landing' },
      },
    });

    beforeAll(async () => {
      await provision(FORMAT_TOKEN);
      await provision(PLAIN_TOKEN);
      for (const tenant of ['inventory-adserver', 'inventory-content']) {
        const seeded = await controller(tenant, 'seed_product', { product_id: 'seeded_formats', fixture });
        expect(seeded.success, JSON.stringify(seeded).slice(0, 500)).toBe(true);
        expect((await controller(tenant, 'seed_pricing_option', {
          product_id: 'seeded_formats', pricing_option_id: 'cpm_formats', fixture: { pricing_model: 'cpm', currency: 'USD', floor_price: 4 },
        })).success).toBe(true);
      }
    });

    it('refuses a carousel card cta outside cta_values, naming the field and the allowed values', async () => {
      const result = await sync('inventory-adserver', [carousel('carousel_bad', ['SHOP_NOW', 'SHOP_NOW', 'BUY_ME'])]);
      const error = result.errors?.[0] ?? result.adcp_error;
      expect(error, JSON.stringify(result).slice(0, 800)).toMatchObject({ code: 'CREATIVE_VALUE_NOT_ALLOWED', field: 'creatives[0].assets.cards[2].cta' });
      expect(error.details.allowed_values).toEqual(CTAS);
    });

    it('accepts a carousel with declared ctas and lists it by format_kind and format_option_ref', async () => {
      const result = await sync('inventory-adserver', [carousel('carousel_good', ['SHOP_NOW', 'LEARN_MORE'])]);
      expect(result.errors, JSON.stringify(result).slice(0, 800)).toBeUndefined();
      expect(result.creatives[0]).toMatchObject({ creative_id: 'carousel_good', action: 'created' });
      const listed = await call('inventory-adserver', 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['carousel_good'] } }, FORMAT_TOKEN);
      expectCanonical('list_creatives', listed);
      expect(listed.creatives[0]).toMatchObject({ format_kind: 'image_carousel', format_option_ref: { scope: 'product', format_option_id: 'seeded_carousel' } });
      expect(listed.creatives[0].format_id).toBeUndefined();
    });

    it('lists a publisher-catalog option with scope publisher', async () => {
      const ref = { scope: 'publisher', publisher_domain: 'pub.example', format_option_id: 'seeded_pub_carousel' };
      const creative = { ...carousel('carousel_pub', ['ANYTHING']), format_option_ref: ref };
      const result = await sync('inventory-adserver', [creative]);
      expect(result.errors, JSON.stringify(result).slice(0, 800)).toBeUndefined();
      const listed = await call('inventory-adserver', 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['carousel_pub'] } }, FORMAT_TOKEN);
      expect(listed.creatives[0].format_option_ref).toEqual(ref);
    });

    it('holds a native creative to the declared params, and accepts a conforming one on both tenants', async () => {
      for (const tenant of ['inventory-adserver', 'inventory-content']) {
        const ok = await sync(tenant, [native('native_ok')]);
        expect(ok.errors, `${tenant}: ${JSON.stringify(ok).slice(0, 800)}`).toBeUndefined();
        expect(ok.creatives[0]).toMatchObject({ creative_id: 'native_ok', action: 'created' });
        const listed = await call(tenant, 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['native_ok'] } }, FORMAT_TOKEN);
        expect(listed.creatives[0]).toMatchObject({ format_kind: 'native_in_feed', format_option_ref: { scope: 'product', format_option_id: 'seeded_native' } });

        const long = await sync(tenant, [native('native_long', 'A title well over twenty characters')]);
        expect((long.errors?.[0] ?? long.adcp_error)?.field, tenant).toBe('creatives[0].assets.title.content');
      }
    });

    it('lets a creative in a seeded option be assigned to the seeded product package', async () => {
      const tenant = 'inventory-adserver';
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-seeded-formats-buy-001', account: ACCOUNT, brand: BRAND,
        start_time: '2027-02-01T00:00:00Z', end_time: '2027-02-28T00:00:00Z',
        packages: [{ product_id: 'seeded_formats', pricing_option_id: 'cpm_formats', budget: 1000, bid_price: 5 }],
      }, FORMAT_TOKEN);
      expectCanonical('create_media_buy', buy);
      const result = await sync(tenant, [carousel('carousel_assigned', ['SHOP_NOW'])], FORMAT_TOKEN, {
        assignment_operations: [{ operation: 'assign', creative_id: 'carousel_assigned', package_id: buy.packages[0].package_id }],
      });
      expect(result.errors, JSON.stringify(result).slice(0, 800)).toBeUndefined();
      expect(result.creatives[0].assigned_to).toEqual([buy.packages[0].package_id]);
    });

    it('still refuses a format outside the season for a caller that seeded nothing', async () => {
      const formatted = {
        creative_id: 'audio_plain', name: 'audio', format_id: formatId('audio_spot'),
        assets: { audio: { asset_type: 'audio', url: 'https://cdn.inventory-buyer.example/a.mp3' } },
      };
      const plain = await sync('inventory-adserver', [formatted], PLAIN_TOKEN);
      expect(plain.errors[0]).toMatchObject({ code: 'FORMAT_NOT_SUPPORTED', field: 'creatives[0].format_id' });
      const carouselPlain = await sync('inventory-adserver', [carousel('carousel_plain', ['SHOP_NOW'])], PLAIN_TOKEN);
      expect((carouselPlain.errors?.[0] ?? carouselPlain.adcp_error)?.code).toBe('FORMAT_NOT_SUPPORTED');
    });

    it('keeps a plain 300x250 image on the season format even though a seeded option is also 300x250', async () => {
      const result = await sync('inventory-adserver', [image300('rect_plain')]);
      expect(result.errors, JSON.stringify(result).slice(0, 800)).toBeUndefined();
      expect(result.creatives[0].action).toBe('created');
      const listed = await call('inventory-adserver', 'list_creatives', { account: ACCOUNT, filters: { creative_ids: ['rect_plain'] } }, FORMAT_TOKEN);
      expect(listed.creatives[0].format_id.id).toBe('display_300x250');
      expect(listed.creatives[0].format_option_ref).toBeUndefined();
    });
  });

  describe('review regressions: simulated finality (#9151)', () => {
    const tenant = 'inventory-adserver';
    const TOKEN_FIN = 'demo-inventory-simulate-finality-v1';
    const flight = { start_time: '2027-01-01T00:00:00Z', end_time: '2027-01-31T00:00:00Z' };
    const controller = (scenario: string, params: Record<string, unknown>) =>
      call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, TOKEN_FIN);
    const billing = (window: string) => ({
      billing_measurement: { vendor: { domain: 'measurementvendor.example' }, measurement_window: window, max_variance_percent: 5 },
    });
    let n = 0;
    const book = async (packages: Array<Record<string, unknown>>) => {
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: `inventory-simulate-finality-buy-${String(++n).padStart(8, '0')}`, account: ACCOUNT, brand: BRAND, ...flight, packages,
      }, TOKEN_FIN);
      expectCanonical('create_media_buy', buy);
      return buy;
    };
    const finalityPackage = (extra: Record<string, unknown> = {}) => ({
      product_id: 'billing_finality_video', pricing_option_id: 'cpm_billing_finality', budget: 1000, bid_price: 20, ...extra,
    });
    const row = async (id: string) => {
      const result = await call(tenant, 'get_media_buy_delivery', { account: ACCOUNT, media_buy_ids: [id] }, TOKEN_FIN);
      expectCanonical('get_media_buy_delivery', result);
      return result.media_buy_deliveries[0] as Structured;
    };

    beforeAll(async () => {
      await provision(TOKEN_FIN);
      expect((await controller('sandbox_clock', { operation: 'advance_time', to: '2026-12-31T12:00:00Z' })).success).toBe(true);
      const seeded = await controller('seed_product', {
        product_id: 'billing_finality_video',
        fixture: {
          delivery_type: 'non_guaranteed', channels: ['olv'], name: 'Billing finality video',
          format_options: [{ format_option_id: 'video_15s', format_kind: 'video_hosted', params: { duration_ms_exact: 15000 } }],
          reporting_capabilities: {
            available_metrics: ['impressions', 'clicks', 'spend'],
            measurement_windows: [
              { window_id: 'post_givt', description: 'After GIVT filtering', duration_days: 0, expected_availability_days: 1, is_guarantee_basis: false },
              { window_id: 'post_sivt', description: 'After SIVT filtering', duration_days: 0, expected_availability_days: 3, is_guarantee_basis: true },
            ],
          },
        },
      });
      expect(seeded.success, JSON.stringify(seeded).slice(0, 500)).toBe(true);
      expect((await controller('seed_pricing_option', {
        product_id: 'billing_finality_video', pricing_option_id: 'cpm_billing_finality', fixture: { pricing_model: 'cpm', currency: 'USD', floor_price: 18 },
      })).success).toBe(true);
    });

    it('leaves the row provisional while the buy is final for a window other than the package billing window', async () => {
      const buy = await book([finalityPackage({ measurement_terms: billing('post_sivt') })]);
      const id = buy.media_buy_id;

      const early = await controller('simulate_delivery', { media_buy_id: id, impressions: 100, is_final: true, measurement_window: 'post_givt' });
      expect(early.success, JSON.stringify(early).slice(0, 500)).toBe(true);
      const provisional = await row(id);
      // The package row shows the finality as set, the buy row is not final.
      expect(provisional.by_package[0]).toMatchObject({ is_final: true, measurement_window: 'post_givt' });
      expect(provisional.by_package[0].finalized_at).toBeDefined();
      expect(provisional.is_final).toBe(false);
      expect(provisional.finalized_at).toBeUndefined();

      const billed = await controller('simulate_delivery', { media_buy_id: id, impressions: 10, is_final: true, measurement_window: 'post_sivt' });
      expect(billed.success, JSON.stringify(billed).slice(0, 500)).toBe(true);
      const final = await row(id);
      expect(final.is_final).toBe(true);
      expect(Number.isFinite(Date.parse(final.finalized_at))).toBe(true);
      expect(final.by_package[0]).toMatchObject({ is_final: true, measurement_window: 'post_sivt' });
    });

    it('does not let a package without a billing window hold the row back', async () => {
      const buy = await book([finalityPackage()]);
      const result = await controller('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 50, is_final: true, measurement_window: 'post_givt' });
      expect(result.success, JSON.stringify(result).slice(0, 500)).toBe(true);
      const final = await row(buy.media_buy_id);
      expect(final.is_final).toBe(true);
      expect(final.finalized_at).toBeDefined();
    });

    it('holds the row to every package billing window, ignoring packages that name none', async () => {
      const buy = await book([
        finalityPackage({ measurement_terms: billing('post_sivt') }),
        finalityPackage({ measurement_terms: billing('post_givt') }),
        finalityPackage(),
      ]);
      await controller('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 90, is_final: true, measurement_window: 'post_sivt' });
      expect((await row(buy.media_buy_id)).is_final).toBe(false);
    });

    it('refuses a finalized_at that is not a date-time with an offset', async () => {
      const buy = await book([finalityPackage()]);
      for (const finalized_at of ['2027-01-04', '2027-01-04T12:00:00', 'Jan 4 2027', '20270104T120000Z', 7]) {
        const result = await controller('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 10, finalized_at });
        expect(result.success, String(finalized_at)).toBe(false);
        expect(result.error, String(finalized_at)).toBe('INVALID_PARAMS');
      }
      expect((await row(buy.media_buy_id)).totals.impressions).toBe(0);
    });

    it('emits finalized_at normalized to UTC', async () => {
      const buy = await book([finalityPackage()]);
      const result = await controller('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 10, finalized_at: '2027-01-04T12:00:00+02:00' });
      expect(result.success, JSON.stringify(result).slice(0, 500)).toBe(true);
      const final = await row(buy.media_buy_id);
      expect(final.finalized_at).toBe('2027-01-04T10:00:00.000Z');
      expect(final.by_package[0].finalized_at).toBe('2027-01-04T10:00:00.000Z');
    });
  });

  describe('review regressions: simulated delivery on a canceled package (#9151)', () => {
    const tenant = 'inventory-adserver';
    const TOKEN_CANCEL = 'demo-inventory-simulate-canceled-package-v1';

    it('apportions simulated delivery to the live package only', async () => {
      await provision(TOKEN_CANCEL);
      const run = (scenario: string, params: Record<string, unknown>) =>
        call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, TOKEN_CANCEL);
      expect((await run('sandbox_clock', { operation: 'advance_time', to: '2026-12-31T12:00:00Z' })).success).toBe(true);
      const buy = await call(tenant, 'create_media_buy', {
        idempotency_key: 'inventory-simulate-canceled-package-01', account: ACCOUNT, brand: BRAND,
        start_time: '2027-01-01T00:00:00Z', end_time: '2027-01-31T00:00:00Z',
        packages: [
          { product_id: 'sports_hero_guaranteed', pricing_option_id: 'sports_hero_guaranteed_cpm', budget: 3000, impressions: 5000 },
          { product_id: 'ros_display_guaranteed', pricing_option_id: 'ros_display_guaranteed_cpm', budget: 1000, impressions: 2500 },
        ],
      }, TOKEN_CANCEL);
      expectCanonical('create_media_buy', buy);
      const [hero, ros] = buy.packages.map((pkg: Structured) => pkg.package_id);
      const canceled = await call(tenant, 'update_media_buy', {
        idempotency_key: 'inventory-simulate-canceled-package-02', account: ACCOUNT, media_buy_id: buy.media_buy_id,
        packages: [{ package_id: hero, canceled: true }],
      }, TOKEN_CANCEL);
      expectCanonical('update_media_buy', canceled);

      const result = await run('simulate_delivery', { media_buy_id: buy.media_buy_id, impressions: 1000, clicks: 10 });
      expect(result.success, JSON.stringify(result).slice(0, 500)).toBe(true);
      const delivered = await call(tenant, 'get_media_buy_delivery', { account: ACCOUNT, media_buy_ids: [buy.media_buy_id] }, TOKEN_CANCEL);
      const entries = Object.fromEntries(delivered.media_buy_deliveries[0].by_package.map((entry: Structured) => [entry.package_id, entry]));
      expect(entries[ros].impressions).toBe(1000);
      expect(entries[hero]?.impressions ?? 0).toBe(0);
      expect(delivered.media_buy_deliveries[0].totals.impressions).toBe(1000);
    });
  });

  describe('review regressions: seeded format options (#9152)', () => {
    const tenant = 'inventory-adserver';
    const TOKEN_FMT = 'demo-inventory-seeded-regressions-v1';
    const TOKEN_NATIVE = 'demo-inventory-seeded-regressions-native-v1';
    const TOKEN_AMBIGUOUS = 'demo-inventory-seeded-regressions-ambiguous-v1';
    const controller = (token: string, scenario: string, params: Record<string, unknown>) =>
      call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, token);
    const seed = async (token: string, productId: string, formatOptions: Structured[]) => {
      const seeded = await controller(token, 'seed_product', {
        product_id: productId,
        fixture: { delivery_type: 'non_guaranteed', channels: ['display'], name: productId, format_options: formatOptions },
      });
      expect(seeded.success, `${productId}: ${JSON.stringify(seeded).slice(0, 500)}`).toBe(true);
      const priced = await controller(token, 'seed_pricing_option', {
        product_id: productId, pricing_option_id: `${productId}_cpm`, fixture: { pricing_model: 'cpm', currency: 'USD', floor_price: 4 },
      });
      expect(priced.success, `${productId}: ${JSON.stringify(priced).slice(0, 500)}`).toBe(true);
    };
    let key = 0;
    const sync = (token: string, creatives: Structured[], extra: Record<string, unknown> = {}) =>
      call(tenant, 'sync_creatives', { idempotency_key: `inventory-seeded-regress-${String(++key).padStart(8, '0')}`, account: ACCOUNT, creatives, ...extra }, token);
    const errorOf = (result: Structured) => result.errors?.[0] ?? result.adcp_error;
    const listed = async (token: string, id: string) =>
      (await call(tenant, 'list_creatives', { account: ACCOUNT, filters: { creative_ids: [id] } }, token)).creatives[0] as Structured;
    const image = (id: string, ref: Structured, width: number, height: number) => ({
      creative_id: id, name: id, format_kind: 'image', format_option_ref: ref,
      assets: {
        image: { asset_type: 'image', url: `https://cdn.inventory-buyer.example/${id}.png`, width, height },
        click_url: { asset_type: 'url', url: 'https://inventory-buyer.example/landing' },
      },
    });
    const video = (id: string, ref: Structured, durationMs: number) => ({
      creative_id: id, name: id, format_kind: 'video_hosted', format_option_ref: ref,
      assets: { video: { asset_type: 'video', url: `https://cdn.inventory-buyer.example/${id}.mp4`, duration_ms: durationMs } },
    });
    const publisher = (domain: string, id: string) => ({ scope: 'publisher', publisher_domain: domain, format_option_id: id });
    const product = (id: string) => ({ scope: 'product', format_option_id: id });
    const buyOf = (token: string, productId: string, keySuffix: string, extra: Record<string, unknown> = {}) =>
      call(tenant, 'create_media_buy', {
        idempotency_key: `inventory-seeded-regress-buy-${keySuffix}`, account: ACCOUNT, brand: BRAND,
        start_time: '2027-02-01T00:00:00Z', end_time: '2027-02-28T00:00:00Z',
        packages: [{ product_id: productId, pricing_option_id: `${productId}_cpm`, budget: 1000, bid_price: 5, ...extra }],
      }, token);

    beforeAll(async () => {
      await provision(TOKEN_FMT);
      await provision(TOKEN_NATIVE);
      await provision(TOKEN_AMBIGUOUS);
      await seed(TOKEN_FMT, 'pub_a', [{ format_option_id: 'banner', format_kind: 'image', publisher_domain: 'a.example', params: { width: 300, height: 250 } }]);
      await seed(TOKEN_FMT, 'pub_b', [{ format_option_id: 'banner', format_kind: 'image', publisher_domain: 'b.example', params: { width: 728, height: 90 } }]);
      await seed(TOKEN_FMT, 'tile_a', [{ format_option_id: 'tile', format_kind: 'image', params: { width: 320, height: 50 } }]);
      await seed(TOKEN_FMT, 'tile_b', [{ format_option_id: 'tile', format_kind: 'image', params: { width: 160, height: 600 } }]);
      await seed(TOKEN_FMT, 'twin_a', [{ format_option_id: 'twin', format_kind: 'image', params: { width: 120, height: 600 } }]);
      await seed(TOKEN_FMT, 'twin_b', [{ format_option_id: 'twin', format_kind: 'image', params: { width: 120, height: 600 } }]);
      await seed(TOKEN_FMT, 'clips', [
        { format_option_id: 'clip_15s', format_kind: 'video_hosted', params: { duration_ms_exact: 15000 } },
        { format_option_id: 'clip_short', format_kind: 'video_hosted', params: { duration_ms_range: [null, 30000] } },
      ]);
      await seed(TOKEN_NATIVE, 'idless_native', [{ format_kind: 'native_in_feed', params: { title_max_chars: 20 } }]);
      await seed(TOKEN_AMBIGUOUS, 'native_one', [{ format_option_id: 'feed_one', format_kind: 'native_in_feed', params: { title_max_chars: 20 } }]);
      await seed(TOKEN_AMBIGUOUS, 'native_two', [{ format_option_id: 'feed_two', format_kind: 'native_in_feed', params: { title_max_chars: 40 } }]);
    });

    it('resolves a publisher ref to the option that publisher declares, and lists it back under that publisher', async () => {
      const ref = publisher('b.example', 'banner');
      const result = await sync(TOKEN_FMT, [image('banner_b', ref, 728, 90)]);
      expect(result.errors, JSON.stringify(result).slice(0, 800)).toBeUndefined();
      expect((await listed(TOKEN_FMT, 'banner_b')).format_option_ref).toEqual(ref);
      const other = publisher('a.example', 'banner');
      expect((await sync(TOKEN_FMT, [image('banner_a', other, 300, 250)])).errors).toBeUndefined();
      expect((await listed(TOKEN_FMT, 'banner_a')).format_option_ref).toEqual(other);
    });

    it('refuses a publisher ref for a publisher that declares no such option', async () => {
      const result = await sync(TOKEN_FMT, [image('banner_c', publisher('c.example', 'banner'), 300, 250)]);
      expect(errorOf(result), JSON.stringify(result).slice(0, 800)).toMatchObject({ code: 'FORMAT_NOT_SUPPORTED', field: 'creatives[0].format_option_ref' });
    });

    it('refuses a product-scope ref to an id only a publisher option has', async () => {
      const result = await sync(TOKEN_FMT, [image('banner_product', product('banner'), 300, 250)]);
      expect(errorOf(result), JSON.stringify(result).slice(0, 800)).toMatchObject({ code: 'FORMAT_NOT_SUPPORTED', field: 'creatives[0].format_option_ref' });
    });

    it('calls a library creative ambiguous when two products declare different product-local options by one id', async () => {
      const result = await sync(TOKEN_FMT, [image('tile_library', product('tile'), 320, 50)]);
      expect(errorOf(result), JSON.stringify(result).slice(0, 800)).toMatchObject({ code: 'INVALID_REQUEST', field: 'creatives[0].format_option_ref' });
    });

    it('resolves the same ref inline to the option of the package product, on create_media_buy and update_media_buy', async () => {
      const created = await buyOf(TOKEN_FMT, 'tile_a', 'tile-a-01', { creatives: [image('tile_inline_a', product('tile'), 320, 50)] });
      expectCanonical('create_media_buy', created);
      expect(created.packages[0].package_id).toBeDefined();
      expect(await listed(TOKEN_FMT, 'tile_inline_a')).toMatchObject({ format_kind: 'image', format_option_ref: product('tile') });

      // Product B's tile is 160x600, so A's size is refused in B's package.
      const refused = await buyOf(TOKEN_FMT, 'tile_b', 'tile-b-01', { creatives: [image('tile_inline_wrong', product('tile'), 320, 50)] });
      expect(errorOf(refused) ?? refused, JSON.stringify(refused).slice(0, 800)).toMatchObject({ code: 'CREATIVE_SIZE_MISMATCH' });
      const accepted = await buyOf(TOKEN_FMT, 'tile_b', 'tile-b-02', { creatives: [image('tile_inline_b', product('tile'), 160, 600)] });
      expectCanonical('create_media_buy', accepted);

      const updated = await call(tenant, 'update_media_buy', {
        idempotency_key: 'inventory-seeded-regress-update-01', account: ACCOUNT, media_buy_id: created.media_buy_id,
        packages: [{ package_id: created.packages[0].package_id, creatives: [image('tile_update_a', product('tile'), 320, 50)] }],
      }, TOKEN_FMT);
      expectCanonical('update_media_buy', updated);
      expect(await listed(TOKEN_FMT, 'tile_update_a')).toMatchObject({ format_option_ref: product('tile') });

      const wrong = await call(tenant, 'update_media_buy', {
        idempotency_key: 'inventory-seeded-regress-update-02', account: ACCOUNT, media_buy_id: created.media_buy_id,
        packages: [{ package_id: created.packages[0].package_id, creatives: [image('tile_update_wrong', product('tile'), 160, 600)] }],
      }, TOKEN_FMT);
      expect(JSON.stringify(wrong)).toContain('CREATIVE_SIZE_MISMATCH');
    });

    it('treats an option two products declare identically as one format, assignable to either package', async () => {
      const first = await buyOf(TOKEN_FMT, 'twin_a', 'twin-a');
      const second = await buyOf(TOKEN_FMT, 'twin_b', 'twin-b');
      expectCanonical('create_media_buy', first);
      expectCanonical('create_media_buy', second);
      const synced = await sync(TOKEN_FMT, [image('twin_creative', product('twin'), 120, 600)]);
      expect(synced.errors, JSON.stringify(synced).slice(0, 800)).toBeUndefined();
      for (const buy of [first, second]) {
        const assigned = await sync(TOKEN_FMT, [], {
          assignment_operations: [{ operation: 'assign', creative_id: 'twin_creative', package_id: buy.packages[0].package_id }],
        });
        expect(assigned.errors, JSON.stringify(assigned).slice(0, 800)).toBeUndefined();
      }
      const check = await call(tenant, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [first.media_buy_id, second.media_buy_id] }, TOKEN_FMT);
      for (const buy of check.media_buys) {
        expect(buy.packages[0].creative_approvals.map((approval: Structured) => approval.creative_id)).toEqual(['twin_creative']);
      }
    });

    it('serves an option without a format_option_id by kind, and lists it with a format_kind but no format_option_ref', async () => {
      const creative = {
        creative_id: 'idless_ok', name: 'idless_ok', format_kind: 'native_in_feed',
        assets: {
          title: { asset_type: 'text', content: 'Short title' },
          cta: { asset_type: 'text', content: 'SHOP_NOW' },
          landing_page_url: { asset_type: 'url', url: 'https://inventory-buyer.example/landing' },
        },
      };
      const result = await sync(TOKEN_NATIVE, [creative]);
      expect(result.errors, JSON.stringify(result).slice(0, 800)).toBeUndefined();
      const read = await listed(TOKEN_NATIVE, 'idless_ok');
      expect(read.format_kind).toBe('native_in_feed');
      expect(read.format_option_ref).toBeUndefined();
      expect(read.format_id).toBeUndefined();
    });

    it('refuses an image in a seeded option of another size, naming the allowed size', async () => {
      const ref = publisher('a.example', 'banner');
      const wrong = await sync(TOKEN_FMT, [image('size_wrong', ref, 728, 90)]);
      expect(errorOf(wrong), JSON.stringify(wrong).slice(0, 800)).toMatchObject({
        code: 'CREATIVE_SIZE_MISMATCH', field: 'creatives[0].assets.image',
      });
      expect(errorOf(wrong).details.allowed_sizes).toEqual([{ width: 300, height: 250 }]);
      const right = await sync(TOKEN_FMT, [image('size_right', ref, 300, 250)]);
      expect(right.errors, JSON.stringify(right).slice(0, 800)).toBeUndefined();
    });

    it('refuses a size stated in params, on the params field', async () => {
      const creative = { ...image('size_params', publisher('a.example', 'banner'), 300, 250), params: { width: 728, height: 90 } };
      const result = await sync(TOKEN_FMT, [creative]);
      expect(errorOf(result), JSON.stringify(result).slice(0, 800)).toMatchObject({ code: 'CREATIVE_SIZE_MISMATCH', field: 'creatives[0].params' });
    });

    it('does not refuse a creative that states no size', async () => {
      const bare = image('size_unstated', publisher('a.example', 'banner'), 300, 250);
      const { width: _width, height: _height, ...unsized } = bare.assets.image;
      const result = await sync(TOKEN_FMT, [{ ...bare, assets: { ...bare.assets, image: unsized } }]);
      expect(result.errors, JSON.stringify(result).slice(0, 800)).toBeUndefined();
    });

    it('holds a video to the option duration: exactly, or inside a range with an open end', async () => {
      const exact = product('clip_15s');
      expect((await sync(TOKEN_FMT, [video('clip_15_ok', exact, 15000)])).errors).toBeUndefined();
      const long = await sync(TOKEN_FMT, [video('clip_15_long', exact, 30000)]);
      expect(errorOf(long), JSON.stringify(long).slice(0, 800)).toMatchObject({ code: 'VALIDATION_ERROR', field: 'creatives[0].assets.video.duration_ms' });

      const range = product('clip_short');
      expect((await sync(TOKEN_FMT, [video('clip_short_ok', range, 15000)])).errors).toBeUndefined();
      const over = await sync(TOKEN_FMT, [video('clip_short_over', range, 45000)]);
      expect(errorOf(over), JSON.stringify(over).slice(0, 800)).toMatchObject({ code: 'VALIDATION_ERROR', field: 'creatives[0].assets.video.duration_ms' });
    });

    it('returns the seeded ambiguity, naming both options, when the season has no format of the kind', async () => {
      const creative = {
        creative_id: 'native_unnamed', name: 'native_unnamed', format_kind: 'native_in_feed',
        assets: {
          title: { asset_type: 'text', content: 'Short title' },
          cta: { asset_type: 'text', content: 'SHOP_NOW' },
          landing_page_url: { asset_type: 'url', url: 'https://inventory-buyer.example/landing' },
        },
      };
      const result = await sync(TOKEN_AMBIGUOUS, [creative]);
      const error = errorOf(result);
      expect(error, JSON.stringify(result).slice(0, 800)).toMatchObject({ code: 'INVALID_REQUEST' });
      expect(JSON.stringify(error)).toContain('feed_one');
      expect(JSON.stringify(error)).toContain('feed_two');
    });
  });

  describe('second-round review regressions: seeded format options (#9152)', () => {
    const tenant = 'inventory-adserver';
    const TOKEN_TYPO = 'demo-inventory-seeded-round2-typo-v1';
    const TOKEN_COLLIDE = 'demo-inventory-seeded-round2-collide-v1';
    const TOKEN_SIZES = 'demo-inventory-seeded-round2-sizes-v1';
    const TOKEN_ORDER = 'demo-inventory-seeded-round2-order-v1';
    const controller = (token: string, scenario: string, params: Record<string, unknown>) =>
      call(tenant, 'comply_test_controller', { scenario, account: ACCOUNT, params }, token);
    const seed = async (token: string, productId: string, formatOptions: Structured[]) => {
      const seeded = await controller(token, 'seed_product', {
        product_id: productId,
        fixture: { delivery_type: 'non_guaranteed', channels: ['display'], name: productId, format_options: formatOptions },
      });
      expect(seeded.success, `${productId}: ${JSON.stringify(seeded).slice(0, 500)}`).toBe(true);
      const priced = await controller(token, 'seed_pricing_option', {
        product_id: productId, pricing_option_id: `${productId}_cpm`, fixture: { pricing_model: 'cpm', currency: 'USD', floor_price: 4 },
      });
      expect(priced.success, `${productId}: ${JSON.stringify(priced).slice(0, 500)}`).toBe(true);
    };
    let key = 0;
    const sync = (token: string, creatives: Structured[], extra: Record<string, unknown> = {}) =>
      call(tenant, 'sync_creatives', { idempotency_key: `inventory-seeded-round2-${String(++key).padStart(8, '0')}`, account: ACCOUNT, creatives, ...extra }, token);
    const errorOf = (result: Structured) => result.errors?.[0] ?? result.adcp_error;
    const listed = async (token: string, id: string) =>
      (await call(tenant, 'list_creatives', { account: ACCOUNT, filters: { creative_ids: [id] } }, token)).creatives[0] as Structured;
    const image = (id: string, ref: Structured | undefined, width: number, height: number, extra: Record<string, unknown> = {}) => ({
      creative_id: id, name: id, format_kind: 'image', ...(ref ? { format_option_ref: ref } : {}), ...extra,
      assets: {
        image: { asset_type: 'image', url: `https://cdn.inventory-buyer.example/${id}.png`, width, height },
        click_url: { asset_type: 'url', url: 'https://inventory-buyer.example/landing' },
      },
    });
    const native = (id: string, ref?: Structured) => ({
      creative_id: id, name: id, format_kind: 'native_in_feed', ...(ref ? { format_option_ref: ref } : {}),
      assets: {
        title: { asset_type: 'text', content: 'Short title' },
        cta: { asset_type: 'text', content: 'SHOP_NOW' },
        landing_page_url: { asset_type: 'url', url: 'https://inventory-buyer.example/landing' },
      },
    });
    const product = (id: string) => ({ scope: 'product', format_option_id: id });
    const buyOf = (token: string, productId: string, keySuffix: string) =>
      call(tenant, 'create_media_buy', {
        idempotency_key: `inventory-seeded-round2-buy-${keySuffix}`, account: ACCOUNT, brand: BRAND,
        start_time: '2027-02-01T00:00:00Z', end_time: '2027-02-28T00:00:00Z',
        packages: [{ product_id: productId, pricing_option_id: `${productId}_cpm`, budget: 1000, bid_price: 5 }],
      }, token);

    beforeAll(async () => {
      for (const token of [TOKEN_TYPO, TOKEN_COLLIDE, TOKEN_SIZES, TOKEN_ORDER]) await provision(token);
      await seed(TOKEN_TYPO, 'only_feed', [{ format_option_id: 'real_feed', format_kind: 'native_in_feed', params: { title_max_chars: 20 } }]);
      await seed(TOKEN_COLLIDE, 'collide', [{
        format_option_id: 'display_300x250_image', format_kind: 'image', publisher_domain: 'b.example', params: { width: 300, height: 250 },
      }]);
      await seed(TOKEN_SIZES, 'sized', [{ format_option_id: 'sized_rect', format_kind: 'image', params: { width: 300, height: 250 } }]);
      await seed(TOKEN_ORDER, 'order_a', [{ format_option_id: 'rect', format_kind: 'image', params: { width: 300, height: 250, extra: { a: 1, b: 2 } } }]);
      await seed(TOKEN_ORDER, 'order_b', [{ format_option_id: 'rect', format_kind: 'image', params: { extra: { b: 2, a: 1 }, height: 250, width: 300 } }]);
    });

    it('does not pick the only seeded option by kind for an explicit ref that names none', async () => {
      const typo = await sync(TOKEN_TYPO, [native('typo_ref', product('typo'))]);
      expect(errorOf(typo), JSON.stringify(typo).slice(0, 800)).toMatchObject({ code: 'FORMAT_NOT_SUPPORTED' });
      const bare = await sync(TOKEN_TYPO, [native('typo_bare')]);
      expect(bare.errors, JSON.stringify(bare).slice(0, 800)).toBeUndefined();
    });

    it('keeps a publisher ref apart from a season option id, and a product ref on the season format', async () => {
      const ref = { scope: 'publisher', publisher_domain: 'b.example', format_option_id: 'display_300x250_image' };
      const result = await sync(TOKEN_COLLIDE, [image('collide_pub', ref, 300, 250)]);
      expect(result.errors, JSON.stringify(result).slice(0, 800)).toBeUndefined();
      const publisherListed = await listed(TOKEN_COLLIDE, 'collide_pub');
      expect(publisherListed).toMatchObject({ format_kind: 'image', format_option_ref: ref });
      expect(publisherListed.format_id).toBeUndefined();

      const own = await sync(TOKEN_COLLIDE, [image('collide_own', product('display_300x250_image'), 300, 250)]);
      expect(own.errors, JSON.stringify(own).slice(0, 800)).toBeUndefined();
      expect((await listed(TOKEN_COLLIDE, 'collide_own')).format_id).toBeDefined();
    });

    it('refuses an asset of another size even when the params match the seeded option', async () => {
      const creative = image('sized_conflict', product('sized_rect'), 728, 90, { params: { width: 300, height: 250 } });
      const result = await sync(TOKEN_SIZES, [creative]);
      expect(errorOf(result), JSON.stringify(result).slice(0, 800)).toMatchObject({
        code: 'CREATIVE_SIZE_MISMATCH', field: 'creatives[0].assets.image',
      });
    });

    it('treats the same params in another key order as one option, assignable to either package', async () => {
      const first = await buyOf(TOKEN_ORDER, 'order_a', 'a');
      const second = await buyOf(TOKEN_ORDER, 'order_b', 'b');
      expectCanonical('create_media_buy', first);
      expectCanonical('create_media_buy', second);
      const synced = await sync(TOKEN_ORDER, [image('order_creative', product('rect'), 300, 250)]);
      expect(synced.errors, JSON.stringify(synced).slice(0, 800)).toBeUndefined();
      for (const buy of [first, second]) {
        const assigned = await sync(TOKEN_ORDER, [], {
          assignment_operations: [{ operation: 'assign', creative_id: 'order_creative', package_id: buy.packages[0].package_id }],
        });
        expect(assigned.errors, JSON.stringify(assigned).slice(0, 800)).toBeUndefined();
      }
    });
  });
});
