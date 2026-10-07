import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  executeTrainingAgentTool,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION, type TrainingContext } from '../../src/training-agent/types.js';

// Canonical bidding against the advertised features.bidding_policy profile:
// media-buy fixed cost_per (cap, target) and package fixed bid_amount/max_bid.

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'bidding-policy.example' }, operator: 'pinnacle-agency.example', sandbox: true };
const BRAND = { domain: 'bidding-policy.example' };
const FLIGHT = { start_time: '2099-09-01T00:00:00Z', end_time: '2099-09-30T23:59:59Z' };
const PRODUCTS = ['bp_clicks_auction', 'bp_views_auction'];

function withRequestDefaults(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const versioned = args.adcp_version === undefined && toolName !== 'comply_test_controller'
    ? { adcp_version: TRAINING_AGENT_CURRENT_ADCP_VERSION, ...args }
    : args;
  if (!MUTATING_TOOLS.has(toolName) || versioned.idempotency_key !== undefined) return versioned;
  return { ...versioned, idempotency_key: `test-${crypto.randomUUID()}` };
}

type ToolResult = { result: Record<string, unknown>; error?: Record<string, unknown> };

async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call')!;
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: withRequestDefaults(toolName, args) } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed: Record<string, unknown> = response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
  const errorInBody = Array.isArray(parsed.errors) && parsed.errors.length > 0
    ? parsed.errors[0] as Record<string, unknown>
    : undefined;
  const error = (parsed.adcp_error as Record<string, unknown> | undefined) ?? errorInBody;
  return { result: parsed, ...(error && { error }) };
}

async function seedAuctionProducts(server: ReturnType<typeof createTrainingAgentServer>): Promise<void> {
  for (const productId of PRODUCTS) {
    const seeded = await callTool(server, 'comply_test_controller', {
      scenario: 'seed_product',
      account: ACCOUNT,
      brand: BRAND,
      params: {
        product_id: productId,
        fixture: {
          delivery_type: 'non_guaranteed',
          channels: ['display'],
          format_options: [{ format_option_id: `${productId}_300x250`, format_kind: 'image', params: { width: 300, height: 250 } }],
          pricing_options: [{
            pricing_option_id: `${productId}_cpm`,
            pricing_model: 'cpm',
            currency: 'USD',
            floor_price: 1.5,
          }],
        },
      },
    });
    expect(seeded.result.success, JSON.stringify(seeded.result)).toBe(true);
  }
}

async function listedFences(server: ReturnType<typeof createTrainingAgentServer>): Promise<Record<string, unknown>> {
  const listed = await callTool(server, 'list_products', {
    account: ACCOUNT,
    criteria: { product_ids: PRODUCTS },
    fields: ['pricing_options'],
  });
  expect(listed.error, JSON.stringify(listed.result)).toBeUndefined();
  return { feed_version: listed.result.feed_version, pricing_version: listed.result.pricing_version };
}

describe('training agent canonical bidding policy', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  it('rejects an ambiguous fixed cost_per on create_media_buy before any mutation', async () => {
    await seedAuctionProducts(server);
    const mediaBuyIds = async () => (
      ((await callTool(server, 'get_media_buys', { account: ACCOUNT, brand: BRAND })).result.media_buys as
        Array<{ media_buy_id: string }> | undefined ?? []).map(buy => buy.media_buy_id).sort()
    );
    const before = await mediaBuyIds();
    const created = await callTool(server, 'create_media_buy', {
      account: ACCOUNT,
      brand: BRAND,
      ...FLIGHT,
      total_budget: { amount: 10000, currency: 'USD' },
      budget_allocation: { mode: 'fixed' },
      bidding: { cost_per: { amount: 4, strength: 'cap' } },
      packages: [
        {
          product_id: 'bp_clicks_auction', pricing_option_id: 'bp_clicks_auction_cpm', budget: 5000,
          optimization_goals: [{ kind: 'metric', metric: 'clicks', priority: 1 }],
        },
        {
          product_id: 'bp_views_auction', pricing_option_id: 'bp_views_auction_cpm', budget: 5000,
          optimization_goals: [{ kind: 'metric', metric: 'views', priority: 1 }],
        },
      ],
    });
    expect(created.error).toMatchObject({ code: 'BIDDING_PLACEMENT_CONFLICT', field: 'bidding.cost_per' });
    // The demonstration session carries seeded buys; the rejected create adds none.
    expect(await mediaBuyIds()).toEqual(before);
  });

  it('binds a media-buy cost_per to a vendor_metric primary goal on create_media_buy', async () => {
    const vendor = { domain: 'footfallvendor.example' };
    const seeded = await callTool(server, 'comply_test_controller', {
      scenario: 'seed_product',
      account: ACCOUNT,
      brand: BRAND,
      params: {
        product_id: 'bp_store_visits_auction',
        fixture: {
          delivery_type: 'non_guaranteed',
          channels: ['display'],
          format_options: [{ format_option_id: 'bp_store_visits_300x250', format_kind: 'image', params: { width: 300, height: 250 } }],
          pricing_options: [{ pricing_option_id: 'bp_store_visits_cpm', pricing_model: 'cpm', currency: 'USD', floor_price: 1.5 }],
          reporting_capabilities: {
            available_metrics: ['impressions', 'spend'],
            vendor_metrics: [{ vendor, metric_id: 'store_visits_14d_exposed', vendor_relationship: 'third_party' }],
          },
          vendor_metric_optimization: {
            supported_metrics: [{ vendor, metric_id: 'store_visits_14d_exposed', supported_targets: ['cost_per'] }],
          },
        },
      },
    });
    expect(seeded.result.success, JSON.stringify(seeded.result)).toBe(true);
    const created = await callTool(server, 'create_media_buy', {
      account: ACCOUNT,
      brand: BRAND,
      ...FLIGHT,
      total_budget: { amount: 5000, currency: 'USD' },
      budget_allocation: { mode: 'fixed' },
      bidding: { cost_per: { amount: 4, strength: 'cap' } },
      packages: [{
        product_id: 'bp_store_visits_auction',
        pricing_option_id: 'bp_store_visits_cpm',
        budget: 5000,
        bid_price: 2,
        optimization_goals: [{ kind: 'vendor_metric', vendor, metric_id: 'store_visits_14d_exposed', priority: 1 }],
        committed_metrics: [{ scope: 'vendor', vendor, metric_id: 'store_visits_14d_exposed' }],
      }],
    });
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    expect(typeof created.result.media_buy_id).toBe('string');
  });

  it('keeps accepting package bid_amount and max_bid on buy_products purchases', async () => {
    await seedAuctionProducts(server);
    const bought = await executeTrainingAgentTool('buy_products', {
      adcp_version: TRAINING_AGENT_CURRENT_ADCP_VERSION,
      idempotency_key: `buy-bidding-${crypto.randomUUID()}`,
      account: ACCOUNT,
      ...(await listedFences(server)),
      purchases: [
        { product_id: 'bp_clicks_auction', pricing_option_id: 'bp_clicks_auction_cpm', budget: 5000, bidding: { bid_amount: 2.5 } },
        { product_id: 'bp_views_auction', pricing_option_id: 'bp_views_auction_cpm', budget: 5000, bidding: { max_bid: 3 } },
      ],
      ...FLIGHT,
    }, { ...DEFAULT_CTX, principal: 'buyer' });
    expect(bought.success, bought.error).toBe(true);
    const data = bought.data as Record<string, unknown>;
    expect(data.errors, JSON.stringify(data)).toBeUndefined();
    expect(typeof data.media_buy_id).toBe('string');
  });

  it('names purchases[i].bidding when buy_products carries an unadvertised policy', async () => {
    await seedAuctionProducts(server);
    const bought = await executeTrainingAgentTool('buy_products', {
      adcp_version: TRAINING_AGENT_CURRENT_ADCP_VERSION,
      idempotency_key: `buy-bidding-${crypto.randomUUID()}`,
      account: ACCOUNT,
      ...(await listedFences(server)),
      purchases: [
        { product_id: 'bp_clicks_auction', pricing_option_id: 'bp_clicks_auction_cpm', budget: 5000 },
        { product_id: 'bp_views_auction', pricing_option_id: 'bp_views_auction_cpm', budget: 5000, bidding: { automatic: true } },
      ],
      ...FLIGHT,
    }, { ...DEFAULT_CTX, principal: 'buyer' });
    const errors = (bought.data as { errors?: Array<Record<string, unknown>> }).errors;
    expect(errors?.[0]).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'purchases[1].bidding' });
  });
});

// Updates validate the bidding they would leave in effect against the same
// profile, before any mutation. Bidding blocks replace completely; null
// clears one, so a cleared package inherits the media-buy block.
describe('training agent canonical bidding policy on update_media_buy and control_media_buy', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  const CLICKS = [{ kind: 'metric', metric: 'clicks', priority: 1 }];
  const VIEWS = [{ kind: 'metric', metric: 'views', priority: 1 }];

  type BuySnapshot = {
    revision: number;
    bidding?: Record<string, unknown>;
    packages: Array<{ package_id: string; bidding?: Record<string, unknown>; optimization_goals?: unknown[] }>;
  };

  /** A fixed buy with a media-buy cost_per cap inherited by two clicks
   * packages, plus (optionally) a views package carrying its own bid. */
  async function createCostCapBuy(options: { viewsOverride?: boolean } = {}): Promise<{ mediaBuyId: string; packageIds: string[] }> {
    await seedAuctionProducts(server);
    const created = await callTool(server, 'create_media_buy', {
      account: ACCOUNT,
      brand: BRAND,
      ...FLIGHT,
      budget_allocation: { mode: 'fixed' },
      bidding: { cost_per: { amount: 4, strength: 'cap' } },
      packages: [
        { product_id: 'bp_clicks_auction', pricing_option_id: 'bp_clicks_auction_cpm', budget: 3000, bid_price: 2, optimization_goals: CLICKS },
        { product_id: 'bp_views_auction', pricing_option_id: 'bp_views_auction_cpm', budget: 3000, bid_price: 2, optimization_goals: CLICKS },
        ...(options.viewsOverride
          ? [{
              product_id: 'bp_views_auction', pricing_option_id: 'bp_views_auction_cpm', budget: 3000, bid_price: 2,
              optimization_goals: VIEWS, bidding: { bid_amount: 2 },
            }]
          : []),
      ],
    });
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    const packages = created.result.packages as Array<{ package_id: string }>;
    return { mediaBuyId: created.result.media_buy_id as string, packageIds: packages.map(pkg => pkg.package_id) };
  }

  async function snapshot(mediaBuyId: string): Promise<BuySnapshot> {
    const read = await callTool(server, 'get_media_buys', { account: ACCOUNT, brand: BRAND, media_buy_ids: [mediaBuyId] });
    const buys = read.result.media_buys as Array<BuySnapshot & { media_buy_id: string }>;
    const buy = buys.find(candidate => candidate.media_buy_id === mediaBuyId);
    expect(buy, JSON.stringify(read.result)).toBeDefined();
    return buy!;
  }

  async function expectRejectedWithoutMutation(
    tool: 'update_media_buy' | 'control_media_buy',
    mediaBuyId: string,
    request: Record<string, unknown>,
    expected: { code: string; field: string },
  ): Promise<void> {
    const before = await snapshot(mediaBuyId);
    const args = {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      ...(tool === 'control_media_buy' && { revision: before.revision }),
      idempotency_key: `bidding-update-${crypto.randomUUID()}`,
      ...request,
    };
    const rejected = await callTool(server, tool, args);
    expect(rejected.error, JSON.stringify(rejected.result)).toMatchObject(expected);
    expect(await snapshot(mediaBuyId)).toEqual(before);
    // A replay with the same key re-runs against untouched state and
    // answers the same error; rejections are not cached as successes.
    const replayed = await callTool(server, tool, args);
    expect(replayed.error, JSON.stringify(replayed.result)).toMatchObject(expected);
    expect(await snapshot(mediaBuyId)).toEqual(before);
  }

  it('rejects an explicit automatic media-buy policy without mutating the buy', async () => {
    const { mediaBuyId } = await createCostCapBuy();
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      bidding: { automatic: true },
    }, { code: 'UNSUPPORTED_FEATURE', field: 'bidding' });
  });

  it('rejects unadvertised media-buy modes on update', async () => {
    const { mediaBuyId } = await createCostCapBuy();
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      bidding: { bid_amount: 3 },
    }, { code: 'UNSUPPORTED_FEATURE', field: 'bidding' });
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      bidding: { roas: { value: 4, strength: 'target' } },
    }, { code: 'UNSUPPORTED_FEATURE', field: 'bidding' });
  });

  it('rejects unadvertised package modes on package updates and added packages', async () => {
    const { mediaBuyId, packageIds } = await createCostCapBuy();
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      packages: [
        { package_id: packageIds[0], budget: 3000 },
        { package_id: packageIds[1], bidding: { cost_per: { amount: 3, strength: 'cap' } } },
      ],
    }, { code: 'UNSUPPORTED_FEATURE', field: 'packages[1].bidding' });
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      packages: [{ package_id: packageIds[0], bidding: { automatic: true } }],
    }, { code: 'UNSUPPORTED_FEATURE', field: 'packages[0].bidding' });
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      new_packages: [{
        product_id: 'bp_clicks_auction', pricing_option_id: 'bp_clicks_auction_cpm', budget: 1000, bid_price: 2,
        optimization_goals: CLICKS, bidding: { automatic: true },
      }],
    }, { code: 'UNSUPPORTED_FEATURE', field: 'new_packages[0].bidding' });
  });

  it('rejects a retained policy under an allocation mode the profile does not cover', async () => {
    const { mediaBuyId } = await createCostCapBuy();
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      budget_allocation: { mode: 'seller_optimized', optimization_goals: CLICKS },
    }, { code: 'UNSUPPORTED_FEATURE', field: 'budget_allocation' });
  });

  it('accepts advertised replacements and preserves authored scope', async () => {
    const { mediaBuyId, packageIds } = await createCostCapBuy();
    const updated = await callTool(server, 'update_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      bidding: { cost_per: { amount: 5, strength: 'target' } },
      packages: [{ package_id: packageIds[1], bidding: { max_bid: 3 } }],
    });
    expect(updated.error, JSON.stringify(updated.result)).toBeUndefined();
    const after = await snapshot(mediaBuyId);
    expect(after.bidding).toEqual({ cost_per: { amount: 5, strength: 'target' } });
    expect(after.packages.find(pkg => pkg.package_id === packageIds[0])?.bidding).toBeUndefined();
    expect(after.packages.find(pkg => pkg.package_id === packageIds[1])?.bidding).toEqual({ max_bid: 3 });

    // The overriding package no longer inherits, so it may take another goal.
    const regoaled = await callTool(server, 'update_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      packages: [{ package_id: packageIds[1], optimization_goals: VIEWS }],
    });
    expect(regoaled.error, JSON.stringify(regoaled.result)).toBeUndefined();
  });

  it('rejects result-unit conflicts an update introduces under a fixed media-buy cost_per', async () => {
    const { mediaBuyId, packageIds } = await createCostCapBuy({ viewsOverride: true });
    // An inheriting package's primary goal moves to another result unit.
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      packages: [{ package_id: packageIds[1], optimization_goals: VIEWS }],
    }, { code: 'BIDDING_PLACEMENT_CONFLICT', field: 'packages[0].optimization_goals' });
    // Clearing a views package's override makes it inherit the clicks cap.
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      packages: [{ package_id: packageIds[2], bidding: null }],
    }, { code: 'BIDDING_PLACEMENT_CONFLICT', field: 'packages[0].bidding' });
    // An added package inherits the cap with a different unit, or none.
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      new_packages: [{ product_id: 'bp_views_auction', pricing_option_id: 'bp_views_auction_cpm', budget: 1000, bid_price: 2, optimization_goals: VIEWS }],
    }, { code: 'BIDDING_PLACEMENT_CONFLICT', field: 'new_packages[0].optimization_goals' });
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      new_packages: [{ product_id: 'bp_views_auction', pricing_option_id: 'bp_views_auction_cpm', budget: 1000, bid_price: 2 }],
    }, { code: 'BIDDING_PLACEMENT_CONFLICT', field: 'new_packages[0].optimization_goals' });
    // A replacement media-buy cost_per is checked against every inheritor.
    await expectRejectedWithoutMutation('update_media_buy', mediaBuyId, {
      bidding: { cost_per: { amount: 6, strength: 'target' } },
      packages: [{ package_id: packageIds[2], bidding: null }],
    }, { code: 'BIDDING_PLACEMENT_CONFLICT', field: 'bidding.cost_per' });

    // Canceling the package that would conflict leaves one shared unit.
    const canceled = await callTool(server, 'update_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      packages: [
        { package_id: packageIds[1], optimization_goals: VIEWS },
        { package_id: packageIds[0], canceled: true },
        { package_id: packageIds[2], bidding: null },
      ],
    });
    expect(canceled.error, JSON.stringify(canceled.result)).toBeUndefined();
  });

  it('validates package bidding carried by control_media_buy', async () => {
    const { mediaBuyId, packageIds } = await createCostCapBuy({ viewsOverride: true });
    await expectRejectedWithoutMutation('control_media_buy', mediaBuyId, {
      packages: [{ package_id: packageIds[0], bidding: { automatic: true } }],
    }, { code: 'UNSUPPORTED_FEATURE', field: 'packages[0].bidding' });
    await expectRejectedWithoutMutation('control_media_buy', mediaBuyId, {
      bidding: { automatic: true },
    }, { code: 'UNSUPPORTED_FEATURE', field: 'bidding' });
    await expectRejectedWithoutMutation('control_media_buy', mediaBuyId, {
      packages: [{ package_id: packageIds[2], bidding: null }],
    }, { code: 'BIDDING_PLACEMENT_CONFLICT', field: 'packages[0].bidding' });

    const before = await snapshot(mediaBuyId);
    const controlled = await callTool(server, 'control_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      revision: before.revision,
      packages: [{ package_id: packageIds[2], bidding: { max_bid: 2.5 } }],
    });
    expect(controlled.error, JSON.stringify(controlled.result)).toBeUndefined();
    expect((await snapshot(mediaBuyId)).packages.find(pkg => pkg.package_id === packageIds[2])?.bidding).toEqual({ max_bid: 2.5 });
  });
});
