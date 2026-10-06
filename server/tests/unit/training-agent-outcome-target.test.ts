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
import { clearSessions, findSessionMatching, flushDirtySessions, runWithSessionContext } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { validateProductDiscoverySourceResponse } from '../../src/training-agent/source-schema.js';
import type { TrainingContext } from '../../src/training-agent/types.js';
import { TrainingSalesPlatform } from '../../src/training-agent/v6-sales-platform.js';

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

// vendor_metric goals: the pair a seeded product declares in
// vendor_metric_optimization.supported_metrics, as the storyboard fixture does.
const VENDOR_PRODUCT_ID = 'outcome_target_vendor_store_visits';
const VENDOR_NO_COST_PRODUCT_ID = 'outcome_target_vendor_no_cost_per';
const VENDOR_SCORE_PRODUCT_ID = 'outcome_target_vendor_attention_score';
const UNDECLARING_PRODUCT_ID = 'outcome_target_vendor_undeclaring';
const VENDOR_NOT_REPORTABLE_PRODUCT_ID = 'outcome_target_vendor_not_reportable';
const VENDOR_BRANDED_PRODUCT_ID = 'outcome_target_vendor_branded';
const STORE_VISITS_VENDOR = { domain: 'footfallvendor.example' };
const STORE_VISITS_GOAL = { kind: 'vendor_metric', vendor: STORE_VISITS_VENDOR, metric_id: 'store_visits_14d_exposed' };
const STORE_VISITS_REPORTING_COMMITMENT = {
  scope: 'vendor', vendor: STORE_VISITS_VENDOR, metric_id: 'store_visits_14d_exposed',
};
const STORE_VISITS_OPTIMIZATION_GOAL = { ...STORE_VISITS_GOAL, priority: 1 };

async function seedVendorProduct(
  server: ReturnType<typeof createTrainingAgentServer>,
  productId: string,
  declaration: { vendor: { domain: string; brand_id?: string }; metric_id: string; supported_targets?: string[] } | undefined,
  pricingOptions: Array<Record<string, unknown>> = [USD_FIXED_CPM_40],
  // false declares the pair for optimization only, not in
  // reporting_capabilities.vendor_metrics.
  reportable = true,
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
        ...(declaration && {
          reporting_capabilities: {
            available_metrics: ['impressions', 'spend'],
            vendor_metrics: reportable
              ? [{ vendor: declaration.vendor, metric_id: declaration.metric_id, vendor_relationship: 'third_party' }]
              : [],
          },
          vendor_metric_optimization: { supported_metrics: [declaration] },
        }),
      },
    },
  });
  expect(seed.success, JSON.stringify(seed)).toBe(true);
}

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

  // Regression guards: most vendor_metric tests below cover new behavior.
  // The bidding-binding test ('binds a fixed media-buy cost_per to
  // vendor_metric goals...') and the create_media_buy test in
  // training-agent-bidding-policy.test.ts guard costPerResultUnit's existing
  // vendor_metric handling, which predates this feature and must not regress.
  describe('vendor_metric goal', () => {
    // Fixture: a $40 CPM and the modeled 1 store visit per 2,000 impressions
    // give a plannable cost of $80 per visit.
    const declare = (productId = VENDOR_PRODUCT_ID) => seedVendorProduct(
      server,
      productId,
      { vendor: STORE_VISITS_VENDOR, metric_id: 'store_visits_14d_exposed', supported_targets: ['cost_per'] },
    );

    it('answers a volume in vendor_metric_values with spend only in metrics, and binds the goal and its reporting commitment', async () => {
      await declare();

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: STORE_VISITS_GOAL,
        volume: 5000,
      }, undefined, VENDOR_PRODUCT_ID));

      expectValidResponse(result);
      const proposal = onlyProposal(result);
      // impressions = 5000 / 0.0005 = 10,000,000; B = 10,000,000/1000 * 40 = 400,000
      expect(proposal.total_budget_guidance).toEqual({ min: 320000, recommended: 400000, max: 500000, currency: 'USD' });
      const forecast = proposal.forecast as Record<string, unknown>;
      expect(forecast.forecast_range_unit).toBe('spend');
      const entry = (mid: number) => [{
        vendor: STORE_VISITS_VENDOR,
        metric_id: 'store_visits_14d_exposed',
        value: { mid },
        unit: 'visits',
      }];
      expect(forecast.points).toEqual([
        { budget: 200000, metrics: { spend: { mid: 200000 } }, vendor_metric_values: entry(2500) },
        { budget: 400000, metrics: { spend: { mid: 400000 } }, vendor_metric_values: entry(5000) },
        { budget: 600000, metrics: { spend: { mid: 600000 } }, vendor_metric_values: entry(7500) },
      ]);
      for (const point of forecast.points as Array<{ metrics: Record<string, unknown> }>) {
        expect(point.metrics.store_visits_14d_exposed).toBeUndefined();
      }

      // Volume-only: no cost answer, but the goal and the reporting commitment
      // still bind on every purchase.
      const terms = termsOf(proposal);
      expect(terms.bidding).toBeUndefined();
      expect(terms.purchases).toHaveLength(1);
      for (const purchase of terms.purchases) {
        expect(purchase.optimization_goals).toEqual([STORE_VISITS_OPTIMIZATION_GOAL]);
        expect(purchase.bidding).toBeUndefined();
      }
      expect(terms.reporting_commitments).toEqual([{ purchase_index: 0, metrics: [STORE_VISITS_REPORTING_COMMITMENT] }]);
    });

    it('matches the declared vendor on brand_id as well as domain', async () => {
      await declare();

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { ...STORE_VISITS_GOAL, vendor: { domain: 'footfallvendor.example', brand_id: 'other_brand' } },
        volume: 5000,
      }, undefined, VENDOR_PRODUCT_ID));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.goal');
    });

    it('plans a cost cap above the ask with no purchase bidding, in vendor_metric_values', async () => {
      await declare();

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: STORE_VISITS_GOAL, cost_per: { amount: 4, currency: 'USD', strength: 'cap' } },
        { budget_range: { max: 5000, currency: 'USD' } },
        VENDOR_PRODUCT_ID,
      ));

      expectValidResponse(result);
      const proposal = onlyProposal(result);
      const terms = termsOf(proposal);
      // The seller can only plan to $80, so it answers { 80, cap }: never below
      // the ask, never a changed strength.
      expect(terms.bidding).toEqual({ cost_per: { amount: 80, strength: 'cap' } });
      expect(terms.bidding.cost_per.amount).toBeGreaterThanOrEqual(4);
      expect(terms.total_budget).toEqual({ amount: 5000, currency: 'USD' });
      expect(terms.purchases[0].bidding).toBeUndefined();
      expect(terms.purchases[0].optimization_goals).toEqual([STORE_VISITS_OPTIMIZATION_GOAL]);
      expect(terms.reporting_commitments).toEqual([{ purchase_index: 0, metrics: [STORE_VISITS_REPORTING_COMMITMENT] }]);
      const forecast = proposal.forecast as { forecast_range_unit: string; currency: string; points: Array<Record<string, unknown>> };
      expect(forecast.forecast_range_unit).toBe('spend');
      expect(forecast.currency).toBe('USD');
      // Points stop at the $5,000 ceiling: 31 visits at $80 plan to $2,480.
      expect(forecast.points[0]).toEqual({
        budget: 2500,
        metrics: { spend: { mid: 2480 } },
        vendor_metric_values: [{ vendor: STORE_VISITS_VENDOR, metric_id: 'store_visits_14d_exposed', value: { mid: 31 }, unit: 'visits' }],
      });
      expect(forecast.points).toHaveLength(2);
    });

    it('answers a target strength at the ask when the seller can plan to it', async () => {
      await declare();

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: STORE_VISITS_GOAL,
        volume: 100,
        cost_per: { amount: 120, currency: 'USD', strength: 'target' },
      }, undefined, VENDOR_PRODUCT_ID));

      expectValidResponse(result);
      const terms = termsOf(onlyProposal(result));
      expect(terms.bidding).toEqual({ cost_per: { amount: 120, strength: 'target' } });
      expect(terms.total_budget).toEqual({ amount: 12000, currency: 'USD' });
    });

    it('rejects a goal no product in scope declares, naming criteria.outcome_target.goal', async () => {
      await seedOutcomeTargetProduct(server, [USD_FIXED_CPM_40], UNDECLARING_PRODUCT_ID);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: { kind: 'vendor_metric', vendor: { domain: 'undeclaredvendor.example' }, metric_id: 'store_visits_undeclared' },
        volume: 5000,
      }, undefined, UNDECLARING_PRODUCT_ID));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.goal');
      expect(result.proposals).toBeUndefined();
    });

    it('rejects a pair only another product declares when the requested products do not', async () => {
      await declare();
      await seedOutcomeTargetProduct(server, [USD_FIXED_CPM_40], UNDECLARING_PRODUCT_ID);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs({
        goal: STORE_VISITS_GOAL,
        volume: 5000,
      }, undefined, UNDECLARING_PRODUCT_ID));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.goal');
    });

    it('rejects a declared score metric as not plannable as a cumulative total, and never plans a cost on it', async () => {
      await seedVendorProduct(server, VENDOR_SCORE_PRODUCT_ID, {
        vendor: { domain: 'attentionvendor.example' },
        metric_id: 'attention_score',
        supported_targets: ['cost_per'],
      });
      const goal = { kind: 'vendor_metric', vendor: { domain: 'attentionvendor.example' }, metric_id: 'attention_score' };

      const volume = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal, volume: 100 }, undefined, VENDOR_SCORE_PRODUCT_ID,
      ));
      expect(volume.code).toBe('INVALID_REQUEST');
      expect(volume.field).toBe('criteria.outcome_target.goal');
      expect(String(volume.message)).toContain('cumulative total');

      const cost = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal, cost_per: { amount: 4, currency: 'USD', strength: 'cap' } }, undefined, VENDOR_SCORE_PRODUCT_ID,
      ));
      expect(cost.code).toBe('INVALID_REQUEST');
      expect(cost.field).toBe('criteria.outcome_target.goal');
    });

    it('leaves out allocations whose product does not declare the pair, rescaling the rest to 100%', async () => {
      await declare();
      await seedOutcomeTargetProduct(server, [USD_FIXED_CPM_40], UNDECLARING_PRODUCT_ID);

      const result = await callTool(server, 'request_proposals', {
        account: ACCOUNT,
        brief: 'Reverse-forecast planning test',
        criteria: {
          product_ids: [VENDOR_PRODUCT_ID, UNDECLARING_PRODUCT_ID],
          outcome_target: { goal: STORE_VISITS_GOAL, volume: 5000 },
        },
      });

      expectValidResponse(result);
      const terms = termsOf(onlyProposal(result));
      expect(terms.purchases.map((purchase: { product_id: string }) => purchase.product_id)).toEqual([VENDOR_PRODUCT_ID]);
      expect(terms.reporting_commitments).toEqual([{ purchase_index: 0, metrics: [STORE_VISITS_REPORTING_COMMITMENT] }]);
    });

    it('requires the pair in reporting_capabilities.vendor_metrics, not only in vendor_metric_optimization', async () => {
      await seedVendorProduct(server, VENDOR_NOT_REPORTABLE_PRODUCT_ID, {
        vendor: STORE_VISITS_VENDOR, metric_id: 'store_visits_14d_exposed', supported_targets: ['cost_per'],
      }, [USD_FIXED_CPM_40], false);

      const only = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: STORE_VISITS_GOAL, volume: 5000 }, undefined, VENDOR_NOT_REPORTABLE_PRODUCT_ID,
      ));
      expect(only.code).toBe('INVALID_REQUEST');
      expect(only.field).toBe('criteria.outcome_target.goal');

      // Beside a product that does report it, the unreportable one is left out.
      await declare();
      const result = await callTool(server, 'request_proposals', {
        account: ACCOUNT,
        brief: 'Reverse-forecast planning test',
        criteria: {
          product_ids: [VENDOR_PRODUCT_ID, VENDOR_NOT_REPORTABLE_PRODUCT_ID],
          outcome_target: { goal: STORE_VISITS_GOAL, volume: 5000 },
        },
      });
      expectValidResponse(result);
      const terms = termsOf(onlyProposal(result));
      expect(terms.purchases.map((purchase: { product_id: string }) => purchase.product_id)).toEqual([VENDOR_PRODUCT_ID]);
    });

    it('matches brand_id exactly: a product declaring one does not match a goal that omits it', async () => {
      const brandedVendor = { domain: 'footfallvendor.example', brand_id: 'retail_arm' };
      await seedVendorProduct(server, VENDOR_BRANDED_PRODUCT_ID, {
        vendor: brandedVendor, metric_id: 'store_visits_14d_exposed', supported_targets: ['cost_per'],
      });

      const omitted = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: STORE_VISITS_GOAL, volume: 5000 }, undefined, VENDOR_BRANDED_PRODUCT_ID,
      ));
      expect(omitted.code).toBe('INVALID_REQUEST');
      expect(omitted.field).toBe('criteria.outcome_target.goal');

      const matched = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: { ...STORE_VISITS_GOAL, vendor: brandedVendor }, volume: 5000 }, undefined, VENDOR_BRANDED_PRODUCT_ID,
      ));
      expectValidResponse(matched);
      const proposal = onlyProposal(matched);
      expect(termsOf(proposal).purchases[0].optimization_goals[0].vendor).toEqual(brandedVendor);
      const forecast = proposal.forecast as { points: Array<{ vendor_metric_values: Array<{ vendor: unknown }> }> };
      expect(forecast.points[0]!.vendor_metric_values[0]!.vendor).toEqual(brandedVendor);
    });

    it('rescales three kept allocations that do not divide evenly to exactly 100%', async () => {
      const keptIds = ['outcome_target_vendor_kept_a', 'outcome_target_vendor_kept_b', 'outcome_target_vendor_kept_c'];
      for (const id of keptIds) await declare(id);
      await seedOutcomeTargetProduct(server, [USD_FIXED_CPM_40], UNDECLARING_PRODUCT_ID);

      const result = await callTool(server, 'request_proposals', {
        account: ACCOUNT,
        brief: 'Reverse-forecast planning test',
        criteria: {
          product_ids: [...keptIds, UNDECLARING_PRODUCT_ID],
          outcome_target: { goal: STORE_VISITS_GOAL, volume: 5000 },
        },
      });
      expectValidResponse(result);
      const proposal = onlyProposal(result);
      const budgets = termsOf(proposal).purchases.map((purchase: { budget: number }) => purchase.budget);
      expect(budgets).toHaveLength(3);
      // The three shares of the media-buy total cover it without a leftover
      // or excess: the rescaled allocation percentages sum to exactly 100.
      const total = termsOf(proposal).total_budget.amount as number;
      expect(Math.round(budgets.reduce((sum: number, budget: number) => sum + budget, 0) * 100) / 100).toBe(total);
    });

    it('rejects the catalog attention_score metric as a score, and an undeclared vendor, when no products are selected', async () => {
      const score = await callTool(server, 'request_proposals', {
        account: ACCOUNT,
        brief: 'Plan attention across the catalog',
        criteria: {
          outcome_target: {
            goal: { kind: 'vendor_metric', vendor: { domain: 'attentionvendor.example' }, metric_id: 'attention_score' },
            volume: 100,
          },
        },
      });
      expect(score.code).toBe('INVALID_REQUEST');
      expect(score.field).toBe('criteria.outcome_target.goal');
      expect(String(score.message)).toContain('cumulative total');

      const undeclared = await callTool(server, 'request_proposals', {
        account: ACCOUNT,
        brief: 'Plan store visits across the catalog',
        criteria: { outcome_target: { goal: STORE_VISITS_GOAL, volume: 100 } },
      });
      expect(undeclared.code).toBe('INVALID_REQUEST');
      expect(undeclared.field).toBe('criteria.outcome_target.goal');
    });

    it('rejects a cost target when the matching entry does not list cost_per, naming cost_per', async () => {
      await seedVendorProduct(server, VENDOR_NO_COST_PRODUCT_ID, {
        vendor: STORE_VISITS_VENDOR,
        metric_id: 'store_visits_14d_exposed',
        supported_targets: ['threshold_rate'],
      });

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: STORE_VISITS_GOAL, cost_per: { amount: 4, currency: 'USD', strength: 'cap' } },
        undefined,
        VENDOR_NO_COST_PRODUCT_ID,
      ));
      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.cost_per');

      // The same goal still plans by volume.
      const volume = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: STORE_VISITS_GOAL, volume: 5000 }, undefined, VENDOR_NO_COST_PRODUCT_ID,
      ));
      expectValidResponse(volume);
      expect(onlyProposal(volume).forecast).toBeDefined();
    });

    it('validates the goal before the cost target, so a bad goal is reported first', async () => {
      await seedOutcomeTargetProduct(server, [USD_FIXED_CPM_40], UNDECLARING_PRODUCT_ID);

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        {
          goal: { kind: 'vendor_metric', vendor: { domain: 'undeclaredvendor.example' }, metric_id: 'store_visits_undeclared' },
          // Two cost faults: an unsupported currency alongside the bad goal.
          cost_per: { amount: 4, currency: 'EUR', strength: 'cap' },
        },
        undefined,
        UNDECLARING_PRODUCT_ID,
      ));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.goal');
    });

    it('keeps cost-target currency rejections on cost_per for a declared goal', async () => {
      await declare();

      const result = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: STORE_VISITS_GOAL, cost_per: { amount: 4, currency: 'EUR', strength: 'cap' } },
        undefined,
        VENDOR_PRODUCT_ID,
      ));

      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.field).toBe('criteria.outcome_target.cost_per');
    });

    it('copies only vendor-scope reporting_commitments to committed_metrics on accept', async () => {
      await declare();
      const requested = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: STORE_VISITS_GOAL, cost_per: { amount: 4, currency: 'USD', strength: 'cap' } },
        { budget_range: { max: 5000, currency: 'USD' } },
        VENDOR_PRODUCT_ID,
      ));
      const draft = onlyProposal(requested);
      const refined = await callTool(server, 'refine_proposals', {
        refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }],
      });
      const committed = (refined.results as Array<Record<string, unknown>>)[0]!.proposal as Record<string, unknown>;

      // The seller emits only vendor commitments, so add a standard one to the
      // committed snapshot (both stored copies) before accepting.
      await runWithSessionContext(async () => {
        const session = await findSessionMatching(candidate => candidate.proposalRefinementRecords.has(committed.proposal_id as string));
        expect(session).not.toBeNull();
        const standard = { scope: 'standard', metric_id: 'impressions' };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const record = session!.proposalRefinementRecords.get(committed.proposal_id as string) as any;
        record.proposal.commercial_terms.reporting_commitments[0].metrics.push(standard);
        for (const proposal of session!.lastGetProductsContext?.proposals ?? []) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const internal = proposal as any;
          if (internal.proposal_id === committed.proposal_id) {
            internal.__canonical_commercial_terms?.reporting_commitments?.[0]?.metrics.push(standard);
          }
        }
        await flushDirtySessions();
      });

      const accepted = await callTool(server, 'accept_proposal', {
        adcp_version: '3.2-rc.7',
        account: ACCOUNT,
        proposal_id: committed.proposal_id,
        proposal_terms_digest: committed.terms_digest,
      });
      expect(accepted.errors, JSON.stringify(accepted)).toBeUndefined();
      const read = await callTool(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [accepted.media_buy_id] });
      const buys = read.media_buys as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(buys[0]!.packages[0].committed_metrics).toEqual([expect.objectContaining(STORE_VISITS_REPORTING_COMMITMENT)]);
    });

    it('survives finalize and accept_proposal, adopting the cost cap and the vendor goal without a separate committed_metrics', async () => {
      await declare();

      const requested = await callTool(server, 'request_proposals', requestProposalsArgs(
        { goal: STORE_VISITS_GOAL, cost_per: { amount: 4, currency: 'USD', strength: 'cap' } },
        { budget_range: { max: 5000, currency: 'USD' } },
        VENDOR_PRODUCT_ID,
      ));
      expectValidResponse(requested);
      const draft = onlyProposal(requested);

      const refined = await callTool(server, 'refine_proposals', {
        refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }],
      });
      const finalized = (refined.results as Array<Record<string, unknown>>)[0]!;
      expect(finalized.outcome, JSON.stringify(refined)).toBe('finalized');
      const committed = finalized.proposal as Record<string, unknown>;
      expect(committed.proposal_status).toBe('committed');
      // Finalization preserves the answer.
      expect(termsOf(committed).bidding).toEqual({ cost_per: { amount: 80, strength: 'cap' } });
      expect(termsOf(committed).reporting_commitments).toEqual([{ purchase_index: 0, metrics: [STORE_VISITS_REPORTING_COMMITMENT] }]);

      const accepted = await callTool(server, 'accept_proposal', {
        // accept_proposal is a 3.2 compact-lifecycle tool; an unversioned call
        // resolves to an older release that does not serve it.
        adcp_version: '3.2-rc.7',
        account: ACCOUNT,
        proposal_id: committed.proposal_id,
        proposal_terms_digest: committed.terms_digest,
      });
      expect(accepted.errors, JSON.stringify(accepted)).toBeUndefined();
      expect(typeof accepted.media_buy_id).toBe('string');

      const read = await callTool(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [accepted.media_buy_id] });
      const buys = read.media_buys as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(buys[0]!.bidding, JSON.stringify(read)).toEqual({ cost_per: { amount: 80, strength: 'cap' } });
      expect(buys[0]!.packages[0].optimization_goals).toEqual([STORE_VISITS_OPTIMIZATION_GOAL]);
      expect(buys[0]!.packages[0].committed_metrics).toEqual([
        expect.objectContaining(STORE_VISITS_REPORTING_COMMITMENT),
      ]);
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

    it('declares event-goal cost targets in conversion_tracking.supported_targets on 3.1+ responses only', async () => {
      type ConversionCapabilities = { media_buy: { conversion_tracking: { supported_targets?: string[] } } };
      for (const args of [{ adcp_version: '3.2-rc.7' }, { adcp_version: '3.1' }]) {
        const caps = await callTool(server, 'get_adcp_capabilities', args) as ConversionCapabilities;
        expect(caps.media_buy.conversion_tracking.supported_targets, JSON.stringify(args)).toEqual(['cost_per']);
      }
      const compatServer = createTrainingAgentServer({ mode: 'open', storyboardCompat: { version: '3.0' } });
      const legacy = await callTool(compatServer, 'get_adcp_capabilities', { adcp_version: '3.2-rc.7' }) as ConversionCapabilities;
      expect(legacy.media_buy.conversion_tracking.supported_targets).toBeUndefined();

      // The sales platform's capability getter (the tenant router's source)
      // omits it under 3.0 storyboard compat too, and declares it otherwise.
      const conversionTracking = (platform: TrainingSalesPlatform) => (
        (platform.capabilities as unknown as { conversion_tracking: { supported_targets?: string[] } }).conversion_tracking
      );
      expect(conversionTracking(new TrainingSalesPlatform()).supported_targets).toEqual(['cost_per']);
      expect(conversionTracking(new TrainingSalesPlatform({ version: '3.0' })).supported_targets).toBeUndefined();
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

    it('binds a fixed media-buy cost_per to vendor_metric goals by vendor and metric_id', () => {
      const visitsPackage = {
        product_id: 'v', pricing_option_id: 'v_cpm', budget: 100,
        optimization_goals: [STORE_VISITS_OPTIMIZATION_GOAL],
      };
      expect(createMediaBuyBiddingPolicyError({
        budget_allocation: { mode: 'fixed' },
        bidding: { cost_per: { amount: 4, strength: 'cap' } },
        packages: [visitsPackage, { ...visitsPackage, product_id: 'w' }],
      })).toBeUndefined();
      const otherVendorPackage = {
        ...visitsPackage,
        optimization_goals: [{ ...STORE_VISITS_OPTIMIZATION_GOAL, vendor: { domain: 'othervendor.example' } }],
      };
      expect(createMediaBuyBiddingPolicyError({
        budget_allocation: { mode: 'fixed' },
        bidding: { cost_per: { amount: 4, strength: 'cap' } },
        packages: [visitsPackage, otherVendorPackage],
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
