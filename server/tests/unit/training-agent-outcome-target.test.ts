import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
  computeOutcomeTargetCostPlan,
  createMediaBuyBiddingPolicyError,
} from '../../src/training-agent/task-handlers.js';
import {
  clearCatalogEventStores,
  SELLER_MANAGED_PURCHASE_SOURCE_ID,
} from '../../src/training-agent/catalog-event-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { validateProductDiscoverySourceResponse } from '../../src/training-agent/source-schema.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'outcome-target.example.com' }, operator: 'outcome-tester', sandbox: true };
const OUTCOME_TARGET_PRODUCT_ID = 'outcome_target_test_product';
// Seeded fixtures outlive clearSessions, so a product with a different
// pricing fixture needs its own id.
const MULTI_CURRENCY_PRODUCT_ID = 'outcome_target_multi_currency_product';

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

const USD_FIXED_CPM_40 = {
  pricing_option_id: 'po_outcome_target_fixed_cpm',
  pricing_model: 'cpm',
  currency: 'USD',
  fixed_price: 40,
};

async function seedOutcomeTargetProduct(
  server: ReturnType<typeof createTrainingAgentServer>,
  pricingOptions: Array<Record<string, unknown>> = [USD_FIXED_CPM_40],
  productId = OUTCOME_TARGET_PRODUCT_ID,
): Promise<void> {
  const seed = await callTool(server, 'comply_test_controller', {
    scenario: 'seed_product',
    account: ACCOUNT,
    params: {
      product_id: productId,
      fixture: {
        delivery_type: 'non_guaranteed',
        channels: ['display'],
        pricing_options: pricingOptions,
      },
    },
  });
  expect(seed.success, JSON.stringify(seed)).toBe(true);
}

function requestProposalsArgs(
  outcomeTarget?: Record<string, unknown>,
  offerFilters?: Record<string, unknown>,
  productId = OUTCOME_TARGET_PRODUCT_ID,
): Record<string, unknown> {
  return {
    account: ACCOUNT,
    brief: 'Reverse-forecast planning test',
    criteria: {
      product_ids: [productId],
      ...(offerFilters && { offer_filters: offerFilters }),
      ...(outcomeTarget && { outcome_target: outcomeTarget }),
    },
  };
}

const CLICKS_GOAL = { kind: 'metric', metric: 'clicks' };

// The one window the seller advertises in conversion_tracking.attribution_windows.
const EVENT_ATTRIBUTION_WINDOW = {
  post_click: { interval: 7, unit: 'days' },
  post_view: { interval: 1, unit: 'days' },
  model: 'last_touch',
};

function expectValidResponse(result: Record<string, unknown>): void {
  expect(
    validateProductDiscoverySourceResponse('request-proposals-response', result),
    JSON.stringify(result),
  ).toBeUndefined();
}

function onlyProposal(result: Record<string, unknown>): Record<string, unknown> {
  expect(result.outcome).toBe('proposed');
  const proposals = result.proposals as Array<Record<string, unknown>>;
  expect(proposals).toHaveLength(1);
  return proposals[0]!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function termsOf(proposal: Record<string, unknown>): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return proposal.commercial_terms as Record<string, any>;
}

describe('reverse-forecast outcome_target planning (training agent)', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    clearCatalogEventStores();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  describe('get_adcp_capabilities', () => {
    it('declares media_buy.outcome_target: true', async () => {
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      expect((caps as { media_buy: { outcome_target?: boolean } }).media_buy.outcome_target).toBe(true);
    });
  });

  describe('clicks metric goal', () => {
    it('solves budget and a 3-point clicks forecast from volume 10000 on a fixed_price 40 product', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'metric', metric: 'clicks' },
        volume: 10000,
      }));

      expect(result.outcome).toBe('proposed');
      const proposals = result.proposals as Array<Record<string, unknown>>;
      expect(proposals).toHaveLength(1);
      const proposal = proposals[0]!;

      // impressions = 10000 / 0.001 = 10,000,000; B = 10,000,000/1000 * 40 = 400,000
      expect(proposal.total_budget_guidance).toEqual({
        min: 320000,
        recommended: 400000,
        max: 500000,
        currency: 'USD',
      });

      const forecast = proposal.forecast as Record<string, unknown>;
      expect(forecast.forecast_range_unit).toBe('clicks');
      expect(forecast.method).toBe('modeled');
      expect(forecast.currency).toBe('USD');
      expect(typeof forecast.generated_at).toBe('string');
      expect(typeof forecast.valid_until).toBe('string');

      const points = forecast.points as Array<Record<string, unknown>>;
      expect(points).toHaveLength(3);
      expect(points[0]).toEqual({ budget: 200000, metrics: { clicks: { mid: 5000 } } });
      expect(points[1]).toEqual({ budget: 400000, metrics: { clicks: { mid: 10000 } } });
      expect(points[2]).toEqual({ budget: 600000, metrics: { clicks: { mid: 15000 } } });

      // Volume-only planning carries no cost answer.
      const terms = termsOf(proposal);
      expect(terms.bidding).toBeUndefined();
      expect(terms.purchases[0].optimization_goals).toBeUndefined();
      expectValidResponse(result);
    });
  });

  describe('event goal', () => {
    it('solves a conversions forecast carrying the event_type as the metrics key', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'event', event_type: 'purchase' },
        volume: 500,
      }));

      expect(result.outcome).toBe('proposed');
      const proposals = result.proposals as Array<Record<string, unknown>>;
      const proposal = proposals[0]!;

      const guidance = proposal.total_budget_guidance as Record<string, unknown>;
      expect(guidance.currency).toBe('USD');
      expect(typeof guidance.recommended).toBe('number');

      const forecast = proposal.forecast as Record<string, unknown>;
      expect(forecast.forecast_range_unit).toBe('conversions');
      const points = forecast.points as Array<Record<string, unknown>>;
      expect(points).toHaveLength(3);
      const midPoint = points[1] as { metrics: Record<string, { mid: number }> };
      expect(midPoint.metrics.purchase.mid).toBe(500);
    });
  });

  describe('unplannable spend goal', () => {
    it('rejects a metric:"spend" goal with INVALID_REQUEST naming criteria.outcome_target.goal', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'metric', metric: 'spend' },
        volume: 1000,
      }));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.goal');
      expect(result.proposals).toBeUndefined();
    });
  });

  describe('cost_per target', () => {
    // Fixture: a $40 CPM and the modeled 1 click per 1,000 impressions give a
    // plannable cost of $40 per click.

    it('plans the volume a budget buys at a cap, answering a higher cap than asked', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: CLICKS_GOAL, cost_per: { amount: 3, currency: 'USD', strength: 'cap' } },
        { budget_range: { max: 5000, currency: 'USD' } },
      ));

      expectValidResponse(result);
      const proposal = onlyProposal(result);
      const terms = termsOf(proposal);
      // The seller can only plan to $40, so it answers { 40, cap }: a higher
      // amount, never a changed strength.
      expect(terms.bidding).toEqual({ cost_per: { amount: 40, strength: 'cap' } });
      expect(terms.total_budget).toEqual({ amount: 5000, currency: 'USD' });
      expect(terms.purchases).toHaveLength(1);
      expect(terms.purchases[0].pricing.currency).toBe('USD');
      expect(terms.purchases[0].optimization_goals).toEqual([{ kind: 'metric', metric: 'clicks', priority: 1 }]);
      expect(proposal.total_budget_guidance).toEqual({ min: 4000, recommended: 5000, max: 5000, currency: 'USD' });
      const forecast = proposal.forecast as Record<string, unknown>;
      expect(forecast.currency).toBe('USD');
      expect(forecast.forecast_range_unit).toBe('clicks');
      // Points stop at the $5,000 budget ceiling and carry the planned spend.
      expect(forecast.points).toEqual([
        { budget: 2500, metrics: { clicks: { mid: 62 }, spend: { mid: 2480 } } },
        { budget: 5000, metrics: { clicks: { mid: 125 }, spend: { mid: 5000 } } },
      ]);
    });

    it('keeps a target strength when answering a higher amount', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: CLICKS_GOAL, cost_per: { amount: 3, currency: 'USD', strength: 'target' } },
        { budget_range: { max: 5000, currency: 'USD' } },
      ));

      expectValidResponse(result);
      expect(termsOf(onlyProposal(result)).bidding).toEqual({ cost_per: { amount: 40, strength: 'target' } });
    });

    it('plans toward a volume at the cost without a budget range, in the requested currency', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: CLICKS_GOAL,
        volume: 1000,
        cost_per: { amount: 50, currency: 'USD', strength: 'cap' },
      }));

      expectValidResponse(result);
      const proposal = onlyProposal(result);
      const terms = termsOf(proposal);
      // An ask above the plannable cost is kept. A cap plans at the $40 the
      // seller expects to average, so 1,000 clicks need $40,000.
      expect(terms.bidding).toEqual({ cost_per: { amount: 50, strength: 'cap' } });
      expect(terms.total_budget).toEqual({ amount: 40000, currency: 'USD' });
      expect((proposal.total_budget_guidance as Record<string, unknown>).currency).toBe('USD');
      const forecast = proposal.forecast as { currency: string; points: unknown[] };
      expect(forecast.currency).toBe('USD');
      expect(forecast.points[1]).toEqual({ budget: 40000, metrics: { clicks: { mid: 1000 }, spend: { mid: 40000 } } });
    });

    it('plans a target at the answered amount', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: CLICKS_GOAL,
        volume: 1000,
        cost_per: { amount: 50, currency: 'USD', strength: 'target' },
      }));

      expectValidResponse(result);
      const terms = termsOf(onlyProposal(result));
      expect(terms.bidding).toEqual({ cost_per: { amount: 50, strength: 'target' } });
      expect(terms.total_budget).toEqual({ amount: 50000, currency: 'USD' });
    });

    it('selects the pricing option in the requested currency on a multi-currency product', async () => {
      await seedOutcomeTargetProduct(server, [
        USD_FIXED_CPM_40,
        { pricing_option_id: 'po_outcome_target_eur_cpm', pricing_model: 'cpm', currency: 'EUR', fixed_price: 36 },
      ], MULTI_CURRENCY_PRODUCT_ID);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: CLICKS_GOAL, cost_per: { amount: 3, currency: 'EUR', strength: 'cap' } },
        { budget_range: { max: 5000, currency: 'EUR' } },
        MULTI_CURRENCY_PRODUCT_ID,
      ));

      expectValidResponse(result);
      const proposal = onlyProposal(result);
      const terms = termsOf(proposal);
      expect(terms.purchases[0].pricing_option_id).toBe('po_outcome_target_eur_cpm');
      expect(terms.purchases[0].pricing.currency).toBe('EUR');
      expect(terms.total_budget).toEqual({ amount: 5000, currency: 'EUR' });
      expect(terms.bidding).toEqual({ cost_per: { amount: 36, strength: 'cap' } });
      expect((proposal.total_budget_guidance as Record<string, unknown>).currency).toBe('EUR');
      expect((proposal.forecast as Record<string, unknown>).currency).toBe('EUR');
    });

    it('rejects a cost_per currency that differs from the budget range currency', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: CLICKS_GOAL, cost_per: { amount: 3, currency: 'EUR', strength: 'cap' } },
        { budget_range: { max: 5000, currency: 'USD' } },
      ));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.cost_per');
      expect(result.proposals).toBeUndefined();
    });

    it('rejects a cost_per in a currency no requested product is priced in', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: CLICKS_GOAL,
        cost_per: { amount: 3, currency: 'EUR', strength: 'cap' },
      }));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.cost_per');
      expect(String(result.message)).toContain('EUR');
    });

    it('rejects a cost_per currency excluded by offer_filters.pricing_currencies', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: CLICKS_GOAL, cost_per: { amount: 3, currency: 'USD', strength: 'cap' } },
        { pricing_currencies: ['EUR'] },
      ));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.cost_per');
    });

    it('rejects a cost target on a goal with no canonical optimization-goal form, naming cost_per', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'metric', metric: 'impressions' },
        cost_per: { amount: 3, currency: 'USD', strength: 'cap' },
      }));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.cost_per');
    });

    it('plans the volume it can deliver and states the spend when there is neither volume nor budget', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: CLICKS_GOAL,
        cost_per: { amount: 3, currency: 'USD', strength: 'cap' },
      }));

      expectValidResponse(result);
      const proposal = onlyProposal(result);
      // 10,000,000 deliverable impressions x 0.1% = 10,000 clicks at $40.
      expect(termsOf(proposal).bidding).toEqual({ cost_per: { amount: 40, strength: 'cap' } });
      expect((proposal.total_budget_guidance as Record<string, unknown>).recommended).toBe(400000);
      const forecast = proposal.forecast as { points: unknown[] };
      expect(forecast.points[1]).toEqual({ budget: 400000, metrics: { clicks: { mid: 10000 }, spend: { mid: 400000 } } });
    });

    it('keeps total_budget inside a two-sided budget range', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: CLICKS_GOAL, volume: 10, cost_per: { amount: 50, currency: 'USD', strength: 'cap' } },
        { budget_range: { min: 1000, max: 5000, currency: 'USD' } },
      ));

      expectValidResponse(result);
      const proposal = onlyProposal(result);
      // 10 clicks at $40 is $400, below the $1,000 floor, so the plan spends
      // the floor. The $50 ask is above the $40 plannable cost, so the cap
      // keeps $50, and the plan forecasts the 25 clicks $1,000 buys at the
      // $40 average it expects under that cap.
      expect(termsOf(proposal).total_budget).toEqual({ amount: 1000, currency: 'USD' });
      expect(termsOf(proposal).bidding).toEqual({ cost_per: { amount: 50, strength: 'cap' } });
      const guidance = proposal.total_budget_guidance as Record<string, number>;
      expect(guidance.min).toBeGreaterThanOrEqual(1000);
      expect(guidance.max).toBeLessThanOrEqual(5000);
    });

    it('binds the seller-managed purchase source for a CPA target with no buyer pixel', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'event', event_type: 'purchase' },
        cost_per: { amount: 20, currency: 'USD', strength: 'cap' },
      }));

      expectValidResponse(result);
      const terms = termsOf(onlyProposal(result));
      // $40 CPM at 1 purchase per 5,000 impressions plans to $200.
      expect(terms.bidding).toEqual({ cost_per: { amount: 200, strength: 'cap' } });
      expect(terms.purchases[0].optimization_goals).toEqual([{
        kind: 'event',
        event_sources: [{ event_source_id: SELLER_MANAGED_PURCHASE_SOURCE_ID, event_type: 'purchase' }],
        attribution_window: EVENT_ATTRIBUTION_WINDOW,
        priority: 1,
      }]);
      expect(terms.purchases[0].bidding).toBeUndefined();

      // The stated window is one the seller advertises.
      const caps = await callTool(server, 'get_adcp_capabilities', {}) as {
        media_buy: { conversion_tracking: { attribution_windows: Array<{ post_click: unknown[]; post_view: unknown[] }> } };
      };
      const advertised = caps.media_buy.conversion_tracking.attribution_windows;
      expect(advertised.some(window => (
        window.post_click.some(entry => JSON.stringify(entry) === JSON.stringify(EVENT_ATTRIBUTION_WINDOW.post_click))
        && window.post_view.some(entry => JSON.stringify(entry) === JSON.stringify(EVENT_ATTRIBUTION_WINDOW.post_view))
      ))).toBe(true);
    });

    it('prefers the seller-managed source over buyer-synced purchase sources and binds exactly one', async () => {
      await seedOutcomeTargetProduct(server);
      await callTool(server, 'sync_event_sources', {
        account: ACCOUNT,
        event_sources: [
          { event_source_id: 'web_pixel_main', name: 'Main site pixel', event_types: ['purchase', 'add_to_cart'] },
          { event_source_id: 'server_events', name: 'Server events', event_types: ['purchase'] },
        ],
      });

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'event', event_type: 'purchase' },
        cost_per: { amount: 20, currency: 'USD', strength: 'cap' },
      }));

      expectValidResponse(result);
      const goal = termsOf(onlyProposal(result)).purchases[0].optimization_goals[0];
      // Without multi_source_event_dedup the seller binds exactly one source.
      expect(goal.event_sources).toEqual([{ event_source_id: SELLER_MANAGED_PURCHASE_SOURCE_ID, event_type: 'purchase' }]);
      expect(goal.attribution_window).toEqual(EVENT_ATTRIBUTION_WINDOW);
    });

    it('binds the first registered buyer source for an event no seller-managed source tracks', async () => {
      await seedOutcomeTargetProduct(server);
      const synced = await callTool(server, 'sync_event_sources', {
        account: ACCOUNT,
        event_sources: [
          { event_source_id: 'web_pixel_main', name: 'Main site pixel', event_types: ['purchase', 'add_to_cart'] },
          // A second add_to_cart source: without multi_source_event_dedup the
          // seller binds exactly one.
          { event_source_id: 'server_events', name: 'Server events', event_types: ['add_to_cart'] },
          { event_source_id: 'lead_form', name: 'Lead form', event_types: ['lead'] },
        ],
      });
      expect(Array.isArray(synced.event_sources), JSON.stringify(synced)).toBe(true);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'event', event_type: 'add_to_cart' },
        cost_per: { amount: 20, currency: 'USD', strength: 'cap' },
      }));

      expectValidResponse(result);
      const terms = termsOf(onlyProposal(result));
      expect(terms.bidding).toEqual({ cost_per: { amount: 200, strength: 'cap' } });
      expect(terms.purchases[0].optimization_goals).toEqual([{
        kind: 'event',
        event_sources: [{ event_source_id: 'web_pixel_main', event_type: 'add_to_cart' }],
        attribution_window: EVENT_ATTRIBUTION_WINDOW,
        priority: 1,
      }]);
      expect(terms.purchases[0].bidding).toBeUndefined();
    });

    it('rejects an event-goal cost target when no buyer-synced or seller-managed source tracks the event', async () => {
      await seedOutcomeTargetProduct(server);
      await callTool(server, 'sync_event_sources', {
        account: ACCOUNT,
        event_sources: [{ event_source_id: 'lead_form', name: 'Lead form', event_types: ['lead'] }],
      });

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'event', event_type: 'add_to_cart' },
        cost_per: { amount: 20, currency: 'USD', strength: 'cap' },
      }));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.cost_per');
      expect(String(result.message)).toContain('add_to_cart');
    });
  });

  describe('cost_per edge cases', () => {
    it('drops a plan whose budget buys less than one result and rejects when none remain', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: CLICKS_GOAL, cost_per: { amount: 3, currency: 'USD', strength: 'cap' } },
        { budget_range: { max: 10, currency: 'USD' } },
      ));

      expect(result.outcome).toBe('rejected');
      expect(result.proposals).toBeUndefined();
    });

    it('rejects a cost_per currency that conflicts with a currency-bound account', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', {
        ...requestProposalsArgs({ goal: CLICKS_GOAL, cost_per: { amount: 3, currency: 'USD', strength: 'cap' } }),
        account: { ...ACCOUNT, currency: 'EUR' },
      });

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.cost_per');
      expect(String(result.message)).toContain('account');
    });

    it('never binds event sources registered on another account', async () => {
      await seedOutcomeTargetProduct(server);
      await callTool(server, 'sync_event_sources', {
        account: { brand: { domain: 'other-advertiser.example' }, operator: 'outcome-tester', sandbox: true },
        event_sources: [{ event_source_id: 'other_pixel', name: 'Other pixel', event_types: ['purchase', 'add_to_cart'] }],
      });

      const rejected = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'event', event_type: 'add_to_cart' },
        cost_per: { amount: 20, currency: 'USD', strength: 'cap' },
      }));
      expect(rejected.code).toBe('INVALID_REQUEST');
      expect(rejected.field).toBe('criteria.outcome_target.cost_per');

      // A purchase goal binds this account's own seller-managed source, never
      // the other account's buyer pixel.
      const purchase = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'event', event_type: 'purchase' },
        cost_per: { amount: 20, currency: 'USD', strength: 'cap' },
      }));
      expectValidResponse(purchase);
      expect(termsOf(onlyProposal(purchase)).purchases[0].optimization_goals[0].event_sources)
        .toEqual([{ event_source_id: SELLER_MANAGED_PURCHASE_SOURCE_ID, event_type: 'purchase' }]);
    });
  });

  describe('bidding_policy capability', () => {
    type Capabilities = { media_buy: { features: Record<string, unknown> } };
    it('advertises fixed media-buy cost_per and package bids on 3.2 responses only', async () => {
      const current = await callTool(server, 'get_adcp_capabilities', { adcp_version: '3.2-rc.7' }) as Capabilities;
      expect(current.media_buy.features.bidding_policy).toEqual({
        media_buy: { fixed: { modes: ['cost_per'], cost_per_strengths: ['cap', 'target'] } },
        package: { fixed: { modes: ['bid_amount', 'max_bid'] } },
      });
      for (const args of [{}, { adcp_version: '3.0' }, { adcp_version: '3.1' }]) {
        const legacy = await callTool(server, 'get_adcp_capabilities', args) as Capabilities;
        expect(legacy.media_buy.features.bidding_policy, JSON.stringify(args)).toBeUndefined();
      }
    });

    it('does not leak the object-valued feature into 3.0 storyboard compat on a newer served version', async () => {
      const compatServer = createTrainingAgentServer({ mode: 'open', storyboardCompat: { version: '3.0' } });
      const caps = await callTool(compatServer, 'get_adcp_capabilities', { adcp_version: '3.2-rc.7' }) as Capabilities;
      expect(caps.media_buy.features.bidding_policy).toBeUndefined();
    });
  });

  describe('createMediaBuyBiddingPolicyError', () => {
    const clicksPackage = {
      product_id: 'a', pricing_option_id: 'a_cpm', budget: 100,
      optimization_goals: [{ kind: 'metric', metric: 'clicks', priority: 1 }],
    };
    const viewsPackage = {
      product_id: 'b', pricing_option_id: 'b_cpm', budget: 100,
      optimization_goals: [{ kind: 'metric', metric: 'views', priority: 1 }],
    };

    it('accepts a fixed media-buy cost_per whose inheriting packages share one result unit', () => {
      expect(createMediaBuyBiddingPolicyError({
        budget_allocation: { mode: 'fixed' },
        bidding: { cost_per: { amount: 4, strength: 'cap' } },
        packages: [clicksPackage, { ...clicksPackage, product_id: 'c' }],
      })).toBeUndefined();
    });

    it('rejects a fixed media-buy cost_per across incompatible result units', () => {
      expect(createMediaBuyBiddingPolicyError({
        budget_allocation: { mode: 'fixed' },
        bidding: { cost_per: { amount: 4, strength: 'cap' } },
        packages: [clicksPackage, viewsPackage],
      })).toMatchObject({ code: 'BIDDING_PLACEMENT_CONFLICT', field: 'bidding.cost_per' });
    });

    it('rejects canonical policies outside the advertised profile', () => {
      expect(createMediaBuyBiddingPolicyError({
        bidding: { max_bid: 7 },
        packages: [clicksPackage],
      })).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'bidding' });
      expect(createMediaBuyBiddingPolicyError({
        packages: [{ ...clicksPackage, bidding: { automatic: true } }],
      })).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'packages[0].bidding' });
      expect(createMediaBuyBiddingPolicyError({
        budget_allocation: { mode: 'seller_optimized', optimization_goals: [{ kind: 'metric', metric: 'clicks' }] },
        bidding: { cost_per: { amount: 4, strength: 'cap' } },
        packages: [clicksPackage],
      })).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'bidding' });
    });
  });

  describe('computeOutcomeTargetCostPlan', () => {
    type PlanProposal = Parameters<typeof computeOutcomeTargetCostPlan>[5];
    type PlanProducts = Parameters<typeof computeOutcomeTargetCostPlan>[6];
    const proposal = {
      proposal_id: 'plan',
      name: 'Plan',
      allocations: [{ product_id: 'p1', allocation_percentage: 100, pricing_option_id: 'po_outcome_target_fixed_cpm' }],
    } as unknown as PlanProposal;
    const productsById = new Map([
      ['p1', { product_id: 'p1', pricing_options: [USD_FIXED_CPM_40] }],
    ]) as unknown as PlanProducts;
    const clicksOptimizationGoal = { kind: 'metric', metric: 'clicks', priority: 1 };

    it('bounds a volume plan by the buyer budget and forecasts the lower volume at the same cap', () => {
      const plan = computeOutcomeTargetCostPlan(
        CLICKS_GOAL,
        clicksOptimizationGoal,
        { amount: 50, currency: 'USD', strength: 'cap' },
        1000,
        { max: 20000 },
        proposal,
        productsById,
      );
      expect(plan?.plannableCost).toBe(40);
      expect(plan?.bidding).toEqual({ cost_per: { amount: 50, strength: 'cap' } });
      expect(plan?.totalBudgetGuidance.recommended).toBe(20000);
      expect(plan?.plannedVolume).toBe(500);
    });

    it('never answers below the ask', () => {
      for (const amount of [3, 40, 75]) {
        const plan = computeOutcomeTargetCostPlan(
          CLICKS_GOAL,
          clicksOptimizationGoal,
          { amount, currency: 'USD', strength: 'target' },
          undefined,
          { max: 5000 },
          proposal,
          productsById,
        );
        expect(plan?.bidding.cost_per.amount).toBe(Math.max(amount, 40));
        expect(plan?.bidding.cost_per.strength).toBe('target');
      }
    });

    it('keeps an ask that is not a whole cent rather than rounding it below itself', () => {
      const plan = computeOutcomeTargetCostPlan(
        CLICKS_GOAL,
        clicksOptimizationGoal,
        { amount: 40.004, currency: 'USD', strength: 'cap' },
        undefined,
        { max: 5000 },
        proposal,
        productsById,
      );
      expect(plan?.bidding.cost_per.amount).toBe(40.004);
      expect(plan!.bidding.cost_per.amount).toBeGreaterThanOrEqual(40.004);
    });

    it('returns undefined when the proposal cannot be priced in the requested currency', () => {
      expect(computeOutcomeTargetCostPlan(
        CLICKS_GOAL,
        clicksOptimizationGoal,
        { amount: 3, currency: 'GBP', strength: 'target' },
        undefined,
        { max: 5000 },
        proposal,
        productsById,
      )).toBeUndefined();
    });
  });

  describe('no outcome_target', () => {
    it('leaves proposals without total_budget_guidance or an outcome_target-shaped forecast', async () => {
      await seedOutcomeTargetProduct(server);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs());

      expect(result.outcome).toBe('proposed');
      const proposals = result.proposals as Array<Record<string, unknown>>;
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.total_budget_guidance).toBeUndefined();
    });
  });
});
