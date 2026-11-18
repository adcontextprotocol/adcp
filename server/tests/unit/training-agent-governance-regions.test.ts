/**
 * Plan `regions` as geo enforcement (adcp#9075, specification.mdx "Policy
 * resolution"). An action with no geography, or with country-level geography
 * only, targets the whole country and is outside a regions-restricted plan, as
 * is a region the plan does not list: an intent check returns `conditions`
 * naming the region constraint, and an execution check returns `denied`.
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
  plan_id: 'plan-regions',
  brand: { domain: 'regions.example' },
  objectives: 'A campaign limited to Massachusetts.',
  budget: { total: 100_000, currency: 'USD', reallocation_threshold: 100_000 },
  flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
  countries: ['US'],
  regions: ['US-MA'],
};

type Result = Record<string, any>;

async function sync(extra: Record<string, unknown> = {}) {
  const result = await handleSyncPlans({ plans: [{ ...PLAN, ...extra }] }, OWNER_CTX) as Result;
  expect(result.errors).toBeUndefined();
}

function intent(payload: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Result> {
  return handleCheckGovernance({
    plan_id: PLAN.plan_id,
    caller: OWNER,
    target_agent: SELLER,
    tool: 'create_media_buy',
    payload: payload.packages ? payload : { total_budget: { amount: 10_000, currency: 'USD' }, ...payload },
    ...extra,
  }, OWNER_CTX) as Promise<Result>;
}

function purchase(governanceContext: string, geo?: Record<string, unknown>): Promise<Result> {
  return handleCheckGovernance({
    caller: SELLER,
    governance_context: governanceContext,
    phase: 'purchase',
    planned_delivery: {
      media_buy_id: 'mb_regions',
      total_budget: 10_000,
      currency: 'USD',
      ...(geo && { geo }),
    },
  }, SELLER_CTX) as Promise<Result>;
}

function expectRegionConditions(result: Result, field: string, reason: string) {
  expect(result.errors, JSON.stringify(result)).toBeUndefined();
  expect(result.verdict).toBe('conditions');
  expect(result.governance_context).toBeUndefined();
  expect(result.conditions).toEqual([
    expect.objectContaining({ field, reason: expect.stringContaining(reason) }),
  ]);
  expect(result.findings).toContainEqual(expect.objectContaining({ category_id: 'geo_compliance' }));
}

describe('check_governance plan regions', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('returns conditions for an intent with no geography', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const result = await intent({});
      expectRegionConditions(result, 'payload.geo.regions', 'targets the whole country');
      expect(result.conditions[0].required_value).toEqual(['US-MA']);
    });
  });

  it('returns conditions for an intent with country-level geography only', async () => {
    await runWithSessionContext(async () => {
      await sync();
      expectRegionConditions(
        await intent({ geo: { countries: ['US'] } }),
        'payload.geo.regions',
        'targets the whole country',
      );
    });
  });

  it('returns conditions for an intent that names a region outside the plan', async () => {
    await runWithSessionContext(async () => {
      await sync();
      expectRegionConditions(
        await intent({ geo: { countries: ['US'], regions: ['US-NY'] } }),
        'payload.geo.regions',
        'US-NY',
      );
    });
  });

  it('approves an intent that targets only the plan regions', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const result = await intent({ geo: { countries: ['US'], regions: ['US-MA'] } });
      expect(result.verdict, JSON.stringify(result)).toBe('approved');
    });
  });

  it('conditions only the package that delivers country-wide', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const result = await intent({
        packages: [
          { budget: 5_000, targeting_overlay: { geo_countries: ['US'], geo_regions: ['US-MA'] } },
          { budget: 5_000, targeting_overlay: { geo_countries: ['US'] } },
        ],
      });
      expectRegionConditions(result, 'payload.packages.1.targeting_overlay.geo_regions', 'targets the whole country');
    });
  });

  it('does not require regions on a modification that leaves geography unchanged', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const result = await handleCheckGovernance({
        plan_id: PLAN.plan_id,
        caller: OWNER,
        target_agent: SELLER,
        tool: 'update_media_buy',
        payload: { media_buy_id: 'mb_regions', end_time: '2027-06-30T23:59:59Z' },
        proposed_commitment: { amount: 0, currency: 'USD' },
      }, OWNER_CTX) as Result;
      expect(result.verdict, JSON.stringify(result)).toBe('approved');
    });
  });

  it('leaves a plan without regions at country-level enforcement', async () => {
    await runWithSessionContext(async () => {
      await sync({ regions: undefined });
      const result = await intent({ geo: { countries: ['US'] } });
      expect(result.verdict, JSON.stringify(result)).toBe('approved');
    });
  });

  it('denies an execution check whose planned delivery is country-level only', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const approved = await intent({ geo: { countries: ['US'], regions: ['US-MA'] } });
      expect(approved.verdict, JSON.stringify(approved)).toBe('approved');
      const result = await purchase(approved.governance_context, { countries: ['US'] });
      expect(result.verdict, JSON.stringify(result)).toBe('denied');
      expect(result.findings).toContainEqual(expect.objectContaining({
        category_id: 'geo_compliance',
        severity: 'critical',
        explanation: expect.stringContaining('country-wide'),
      }));
    });
  });

  it('denies an execution check whose planned delivery names a region outside the plan', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const approved = await intent({ geo: { countries: ['US'], regions: ['US-MA'] } });
      const result = await purchase(approved.governance_context, { countries: ['US'], regions: ['US-MA', 'US-NY'] });
      expect(result.verdict, JSON.stringify(result)).toBe('denied');
      expect(result.findings).toContainEqual(expect.objectContaining({
        category_id: 'geo_compliance',
        severity: 'critical',
        explanation: expect.stringContaining('US-NY'),
      }));
    });
  });

  it('approves a modification execution check that leaves geography unchanged, but not one that names an outside region', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const update = () => handleCheckGovernance({
        plan_id: PLAN.plan_id,
        caller: OWNER,
        target_agent: SELLER,
        tool: 'update_media_buy',
        payload: { media_buy_id: 'mb_regions', end_time: '2027-06-30T23:59:59Z' },
        proposed_commitment: { amount: 0, currency: 'USD' },
      }, OWNER_CTX) as Promise<Result>;
      const modification = (governanceContext: string, geo?: Record<string, unknown>) => handleCheckGovernance({
        caller: SELLER,
        governance_context: governanceContext,
        phase: 'modification',
        execution_commitment: { amount: 0, currency: 'USD' },
        planned_delivery: {
          media_buy_id: 'mb_regions',
          end_time: '2027-06-30T23:59:59Z',
          currency: 'USD',
          ...(geo && { geo }),
        },
      }, SELLER_CTX) as Promise<Result>;

      const unchanged = await update();
      expect(unchanged.verdict, JSON.stringify(unchanged)).toBe('approved');
      const unchangedExecution = await modification(unchanged.governance_context);
      expect(unchangedExecution.verdict, JSON.stringify(unchangedExecution)).toBe('approved');

      const widened = await update();
      const widenedExecution = await modification(widened.governance_context, { regions: ['US-NY'] });
      expect(widenedExecution.verdict, JSON.stringify(widenedExecution)).toBe('denied');
      expect(widenedExecution.findings).toContainEqual(expect.objectContaining({
        category_id: 'geo_compliance',
        severity: 'critical',
        explanation: expect.stringContaining('US-NY'),
      }));
    });
  });

  it('approves an execution check that delivers inside the plan regions', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const approved = await intent({ geo: { countries: ['US'], regions: ['US-MA'] } });
      const result = await purchase(approved.governance_context, { countries: ['US'], regions: ['US-MA'] });
      expect(result.verdict, JSON.stringify(result)).toBe('approved');
    });
  });
});
