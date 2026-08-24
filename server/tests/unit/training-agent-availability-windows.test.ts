import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'avail-window.example.com' }, operator: 'avail-tester', sandbox: true };
const BRAND = { domain: 'avail-window.example.com', name: 'Availability Window Test Brand' };

function withIdempotencyKey(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!MUTATING_TOOLS.has(toolName)) return args;
  if (args.idempotency_key !== undefined) return args;
  return { ...args, idempotency_key: `test-${crypto.randomUUID()}` };
}

async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: withIdempotencyKey(toolName, args) } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed: Record<string, unknown> = response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
  return (parsed.adcp_error as Record<string, unknown> | undefined) ?? parsed;
}

const HORIZON = { start_time: '2099-09-01T00:00:00Z', end_time: '2099-10-01T00:00:00Z' };
const AVAILABILITY_PRODUCT_ID = 'avail_test_product';

async function seedAvailabilityProduct(
  server: ReturnType<typeof createTrainingAgentServer>,
  overrides?: { min_bookable_days?: number; booked_windows?: Array<{ start_time: string; end_time: string }> },
): Promise<void> {
  const seed = await callTool(server, 'comply_test_controller', {
    scenario: 'seed_product',
    account: ACCOUNT,
    brand: BRAND,
    params: {
      product_id: AVAILABILITY_PRODUCT_ID,
      fixture: {
        delivery_type: 'non_guaranteed',
        channels: ['display'],
        availability: {
          min_bookable_days: overrides?.min_bookable_days ?? 3,
          booked_windows: overrides?.booked_windows ?? [
            { start_time: '2099-09-20T00:00:00Z', end_time: '2099-09-27T00:00:00Z' },
            { start_time: '2099-09-27T00:00:00Z', end_time: '2099-09-29T00:00:00Z' },
          ],
        },
      },
    },
  });
  expect(seed.success).toBe(true);
}

function buildPackage(startTime: string, endTime: string): Record<string, unknown> {
  return {
    account: ACCOUNT,
    brand: BRAND,
    start_time: startTime,
    end_time: endTime,
    packages: [{
      product_id: AVAILABILITY_PRODUCT_ID,
      pricing_option_id: 'fixture_default_cpm',
      budget: 5000,
      bid_price: 10,
    }],
  };
}

describe('flexible-window availability discovery (training agent)', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  describe('get_adcp_capabilities', () => {
    it('declares media_buy.availability_horizon: true', async () => {
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      expect((caps as { media_buy: { availability_horizon?: boolean } }).media_buy.availability_horizon).toBe(true);
    });
  });

  describe('windowed forecast at discovery time', () => {
    it('partitions the horizon into coalesced available/unavailable windows', async () => {
      await seedAvailabilityProduct(server);

      const discovery = await callTool(server, 'get_products', {
        buying_mode: 'wholesale',
        account: ACCOUNT,
        brand: BRAND,
        filters: { availability_horizon: HORIZON },
      });

      const products = (discovery as { products?: Array<Record<string, unknown>> }).products ?? [];
      const product = products.find(p => p.product_id === AVAILABILITY_PRODUCT_ID);
      expect(product).toBeDefined();

      const forecast = product!.forecast as Record<string, unknown>;
      expect(forecast.forecast_range_unit).toBe('availability');
      expect(forecast.method).toBe('modeled');
      expect(forecast.currency).toBe('USD');
      expect(typeof forecast.generated_at).toBe('string');
      expect(typeof forecast.valid_until).toBe('string');

      const points = forecast.points as Array<Record<string, unknown>>;
      // Booked span (09-20..09-27) + adjacent booked span (09-27..09-29) +
      // the too-short trailing gap (09-29..10-01, 2 days < 3-day minimum)
      // all coalesce into ONE unavailable window.
      expect(points).toHaveLength(2);

      expect(points[0]).toEqual({
        dimensions: [{ kind: 'time', start_time: '2099-09-01T00:00:00Z', end_time: '2099-09-20T00:00:00Z' }],
        availability_status: 'available',
        metrics: {
          impressions: { mid: 19000 },
          spend: { mid: 4750 },
        },
      });
      expect(points[1]).toEqual({
        dimensions: [{ kind: 'time', start_time: '2099-09-20T00:00:00Z', end_time: '2099-10-01T00:00:00Z' }],
        availability_status: 'unavailable',
        metrics: {},
      });
    });

    it('leaves products without seeded availability untouched', async () => {
      const discovery = await callTool(server, 'get_products', {
        buying_mode: 'wholesale',
        account: ACCOUNT,
        brand: BRAND,
        filters: { availability_horizon: HORIZON },
      });
      const products = (discovery as { products?: Array<Record<string, unknown>> }).products ?? [];
      expect(products.length).toBeGreaterThan(0);
      for (const product of products) {
        // Catalog products keep whatever forecast shape product-factory.ts baked in
        // (never an availability_horizon-scoped window) since none has seeded
        // availability data.
        const forecast = product.forecast as Record<string, unknown> | undefined;
        if (forecast) {
          expect(
            forecast.forecast_range_unit !== 'availability'
            || !Array.isArray((forecast.points as unknown[])[0] && (forecast.points as Array<{ dimensions?: unknown }>)[0]?.dimensions),
          ).toBe(true);
        }
      }
    });
  });

  describe('buy-time booking-calendar validation', () => {
    it('rejects a flight that overlaps a booked window with PRODUCT_UNAVAILABLE', async () => {
      await seedAvailabilityProduct(server);

      const buy = await callTool(
        server,
        'create_media_buy',
        buildPackage('2099-09-21T00:00:00Z', '2099-09-25T00:00:00Z'),
      );

      // A single-error response is unwrapped to the bare adcp_error object
      // by the L3 compliance envelope (see callTool's adcp_error unwrap).
      expect(buy.code).toBe('PRODUCT_UNAVAILABLE');
      expect(buy.media_buy_id).toBeUndefined();
    });

    it('rejects a flight shorter than min_bookable_days with PRODUCT_UNAVAILABLE', async () => {
      await seedAvailabilityProduct(server);

      // Open span (no booked window overlap) but only 2 days — below the
      // 3-day minimum bookable duration.
      const buy = await callTool(
        server,
        'create_media_buy',
        buildPackage('2099-10-05T00:00:00Z', '2099-10-07T00:00:00Z'),
      );

      expect(buy.code).toBe('PRODUCT_UNAVAILABLE');
      expect(buy.media_buy_id).toBeUndefined();
    });

    it('accepts a flight on an open span meeting the minimum duration', async () => {
      await seedAvailabilityProduct(server);

      const buy = await callTool(
        server,
        'create_media_buy',
        buildPackage('2099-09-01T00:00:00Z', '2099-09-10T00:00:00Z'),
      );

      expect(buy.errors).toBeUndefined();
      expect(typeof buy.media_buy_id).toBe('string');
    });

    it('skips the calendar check for "asap" starts', async () => {
      await seedAvailabilityProduct(server);

      const buy = await callTool(server, 'create_media_buy', {
        account: ACCOUNT,
        brand: BRAND,
        start_time: 'asap',
        end_time: '2099-09-25T00:00:00Z',
        packages: [{
          product_id: AVAILABILITY_PRODUCT_ID,
          pricing_option_id: 'fixture_default_cpm',
          budget: 5000,
          bid_price: 10,
        }],
      });

      expect(buy.errors).toBeUndefined();
      expect(typeof buy.media_buy_id).toBe('string');
    });
  });

  describe('list_products conditional-read rule', () => {
    it('never returns outcome: unchanged when fields includes forecast, even on a matching if_feed_version', async () => {
      const listBrand = { domain: 'avail-list-products.example.com' };
      const first = await callTool(server, 'list_products', { brand: listBrand });
      expect(first.outcome).toBe('listed');
      const feedVersion = first.feed_version as string;
      expect(typeof feedVersion).toBe('string');

      const withForecastField = await callTool(server, 'list_products', {
        brand: listBrand,
        if_feed_version: feedVersion,
        fields: ['forecast'],
      });
      expect(withForecastField.outcome).toBe('listed');
      expect(withForecastField.products).toEqual(expect.any(Array));

      // Baseline: without fields: ["forecast"], a matching if_feed_version
      // still takes the existing unchanged shortcut.
      const withoutForecastField = await callTool(server, 'list_products', {
        brand: listBrand,
        if_feed_version: feedVersion,
      });
      expect(withoutForecastField.outcome).toBe('unchanged');
      expect(withoutForecastField.products).toBeUndefined();
    });
  });
});
