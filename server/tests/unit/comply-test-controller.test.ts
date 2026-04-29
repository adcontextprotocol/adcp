import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import {
  clearSessions,
} from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'comply-test.example.com' }, operator: 'comply-tester', sandbox: true };
const BRAND = { domain: 'comply-test.example.com', name: 'Comply Test Brand' };

function withIdempotencyKey(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!MUTATING_TOOLS.has(toolName)) return args;
  if (args.idempotency_key !== undefined) return args;
  return { ...args, idempotency_key: `test-${crypto.randomUUID()}` };
}

async function simulateCallTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; isError?: boolean }> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
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
  // Unwrap adcp_error envelope for error responses (L3 compliance format)
  const result = (parsed.adcp_error as Record<string, unknown> | undefined) ?? parsed;
  return { result, isError: response.isError };
}

async function simulateListTools(server: ReturnType<typeof createTrainingAgentServer>) {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/list');
  if (!handler) throw new Error('ListTools handler not found');
  return handler({ method: 'tools/list' }, {});
}

/** Create a media buy and return its ID. */
async function createMediaBuy(server: ReturnType<typeof createTrainingAgentServer>): Promise<string> {
  // Get a valid product first
  const { result: products, isError: productsError } = await simulateCallTool(server, 'get_products', {
    buying_mode: 'wholesale',
    account: ACCOUNT,
    brand: BRAND,
  });
  if (productsError || (products as any).errors) {
    throw new Error(`get_products failed: ${JSON.stringify(products)}`);
  }
  const productList = (products as any).products || [];
  const product = productList[0];
  if (!product) throw new Error('No products in catalog');

  const pricingOption = product.pricing_options[0];
  if (!pricingOption) throw new Error(`No pricing options for product ${product.product_id}`);

  const now = new Date();
  const endTime = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const { result, isError } = await simulateCallTool(server, 'create_media_buy', {
    idempotency_key: crypto.randomUUID(),
    account: ACCOUNT,
    brand: BRAND,
    start_time: now.toISOString(),
    end_time: endTime.toISOString(),
    packages: [{
      product_id: product.product_id,
      pricing_option_id: pricingOption.pricing_option_id,
      budget: 10000,
    }],
  });
  if (isError || (result as any).errors) {
    throw new Error(`create_media_buy failed: ${JSON.stringify(result)}`);
  }
  const mediaBuyId = (result as any).media_buy_id;
  if (!mediaBuyId) throw new Error(`No media_buy_id in response: ${JSON.stringify(result)}`);
  return mediaBuyId;
}

/** Sync a creative and return its ID. */
async function syncCreative(server: ReturnType<typeof createTrainingAgentServer>): Promise<string> {
  const creativeId = `cr-test-${Date.now()}`;
  const { result, isError } = await simulateCallTool(server, 'sync_creatives', {
    idempotency_key: crypto.randomUUID(),
    account: ACCOUNT,
    brand: BRAND,
    creatives: [{
      creative_id: creativeId,
      name: 'Test Creative',
    }],
  });
  if (isError || (result as any).errors) {
    throw new Error(`sync_creatives failed: ${JSON.stringify(result)}`);
  }
  return creativeId;
}

/** Create a media buy with creatives assigned so it reaches active/pending_start status. */
async function createMediaBuyWithCreatives(server: ReturnType<typeof createTrainingAgentServer>): Promise<string> {
  const mediaBuyId = await createMediaBuy(server);
  const creativeId = await syncCreative(server);

  // Discover the package ID from the buy
  const { result: buys } = await simulateCallTool(server, 'get_media_buys', {
    account: ACCOUNT,
    brand: BRAND,
    status_filter: ['pending_creatives'],
  });
  const buy = (buys as any).media_buys?.find((b: any) => b.media_buy_id === mediaBuyId);
  const packageId = buy?.packages?.[0]?.package_id;

  // Assign the creative to the buy's package
  await simulateCallTool(server, 'sync_creatives', {
    idempotency_key: crypto.randomUUID(),
    account: ACCOUNT,
    brand: BRAND,
    creatives: [{ creative_id: creativeId, name: 'Test Creative' }],
    assignments: [{ creative_id: creativeId, package_id: packageId, media_buy_id: mediaBuyId }],
  });

  return mediaBuyId;
}

describe('comply_test_controller', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearTaskStore();
    clearIdempotencyCache();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  describe('tool registration', () => {
    it('appears in tools/list', async () => {
      const { tools } = await simulateListTools(server);
      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain('comply_test_controller');
    });
  });

  describe('list_scenarios', () => {
    it('returns all supported scenarios', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'list_scenarios',
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      const scenarios = result.scenarios as string[];
      // Order-agnostic: the controller does not promise a specific ordering and
      // the SDK is free to reshuffle CONTROLLER_SCENARIOS. Assert membership of
      // every advertised scenario (SDK-native + LOCAL_SCENARIOS appended by the
      // training-agent wrapper) without coupling to enumeration order.
      expect(scenarios).toEqual(expect.arrayContaining([
        'force_creative_status',
        'force_account_status',
        'force_media_buy_status',
        'force_session_status',
        'simulate_delivery',
        'simulate_budget_spend',
        // Local scenarios — see LOCAL_SCENARIOS in
        // server/src/training-agent/comply-test-controller.ts.
        'force_create_media_buy_arm',
        'force_task_completion',
        'seed_creative_format',
      ]));
      // Catch silent drift in either direction (entries removed, or new ones
      // not yet documented in this assertion).
      expect(scenarios.length).toBe(9);
      // Dedup invariant — see SCENARIO_ENUM dedup in the wrapper.
      expect(new Set(scenarios).size).toBe(scenarios.length);
    });
  });

  describe('seed scenarios', () => {
    it('seed_creative pre-populates a creative the rest of the session can reference', async () => {
      const { result, isError } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'seed_creative',
        account: ACCOUNT,
        brand: BRAND,
        params: {
          creative_id: 'seeded_creative_1',
          fixture: { name: 'Seeded Hero Video', status: 'approved', format_id: { id: 'video_30s' } },
        },
      });
      expect(isError).toBeFalsy();
      expect(result.success).toBe(true);

      // Creative should now be visible to list_creatives within the same session.
      const { result: listed } = await simulateCallTool(server, 'list_creatives', {
        account: ACCOUNT,
        brand: BRAND,
      });
      const creatives = (listed as any).creatives as Array<{ creative_id: string }>;
      expect(creatives.some(c => c.creative_id === 'seeded_creative_1')).toBe(true);
    });

    it('seed_plan pre-populates a governance plan', async () => {
      const { result, isError } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'seed_plan',
        account: ACCOUNT,
        brand: BRAND,
        params: {
          plan_id: 'seeded_plan_1',
          fixture: {
            brand: { domain: 'comply-test.example.com' },
            objectives: 'seeded test plan',
            budget: { total: 10000, currency: 'USD' },
          },
        },
      });
      expect(isError).toBeFalsy();
      expect(result.success).toBe(true);
    });

    it('seed_media_buy pre-populates a media buy in active state', async () => {
      const { result, isError } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'seed_media_buy',
        account: ACCOUNT,
        brand: BRAND,
        params: {
          media_buy_id: 'seeded_mb_1',
          fixture: { status: 'active', currency: 'USD' },
        },
      });
      expect(isError).toBeFalsy();
      expect(result.success).toBe(true);

      const { result: buys } = await simulateCallTool(server, 'get_media_buys', {
        account: ACCOUNT,
        brand: BRAND,
        media_buy_ids: ['seeded_mb_1'],
      });
      const found = (buys as any).media_buys as Array<{ media_buy_id: string }>;
      expect(found.some(b => b.media_buy_id === 'seeded_mb_1')).toBe(true);
    });

    it('seed_* requires params (per spec allOf clause)', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'seed_creative',
        account: ACCOUNT,
        brand: BRAND,
      });
      expect((result as any).success).toBe(false);
      expect((result as any).error).toBe('INVALID_PARAMS');
    });

    it('seeded product + pricing option resolves via create_media_buy (overlay consumer side)', async () => {
      // seed_product writes to session.complyExtensions.seededProducts;
      // handleCreateMediaBuy overlays those entries onto its catalog lookup.
      // Without the overlay, create_media_buy returns PRODUCT_NOT_FOUND.
      const seedProd = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'seed_product',
        account: ACCOUNT,
        brand: BRAND,
        params: {
          product_id: 'seeded_auction_product',
          fixture: { delivery_type: 'non_guaranteed', channels: ['display'] },
        },
      });
      expect((seedProd.result as any).success).toBe(true);

      const seedPricing = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'seed_pricing_option',
        account: ACCOUNT,
        brand: BRAND,
        params: {
          product_id: 'seeded_auction_product',
          pricing_option_id: 'seeded_cpm_auction',
          fixture: { pricing_model: 'cpm', currency: 'USD', floor_price: 5.0 },
        },
      });
      expect((seedPricing.result as any).success).toBe(true);

      const { result } = await simulateCallTool(server, 'create_media_buy', {
        account: ACCOUNT,
        brand: BRAND,
        start_time: '2027-06-01T00:00:00Z',
        end_time: '2027-07-01T00:00:00Z',
        packages: [{
          product_id: 'seeded_auction_product',
          pricing_option_id: 'seeded_cpm_auction',
          bid_price: 8.50,
          budget: 10000,
        }],
      });
      expect(result.media_buy_id).toBeDefined();
      const pkgs = result.packages as Array<Record<string, unknown>>;
      expect(pkgs).toHaveLength(1);
      expect(pkgs[0].package_id).toBe('pkg-0');
    });
  });

  describe('sandbox gating', () => {
    it('allows calls when sandbox is not specified', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'list_scenarios',
        account: { brand: { domain: 'test.example.com' }, operator: 'tester' },
        brand: BRAND,
      });
      expect(result.success).toBe(true);
    });

    it('rejects calls with sandbox: false', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'list_scenarios',
        account: { brand: { domain: 'test.example.com' }, operator: 'tester', sandbox: false },
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('FORBIDDEN');
    });

    it('allows calls with no account', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'list_scenarios',
        brand: BRAND,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('unknown scenario', () => {
    it('returns UNKNOWN_SCENARIO error', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'nonexistent_scenario',
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('UNKNOWN_SCENARIO');
    });
  });

  describe('force_creative_status', () => {
    it('transitions creative through valid states', async () => {
      const creativeId = await syncCreative(server);

      // Creative starts as "approved" in training agent
      // Force to archived (approved → archived is valid)
      const { result: r1 } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: { creative_id: creativeId, status: 'archived' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(r1.success).toBe(true);
      expect(r1.previous_state).toBe('approved');
      expect(r1.current_state).toBe('archived');

      // Verify reflected in list_creatives
      const { result: list } = await simulateCallTool(server, 'list_creatives', {
        account: ACCOUNT,
        brand: BRAND,
        creative_ids: [creativeId],
      });
      expect((list as any).creatives[0].status).toBe('archived');
    });

    it('rejects invalid transitions', async () => {
      const creativeId = await syncCreative(server);

      // approved → processing is not valid
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: { creative_id: creativeId, status: 'processing' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_TRANSITION');
      expect(result.current_state).toBe('approved');
    });

    it('is idempotent for same status', async () => {
      const creativeId = await syncCreative(server);
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: { creative_id: creativeId, status: 'approved' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      expect(result.previous_state).toBe('approved');
      expect(result.current_state).toBe('approved');
    });

    it('returns NOT_FOUND for unknown creative', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: { creative_id: 'cr-nonexistent', status: 'approved' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_FOUND');
      expect(result.current_state).toBeNull();
    });

    it('rejects transition to rejected from approved without a rejection_reason', async () => {
      // approved → rejected is a valid path (brand-safety flagging an
      // already-approved creative is a real lifecycle edge); but rejecting
      // still requires a reason, so the call must fail with INVALID_PARAMS.
      const creativeId = await syncCreative(server);
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: { creative_id: creativeId, status: 'rejected' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toContain('rejection_reason');
    });

    it('allows approved -> rejected with a rejection_reason (post-approval brand-safety flag)', async () => {
      const creativeId = await syncCreative(server);
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: {
          creative_id: creativeId,
          status: 'rejected',
          rejection_reason: 'Brand safety policy violation discovered post-approval',
        },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      expect(result.previous_state).toBe('approved');
      expect(result.current_state).toBe('rejected');
    });

    it('allows approved -> pending_review (seller re-review)', async () => {
      const creativeId = await syncCreative(server);
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: { creative_id: creativeId, status: 'pending_review' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      expect(result.previous_state).toBe('approved');
      expect(result.current_state).toBe('pending_review');
    });

    it('requires rejection_reason when rejecting from pending_review', async () => {
      const creativeId = await syncCreative(server);
      // approved -> pending_review -> rejected (without reason)
      await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: { creative_id: creativeId, status: 'pending_review' },
        account: ACCOUNT,
        brand: BRAND,
      });
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: { creative_id: creativeId, status: 'rejected' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toContain('rejection_reason');
    });
  });

  describe('force_account_status', () => {
    it('transitions account through valid states', async () => {
      const accountId = 'acct-test-1';

      // Default is active → suspend it
      const { result: r1 } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_account_status',
        params: { account_id: accountId, status: 'suspended' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(r1.success).toBe(true);
      expect(r1.previous_state).toBe('active');
      expect(r1.current_state).toBe('suspended');

      // Reactivate: suspended → active
      const { result: r2 } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_account_status',
        params: { account_id: accountId, status: 'active' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(r2.success).toBe(true);
      expect(r2.previous_state).toBe('suspended');
      expect(r2.current_state).toBe('active');
    });

    it('rejects transition from terminal state', async () => {
      const accountId = 'acct-test-2';

      // Close the account (active → closed)
      await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_account_status',
        params: { account_id: accountId, status: 'closed' },
        account: ACCOUNT,
        brand: BRAND,
      });

      // Try to reactivate (closed is terminal)
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_account_status',
        params: { account_id: accountId, status: 'active' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_TRANSITION');
      expect(result.error_detail).toContain('terminal');
    });

    it('is idempotent for same status', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_account_status',
        params: { account_id: 'acct-test-3', status: 'active' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      expect(result.previous_state).toBe('active');
      expect(result.current_state).toBe('active');
    });

    it('blocks create_media_buy when account is suspended', async () => {
      const accountId = 'acct-gated';
      const ACCT_WITH_ID = { ...ACCOUNT, account_id: accountId };

      // Suspend the account
      await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_account_status',
        params: { account_id: accountId, status: 'suspended' },
        account: ACCT_WITH_ID,
        brand: BRAND,
      });

      // Try to create a media buy — should be blocked
      const { result: products } = await simulateCallTool(server, 'get_products', {
        buying_mode: 'wholesale',
        account: ACCT_WITH_ID,
        brand: BRAND,
      });
      const product = (products as any).products[0];
      const now = new Date();
      const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const { result, isError } = await simulateCallTool(server, 'create_media_buy', {
        account: ACCT_WITH_ID,
        brand: BRAND,
        start_time: now.toISOString(),
        end_time: end.toISOString(),
        packages: [{
          product_id: product.product_id,
          pricing_option_id: product.pricing_options[0].pricing_option_id,
          budget: 5000,
        }],
      });
      expect(isError).toBe(true);
      expect((result as any).code).toBe('ACCOUNT_STATUS_BLOCKED');
    });
  });

  describe('force_media_buy_status', () => {
    it('transitions media buy through valid states', async () => {
      const mediaBuyId = await createMediaBuyWithCreatives(server);

      // Buy with creatives and current dates starts as 'active'. Pause it.
      const { result: r1 } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: mediaBuyId, status: 'paused' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(r1.success).toBe(true);
      expect(r1.previous_state).toBe('active');
      expect(r1.current_state).toBe('paused');

      // Resume: paused → active
      const { result: r2 } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: mediaBuyId, status: 'active' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(r2.success).toBe(true);
      expect(r2.previous_state).toBe('paused');
      expect(r2.current_state).toBe('active');

      // Verify reflected in get_media_buys
      const { result: buys } = await simulateCallTool(server, 'get_media_buys', {
        account: ACCOUNT,
        brand: BRAND,
      });
      const buy = (buys as any).media_buys?.find((b: any) => b.media_buy_id === mediaBuyId);
      expect(buy?.status).toBe('active');
    });

    it('rejects transition from terminal state', async () => {
      const mediaBuyId = await createMediaBuy(server);

      // Complete it (active → completed is valid)
      await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: mediaBuyId, status: 'completed' },
        account: ACCOUNT,
        brand: BRAND,
      });

      // Try to activate (completed is terminal)
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: mediaBuyId, status: 'active' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_TRANSITION');
    });

    it('rejects rejected from active (only valid from pending_creatives or pending_start)', async () => {
      const mediaBuyId = await createMediaBuyWithCreatives(server);

      // Buy with creatives is active — rejected is not valid from active
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: mediaBuyId, status: 'rejected', rejection_reason: 'Test' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_TRANSITION');
    });

    it('returns NOT_FOUND for unknown media buy', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: 'mb-nonexistent', status: 'active' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_FOUND');
    });

    it('cancels a media buy from active', async () => {
      const mediaBuyId = await createMediaBuyWithCreatives(server);

      // Cancel from active (active → canceled is valid)
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: mediaBuyId, status: 'canceled' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      expect(result.previous_state).toBe('active');
      expect(result.current_state).toBe('canceled');
    });
  });

  describe('force_session_status', () => {
    it('terminates an active session', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_session_status',
        params: { session_id: 'sess-1', status: 'terminated', termination_reason: 'session_timeout' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      expect(result.previous_state).toBe('active');
      expect(result.current_state).toBe('terminated');
    });

    it('completes a session', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_session_status',
        params: { session_id: 'sess-2', status: 'complete' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      expect(result.current_state).toBe('complete');
    });

    it('rejects transition from terminal state', async () => {
      // Complete a session first
      await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_session_status',
        params: { session_id: 'sess-3', status: 'complete' },
        account: ACCOUNT,
        brand: BRAND,
      });

      // Try to terminate (complete is terminal)
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_session_status',
        params: { session_id: 'sess-3', status: 'terminated', termination_reason: 'test' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_TRANSITION');
    });

    it('rejects non-terminal target statuses', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_session_status',
        params: { session_id: 'sess-4', status: 'active' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
    });

    it('requires termination_reason when terminating', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_session_status',
        params: { session_id: 'sess-5', status: 'terminated' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toContain('termination_reason');
    });
  });

  describe('simulate_delivery', () => {
    it('injects delivery data and reflects in get_media_buy_delivery', async () => {
      const mediaBuyId = await createMediaBuy(server);

      // Simulate delivery
      const { result: simResult } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_delivery',
        params: {
          media_buy_id: mediaBuyId,
          impressions: 10000,
          clicks: 150,
          reported_spend: { amount: 150.00, currency: 'USD' },
        },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(simResult.success).toBe(true);
      expect((simResult as any).simulated.impressions).toBe(10000);
      expect((simResult as any).cumulative.impressions).toBe(10000);

      // Verify reflected in delivery
      const { result: delivery } = await simulateCallTool(server, 'get_media_buy_delivery', {
        media_buy_id: mediaBuyId,
        account: ACCOUNT,
        brand: BRAND,
      });
      const totals = (delivery as any).media_buy_deliveries[0].totals;
      expect(totals.impressions).toBeGreaterThanOrEqual(10000);
      expect(totals.clicks).toBeGreaterThanOrEqual(150);
    });

    it('is additive across calls', async () => {
      const mediaBuyId = await createMediaBuy(server);

      await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_delivery',
        params: { media_buy_id: mediaBuyId, impressions: 5000 },
        account: ACCOUNT,
        brand: BRAND,
      });

      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_delivery',
        params: { media_buy_id: mediaBuyId, impressions: 3000 },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect((result as any).cumulative.impressions).toBe(8000);
    });

    it('returns NOT_FOUND for unknown media buy', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_delivery',
        params: { media_buy_id: 'mb-ghost', impressions: 100 },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_FOUND');
    });

    it('rejects delivery simulation for terminal media buy', async () => {
      const mediaBuyId = await createMediaBuyWithCreatives(server);

      // Complete the media buy (terminal state)
      await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_media_buy_status',
        params: { media_buy_id: mediaBuyId, status: 'completed' },
        account: ACCOUNT,
        brand: BRAND,
      });

      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_delivery',
        params: { media_buy_id: mediaBuyId, impressions: 1000 },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_STATE');
    });
  });

  describe('simulate_budget_spend', () => {
    it('simulates budget consumption', async () => {
      const mediaBuyId = await createMediaBuy(server);

      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_budget_spend',
        params: { media_buy_id: mediaBuyId, spend_percentage: 95 },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      expect((result as any).simulated.spend_percentage).toBe(95);
      expect((result as any).simulated.budget.amount).toBe(10000);
      expect((result as any).simulated.computed_spend.amount).toBe(9500);
    });

    it('replaces spend level (not additive)', async () => {
      const mediaBuyId = await createMediaBuy(server);

      await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_budget_spend',
        params: { media_buy_id: mediaBuyId, spend_percentage: 50 },
        account: ACCOUNT,
        brand: BRAND,
      });

      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_budget_spend',
        params: { media_buy_id: mediaBuyId, spend_percentage: 75 },
        account: ACCOUNT,
        brand: BRAND,
      });
      // Should be 75%, not 125%
      expect((result as any).simulated.spend_percentage).toBe(75);
      expect((result as any).simulated.computed_spend.amount).toBe(7500);
    });

    it('requires at least one of account_id or media_buy_id', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_budget_spend',
        params: { spend_percentage: 50 },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
    });

    it('rejects spend_percentage outside 0-100', async () => {
      const mediaBuyId = await createMediaBuy(server);
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'simulate_budget_spend',
        params: { media_buy_id: mediaBuyId, spend_percentage: 150 },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
    });
  });

  describe('missing params', () => {
    it('returns INVALID_PARAMS when params is omitted for force scenarios', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
    });
  });
});
