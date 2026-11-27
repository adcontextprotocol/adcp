/**
 * A presented `governance_context`, and its match with `plan_id`, is verified
 * before plan access is resolved (adcp#9075, specification.mdx
 * "Governance-agent obligations"; error-code.json PERMISSION_DENIED). A
 * context this agent did not issue, or one issued for another plan, is
 * PERMISSION_DENIED whether or not plan_id exists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/training-agent/task-handlers.js';
import { handleCheckGovernance, handleSyncPlans } from '../../src/training-agent/governance-handlers.js';
import { clearSessions, runWithSessionContext } from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const OWNER = 'https://owner.example';
const SELLER = 'https://seller.example';
const OWNER_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: OWNER };
const SELLER_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: SELLER };
const PLAN = {
  plan_id: 'plan-context-a',
  brand: { domain: 'context-verification.example' },
  objectives: 'Verify governance_context before plan access.',
  budget: { total: 100_000, currency: 'USD', reallocation_threshold: 100_000 },
  flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
};
const OTHER_PLAN = { ...PLAN, plan_id: 'plan-context-b' };
// Opaque to the caller; any string this agent never issued.
const FABRICATED_CONTEXT = 'gc_fabricated_never_issued_by_this_agent';

type Result = Record<string, any>;

async function approvedIntentContext(): Promise<string> {
  const synced = await handleSyncPlans({ plans: [PLAN, OTHER_PLAN] }, OWNER_CTX) as Result;
  expect(synced.errors).toBeUndefined();
  const intent = await handleCheckGovernance({
    plan_id: PLAN.plan_id,
    caller: OWNER,
    target_agent: SELLER,
    tool: 'create_media_buy',
    payload: { total_budget: { amount: 10_000, currency: 'USD' } },
  }, OWNER_CTX) as Result;
  expect(intent.verdict, JSON.stringify(intent)).toBe('approved');
  return intent.governance_context;
}

function executionCheck(governanceContext: string, planId?: string): Promise<Result> {
  return handleCheckGovernance({
    ...(planId !== undefined && { plan_id: planId }),
    caller: SELLER,
    governance_context: governanceContext,
    phase: 'purchase',
    planned_delivery: { media_buy_id: 'mb_context', total_budget: 10_000, currency: 'USD' },
  }, SELLER_CTX) as Promise<Result>;
}

describe('check_governance governance_context verification', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it.each([
    ['an existing plan_id', PLAN.plan_id],
    ['a plan_id that does not exist', 'plan-does-not-exist'],
    ['no plan_id', undefined],
  ])('returns PERMISSION_DENIED for a context it did not issue, with %s', async (_label, planId) => {
    await runWithSessionContext(async () => {
      await approvedIntentContext();
      const result = await executionCheck(FABRICATED_CONTEXT, planId);
      expect(result.errors?.[0]?.code, JSON.stringify(result)).toBe('PERMISSION_DENIED');
      expect(result.verdict).toBeUndefined();
    });
  });

  it.each([
    ['another existing plan', OTHER_PLAN.plan_id],
    ['a plan_id that does not exist', 'plan-does-not-exist'],
  ])('returns PERMISSION_DENIED for a context issued for a different plan than %s', async (_label, planId) => {
    await runWithSessionContext(async () => {
      const context = await approvedIntentContext();
      const result = await executionCheck(context, planId);
      expect(result.errors?.[0]?.code, JSON.stringify(result)).toBe('PERMISSION_DENIED');
    });
  });

  it('still accepts the context with its own plan_id', async () => {
    await runWithSessionContext(async () => {
      const context = await approvedIntentContext();
      const result = await executionCheck(context, PLAN.plan_id);
      expect(result.verdict, JSON.stringify(result)).toBe('approved');
    });
  });

  it('keeps an intent check that carries a context a malformed request', async () => {
    await runWithSessionContext(async () => {
      await approvedIntentContext();
      const result = await handleCheckGovernance({
        plan_id: PLAN.plan_id,
        caller: OWNER,
        target_agent: SELLER,
        tool: 'create_media_buy',
        payload: { total_budget: { amount: 10_000, currency: 'USD' } },
        governance_context: FABRICATED_CONTEXT,
      }, OWNER_CTX) as Result;
      expect(result.errors?.[0]?.code, JSON.stringify(result)).toBe('VALIDATION_ERROR');
    });
  });
});
