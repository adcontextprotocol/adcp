import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// buildCatalog is wrapped so a test can perturb the built-in catalogue the
// agent serves. invalidateCache() drops the module-level cachedCatalog so the
// next read rebuilds through the mutator.
const hooks = vi.hoisted(() => ({
  mutate: null as null | ((catalog: Array<{ product: Record<string, any> }>) => void),
}));

vi.mock('../../src/training-agent/product-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/training-agent/product-factory.js')>();
  return {
    ...actual,
    buildCatalog: (...args: Parameters<typeof actual.buildCatalog>) => {
      const catalog = actual.buildCatalog(...args);
      hooks.mutate?.(catalog as unknown as Array<{ product: Record<string, any> }>);
      return catalog;
    },
  };
});

import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache, MUTATING_TOOLS } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const FEED_RE = /^training-products-feed-v1\.public\.[0-9a-f]{16}$/;
const PRICING_RE = /^training-products-pricing-v1\.public\.[0-9a-f]{16}$/;

type Server = ReturnType<typeof createTrainingAgentServer>;

async function call(server: Server, tool: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const handler = ((server as any)._requestHandlers as Map<string, Function>).get('tools/call')!;
  const withKey = MUTATING_TOOLS.has(tool) && args.idempotency_key === undefined
    ? { ...args, idempotency_key: `test-${randomUUID()}` }
    : args;
  const response = await handler({ method: 'tools/call', params: { name: tool, arguments: withKey } }, {});
  const text = response.content?.[0]?.text;
  const parsed = response.structuredContent ?? (text ? JSON.parse(text) : {});
  return parsed.adcp_error ?? parsed;
}

const wholesale = (server: Server, extra: Record<string, unknown> = {}) =>
  call(server, 'get_products', { buying_mode: 'wholesale', ...extra });

function rebuildCatalog(mutate: typeof hooks.mutate): void {
  hooks.mutate = mutate;
  invalidateCache();
  clearSessions();
}

describe('training agent wholesale feed version covers the built-in catalogue', () => {
  beforeEach(() => {
    hooks.mutate = null;
    invalidateCache();
    clearSessions();
    clearTaskStore();
    clearIdempotencyCache();
  });

  it('returns well-formed digest tokens', async () => {
    const res = await wholesale(createTrainingAgentServer(DEFAULT_CTX));
    expect(res.wholesale_feed_version).toMatch(FEED_RE);
    expect(res.pricing_version).toMatch(PRICING_RE);
  });

  it('keeps both tokens for an identical catalogue and answers unchanged', async () => {
    const first = await wholesale(createTrainingAgentServer(DEFAULT_CTX));
    const again = await wholesale(createTrainingAgentServer(DEFAULT_CTX));
    expect(again.wholesale_feed_version).toBe(first.wholesale_feed_version);
    expect(again.pricing_version).toBe(first.pricing_version);

    // A rebuilt-but-identical catalogue digests the same.
    rebuildCatalog(null);
    const rebuilt = await wholesale(createTrainingAgentServer(DEFAULT_CTX));
    expect(rebuilt.wholesale_feed_version).toBe(first.wholesale_feed_version);
    expect(rebuilt.pricing_version).toBe(first.pricing_version);

    const probe = await wholesale(createTrainingAgentServer(DEFAULT_CTX), {
      if_wholesale_feed_version: first.wholesale_feed_version,
      if_pricing_version: first.pricing_version,
    });
    expect(probe.unchanged).toBe(true);
    expect(probe.products).toBeUndefined();
  });

  it('moves wholesale_feed_version when the built-in catalogue changes', async () => {
    const first = await wholesale(createTrainingAgentServer(DEFAULT_CTX));
    const total = (first.products as unknown[]).length;
    expect(total).toBeGreaterThan(1);

    rebuildCatalog(catalog => { catalog[0].product.description = `${catalog[0].product.description ?? ''} (edited)`; });
    const probe = await wholesale(createTrainingAgentServer(DEFAULT_CTX), {
      if_wholesale_feed_version: first.wholesale_feed_version,
      if_pricing_version: first.pricing_version,
    });
    expect(probe.unchanged).toBeUndefined();
    expect((probe.products as unknown[]).length).toBe(total);
    expect(probe.wholesale_feed_version).not.toBe(first.wholesale_feed_version);
    expect(probe.pricing_version).toBe(first.pricing_version);
  });

  it('moves wholesale_feed_version when a built-in product is dropped', async () => {
    const first = await wholesale(createTrainingAgentServer(DEFAULT_CTX));
    rebuildCatalog(catalog => { catalog.pop(); });
    const probe = await wholesale(createTrainingAgentServer(DEFAULT_CTX), {
      if_wholesale_feed_version: first.wholesale_feed_version,
      if_pricing_version: first.pricing_version,
    });
    expect(probe.unchanged).toBeUndefined();
    expect(probe.wholesale_feed_version).not.toBe(first.wholesale_feed_version);
    expect(probe.products).toBeDefined();
  });

  it('moves only pricing_version on a built-in price-only change', async () => {
    const first = await wholesale(createTrainingAgentServer(DEFAULT_CTX));
    rebuildCatalog(catalog => {
      const option = catalog.find(e => Array.isArray(e.product.pricing_options) && e.product.pricing_options.length > 0)!
        .product.pricing_options[0];
      option.fixed_price = (option.fixed_price ?? option.floor_price ?? 1) + 0.37;
      if (option.floor_price !== undefined) option.floor_price += 0.37;
    });
    const probe = await wholesale(createTrainingAgentServer(DEFAULT_CTX), {
      if_wholesale_feed_version: first.wholesale_feed_version,
      if_pricing_version: first.pricing_version,
    });
    expect(probe.unchanged).toBeUndefined();
    expect((probe.products as unknown[]).length).toBeGreaterThan(0);
    expect(probe.wholesale_feed_version).toBe(first.wholesale_feed_version);
    expect(probe.pricing_version).not.toBe(first.pricing_version);
  });

  it('ignores forecast-only changes (forecast is not part of the durable offer definition)', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const first = await wholesale(server);
    const productId = (first.products as Array<{ product_id: string }>)[0].product_id;
    const listedFirst = await call(server, 'list_products', { criteria: { product_ids: [productId] } });

    rebuildCatalog(catalog => {
      const entry = catalog.find(e => e.product.forecast?.points?.[0]?.metrics?.impressions)!;
      entry.product.forecast.points[0].metrics.impressions.mid += 1;
    });
    const fresh = createTrainingAgentServer(DEFAULT_CTX);
    const probe = await wholesale(fresh, {
      if_wholesale_feed_version: first.wholesale_feed_version,
      if_pricing_version: first.pricing_version,
    });
    expect(probe.wholesale_feed_version).toBe(first.wholesale_feed_version);
    expect(probe.pricing_version).toBe(first.pricing_version);
    expect(probe.unchanged).toBe(true);

    const listedAfter = await call(fresh, 'list_products', { criteria: { product_ids: [productId] } });
    expect(listedAfter.feed_version).toBe(listedFirst.feed_version);
  });

  it('is independent of filters and pagination', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const all = await wholesale(server);
    const filtered = await wholesale(server, { filters: { channels: ['display'] } });
    const paged = await wholesale(server, { pagination: { max_results: 1 } });
    for (const res of [filtered, paged]) {
      expect(res.wholesale_feed_version).toBe(all.wholesale_feed_version);
      expect(res.pricing_version).toBe(all.pricing_version);
    }
  });

  it('is scope-keyed: account scope differs from public only in the scope segment', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const pub = await wholesale(server);
    const acct = await wholesale(server, {
      account: { brand: { domain: 'account-overlay.example' }, operator: 'pinnacle-agency.example' },
    });
    expect(acct.cache_scope).toBe('account');
    expect(acct.wholesale_feed_version).not.toBe(pub.wholesale_feed_version);
    expect(acct.wholesale_feed_version.replace('.account.', '.public.')).toBe(pub.wholesale_feed_version);
    expect(acct.pricing_version.replace('.account.', '.public.')).toBe(pub.pricing_version);
  });

  it('moves pricing_version only when a pricing option is seeded on a seeded product', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const account = { brand: { domain: 'feed-version-pricing.example' }, operator: 'pinnacle-agency.example', sandbox: true };
    const brand = { domain: 'feed-version-pricing.example' };
    const seedProduct = await call(server, 'comply_test_controller', {
      account, brand, scenario: 'seed_product',
      params: {
        product_id: 'feed_version_seeded',
        fixture: { channels: ['display'], delivery_type: 'non_guaranteed' },
      },
    });
    expect(seedProduct.success, JSON.stringify(seedProduct)).toBe(true);
    const before = await wholesale(server, { account });

    const seedPricing = await call(server, 'comply_test_controller', {
      account, brand, scenario: 'seed_pricing_option',
      params: {
        product_id: 'feed_version_seeded',
        pricing_option_id: 'feed_version_cpm',
        fixture: { pricing_model: 'cpm', currency: 'USD', floor_price: 4.2 },
      },
    });
    expect(seedPricing.success).toBe(true);

    const after = await wholesale(server, {
      account,
      if_wholesale_feed_version: before.wholesale_feed_version,
      if_pricing_version: before.pricing_version,
    });
    expect(after.unchanged).toBeUndefined();
    expect(after.wholesale_feed_version).toBe(before.wholesale_feed_version);
    expect(after.pricing_version).not.toBe(before.pricing_version);
  });

  it('list_products carries the same feed_version token as wholesale get_products', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const wholesaleRes = await wholesale(server);
    const productId = (wholesaleRes.products as Array<{ product_id: string }>)[0].product_id;
    const listed = await call(server, 'list_products', { criteria: { product_ids: [productId] } });
    expect(listed.feed_version).toBe(wholesaleRes.wholesale_feed_version);
  });
});
