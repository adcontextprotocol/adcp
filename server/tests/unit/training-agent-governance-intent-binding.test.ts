import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from 'jose';
// Initialize the aggregate tool catalog before importing a leaf handler. The
// training-agent modules intentionally have a catalog/tenant dependency cycle;
// production enters through task-handlers in the same order.
import { handleUpdateMediaBuy } from '../../src/training-agent/task-handlers.js';
import {
  handleCheckGovernance,
  handleSyncPlans,
} from '../../src/training-agent/governance-handlers.js';
import {
  clearSessions,
  flushDirtySessions,
  getSession,
  runWithSessionContext,
} from '../../src/training-agent/state.js';
import { resetGovernanceSigning } from '../../src/training-agent/governance-signing.js';
import { computeDeliveryStatementDigest } from '../../src/training-agent/governance-payload-hash.js';
import { getCanonicalBase } from '../../src/training-agent/tenants/registry.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: 'https://buyer.example' };
const PLAN = {
  plan_id: 'plan-intent-binding',
  brand: { domain: 'intent-binding.example' },
  objectives: 'Verify governance request-shape binding.',
  budget: { total: 100_000, currency: 'USD', reallocation_threshold: 100_000 },
  flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
};

async function syncPlan() {
  const result = await handleSyncPlans({ plans: [PLAN] }, CTX) as Record<string, any>;
  expect(result.errors, JSON.stringify(result)).toBeUndefined();
}

async function withPlan<T>(fn: () => Promise<T>): Promise<T> {
  return runWithSessionContext(async () => {
    await syncPlan();
    return fn();
  });
}

async function check(args: Record<string, unknown>) {
  const caller = typeof args.caller === 'string' ? args.caller : 'https://buyer.example';
  const rawPayload = args.payload as Record<string, unknown> | undefined;
  const { target_seller: legacyTarget, ...payload } = rawPayload ?? {};
  const executionCtx = args.governance_context
    ? { ...CTX, authenticatedAgentUrl: caller }
    : CTX;
  return handleCheckGovernance({
    plan_id: PLAN.plan_id,
    brand: PLAN.brand,
    caller: 'https://buyer.example',
    ...args,
    ...(rawPayload ? {
      target_agent: args.target_agent ?? legacyTarget,
      payload,
    } : {}),
  }, executionCtx) as Promise<Record<string, any>>;
}

function claims(result: Record<string, any>) {
  expect(result.status, JSON.stringify(result)).toBe('approved');
  expect(result.governance_context).toEqual(expect.any(String));
  return decodeJwt(result.governance_context as string);
}

describe('check_governance request-shape binding', () => {
  beforeEach(() => {
    clearSessions();
    resetGovernanceSigning();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSessions();
  });

  it('emits an intent token for create_media_buy proposals', async () => {
    const payload = await withPlan(async () => claims(await check({
      tool: 'create_media_buy',
      phase: 'purchase',
      payload: {
        media_buy_id: 'mb_must_not_bind',
        target_seller: 'https://seller.example',
        total_budget: { amount: 1_000, currency: 'USD' },
      },
    })));

    expect(payload.phase).toBe('intent');
    expect(payload).not.toHaveProperty('media_buy_id');
    expect(payload.authorized_commitment).toEqual({ amount: 1_000, currency: 'USD' });
    expect(payload.authorized_task).toBe('create_media_buy');
    expect(payload.authorized_payload_hash).toEqual(expect.any(String));
  });

  it('emits an intent token for update_media_buy proposals with an existing buy ID', async () => {
    const payload = await withPlan(async () => claims(await check({
        tool: 'update_media_buy',
        phase: 'modification',
        proposed_commitment: { amount: 500, currency: 'USD' },
        payload: {
          media_buy_id: 'mb_existing',
          revision: 1,
          target_seller: `${getCanonicalBase()}/sales`,
          packages: [{ package_id: 'pkg_existing', budget: 1_500 }],
        },
      })));

    expect(payload.phase).toBe('intent');
    expect(payload).not.toHaveProperty('media_buy_id');
    expect(payload.authorized_commitment).toEqual({ amount: 500, currency: 'USD' });
    expect(payload.authorized_task).toBe('update_media_buy');
    expect(payload.authorized_payload_hash).toEqual(expect.any(String));
  });

  it('carries only the positive update delta through the execution check', async () => {
    const result = await withPlan(async () => {
      const intent = await check({
        tool: 'update_media_buy',
        proposed_commitment: { amount: 300, currency: 'USD' },
        payload: {
          media_buy_id: 'mb_delta',
          revision: 3,
          target_seller: 'https://seller.example',
          packages: [{ package_id: 'pkg_delta', budget: 1_300 }],
        },
      });
      const execution = await check({
        plan_id: undefined,
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'modification',
        execution_commitment: { amount: 300, currency: 'USD' },
        planned_delivery: {
          media_buy_id: 'mb_delta',
          total_budget: 1_300,
          currency: 'USD',
        },
      });
      return { intent: claims(intent), execution: claims(execution) };
    });

    expect(result.intent.authorized_commitment).toEqual({ amount: 300, currency: 'USD' });
    expect(result.execution.authorized_commitment).toEqual({ amount: 300, currency: 'USD' });
  });

  it('rejects a seller-computed update delta above the buyer intent ceiling', async () => {
    const result = await withPlan(async () => {
      const intent = await check({
        tool: 'update_media_buy',
        proposed_commitment: { amount: 300, currency: 'USD' },
        payload: {
          media_buy_id: 'mb_delta',
          revision: 3,
          target_seller: 'https://seller.example',
          packages: [{ package_id: 'pkg_delta', budget: 1_300 }],
        },
      });
      return check({
        plan_id: undefined,
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'modification',
        execution_commitment: { amount: 301, currency: 'USD' },
        planned_delivery: {
          media_buy_id: 'mb_delta',
          total_budget: 1_301,
          currency: 'USD',
        },
      });
    });

    expect(result.verdict).toBe('denied');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category_id: 'budget_authority', severity: 'critical' }),
    ]));
  });

  it('makes the training seller compute and enforce the update delta before mutation', async () => {
    await withPlan(async () => {
      const session = await getSession('open:intent-binding.example');
      session.mediaBuys.set('mb_seller_delta', {
        mediaBuyId: 'mb_seller_delta',
        accountRef: { brand: { domain: 'intent-binding.example' } },
        status: 'active',
        currency: 'USD',
        packages: [{
          packageId: 'pkg_delta',
          productId: 'display_standard',
          pricingOptionId: 'cpm_standard',
          budget: 1_000,
          paused: false,
          startTime: '2027-01-01T00:00:00Z',
          endTime: '2027-12-31T23:59:59Z',
          creativeAssignments: [],
        }],
        startTime: '2027-01-01T00:00:00Z',
        endTime: '2027-12-31T23:59:59Z',
        revision: 3,
        confirmedAt: '2027-01-01T00:00:00Z',
        createdAt: '2027-01-01T00:00:00Z',
        updatedAt: '2027-01-01T00:00:00Z',
        history: [],
      });
      await flushDirtySessions();
      const intent = await check({
        tool: 'update_media_buy',
        proposed_commitment: { amount: 300, currency: 'USD' },
        payload: {
          account: { brand: { domain: 'intent-binding.example' } },
          media_buy_id: 'mb_seller_delta',
          revision: 3,
          target_seller: `${getCanonicalBase()}/sales`,
          packages: [{ package_id: 'pkg_delta', budget: 1_400 }],
        },
      });

      const result = await handleUpdateMediaBuy({
        account: { brand: { domain: 'intent-binding.example' } },
        media_buy_id: 'mb_seller_delta',
        revision: 3,
        governance_context: intent.governance_context,
        packages: [{ package_id: 'pkg_delta', budget: 1_400 }],
      }, CTX) as Record<string, any>;

      expect(result.errors?.[0]?.code).toBe('PERMISSION_DENIED');
      const deniedSession = await getSession('open:intent-binding.example');
      expect(deniedSession.mediaBuys.get('mb_seller_delta')?.revision).toBe(3);
      expect(deniedSession.mediaBuys.get('mb_seller_delta')?.packages[0]?.budget).toBe(1_000);

      const wrongAudienceIntent = await check({
        tool: 'update_media_buy',
        proposed_commitment: { amount: 1_000, currency: 'USD' },
        payload: {
          account: { brand: { domain: 'intent-binding.example' } },
          media_buy_id: 'mb_seller_delta',
          revision: 3,
          target_seller: 'https://other-seller.example',
          packages: [{ package_id: 'pkg_delta', budget: 1_400 }],
        },
      });
      const wrongAudience = await handleUpdateMediaBuy({
        account: { brand: { domain: 'intent-binding.example' } },
        media_buy_id: 'mb_seller_delta',
        revision: 3,
        governance_context: wrongAudienceIntent.governance_context,
        packages: [{ package_id: 'pkg_delta', budget: 1_400 }],
      }, CTX) as Record<string, any>;
      expect(wrongAudience.errors?.[0]?.message).toContain('audience');

      const negativeOffset = await handleUpdateMediaBuy({
        account: { brand: { domain: 'intent-binding.example' } },
        media_buy_id: 'mb_seller_delta',
        revision: 3,
        packages: [{ package_id: 'pkg_delta', budget: 1_400 }],
        new_packages: [{ product_id: 'display_standard', pricing_option_id: 'cpm_standard', budget: -400 }],
      }, CTX) as Record<string, any>;
      expect(negativeOffset.errors?.[0]?.code).toBe('VALIDATION_ERROR');

      const packageResume = await handleUpdateMediaBuy({
        account: { brand: { domain: 'intent-binding.example' } },
        media_buy_id: 'mb_seller_delta',
        revision: 3,
        packages: [{ package_id: 'pkg_delta', paused: false }],
      }, CTX) as Record<string, any>;
      expect(packageResume.errors?.[0]?.code).toBe('GOVERNANCE_DENIED');

      const zeroBudgetAddition = await handleUpdateMediaBuy({
        account: { brand: { domain: 'intent-binding.example' } },
        media_buy_id: 'mb_seller_delta',
        revision: 3,
        new_packages: [{ product_id: 'display_standard', pricing_option_id: 'cpm_standard', budget: 0 }],
      }, CTX) as Record<string, any>;
      expect(zeroBudgetAddition.errors?.[0]?.code).toBe('GOVERNANCE_DENIED');
      const finalSession = await getSession('open:intent-binding.example');
      expect(finalSession.mediaBuys.get('mb_seller_delta')?.revision).toBe(3);
    });
  });

  it('preserves a seller-optimized shared total when package caps change', async () => {
    await withPlan(async () => {
      const session = await getSession('open:intent-binding.example');
      session.mediaBuys.set('mb_shared_budget', {
        mediaBuyId: 'mb_shared_budget',
        accountRef: { brand: { domain: 'intent-binding.example' } },
        status: 'active',
        currency: 'USD',
        totalBudget: 1_000,
        budgetAllocation: {
          mode: 'seller_optimized',
          optimization_goals: [{ metric: 'impressions' }],
        },
        aggregatePacing: 'even',
        packages: [
          {
            packageId: 'pkg_shared_a',
            productId: 'display_standard',
            pricingOptionId: 'cpm_standard',
            budget: 800,
            paused: false,
            startTime: '2027-01-01T00:00:00Z',
            endTime: '2027-12-31T23:59:59Z',
            creativeAssignments: [],
          },
          {
            packageId: 'pkg_shared_b',
            productId: 'display_standard',
            pricingOptionId: 'cpm_standard',
            budget: 800,
            paused: false,
            startTime: '2027-01-01T00:00:00Z',
            endTime: '2027-12-31T23:59:59Z',
            creativeAssignments: [],
          },
        ],
        startTime: '2027-01-01T00:00:00Z',
        endTime: '2027-12-31T23:59:59Z',
        revision: 1,
        confirmedAt: '2027-01-01T00:00:00Z',
        createdAt: '2027-01-01T00:00:00Z',
        updatedAt: '2027-01-01T00:00:00Z',
        history: [],
      });
      await flushDirtySessions();
      const businessPayload = {
        account: { brand: { domain: 'intent-binding.example' } },
        media_buy_id: 'mb_shared_budget',
        revision: 1,
        packages: [{ package_id: 'pkg_shared_a', budget: 900 }],
      };
      const withoutContext = await handleUpdateMediaBuy(businessPayload, CTX) as Record<string, any>;
      expect(withoutContext.errors?.[0]?.code).toBe('GOVERNANCE_DENIED');
      const rejectedSession = await getSession('open:intent-binding.example');
      expect(rejectedSession.mediaBuys.get('mb_shared_budget')?.revision).toBe(1);

      const intent = await check({
        tool: 'update_media_buy',
        target_agent: `${getCanonicalBase()}/sales`,
        proposed_commitment: { amount: 0, currency: 'USD' },
        payload: businessPayload,
      });

      const result = await handleUpdateMediaBuy({
        ...businessPayload,
        governance_context: intent.governance_context,
      }, CTX) as Record<string, any>;

      expect(result.errors, JSON.stringify(result)).toBeUndefined();
      expect(result.total_budget).toBe(1_000);
      const updatedSession = await getSession('open:intent-binding.example');
      expect(updatedSession.mediaBuys.get('mb_shared_budget')?.totalBudget).toBe(1_000);
      expect(updatedSession.mediaBuys.get('mb_shared_budget')?.packages.map(pkg => pkg.budget)).toEqual([900, 800]);
    });
  });

  it.each([
    ['budget allocation', { budget_allocation: { mode: 'seller_optimized', optimization_goals: [{ metric: 'clicks' }] } }],
    ['aggregate pacing', { pacing: 'front_loaded' }],
    ['aggregate bidding', { bidding: { automatic: true } }],
  ])('requires governance for a changed top-level %s', async (_label, update) => {
    await withPlan(async () => {
      const session = await getSession('open:intent-binding.example');
      session.mediaBuys.set('mb_aggregate_controls', {
        mediaBuyId: 'mb_aggregate_controls',
        accountRef: { brand: { domain: 'intent-binding.example' } },
        status: 'active',
        currency: 'USD',
        totalBudget: 1_000,
        budgetAllocation: { mode: 'fixed' },
        aggregatePacing: 'even',
        packages: [{
          packageId: 'pkg_aggregate',
          productId: 'display_standard',
          pricingOptionId: 'cpm_standard',
          budget: 1_000,
          paused: false,
          startTime: '2027-01-01T00:00:00Z',
          endTime: '2027-12-31T23:59:59Z',
          creativeAssignments: [],
        }],
        startTime: '2027-01-01T00:00:00Z',
        endTime: '2027-12-31T23:59:59Z',
        revision: 1,
        confirmedAt: '2027-01-01T00:00:00Z',
        createdAt: '2027-01-01T00:00:00Z',
        updatedAt: '2027-01-01T00:00:00Z',
        history: [],
      });
      await flushDirtySessions();

      const result = await handleUpdateMediaBuy({
        account: { brand: { domain: 'intent-binding.example' } },
        media_buy_id: 'mb_aggregate_controls',
        revision: 1,
        ...update,
      }, CTX) as Record<string, any>;

      expect(result.errors?.[0]?.code).toBe('GOVERNANCE_DENIED');
      const rejectedSession = await getSession('open:intent-binding.example');
      expect(rejectedSession.mediaBuys.get('mb_aggregate_controls')?.revision).toBe(1);
    });
  });

  it('does not let a caller-supplied lifecycle phase override an intent-shaped request', async () => {
    const payload = await withPlan(async () => claims(await check({
      tool: 'create_media_buy',
      phase: 'delivery',
      payload: {
        media_buy_id: 'mb_caller_phase',
        target_seller: 'https://seller.example',
        total_budget: { amount: 1_000, currency: 'USD' },
      },
    })));

    expect(payload.phase).toBe('intent');
    expect(payload).not.toHaveProperty('media_buy_id');
  });

  it('returns intent conditions without an authorization context or expiry', async () => {
    const { result, approved } = await runWithSessionContext(async () => {
      await handleSyncPlans({
        plans: [{
          ...PLAN,
          plan_id: 'plan-with-condition',
          custom_policies: [{ policy_id: 'frequency', policy: 'Apply a frequency cap.', enforcement: 'must' }],
        }],
      }, CTX);
      const result = await handleCheckGovernance({
        plan_id: 'plan-with-condition',
        brand: PLAN.brand,
        caller: 'https://buyer.example',
        tool: 'create_media_buy',
        target_agent: 'https://seller.example', payload: { total_budget: { amount: 1_000, currency: 'USD' } },
      }, CTX) as Record<string, any>;
      const approved = await handleCheckGovernance({
        plan_id: 'plan-with-condition',
        brand: PLAN.brand,
        caller: 'https://buyer.example',
        tool: 'create_media_buy',
        consultation_context: result.consultation_context,
        target_agent: 'https://seller.example',
        payload: {
          total_budget: { amount: 1_000, currency: 'USD' },
          ext: { governance_policy_acknowledgements: ['frequency'] },
        },
      }, CTX) as Record<string, any>;
      return { result, approved };
    });

    expect(result.verdict).toBe('conditions');
    expect(result.conditions).toHaveLength(1);
    expect(result.consultation_context).toEqual(expect.any(String));
    expect(result).not.toHaveProperty('governance_context');
    expect(result).not.toHaveProperty('expires_at');

    expect(approved.verdict, JSON.stringify(approved)).toBe('approved');
    expect(approved.governance_context).toEqual(expect.any(String));
    expect(approved).not.toHaveProperty('consultation_context');
  });

  it('emits whole-request condition paths that can be applied before re-checking', async () => {
    const { conditioned, approved, adjustedRequest } = await runWithSessionContext(async () => {
      await handleSyncPlans({
        plans: [{
          ...PLAN,
          plan_id: 'plan-with-budget-condition',
          budget: { total: 1_000, currency: 'USD', reallocation_threshold: 1_000 },
        }],
      }, CTX);
      const session = await getSession('open:intent-binding.example');
      const plan = [...session.governancePlans.values()].find(candidate =>
        candidate.planId === 'plan-with-budget-condition');
      expect(plan).toBeDefined();
      plan!.committedBudget = 500;

      const request: Record<string, any> = {
        plan_id: 'plan-with-budget-condition',
        brand: PLAN.brand,
        caller: 'https://buyer.example',
        target_agent: 'https://seller.example',
        tool: 'create_media_buy',
        payload: { total_budget: { amount: 750, currency: 'USD' } },
      };
      const conditioned = await handleCheckGovernance(request, CTX) as Record<string, any>;
      expect(conditioned.conditions).toHaveLength(1);

      const adjustedRequest = structuredClone(request);
      const condition = conditioned.conditions[0] as { field: string; required_value: unknown };
      const segments = condition.field.split('.');
      let target = adjustedRequest;
      for (const segment of segments.slice(0, -1)) target = target[segment];
      target[segments.at(-1)!] = condition.required_value;
      adjustedRequest.consultation_context = conditioned.consultation_context;

      const approved = await handleCheckGovernance(adjustedRequest, CTX) as Record<string, any>;
      return { conditioned, approved, adjustedRequest };
    });

    expect(conditioned.conditions[0]).toMatchObject({
      field: 'payload.total_budget.amount',
      required_value: 500,
    });
    expect(adjustedRequest.payload.total_budget.amount).toBe(500);
    expect(approved.verdict, JSON.stringify(approved)).toBe('approved');
  });

  it('binds consultation_context to the principal, caller, tool, purchase type, and audience', async () => {
    const result = await runWithSessionContext(async () => {
      await handleSyncPlans({
        plans: [{
          ...PLAN,
          plan_id: 'plan-consult-binding',
          custom_policies: [{ policy_id: 'frequency', policy: 'Apply a frequency cap.', enforcement: 'must' }],
        }],
      }, CTX);
      const conditioned = await handleCheckGovernance({
        plan_id: 'plan-consult-binding',
        caller: 'https://buyer.example',
        tool: 'create_media_buy',
        target_agent: 'https://seller.example', payload: { total_budget: { amount: 1_000, currency: 'USD' } },
      }, { ...CTX, principal: 'buyer-principal' }) as Record<string, any>;

      return handleCheckGovernance({
        plan_id: 'plan-consult-binding',
        caller: 'https://buyer.example',
        tool: 'create_media_buy',
        consultation_context: conditioned.consultation_context,
        target_agent: 'https://other-seller.example',
        payload: {
          total_budget: { amount: 1_000, currency: 'USD' },
          ext: { governance_policy_acknowledgements: ['frequency'] },
        },
      }, { ...CTX, principal: 'buyer-principal' }) as Promise<Record<string, any>>;
    });

    expect(result.errors?.[0]?.code).toBe('VALIDATION_ERROR');
    expect(result.errors?.[0]?.message).toContain('target audience');
  });

  it('rejects an unknown consultation_context', async () => {
    const result = await withPlan(() => check({
      tool: 'create_media_buy',
      consultation_context: 'consult_unknown',
      target_agent: 'https://seller.example',
      payload: {
        total_budget: { amount: 1_000, currency: 'USD' },
      },
    }));

    expect(result.errors?.[0]?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a proposed_commitment that understates a numeric task payload', async () => {
    const result = await withPlan(() => check({
      tool: 'create_media_buy',
      proposed_commitment: { amount: 1, currency: 'USD' },
      target_agent: 'https://seller.example',
      payload: {
        total_budget: { amount: 1_000, currency: 'USD' },
      },
    }));

    expect(result.errors?.[0]?.message).toContain('must equal the numeric commitment');
  });

  it.each(['acquire_rights', 'update_rights', 'activate_signal', 'build_creative'])(
    'requires an explicit commitment for indirectly priced %s intents',
    async (tool) => {
      const result = await withPlan(() => check({
        tool,
        target_agent: 'https://seller.example',
        payload: { pricing_option_id: 'price_indirect' },
      }));

      expect(result.errors?.[0]?.code).toBe('VALIDATION_ERROR');
      expect(result.errors?.[0]?.message).toContain('proposed_commitment is required');
    },
  );

  it.each(['purchase', 'modification', 'delivery'] as const)(
    'emits an execution token for governance_context + planned_delivery (%s)',
    async (phase) => {
      const payload = await withPlan(async () => {
        const intent = await check({
          tool: 'create_media_buy',
          target_agent: 'https://seller.example',
          payload: {
            total_budget: { amount: 1_000, currency: 'USD' },
          },
        });
        const deliveryMetrics = {
          statement_id: 'stmt_mb_execution_0001',
          sequence: 1,
          issued_at: '2027-01-02T01:00:00Z',
          reporting_period: { start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' },
          cumulative_spend: 100,
          currency: 'USD',
        };
        return claims(await check({
          plan_id: undefined,
          caller: 'https://seller.example',
          governance_context: intent.governance_context,
          phase,
          planned_delivery: {
            media_buy_id: 'mb_execution',
            total_budget: 1_000,
            currency: 'USD',
          },
          ...(phase === 'delivery' && {
            delivery_metrics: {
              ...deliveryMetrics,
              statement_digest: computeDeliveryStatementDigest('mb_execution', deliveryMetrics),
            },
          }),
        }));
      });

      expect(payload.phase).toBe(phase);
      expect(payload.media_buy_id).toBe('mb_execution');
    },
  );

  it('allows purchase prepare before a durable media_buy_id exists', async () => {
    const payload = await withPlan(async () => {
      const intent = await check({
        tool: 'create_media_buy',
        target_agent: 'https://seller.example',
        payload: {
          total_budget: { amount: 1_000, currency: 'USD' },
        },
      });
      return claims(await check({
        plan_id: undefined,
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'purchase',
        planned_delivery: { total_budget: 1_000, currency: 'USD' },
      }));
    });

    expect(payload.phase).toBe('purchase');
    expect(payload).not.toHaveProperty('media_buy_id');
  });

  it('does not renew an expired intent context into a fresh execution token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    const result = await withPlan(async () => {
      const intent = await check({
        tool: 'create_media_buy',
        target_agent: 'https://seller.example',
        payload: { total_budget: { amount: 1_000, currency: 'USD' } },
      });
      vi.setSystemTime(new Date('2026-08-04T12:16:01Z'));
      return check({
        plan_id: undefined,
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'purchase',
        planned_delivery: { total_budget: 1_000, currency: 'USD' },
      });
    });

    expect(result.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    expect(result.governance_context).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'not-a-date'],
  ])('does not renew a context with %s expiry metadata', async (_label, expiresAt) => {
    const result = await withPlan(async () => {
      const intent = await check({
        tool: 'create_media_buy',
        target_agent: 'https://seller.example',
        payload: { total_budget: { amount: 1_000, currency: 'USD' } },
      });
      const session = await getSession('open:intent-binding.example');
      const stored = [...session.governanceChecks.values()]
        .find(item => item.governanceContext === intent.governance_context)!;
      if (expiresAt === undefined) delete stored.expiresAt;
      else stored.expiresAt = expiresAt;

      return check({
        plan_id: undefined,
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'purchase',
        planned_delivery: { total_budget: 1_000, currency: 'USD' },
      });
    });

    expect(result.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    expect(result.governance_context).toBeUndefined();
  });

  it('requires media_buy_id after the purchase phase', async () => {
    const result = await withPlan(async () => {
      const intent = await check({
        tool: 'create_media_buy',
        target_agent: 'https://seller.example',
        payload: {
          total_budget: { amount: 1_000, currency: 'USD' },
        },
      });
      return check({
        plan_id: undefined,
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'modification',
        planned_delivery: { total_budget: 1_000, currency: 'USD' },
      });
    });

    expect(result.errors?.[0]?.message).toContain('media_buy_id is required for modification');
  });

  it('rejects planned_delivery without an approved governance_context', async () => {
    const result = await withPlan(async () => check({
      planned_delivery: {
        media_buy_id: 'mb_without_prior_context',
        total_budget: 1_000,
      },
    }));

    expect(result).toEqual({
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'governance_context is required for execution governance checks',
      }],
    });
  });

  it('rejects a delivery check that cannot bind a seller-assigned media buy ID', async () => {
    const result = await withPlan(async () => {
      const intent = await check({
        tool: 'create_media_buy',
        target_agent: 'https://seller.example',
        payload: {
          total_budget: { amount: 1_000, currency: 'USD' },
        },
      });
      return check({
        plan_id: undefined,
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'delivery',
        planned_delivery: { total_budget: 1_000, currency: 'USD' },
      });
    });

    expect(result).toEqual({
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'planned_delivery.media_buy_id is required for delivery governance checks',
      }],
    });
    expect(result).not.toHaveProperty('governance_context');
  });

  it('rejects execution by an agent other than the intent token audience', async () => {
    const result = await withPlan(async () => {
      const intent = await check({
        tool: 'create_media_buy',
        target_agent: 'https://seller.example',
        payload: {
          total_budget: { amount: 1_000, currency: 'USD' },
        },
      });
      return handleCheckGovernance({
        caller: 'https://attacker.example',
        governance_context: intent.governance_context,
        phase: 'purchase',
        planned_delivery: { total_budget: 1_000, currency: 'USD' },
      }, { ...CTX, authenticatedAgentUrl: 'https://attacker.example' }) as Promise<Record<string, any>>;
    });

    expect(result.errors?.[0]?.code).toBe('PERMISSION_DENIED');
  });

  it.each([
    [{ total_budget: 1_001, currency: 'USD' }, 'intent-authorized commitment'],
    [{ total_budget: 1_000, currency: 'EUR' }, 'must match both intent currency'],
  ])('rejects execution that widens or changes the intent commitment: %o', async (plannedDelivery, message) => {
    const result = await withPlan(async () => {
      const intent = await check({
        tool: 'create_media_buy',
        target_agent: 'https://seller.example',
        payload: {
          total_budget: { amount: 1_000, currency: 'USD' },
        },
      });
      return check({
        plan_id: undefined,
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'purchase',
        planned_delivery: plannedDelivery,
      });
    });

    expect(result.verdict).toBe('denied');
    expect(result.findings.some((finding: any) => finding.explanation.includes(message))).toBe(true);
  });

  it.each([-1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects malformed planned delivery budget %s',
    async (totalBudget) => {
      const result = await withPlan(async () => {
        const intent = await check({
          tool: 'create_media_buy',
          target_agent: 'https://seller.example',
          payload: {
            total_budget: { amount: 1_000, currency: 'USD' },
          },
        });
        return check({
          plan_id: undefined,
          caller: 'https://seller.example',
          governance_context: intent.governance_context,
          phase: 'purchase',
          planned_delivery: { total_budget: totalBudget, currency: 'USD' },
        });
      });

      expect(result.errors?.[0]?.code).toBe('VALIDATION_ERROR');
    },
  );
});
