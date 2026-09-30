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
