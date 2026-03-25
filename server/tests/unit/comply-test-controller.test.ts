import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import {
  clearSessions,
} from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'comply-test.example.com' }, operator: 'comply-tester', sandbox: true };
const BRAND = { domain: 'comply-test.example.com', name: 'Comply Test Brand' };

async function simulateCallTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; isError?: boolean }> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: args } },
    {},
  );
  const text = response.content?.[0]?.text;
  return { result: text ? JSON.parse(text) : {}, isError: response.isError };
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

describe('comply_test_controller', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearTaskStore();
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
      expect(result.scenarios).toEqual([
        'force_creative_status',
        'force_account_status',
        'force_media_buy_status',
        'force_session_status',
        'simulate_delivery',
        'simulate_budget_spend',
      ]);
    });
  });

  describe('sandbox gating', () => {
    it('rejects calls without sandbox: true', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'list_scenarios',
        account: { brand: { domain: 'test.example.com' }, operator: 'tester' },
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('FORBIDDEN');
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

    it('rejects calls with no account', async () => {
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'list_scenarios',
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('FORBIDDEN');
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

    it('rejects transition to rejected from approved (no valid path)', async () => {
      const creativeId = await syncCreative(server);
      // Training agent auto-approves on sync. No valid transition from approved → rejected,
      // so transition validation fires before rejection_reason check.
      const { result } = await simulateCallTool(server, 'comply_test_controller', {
        scenario: 'force_creative_status',
        params: { creative_id: creativeId, status: 'rejected' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_TRANSITION');
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
      const mediaBuyId = await createMediaBuy(server);

      // Training agent creates buys as 'active'. Pause it.
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

    it('rejects rejected from active (only valid from pending_activation)', async () => {
      const mediaBuyId = await createMediaBuy(server);

      // Try to reject from active — rejected is only valid from pending_activation
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
      const mediaBuyId = await createMediaBuy(server);

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
