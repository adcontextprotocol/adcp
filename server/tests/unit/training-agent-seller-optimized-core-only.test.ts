import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION, type TrainingContext } from '../../src/training-agent/types.js';

// A seller that declares only the core shared-budget contract must answer
// UNSUPPORTED_FEATURE for every package control, ahead of any
// over-subscription check, on create and on update.
vi.mock('../../src/training-agent/seller-optimized-budget.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/training-agent/seller-optimized-budget.js')>();
  return {
    ...original,
    sellerOptimizedDeclarationForVersion: () => ({
      seller_optimized_budget: true,
      seller_optimized_package_budgets: false,
      seller_optimized_min_spend_targets: false,
      seller_optimized_package_pacing: false,
    }),
  };
});

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'seller-optimized.example' }, operator: 'pinnacle-agency.example', sandbox: true };
const BRAND = { domain: 'seller-optimized.example' };
const FLIGHT = { start_time: '2099-09-01T00:00:00Z', end_time: '2099-09-30T23:59:59Z' };
const GOALS = [{ kind: 'metric', metric: 'clicks', priority: 1 }];

type ToolResult = { result: Record<string, unknown>; error?: Record<string, unknown> };

async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
  adcpVersion: string = TRAINING_AGENT_CURRENT_ADCP_VERSION,
): Promise<ToolResult> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call')!;
  const versioned = toolName === 'comply_test_controller' ? args : { adcp_version: adcpVersion, ...args };
  const withKey = MUTATING_TOOLS.has(toolName) && versioned.idempotency_key === undefined
    ? { ...versioned, idempotency_key: `test-${crypto.randomUUID()}` }
    : versioned;
  const response = await handler({ method: 'tools/call', params: { name: toolName, arguments: withKey } }, {});
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

async function seedSharedProducts(server: ReturnType<typeof createTrainingAgentServer>): Promise<void> {
  for (const [productId, options] of [
    ['so_prospecting', [{ id: 'so_prospecting_cpm', currency: 'USD' }]],
    ['so_retargeting', [{ id: 'so_retargeting_cpm', currency: 'USD' }, { id: 'so_retargeting_cpm_eur', currency: 'EUR' }]],
  ] as const) {
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
          pricing_options: options.map(option => ({
            pricing_option_id: option.id,
            pricing_model: 'cpm',
            currency: option.currency,
            floor_price: 1.5,
          })),
        },
      },
    });
    expect(seeded.result.success, JSON.stringify(seeded.result)).toBe(true);
  }
}

function sharedBuy(overrides: Record<string, unknown> = {}, packageOverrides: Array<Record<string, unknown>> = [{}, {}]) {
  return {
    account: ACCOUNT,
    brand: BRAND,
    ...FLIGHT,
    total_budget: { amount: 100000, currency: 'USD' },
    budget_allocation: { mode: 'seller_optimized', optimization_goals: GOALS },
    packages: [
      { product_id: 'so_prospecting', pricing_option_id: 'so_prospecting_cpm', ...packageOverrides[0] },
      { product_id: 'so_retargeting', pricing_option_id: 'so_retargeting_cpm', ...packageOverrides[1] },
    ],
    ...overrides,
  };
}

describe('training agent core-only seller-optimized declaration', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
    await seedSharedProducts(server);
  });

  it('accepts the core contract', async () => {
    const created = await callTool(server, 'create_media_buy', sharedBuy({ pacing: 'even' }));
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    expect(created.result).toMatchObject({ budget_allocation: { mode: 'seller_optimized' }, pacing: 'even' });
  });

  it.each([
    ['package budget', [{ budget: 65000, min_spend_target: 70000 }, {}], 'packages[0].budget'],
    ['minimum-spend targets', [{ min_spend_target: 70000 }, { min_spend_target: 40000 }], 'packages[0].min_spend_target'],
    ['package pacing', [{}, { pacing: 'asap' }], 'packages[1].pacing'],
  ])('rejects %s with UNSUPPORTED_FEATURE before over-subscription', async (_name, packages, field) => {
    const created = await callTool(server, 'create_media_buy', sharedBuy({ pacing: 'even' }, packages as Array<Record<string, unknown>>));
    expect(created.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field });
  });

  it('rejects an update that would leave an undeclared control in effect', async () => {
    const created = await callTool(server, 'create_media_buy', sharedBuy());
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    const packages = created.result.packages as Array<{ package_id: string }>;
    const updated = await callTool(server, 'update_media_buy', {
      account: ACCOUNT,
      media_buy_id: created.result.media_buy_id,
      packages: [{ package_id: packages[0].package_id, min_spend_target: 20000 }],
    });
    expect(updated.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
  });
});
