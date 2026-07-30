import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Initialize the aggregate tool catalog before importing leaf handlers. The
// production entrypoint uses the same order for this intentional module cycle.
import '../../src/training-agent/task-handlers.js';
import {
  handleGetPlanAuditLogs,
  handleReportPlanOutcome,
  handleSyncPlans,
} from '../../src/training-agent/governance-handlers.js';
import { clearSessions, runWithSessionContext } from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const CTX: TrainingContext = { mode: 'open' };
const PLAN = {
  plan_id: 'plan-outcome-spend-invariant',
  brand: { domain: 'outcome-spend.example' },
  objectives: 'Verify outcome spend cannot roll back the budget ledger.',
  budget: { total: 100, currency: 'USD', reallocation_threshold: 100 },
  flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
};

async function syncPlan() {
  const result = await handleSyncPlans({ plans: [PLAN] }, CTX) as Record<string, any>;
  expect(result.errors, JSON.stringify(result)).toBeUndefined();
}

async function reportSpend(spend: number) {
  return handleReportPlanOutcome({
    plan_id: PLAN.plan_id,
    governance_context: 'test-governance-context',
    outcome: 'delivery',
    delivery: { spend },
  }, CTX) as Promise<Record<string, any>>;
}

async function reportCompleted(sellerResponse: Record<string, unknown>) {
  return handleReportPlanOutcome({
    plan_id: PLAN.plan_id,
    governance_context: 'test-governance-context',
    outcome: 'completed',
    seller_response: sellerResponse,
  }, CTX) as Promise<Record<string, any>>;
}

async function getAudit() {
  return handleGetPlanAuditLogs({
    brand: PLAN.brand,
    plan_ids: [PLAN.plan_id],
    include_entries: true,
  }, CTX) as Promise<Record<string, any>>;
}

function expectLedger(audit: Record<string, any>, committed: number, outcomes: number) {
  expect(audit.plans[0].budget).toMatchObject({
    authorized: 100,
    committed,
    remaining: 100 - committed,
  });
  expect(audit.plans[0].summary.outcomes_reported).toBe(outcomes);
  expect(audit.plans[0].entries).toHaveLength(outcomes);
}

describe('report_plan_outcome spend invariants', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('accepts zero and positive delivery spend', async () => {
    await runWithSessionContext(async () => {
      await syncPlan();

      const zero = await reportSpend(0);
      const positive = await reportSpend(25);
      const audit = await getAudit();

      expect(zero.status).toBe('accepted');
      expect(positive).toMatchObject({ status: 'accepted', committed_budget: 25 });
      expectLedger(audit, 25, 2);
    });
  });

  it.each([
    ['negative', -1],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('rejects %s delivery spend without mutating or auditing it', async (_label, spend) => {
    await runWithSessionContext(async () => {
      await syncPlan();
      expect((await reportSpend(25)).status).toBe('accepted');

      const rejected = await reportSpend(spend);
      const audit = await getAudit();

      expect(rejected).toEqual({
        errors: [{
          code: 'VALIDATION_ERROR',
          message: 'delivery.spend must be a finite, non-negative number',
        }],
      });
      expectLedger(audit, 25, 1);
      expect(audit.plans[0].entries[0]).toMatchObject({
        type: 'outcome',
        committed_budget: 25,
      });
    });
  });

  it.each([
    ['negative committed budget', { committed_budget: -1 }],
    ['infinite committed budget', { committed_budget: Number.POSITIVE_INFINITY }],
    ['NaN committed budget', { committed_budget: Number.NaN }],
    ['negative package budget', { packages: [{ budget: -1 }] }],
    ['infinite package budget', { packages: [{ budget: Number.POSITIVE_INFINITY }] }],
    ['negative legacy package total', { packages: [{ budget: { total: -1 } }] }],
    ['negative package budget alongside committed budget', { committed_budget: 10, packages: [{ budget: -1 }] }],
    ['infinite package budget alongside committed budget', { committed_budget: 10, packages: [{ budget: Number.POSITIVE_INFINITY }] }],
    ['package budget sum overflow', { packages: [{ budget: Number.MAX_VALUE }, { budget: Number.MAX_VALUE }] }],
    ['non-array package collection', { packages: 'not-an-array' }],
    ['null package entry', { packages: [null] }],
    ['null package budget', { packages: [{ budget: null }] }],
  ])('rejects %s without mutating or auditing it', async (_label, sellerResponse) => {
    await runWithSessionContext(async () => {
      await syncPlan();
      expect((await reportCompleted({ committed_budget: 25 })).status).toBe('accepted');

      const rejected = await reportCompleted(sellerResponse);
      const audit = await getAudit();

      expect(rejected.errors).toEqual([expect.objectContaining({ code: 'VALIDATION_ERROR' })]);
      expectLedger(audit, 25, 1);
    });
  });

  it('rejects cumulative delivery overflow without mutating or auditing it', async () => {
    await runWithSessionContext(async () => {
      await syncPlan();
      expect((await reportSpend(Number.MAX_VALUE)).status).toBe('accepted');

      const rejected = await reportSpend(Number.MAX_VALUE);
      const audit = await getAudit();

      expect(rejected).toEqual({
        errors: [{
          code: 'VALIDATION_ERROR',
          message: 'delivery.spend exceeds numeric ledger limits',
        }],
      });
      expectLedger(audit, Number.MAX_VALUE, 1);
    });
  });

  it('rejects cumulative completed-budget overflow without mutating or auditing it', async () => {
    await runWithSessionContext(async () => {
      await syncPlan();
      expect((await reportCompleted({ committed_budget: Number.MAX_VALUE })).status).toBe('findings');

      const rejected = await reportCompleted({ committed_budget: Number.MAX_VALUE });
      const audit = await getAudit();

      expect(rejected).toEqual({
        errors: [{
          code: 'VALIDATION_ERROR',
          message: 'seller_response committed budget exceeds numeric ledger limits',
        }],
      });
      expectLedger(audit, Number.MAX_VALUE, 1);
    });
  });
});
