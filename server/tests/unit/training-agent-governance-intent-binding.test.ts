import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
// Initialize the aggregate tool catalog before importing a leaf handler. The
// training-agent modules intentionally have a catalog/tenant dependency cycle;
// production enters through task-handlers in the same order.
import '../../src/training-agent/task-handlers.js';
import {
  handleCheckGovernance,
  handleSyncPlans,
} from '../../src/training-agent/governance-handlers.js';
import { clearSessions, runWithSessionContext } from '../../src/training-agent/state.js';
import { resetGovernanceSigning } from '../../src/training-agent/governance-signing.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const CTX: TrainingContext = { mode: 'open' };
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
  return handleCheckGovernance({
    plan_id: PLAN.plan_id,
    brand: PLAN.brand,
    caller: 'https://buyer.example',
    ...args,
  }, CTX) as Promise<Record<string, any>>;
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

  afterEach(() => clearSessions());

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
  });

  it('emits an intent token for update_media_buy proposals with an existing buy ID', async () => {
    const payload = await withPlan(async () => claims(await check({
      tool: 'update_media_buy',
      phase: 'modification',
      payload: {
        media_buy_id: 'mb_existing',
        target_seller: 'https://seller.example',
        total_budget: { amount: 1_500, currency: 'USD' },
      },
    })));

    expect(payload.phase).toBe('intent');
    expect(payload).not.toHaveProperty('media_buy_id');
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

  it.each(['purchase', 'modification', 'delivery'] as const)(
    'emits an execution token for governance_context + planned_delivery (%s)',
    async (phase) => {
      const payload = await withPlan(async () => {
        const intent = await check({
          tool: 'create_media_buy',
          payload: {
            target_seller: 'https://seller.example',
            total_budget: { amount: 1_000, currency: 'USD' },
          },
        });
        return claims(await check({
          caller: 'https://seller.example',
          governance_context: intent.governance_context,
          phase,
          planned_delivery: {
            media_buy_id: 'mb_execution',
            total_budget: 1_000,
          },
        }));
      });

      expect(payload.phase).toBe(phase);
      expect(payload.media_buy_id).toBe('mb_execution');
    },
  );

  it('treats planned_delivery alone as an execution check with the default purchase phase', async () => {
    const payload = await withPlan(async () => claims(await check({
      planned_delivery: {
        media_buy_id: 'mb_without_prior_context',
        total_budget: 1_000,
      },
    })));

    expect(payload.phase).toBe('purchase');
    expect(payload.media_buy_id).toBe('mb_without_prior_context');
  });
});
