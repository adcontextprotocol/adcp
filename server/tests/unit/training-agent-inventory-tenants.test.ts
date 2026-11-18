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

  describe('sandbox_clock on the inventory tenants', () => {
    const tenant = 'inventory-adserver';
    const CLOCK_TOKEN = 'demo-inventory-clock-v1';
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

  describe('/inventory-content', () => {
    const tenant = 'inventory-content';
    const CONTENT_TOKEN = 'demo-inventory-content-v1';
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

    it('reports a postponed installment at its new date', async () => {
      await clock({ operation: 'advance_time', to: '2027-01-24T00:00:00Z' });
      const offer = await products('2027-01-15', '2027-01-20');
      const video = offer.products.find((product: Structured) => product.product_id === 'maker_studio_integration');
      const moved = video.installments.find((installment: Structured) => installment.installment_id === 'maker_studio_006');
      expect(moved.status).toBe('published');
      expect(moved.scheduled_at).toBe('2027-01-23T00:00:00Z');
    });
  });
});
