import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION, type TrainingContext } from '../../src/training-agent/types.js';
import {
  sellerOptimizedDeclarationForVersion,
  sellerOptimizedFeatureFlags,
  sellerOptimizedProposalForBrief,
  sellerOptimizedStateError,
  type SellerOptimizedDeclaration,
  type SellerOptimizedState,
} from '../../src/training-agent/seller-optimized-budget.js';

// Shared seller-optimized budgets: the declaration, the rejection paths that
// justify it, and the proposal the agent emits for a shared-budget brief.

const FULL = sellerOptimizedDeclarationForVersion('3.2');
const CORE_ONLY: SellerOptimizedDeclaration = {
  ...FULL,
  seller_optimized_package_budgets: false,
  seller_optimized_min_spend_targets: false,
  seller_optimized_package_pacing: false,
};
const NONE = sellerOptimizedDeclarationForVersion('3.0');

function state(overrides: Partial<SellerOptimizedState> = {}): SellerOptimizedState {
  return {
    allocationMode: 'seller_optimized',
    totalBudget: 100000,
    pacing: undefined,
    packages: [{ ref: 'packages[0]' }, { ref: 'packages[1]' }],
    ...overrides,
  };
}

describe('seller-optimized declaration', () => {
  it('declares the whole enforced set on 3.2 and nothing on frozen 3.0/3.1 lines', () => {
    expect(sellerOptimizedFeatureFlags(FULL)).toEqual({
      seller_optimized_budget: true,
      seller_optimized_package_budgets: true,
      seller_optimized_min_spend_targets: true,
      seller_optimized_package_pacing: true,
    });
    expect(sellerOptimizedFeatureFlags(sellerOptimizedDeclarationForVersion('3.0'))).toEqual({});
    expect(sellerOptimizedFeatureFlags(sellerOptimizedDeclarationForVersion('3.1'))).toEqual({});
    expect(sellerOptimizedFeatureFlags(sellerOptimizedDeclarationForVersion(undefined))).toEqual({});
  });

  it('advertises only the flags that are true', () => {
    expect(sellerOptimizedFeatureFlags(CORE_ONLY)).toEqual({ seller_optimized_budget: true });
  });
});

describe('seller-optimized state validation', () => {
  it('ignores fixed allocation entirely', () => {
    expect(sellerOptimizedStateError(
      state({ allocationMode: 'fixed', packages: [{ ref: 'packages[0]', budget: 5, min_spend_target: 9, pacing: 'asap' }] }),
      NONE,
    )).toBeUndefined();
  });

  it('rejects seller_optimized mode without the core capability', () => {
    expect(sellerOptimizedStateError(state(), NONE)).toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
      field: 'budget_allocation.mode',
    });
  });

  it.each([
    ['budget', { budget: 70000 }, 'packages[0].budget'],
    ['min_spend_target', { min_spend_target: 20000 }, 'packages[0].min_spend_target'],
    ['pacing', { pacing: 'front_loaded' }, 'packages[0].pacing'],
  ])('rejects an undeclared package %s with UNSUPPORTED_FEATURE', (_name, controls, field) => {
    expect(sellerOptimizedStateError(
      state({ packages: [{ ref: 'packages[0]', ...controls }, { ref: 'packages[1]' }] }),
      CORE_ONLY,
    )).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field });
  });

  it('answers UNSUPPORTED_FEATURE before over-subscription for undeclared controls', () => {
    expect(sellerOptimizedStateError(
      state({ packages: [
        { ref: 'packages[0]', min_spend_target: 70000 },
        { ref: 'packages[1]', min_spend_target: 40000 },
      ] }),
      CORE_ONLY,
    )).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'packages[0].min_spend_target' });
    expect(sellerOptimizedStateError(
      state({ packages: [{ ref: 'packages[0]', budget: 65000, min_spend_target: 70000 }] }),
      { ...CORE_ONLY, seller_optimized_min_spend_targets: true },
    )).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'packages[0].budget' });
  });

  it('treats package pacing equal to the effective media-buy pacing as no constraint', () => {
    expect(sellerOptimizedStateError(
      state({ pacing: undefined, packages: [{ ref: 'packages[0]', pacing: 'even' }] }),
      CORE_ONLY,
    )).toBeUndefined();
    expect(sellerOptimizedStateError(
      state({ pacing: 'asap', packages: [{ ref: 'packages[0]', pacing: 'asap' }] }),
      CORE_ONLY,
    )).toBeUndefined();
  });

  it('treats null package controls as absent', () => {
    expect(sellerOptimizedStateError(
      state({ packages: [{ ref: 'packages[0]', budget: null, min_spend_target: null, pacing: null }] }),
      CORE_ONLY,
    )).toBeUndefined();
  });

  it('rejects a minimum above its own cap with INVALID_REQUEST when both are declared', () => {
    expect(sellerOptimizedStateError(
      state({ packages: [{ ref: 'packages[0]', budget: 70000, min_spend_target: 80000 }, { ref: 'packages[1]' }] }),
      FULL,
    )).toMatchObject({ code: 'INVALID_REQUEST', field: 'packages[0].min_spend_target' });
  });

  it('rejects package minimums that sum above total_budget', () => {
    expect(sellerOptimizedStateError(
      state({ packages: [
        { ref: 'packages[0]', min_spend_target: 60000 },
        { ref: 'packages[1]', min_spend_target: 50000 },
      ] }),
      FULL,
    )).toMatchObject({ code: 'INVALID_REQUEST', field: 'total_budget' });
  });

  it('rejects package caps that cannot collectively spend the total', () => {
    expect(sellerOptimizedStateError(
      state({ packages: [{ ref: 'packages[0]', budget: 30000 }, { ref: 'packages[1]', budget: 40000 }] }),
      FULL,
    )).toMatchObject({ code: 'INVALID_REQUEST', field: 'total_budget' });
    // One uncapped package keeps the whole total reachable.
    expect(sellerOptimizedStateError(
      state({ packages: [{ ref: 'packages[0]', budget: 30000 }, { ref: 'packages[1]' }] }),
      FULL,
    )).toBeUndefined();
  });

  it('accepts caps that sum above the total and minimums within it', () => {
    expect(sellerOptimizedStateError(
      state({ packages: [
        { ref: 'packages[0]', budget: 70000, min_spend_target: 20000 },
        { ref: 'packages[1]', budget: 60000 },
      ] }),
      FULL,
    )).toBeUndefined();
  });
});

describe('seller-optimized proposal for a shared-budget brief', () => {
  const products = [
    { product_id: 'shared_budget_prospecting', pricing_options: [{ pricing_option_id: 'prospecting_cpm', currency: 'USD' }] },
    {
      product_id: 'shared_budget_retargeting',
      pricing_options: [
        { pricing_option_id: 'retargeting_cpm_eur', currency: 'EUR' },
        { pricing_option_id: 'retargeting_cpm', currency: 'USD' },
      ],
    },
  ];
  const brief = 'Propose a $100,000 shared display budget across prospecting and retargeting, optimize allocation for clicks, pace the buy evenly, and front-load retargeting.';

  it('emits a seller-optimized proposal with subordinate pacing and no exact percentages', () => {
    const proposal = sellerOptimizedProposalForBrief(brief, products, FULL)!;
    expect(proposal.budget_allocation).toEqual({
      mode: 'seller_optimized',
      optimization_goals: [{ kind: 'metric', metric: 'clicks', priority: 1 }],
    });
    expect(proposal.pacing).toBe('even');
    expect(proposal.total_budget_guidance).toEqual({ min: 100000, recommended: 100000, currency: 'USD' });
    expect(proposal.allocations).toEqual([
      expect.objectContaining({ product_id: 'shared_budget_prospecting', pricing_option_id: 'prospecting_cpm' }),
      expect.objectContaining({ product_id: 'shared_budget_retargeting', pricing_option_id: 'retargeting_cpm', pacing: 'front_loaded' }),
    ]);
    for (const allocation of proposal.allocations) {
      expect(allocation).not.toHaveProperty('allocation_percentage');
      expect(allocation).not.toHaveProperty('min_spend_target_percentage');
      expect(allocation).not.toHaveProperty('max_spend_percentage');
    }
  });

  it('never emits allocation pacing without seller_optimized_package_pacing', () => {
    const proposal = sellerOptimizedProposalForBrief(brief, products, { ...FULL, seller_optimized_package_pacing: false })!;
    expect(proposal.allocations.some(allocation => 'pacing' in allocation)).toBe(false);
  });

  it('matches metric words and front-load targets exactly', () => {
    const proposal = sellerOptimizedProposalForBrief(
      'Propose a shared budget for interviews, front-loaded and front-load retargeting.',
      products,
      FULL,
    )!;
    expect(proposal.budget_allocation.optimization_goals[0].metric).toBe('clicks');
    expect(proposal.allocations.map(allocation => allocation.pacing)).toEqual([undefined, 'front_loaded']);
  });

  it('derives a stable ID from the terms', () => {
    const first = sellerOptimizedProposalForBrief(brief, products, FULL)!;
    expect(sellerOptimizedProposalForBrief(brief, products, FULL)!.proposal_id).toBe(first.proposal_id);
    expect(sellerOptimizedProposalForBrief(brief.replace(', and front-load retargeting', ''), products, FULL)!.proposal_id)
      .not.toBe(first.proposal_id);
  });

  it('emits nothing without the declaration, a shared-budget proposal request, or two products', () => {
    expect(sellerOptimizedProposalForBrief(brief, products, NONE)).toBeUndefined();
    expect(sellerOptimizedProposalForBrief('Allocate a $100,000 performance budget across prospecting and retargeting.', products, FULL)).toBeUndefined();
    expect(sellerOptimizedProposalForBrief('Propose a shared budget.', products.slice(0, 1), FULL)).toBeUndefined();
  });
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

describe('training agent seller-optimized budgets', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
    await seedSharedProducts(server);
  });

  async function mediaBuyCount(): Promise<number> {
    const read = await callTool(server, 'get_media_buys', { account: ACCOUNT, brand: BRAND });
    return ((read.result.media_buys as unknown[] | undefined) ?? []).length;
  }

  it('declares exactly the enforced controls on 3.2 and none on 3.0', async () => {
    const current = await callTool(server, 'get_adcp_capabilities', {});
    expect((current.result.media_buy as { features: Record<string, unknown> }).features).toMatchObject({
      seller_optimized_budget: true,
      seller_optimized_package_budgets: true,
      seller_optimized_min_spend_targets: true,
      seller_optimized_package_pacing: true,
    });
    const legacy = await callTool(server, 'get_adcp_capabilities', {}, '3.0');
    const features = (legacy.result.media_buy as { features: Record<string, unknown> }).features;
    expect(Object.keys(features).filter(key => key.startsWith('seller_optimized'))).toEqual([]);
  });

  it('accepts a shared buy with declared package controls and echoes them', async () => {
    const created = await callTool(server, 'create_media_buy', sharedBuy({ pacing: 'even' }, [
      { budget: 70000, min_spend_target: 20000 },
      { budget: 60000, pacing: 'front_loaded' },
    ]));
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    expect(created.result).toMatchObject({ total_budget: 100000, pacing: 'even', budget_allocation: { mode: 'seller_optimized' } });
    expect(created.result.packages).toEqual([
      expect.objectContaining({ budget: 70000, min_spend_target: 20000 }),
      expect.objectContaining({ budget: 60000, pacing: 'front_loaded' }),
    ]);
  });

  it('rejects seller_optimized allocation on a served line that does not declare it', async () => {
    const before = await mediaBuyCount();
    const created = await callTool(server, 'create_media_buy', sharedBuy(), '3.0');
    expect(created.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'budget_allocation.mode' });
    expect(await mediaBuyCount()).toBe(before);
  });

  it('rejects a mixed-currency shared buy with TERMS_REJECTED before mutation', async () => {
    const before = await mediaBuyCount();
    const created = await callTool(server, 'create_media_buy', sharedBuy({}, [
      {},
      { pricing_option_id: 'so_retargeting_cpm_eur' },
    ]));
    expect(created.error).toMatchObject({ code: 'TERMS_REJECTED', field: 'packages[1].pricing_option_id' });
    expect(await mediaBuyCount()).toBe(before);
  });

  it('keeps INVALID_REQUEST for a currency mismatch on a fixed buy', async () => {
    const created = await callTool(server, 'create_media_buy', sharedBuy(
      { budget_allocation: { mode: 'fixed' }, total_budget: { amount: 2000, currency: 'USD' } },
      [{ budget: 1000, bid_price: 2 }, { pricing_option_id: 'so_retargeting_cpm_eur', budget: 1000, bid_price: 2 }],
    ));
    expect(created.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'packages[1].pricing_option_id' });
  });

  it('rejects a minimum above its own package budget and minimums above the total', async () => {
    const before = await mediaBuyCount();
    const overCap = await callTool(server, 'create_media_buy', sharedBuy({}, [{ budget: 70000, min_spend_target: 80000 }, {}]));
    expect(overCap.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'packages[0].min_spend_target' });
    const overTotal = await callTool(server, 'create_media_buy', sharedBuy({}, [{ min_spend_target: 60000 }, { min_spend_target: 50000 }]));
    expect(overTotal.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'total_budget' });
    expect(await mediaBuyCount()).toBe(before);
  });

  it('applies the same checks to the buy an update would leave in effect', async () => {
    const created = await callTool(server, 'create_media_buy', sharedBuy({}, [{ min_spend_target: 20000 }, {}]));
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    const mediaBuyId = created.result.media_buy_id as string;
    const packages = created.result.packages as Array<{ package_id: string }>;

    const overCap = await callTool(server, 'update_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      packages: [{ package_id: packages[0].package_id, budget: 10000 }],
    });
    expect(overCap.error).toMatchObject({ code: 'INVALID_REQUEST', field: `packages[${packages[0].package_id}].min_spend_target` });

    const overTotal = await callTool(server, 'update_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      packages: [{ package_id: packages[1].package_id, min_spend_target: 90000 }],
    });
    expect(overTotal.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'total_budget' });

    const read = await callTool(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [mediaBuyId] });
    const buy = (read.result.media_buys as Array<{ revision: number; packages: Array<{ min_spend_target?: number }> }>)[0];
    expect(buy.revision).toBe(1);
    expect(buy.packages.map(pkg => pkg.min_spend_target)).toEqual([20000, undefined]);
  });

  it('answers a shared-budget brief with a seller-optimized proposal that finalizes and executes', async () => {
    const brief = 'Propose a $100,000 shared display budget across prospecting and retargeting, optimize allocation for clicks, pace the buy evenly, and front-load retargeting.';
    const offered = await callTool(server, 'get_products', { buying_mode: 'brief', brief, account: ACCOUNT });
    expect(offered.error, JSON.stringify(offered.result)).toBeUndefined();
    const proposals = offered.result.proposals as Array<Record<string, unknown>>;
    expect(proposals[0]).toMatchObject({ budget_allocation: { mode: 'seller_optimized' }, pacing: 'even' });
    const proposalId = proposals[0].proposal_id as string;

    const finalized = await callTool(server, 'get_products', {
      buying_mode: 'refine',
      account: ACCOUNT,
      refine: [{ scope: 'proposal', proposal_id: proposalId, action: 'finalize' }],
    });
    expect(finalized.error, JSON.stringify(finalized.result)).toBeUndefined();
    expect((finalized.result.proposals as Array<Record<string, unknown>>)[0]).toMatchObject({
      proposal_id: proposalId,
      proposal_status: 'committed',
    });

    const created = await callTool(server, 'create_media_buy', {
      account: ACCOUNT,
      brand: BRAND,
      ...FLIGHT,
      proposal_id: proposalId,
      total_budget: { amount: 100000, currency: 'USD' },
    });
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    expect(created.result).toMatchObject({ pacing: 'even', budget_allocation: { mode: 'seller_optimized' } });
    expect((created.result.packages as Array<Record<string, unknown>>).map(pkg => pkg.pacing)).toEqual([undefined, 'front_loaded']);
  });
  it('rejects adding a package priced outside the media-buy currency to a shared buy', async () => {
    const created = await callTool(server, 'create_media_buy', sharedBuy());
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    const added = await callTool(server, 'update_media_buy', {
      account: ACCOUNT,
      media_buy_id: created.result.media_buy_id,
      new_packages: [{ product_id: 'so_retargeting', pricing_option_id: 'so_retargeting_cpm_eur', budget: 1000 }],
    });
    expect(added.error).toMatchObject({ code: 'TERMS_REJECTED', field: 'new_packages[0].pricing_option_id' });
  });

  it('keeps registry proposals in the refine view after a shared-budget brief', async () => {
    const brief = 'Propose a $100,000 shared display budget across prospecting and retargeting, optimize allocation for clicks.';
    const offered = await callTool(server, 'get_products', { buying_mode: 'brief', brief, account: ACCOUNT });
    const sharedId = (offered.result.proposals as Array<{ proposal_id: string }>)[0].proposal_id;
    const refined = await callTool(server, 'get_products', {
      buying_mode: 'refine',
      account: ACCOUNT,
      refine: [{ scope: 'request', ask: 'Show everything.' }],
    });
    const ids = (refined.result.proposals as Array<{ proposal_id: string }> | undefined ?? []).map(proposal => proposal.proposal_id);
    expect(ids).toContain(sharedId);
    expect(ids.length).toBeGreaterThan(1);
  });

  it('rejects executing a committed seller-optimized proposal with a contradicting allocation', async () => {
    const brief = 'Propose a $100,000 shared display budget across prospecting and retargeting, optimize allocation for clicks.';
    const offered = await callTool(server, 'get_products', { buying_mode: 'brief', brief, account: ACCOUNT });
    const proposalId = (offered.result.proposals as Array<{ proposal_id: string }>)[0].proposal_id;
    await callTool(server, 'get_products', {
      buying_mode: 'refine',
      account: ACCOUNT,
      refine: [{ scope: 'proposal', proposal_id: proposalId, action: 'finalize' }],
    });
    const created = await callTool(server, 'create_media_buy', {
      account: ACCOUNT,
      brand: BRAND,
      ...FLIGHT,
      proposal_id: proposalId,
      total_budget: { amount: 100000, currency: 'USD' },
      budget_allocation: { mode: 'fixed' },
    });
    expect(created.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'budget_allocation' });
  });
});
